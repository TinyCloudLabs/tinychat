import { expect, test } from "bun:test";
import type { ISessionStorage, PermissionEntry, PersistedSessionData, TinyCloudWeb } from "@tinycloud/web-sdk";
import { reauthorizeHome, type HomeReauthorizeDeps } from "./homeReauthorize";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

const ADDRESS = "0x00000000000000000000000000000000000000A1";
const OLD = { tag: "old session" } as unknown as PersistedSessionData;
const NEW = { tag: "new session" } as unknown as PersistedSessionData;

/**
 * An OpenKey approval whose signed approval lacks `missing`: hasPermissions answers like the SDK does, true only when
 * the session covers every entry asked about.
 */
function approvedWithout(missing: (entry: PermissionEntry) => boolean) {
  const records = new Map<string, PersistedSessionData>([[ADDRESS, OLD]]);
  const storage: ISessionStorage = {
    save: async (address, data) => { records.set(address, data); },
    load: async (address) => records.get(address) ?? null,
    clear: async (address) => { records.delete(address); },
    exists: (address) => records.has(address),
    isAvailable: () => true,
  };
  const calls = { verified: 0, cleanup: 0, completed: 0 };
  const deps: HomeReauthorizeDeps = {
    connect: async () => ({ address: ADDRESS, openkey: { tag: "openkey" }, web3Provider: { request: async () => null } }),
    prefetch: {
      manifest: async () => WEB_APP_MANIFEST,
      nonceForSigning: async () => "nonce-1",
      guardSigning: (provider) => provider,
      complete: () => { calls.completed += 1; },
      cancel: () => {},
    },
    createTcw: (_provider, config) => ({
      signIn: async () => { await config.sessionStorage!.save(ADDRESS, NEW); return { siwe: "siwe", signature: "signature" }; },
      hasPermissions: (entries: PermissionEntry[]) => !entries.some(missing),
      cleanup: () => { calls.cleanup += 1; },
    }) as unknown as TinyCloudWeb,
    verify: async () => { calls.verified += 1; return { token: "bearer", expiresIn: 3600 }; },
    sessionStorage: storage,
  };
  return { deps, records, calls };
}

const input = { address: ADDRESS, features: ["connectors" as const], config: { autoCreateSpace: true }, canCommit: () => null };

test("everything allowed except unlocking encrypted data is its own outcome, and nothing is kept", async () => {
  const { deps, records, calls } = approvedWithout((entry) => entry.service === "tinycloud.encryption");
  expect((await reauthorizeHome(deps, input)).outcome).toBe("partial");
  expect(calls.verified).toBe(0);
  expect(calls.completed).toBe(0);
  expect(calls.cleanup).toBe(1);
  expect(records.get(ADDRESS)).toBe(OLD);
});

test("an approval that also lacks something else stays a plain failure", async () => {
  const { deps, records } = approvedWithout((entry) => entry.service === "tinycloud.encryption" || entry.service === "tinycloud.sql");
  expect((await reauthorizeHome(deps, input)).outcome).toBe("failed");
  expect(records.get(ADDRESS)).toBe(OLD);
});

test("an approval that lacks only a secret key stays a plain failure", async () => {
  const { deps } = approvedWithout((entry) => entry.space === "secrets" && entry.service === "tinycloud.kv");
  expect((await reauthorizeHome(deps, input)).outcome).toBe("failed");
});
