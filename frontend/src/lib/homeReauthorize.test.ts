import { describe, expect, test } from "bun:test";
import type { ISessionStorage, PersistedSessionData, TinyCloudWeb } from "@tinycloud/web-sdk";
import type { TinyCloudWebConfig } from "@tinyboilerplate/client";
import { webAppManifestFor } from "./webSignInPrefetch";
import { homeSignInManifest } from "./homeFeatures";
import { reauthorizeHome, type HomeReauthorizeDeps } from "./homeReauthorize";
import { isHomeReauthorizing } from "./homeReauthorizing";

const ADDRESS = "0x00000000000000000000000000000000000000A1";
const base = webAppManifestFor(true);
const OLD = { tag: "old session" } as unknown as PersistedSessionData;
const NEW = { tag: "new session" } as unknown as PersistedSessionData;

function browserStorage(): ISessionStorage & { records: Map<string, PersistedSessionData> } {
  const records = new Map<string, PersistedSessionData>([[ADDRESS, OLD]]);
  return {
    records,
    save: async (address, data) => { records.set(address, data); },
    load: async (address) => records.get(address) ?? null,
    clear: async (address) => { records.delete(address); },
    exists: (address) => records.has(address),
    isAvailable: () => true,
  };
}

/** A TinyCloudWeb whose sign-in does what the SDK's does with storage: look for a session to restore (clearing one
 * it would not use), ask for the signature, then save the new session. `covers`: whether the approved session covers
 * what was asked (false: OpenKey approved less). */
function harness(options: { answer: "approve" | "cancel" | "error"; connected?: string; verify?: "ok" | "error"; covers?: boolean }) {
  const storage = browserStorage();
  const calls = { signIn: 0, cleanup: 0, completed: 0, cancelled: 0, verified: 0, config: null as TinyCloudWebConfig | null, reauthorizingDuringSignIn: null as boolean | null };
  const deps: HomeReauthorizeDeps = {
    connect: async () => ({ address: options.connected ?? ADDRESS, openkey: { tag: "openkey" }, web3Provider: { request: async () => null } }),
    prefetch: {
      manifest: async () => base,
      nonceForSigning: async () => "nonce-1",
      guardSigning: (provider) => provider,
      complete: () => { calls.completed += 1; },
      cancel: () => { calls.cancelled += 1; },
    },
    createTcw: (_provider, config) => {
      calls.config = config;
      const sessionStorage = config.sessionStorage!;
      return {
        signIn: async () => {
          calls.signIn += 1;
          calls.reauthorizingDuringSignIn = isHomeReauthorizing();
          if (await sessionStorage.load(ADDRESS)) await sessionStorage.clear(ADDRESS);
          if (options.answer === "cancel") throw { code: "USER_CANCELLED" };
          if (options.answer === "error") throw new Error("node unreachable");
          await sessionStorage.save(ADDRESS, NEW);
          return { siwe: "siwe", signature: "signature" };
        },
        hasPermissions: () => options.covers ?? true,
        cleanup: () => { calls.cleanup += 1; },
      } as unknown as TinyCloudWeb;
    },
    verify: async () => {
      calls.verified += 1;
      if (options.verify === "error") throw new Error("backend refused");
      return { token: "bearer-2", expiresIn: 3600 };
    },
    sessionStorage: storage,
  };
  return { deps, storage, calls };
}

const input = { address: ADDRESS.toLowerCase(), features: ["recording" as const], config: { autoCreateSpace: true }, canCommit: () => null };

describe("re-authorising the Home site in place", () => {
  test("approved: one sign-in for the base plus the asked sets, and the new session is kept only once verified", async () => {
    const { deps, storage, calls } = harness({ answer: "approve" });
    const result = await reauthorizeHome(deps, { ...input, features: ["connectors", "recording"] });
    expect(result.outcome).toBe("granted");
    if (result.outcome !== "granted") return;
    expect(calls.signIn).toBe(1);
    expect(calls.config!.manifest).toEqual(homeSignInManifest(base, ["connectors", "recording"], ADDRESS));
    expect(result.manifest).toEqual(calls.config!.manifest);
    expect(calls.config!.siweConfig).toEqual({ nonce: "nonce-1" });
    expect(storage.records.get(ADDRESS)).toBe(NEW);
    expect(result.verified).toEqual({ token: "bearer-2", expiresIn: 3600 });
    expect(calls.completed).toBe(1);
    expect(calls.cleanup).toBe(0);
  });

  test("declined: the saved session is untouched and nothing new is kept", async () => {
    const { deps, storage, calls } = harness({ answer: "cancel" });
    expect((await reauthorizeHome(deps, input)).outcome).toBe("declined");
    expect(storage.records.get(ADDRESS)).toBe(OLD);
    expect(calls.cleanup).toBe(1);
    expect(calls.cancelled).toBe(1);
    expect(calls.completed).toBe(0);
  });

  test("a failed sign-in or a refused verification keeps the saved session", async () => {
    for (const options of [{ answer: "error" as const }, { answer: "approve" as const, verify: "error" as const }]) {
      const { deps, storage, calls } = harness(options);
      expect((await reauthorizeHome(deps, input)).outcome).toBe("failed");
      expect(storage.records.get(ADDRESS)).toBe(OLD);
      expect(calls.cleanup).toBe(1);
    }
  });

  test("another account in OpenKey is refused before anything is signed, with its own outcome", async () => {
    const { deps, storage, calls } = harness({ answer: "approve", connected: "0x00000000000000000000000000000000000000b2" });
    expect((await reauthorizeHome(deps, input)).outcome).toBe("wrong-account");
    expect(calls.signIn).toBe(0);
    expect(storage.records.get(ADDRESS)).toBe(OLD);
  });

  test("an approval that covers less than was asked is not kept: failed, nothing verified or saved", async () => {
    const { deps, storage, calls } = harness({ answer: "approve", covers: false });
    expect((await reauthorizeHome(deps, input)).outcome).toBe("failed");
    expect(calls.verified).toBe(0);
    expect(storage.records.get(ADDRESS)).toBe(OLD);
    expect(calls.cleanup).toBe(1);
    expect(calls.completed).toBe(0);
  });

  test("signed out or busy by the time it would be kept: nothing is saved and that is the outcome", async () => {
    for (const blocked of ["signed-out", "busy"] as const) {
      const { deps, storage, calls } = harness({ answer: "approve" });
      expect((await reauthorizeHome(deps, { ...input, canCommit: () => blocked })).outcome).toBe(blocked);
      expect(storage.records.get(ADDRESS)).toBe(OLD);
      expect(calls.cleanup).toBe(1);
    }
  });

  test("a late approval, released after the owner signed out, keeps nothing", async () => {
    const { deps, storage, calls } = harness({ answer: "approve" });
    const verification = Promise.withResolvers<{ token: string; expiresIn: number }>();
    const verifying = Promise.withResolvers<void>();
    deps.verify = () => { verifying.resolve(); return verification.promise; };
    let signedOut = false;
    const pending = reauthorizeHome(deps, { ...input, canCommit: () => (signedOut ? "signed-out" : null) });
    // OpenKey approved and the backend check is in flight when the owner signs out.
    await verifying.promise;
    signedOut = true;
    verification.resolve({ token: "bearer-2", expiresIn: 3600 });
    expect((await pending).outcome).toBe("signed-out");
    expect(storage.records.get(ADDRESS)).toBe(OLD);
    expect(calls.cleanup).toBe(1);
  });

  test("a save that fails part-way puts the previous session back, and the outcome says nothing changed", async () => {
    const { deps, storage, calls } = harness({ answer: "approve" });
    const save = storage.save;
    // The write lands, then the storage reports a failure (as a quota error mid-write can).
    storage.save = async (address, data) => { await save(address, data); if (data === NEW) throw new Error("quota"); };
    expect((await reauthorizeHome(deps, input)).outcome).toBe("failed");
    expect(storage.records.get(ADDRESS)).toBe(OLD);
    expect(calls.cleanup).toBe(1);
    expect(calls.completed).toBe(0);
  });

  test("is marked as re-authorising only while it runs, whatever the outcome", async () => {
    for (const options of [{ answer: "approve" as const }, { answer: "cancel" as const }, { answer: "error" as const }, { answer: "approve" as const, covers: false }]) {
      const { deps, calls } = harness(options);
      expect(isHomeReauthorizing()).toBe(false);
      await reauthorizeHome(deps, input);
      expect(calls.reauthorizingDuringSignIn).toBe(true);
      expect(isHomeReauthorizing()).toBe(false);
    }
  });
});
