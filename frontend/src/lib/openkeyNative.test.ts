import { stubSdkDomGlobals } from "../test/sdkDomGlobals";
// TC-775 E1 — the Exo native OpenKey sign-in.
//
// The SDK and the node are mocked (O3/O4 are not deployed): OpenKeyNative and
// the handoff deps are fakes that record calls, so the tests pin the flow
// contract — unbound nonce → capabilities → secure-store handoff → activate →
// restore with a read-only provider → verify — plus the flag/platform routing
// and the cancel/deny messages.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenKeyNativeError } from "@openkey/sdk-capacitor";
import { UserFacingError } from "./authErrors";
import type {
  NativeSession,
  OpenKeyNative,
  TinyCloudDelegation,
} from "@openkey/sdk-capacitor";
import type { ISessionStorage, PersistedSessionData } from "@tinycloud/web-sdk";
import type { Manifest } from "@tinycloud/sdk-core";

import {
  describeAuthFailure,
  nativeClientOptions,
  normalizeLoginHint,
  NATIVE_BROWSER_THEME,
  nativePermissions,
  nativeSignInErrorMessage,
  isNativeOpenKeySession,
  isNativeOpenKeySignIn,
  logNativeOpenKeyError,
  nativeSessionWasActive,
  isNativeStorageError,
  installNativeSession,
  resetNativeOpenKeyClientForTests,
  restoreNativeAtBoot,
  secretsAvailable,
  setNativeSessionActive,
  signInNative,
  signOutNative,
  NATIVE_SIGN_OUT_DEADLINE_MS,
  NATIVE_SIGN_IN_CANCELLED_MESSAGE,
  NATIVE_SIGN_IN_DENIED_MESSAGE,
  NATIVE_SIGN_IN_NETWORK_MESSAGE,
  NATIVE_SIGN_IN_NONCE_MESSAGE,
  NATIVE_SIGN_IN_SERVER_MESSAGE,
  NATIVE_SIGN_IN_SPACE_MESSAGE,
  NATIVE_SIGN_IN_STORAGE_MESSAGE,
  NATIVE_SIGN_OUT_STORAGE_WARNING,
  type NativeSignInDeps,
} from "./openkeyNative";
import APP_MANIFEST from "../../../manifest.json";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const HOST = "https://tee.node.tinycloud.xyz";
const SPACE_ID = "did:pkh:eip155:1:" + ADDRESS + "/applications";

const delegation: TinyCloudDelegation = {
  address: ADDRESS,
  chainId: 1,
  spaceId: SPACE_ID,
  verificationMethod: "did:key:z6MkTest#z6MkTest",
  siwe: "siwe-message",
  signature: "0xdeadbeef",
  delegationHeader: { Authorization: "Bearer delegation" },
  delegationCid: "bafydelegation",
  expiresAt: "2099-01-01T00:00:00.000Z",
  permissions: [],
  tinycloudHost: HOST,
};

const sessionKey = {
  did: "did:key:z6MkTest",
  keyId: "did:key:z6MkTest#z6MkTest",
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "x" },
  privateJwk: { kty: "OKP", crv: "Ed25519", x: "x", d: "private" },
} as NativeSession["sessionKey"];

/** A NativeSessionStorage-shaped fake; `saved` keeps every handoff record. */
function fakeStorage(order: string[]) {
  const saved: Array<{ address: string; record: PersistedSessionData }> = [];
  const storage: ISessionStorage & { saved: typeof saved } = {
    saved,
    save: async (address, record) => {
      order.push("save");
      saved.push({ address, record });
    },
    load: async () => null,
    clear: async () => {},
    exists: () => true,
    isAvailable: () => true,
    activeAddress: () => ADDRESS,
  };
  return storage;
}

interface Flow {
  deps: NativeSignInDeps;
  order: string[];
  storage: ReturnType<typeof fakeStorage>;
  signInArgs: { capabilities: unknown; siweNonce?: string; loginHint?: string; loginMethod?: string }[];
  nonceCalls: (string | undefined)[];
  activation: { host: string; header: { Authorization: string } }[];
  restore: { address: string; config: Record<string, unknown> }[];
  verify: { backendUrl: string; siwe: string; signature: string }[];
  openkey: OpenKeyNative;
}

/** A fully mocked sign-in flow; individual fakes can be re-pointed per test. */
function makeFlow(): Flow {
  const order: string[] = [];
  const flow = {
    order,
    storage: fakeStorage(order),
    signInArgs: [] as Flow["signInArgs"],
    nonceCalls: [] as Flow["nonceCalls"],
    activation: [] as Flow["activation"],
    restore: [] as Flow["restore"],
    verify: [] as Flow["verify"],
  } as Flow;
  flow.openkey = {
    current: async () => null,
    signOut: async () => { flow.order.push("signOut"); },
    signIn: async (args: { capabilities: unknown; siweNonce?: string; loginHint?: string; loginMethod?: string }) => {
      flow.order.push("signIn");
      flow.signInArgs.push(args);
      return { tokens: { accessToken: "a", refreshToken: "r" }, delegation, sessionKey };
    },
    sessionStorageAdapter: () => flow.storage,
  } as unknown as OpenKeyNative;
  flow.deps = {
    createOpenKeyNative: () => flow.openkey,
    requestNonce: async (_backendUrl: string, address?: string) => {
      flow.order.push("nonce");
      flow.nonceCalls.push(address);
      return "backend-nonce-1";
    },
    loadManifest: async () => APP_MANIFEST as unknown as Manifest,
    activateSession: async (host, header) => {
      flow.order.push("activate");
      flow.activation.push({ host, header });
      return { success: true, status: 200, activated: [SPACE_ID], skipped: [], commitEventCid: "bafyreceipt" };
    },
    restoreSession: async (address, config) => {
      flow.order.push("restore");
      flow.restore.push({ address, config: config as Record<string, unknown> });
      return { tcw: { fake: true }, status: "restored" } as never;
    },
    verifySession: async (backendUrl, siwe, signature) => {
      flow.order.push("verify");
      flow.verify.push({ backendUrl, siwe, signature });
      return { token: "jwt", expiresIn: 3600, address: ADDRESS };
    },
  };
  return flow;
}

const config = {
  backendUrl: "https://api.tinycloud.chat",
  tinycloudHost: HOST,
  env: { VITE_OPENKEY_NATIVE_CLIENT_ID: "exo-native" },
};

afterEach(() => {
  setNativeSessionActive(false);
  resetNativeOpenKeyClientForTests();
});

describe("native sign-in gate", () => {
  test("runs only on ios/android", () => {
    for (const platform of ["ios", "android"] as const) {
      expect(isNativeOpenKeySignIn(platform)).toBe(true);
    }
    // Web and the Tauri desktop app keep the iframe widget.
    for (const platform of ["web", "tauri"] as const) {
      expect(isNativeOpenKeySignIn(platform)).toBe(false);
    }
  });

  test("test env is web, so secrets stay available by default", () => {
    expect(secretsAvailable()).toBe(true);
  });

  test("an active native session loses vault access", () => {
    expect(isNativeOpenKeySignIn("android")).toBe(true);
    expect(isNativeOpenKeySession()).toBe(false);
    expect(secretsAvailable()).toBe(true);
    setNativeSessionActive(true);
    expect(isNativeOpenKeySession()).toBe(true);
    expect(secretsAvailable()).toBe(false);
  });

  test("the native session marker stores only the kind, never a JWK", () => {
    const prior = (globalThis as { localStorage?: unknown }).localStorage;
    const values = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    try {
      setNativeSessionActive(true);
      expect(nativeSessionWasActive()).toBe(true);
      expect([...values.values()]).toEqual(["native"]);
      setNativeSessionActive(false);
      expect(nativeSessionWasActive()).toBe(false);
    } finally {
      if (prior === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else (globalThis as { localStorage?: unknown }).localStorage = prior;
    }
  });
});

describe("nativeClientOptions", () => {
  const CLIENT_ID = "ok_e1d13d0b220379f37a553aa0391d28a4";

  test("the prod OpenKey host derives the issuer OpenKey's own discovery document reports", () => {
    // frontend/.env.production: VITE_OPENKEY_HOST=https://openkey.so (the same
    // value App.tsx's widget client reads). This must land on the exact origin
    // OpenKey's OAuth discovery names as `issuer`, or token exchange fails.
    const options = nativeClientOptions(
      { VITE_OPENKEY_NATIVE_CLIENT_ID: CLIENT_ID, VITE_OPENKEY_HOST: "https://openkey.so" },
      HOST,
    );
    expect(options.issuer).toBe("https://api.openkey.so/api/auth");
    expect(options.redirectUri).toBe("xyz.tinycloud.exo://openkey/callback");
    expect(options.clientId).toBe(CLIENT_ID);
  });

  test("an unset VITE_OPENKEY_HOST falls back to the same default App.tsx uses", () => {
    const options = nativeClientOptions({ VITE_OPENKEY_NATIVE_CLIENT_ID: CLIENT_ID }, HOST);
    expect(options.issuer).toBe("https://api.openkey.so/api/auth");
  });

  test("a non-default OpenKey host derives the matching api. host, not the hard-coded default", () => {
    const options = nativeClientOptions(
      { VITE_OPENKEY_NATIVE_CLIENT_ID: CLIENT_ID, VITE_OPENKEY_HOST: "https://openkey.example.com" },
      HOST,
    );
    expect(options.issuer).toBe("https://api.openkey.example.com/api/auth");
  });

  test("a loopback OpenKey host keeps its own origin (API and widget share it in local dev)", () => {
    const options = nativeClientOptions(
      { VITE_OPENKEY_NATIVE_CLIENT_ID: CLIENT_ID, VITE_OPENKEY_HOST: "http://localhost:5183" },
      HOST,
    );
    expect(options.issuer).toBe("http://localhost:5183/api/auth");
  });

  test("a malformed OpenKey host throws instead of falling back to the prod issuer", () => {
    expect(() => nativeClientOptions(
      { VITE_OPENKEY_NATIVE_CLIENT_ID: CLIENT_ID, VITE_OPENKEY_HOST: "openkey.example.com" },
      HOST,
    )).toThrow('Native sign-in is not configured in this build (VITE_OPENKEY_HOST is not a valid URL: "openkey.example.com").');
  });

  const malformedHost = { ...config, env: { ...config.env, VITE_OPENKEY_HOST: "openkey.example.com" } };

  test("signInNative surfaces a malformed host as the configuration error, not a generic failure", async () => {
    await expect(signInNative(malformedHost, undefined, makeFlow().deps)).rejects.toThrow(
      'Native sign-in is not configured in this build (VITE_OPENKEY_HOST is not a valid URL: "openkey.example.com").',
    );
  });

  test("restoreNativeAtBoot classifies a malformed host as configuration, not unavailable", async () => {
    expect((await restoreNativeAtBoot(malformedHost, true, makeFlow().deps)).kind).toBe("configuration");
  });
});

describe("nativePermissions", () => {
  test("requests the manifest's applications-space entries plus capabilities/read", () => {
    const permissions = nativePermissions(APP_MANIFEST as unknown as Manifest);
    expect(permissions[0]).toEqual({
      service: "tinycloud.capabilities",
      space: "applications",
      path: "",
      actions: ["tinycloud.capabilities/read"],
    });
    // Every manifest KV/SQL entry, prefixed and URN-expanded.
    const kv = permissions.find((p) => p.service === "tinycloud.kv" && p.path.includes("threads"));
    expect(kv).toEqual({
      service: "tinycloud.kv",
      space: "applications",
      path: "xyz.tinycloud.tinychat/threads/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list"],
    });
    const sql = permissions.find((p) => p.service === "tinycloud.sql" && p.path.endsWith("connectors"));
    expect(sql).toEqual({
      service: "tinycloud.sql",
      space: "applications",
      path: "xyz.tinycloud.tinychat/connectors",
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"],
    });
    // The manifest's `secrets` block produces no delegation permission.
    expect(permissions.some((p) => p.service.includes("secrets") || p.service.includes("vault"))).toBe(false);
    expect(permissions.some((p) => p.space !== "applications")).toBe(false);
  });
});

describe("signInNative", () => {
  test("a fresh activation runs nonce → sign-in → handoff → activate → restore → verify", async () => {
    const flow = makeFlow();
    const result = await signInNative(config, undefined, flow.deps);

    expect(flow.order).toEqual(["nonce", "signIn", "save", "activate", "restore", "verify"]);
    // Address-less: the signer is unknown until OpenKey signs the delegation.
    expect(flow.nonceCalls).toEqual([undefined]);
    expect(flow.signInArgs[0].siweNonce).toBe("backend-nonce-1");
    expect((flow.signInArgs[0].capabilities as unknown[])[0]).toEqual({
      service: "tinycloud.capabilities",
      space: "applications",
      path: "",
      actions: ["tinycloud.capabilities/read"],
    });

    // The session record went to the native secure-store adapter — the same
    // object restoreSession then reads back through.
    expect(flow.storage.saved).toHaveLength(1);
    const saved = flow.storage.saved[0];
    expect(saved.address).toBe(ADDRESS);
    expect(JSON.parse(saved.record.sessionKey)).toEqual(sessionKey.privateJwk);
    expect(saved.record.tinycloudSession?.delegationCid).toBe("bafydelegation");
    expect(saved.record.expiresAt).toBe("2099-01-01T00:00:00.000Z");

    expect(flow.activation).toEqual([{ host: HOST, header: { Authorization: "Bearer delegation" } }]);

    expect(flow.restore).toHaveLength(1);
    expect(flow.restore[0].address).toBe(ADDRESS);
    expect(flow.restore[0].config.sessionStorage).toBe(flow.storage);
    // The provider answers account/chain queries and refuses to sign.
    const provider = flow.restore[0].config.provider as {
      request: (args: { method: string }) => Promise<unknown>;
    };
    await expect(provider.request({ method: "eth_accounts" })).resolves.toEqual([ADDRESS]);
    await expect(provider.request({ method: "eth_chainId" })).resolves.toBe("0x1");
    await expect(provider.request({ method: "personal_sign" })).rejects.toThrow(/signing/i);

    expect(flow.verify).toEqual([
      { backendUrl: "https://api.tinycloud.chat", siwe: "siwe-message", signature: "0xdeadbeef" },
    ]);
    expect(result.address).toBe(ADDRESS);
    expect(result.verified.token).toBe("jwt");
  });

  test("hints reach OpenKeyNative.signIn: the email path sends the address with its method", async () => {
    const flow = makeFlow();
    await signInNative(config, { loginHint: "sam@mailinator.com", loginMethod: "email" }, flow.deps);
    expect(flow.signInArgs[0].loginHint).toBe("sam@mailinator.com");
    expect(flow.signInArgs[0].loginMethod).toBe("email");
    expect(flow.signInArgs[0].siweNonce).toBe("backend-nonce-1");
  });

  test("a method-only hint sends no address", async () => {
    for (const loginMethod of ["google", "passkey"] as const) {
      resetNativeOpenKeyClientForTests();
      const flow = makeFlow();
      await signInNative(config, { loginMethod }, flow.deps);
      expect(flow.signInArgs[0].loginMethod).toBe(loginMethod);
      expect("loginHint" in flow.signInArgs[0]).toBe(false);
    }
  });

  test("with no hints the sign-in carries none", async () => {
    const flow = makeFlow();
    await signInNative(config, undefined, flow.deps);
    expect("loginHint" in flow.signInArgs[0]).toBe(false);
    expect("loginMethod" in flow.signInArgs[0]).toBe(false);
  });

  test("an already active space with no new activation restores and verifies", async () => {
    const flow = makeFlow();
    const activate = flow.deps.activateSession;
    flow.deps.activateSession = async (host, header) => ({
      ...await activate(host, header), activated: [], skipped: [],
    });

    const result = await signInNative(config, undefined, flow.deps);
    expect(result.verified.token).toBe("jwt");
    expect(flow.order).toEqual(["nonce", "signIn", "save", "activate", "restore", "verify"]);
  });

  test("a skipped delegated space maps to SPACE_UNAVAILABLE and revokes the grant", async () => {
    const flow = makeFlow();
    const activate = flow.deps.activateSession;
    flow.deps.activateSession = async (host, header) => ({
      ...await activate(host, header), activated: [], skipped: [SPACE_ID],
    });

    let caught: unknown;
    try { await signInNative(config, undefined, flow.deps); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(NATIVE_SIGN_IN_SPACE_MESSAGE);
    expect((caught as Error & { cause?: { code?: string } }).cause?.code).toBe("SPACE_UNAVAILABLE");
    expect(flow.order.at(-1)).toBe("signOut");
    expect(flow.restore).toEqual([]);
    expect(flow.verify).toEqual([]);
  });

  test("never writes the session key or JWK to localStorage", async () => {
    const writes: string[] = [];
    const spy = {
      setItem: (key: string, _v: string) => void writes.push(key),
      getItem: () => null,
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    const had = "localStorage" in globalThis;
    const prev = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = spy;
    try {
      await signInNative(config, undefined, makeFlow().deps);
    } finally {
      if (had) (globalThis as { localStorage?: unknown }).localStorage = prev;
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    expect(writes).toEqual([]);
  });

  test("USER_CANCELLED reports a cancellation and never reaches verify", async () => {
    const flow = makeFlow();
    flow.openkey.signIn = async () => {
      throw new OpenKeyNativeError("USER_CANCELLED", "sheet closed");
    };
    await expect(signInNative(config, undefined, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_CANCELLED_MESSAGE);
    expect(flow.verify).toEqual([]);
    expect(flow.storage.saved).toEqual([]);
  });

  test("ACCESS_DENIED reports a denial and never reaches verify", async () => {
    const flow = makeFlow();
    flow.openkey.signIn = async () => {
      throw new OpenKeyNativeError("ACCESS_DENIED", "user denied");
    };
    await expect(signInNative(config, undefined, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_DENIED_MESSAGE);
    expect(flow.verify).toEqual([]);
  });

  test("an unspecified failure gets the generic message", async () => {
    const flow = makeFlow();
    flow.deps.activateSession = async () => ({ success: false, status: 503, error: "node unreachable" });
    await expect(signInNative(config, undefined, flow.deps)).rejects.toThrow(/failed/i);
    expect(flow.verify).toEqual([]);
  });

  test("a delegation for another TinyCloud node is refused", async () => {
    const flow = makeFlow();
    flow.openkey.signIn = async () => ({
      tokens: { accessToken: "a", refreshToken: "r" },
      delegation: { ...delegation, tinycloudHost: "https://other.example" },
      sessionKey,
    });
    await expect(signInNative(config, undefined, flow.deps)).rejects.toThrow();
    expect(flow.activation).toEqual([]);
  });

  test("save, activate, restore and verify failures all revoke the new grant", async () => {
    for (const failed of ["save", "activate", "restore", "verify"]) {
      resetNativeOpenKeyClientForTests();
      const flow = makeFlow();
      if (failed === "save") flow.storage.save = async () => { throw new Error("secure store failed"); };
      if (failed === "activate") flow.deps.activateSession = async () => { throw new Error("activation failed"); };
      if (failed === "restore") flow.deps.restoreSession = async () => { throw new Error("restore failed"); };
      if (failed === "verify") flow.deps.verifySession = async () => { throw new Error("SIWE verification failed: Nonce is invalid, expired, or already used"); };
      await expect(signInNative(config, undefined, flow.deps)).rejects.toThrow(
        failed === "verify" ? NATIVE_SIGN_IN_NONCE_MESSAGE : /sign-in failed/i,
      );
      expect(flow.order.at(-1)).toBe("signOut");
      expect(flow.order.filter((step) => step === "signOut")).toHaveLength(1);
    }
  });

  test("a failed new sign-in leaves an existing SDK session for the SDK to keep", async () => {
    const flow = makeFlow();
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation, sessionKey });
    flow.openkey.signIn = async () => { throw new OpenKeyNativeError("ACCESS_DENIED", "denied"); };
    await expect(signInNative(config, undefined, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_DENIED_MESSAGE);
    expect(flow.order).toEqual(["nonce"]);
    expect(await flow.openkey.current()).not.toBeNull();
  });

  test("a failed immediate renewal is handled by the SDK without another revoke", async () => {
    const flow = makeFlow();
    flow.openkey.signIn = async () => { throw new OpenKeyNativeError("NETWORK", "renew failed"); };
    await expect(signInNative(config, undefined, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_NETWORK_MESSAGE);
    expect(flow.order).toEqual(["nonce"]);
  });

  test("a failed cleanup revoke leaves the handoff error visible", async () => {
    const flow = makeFlow();
    flow.deps.verifySession = async () => { throw new Error("SIWE verification failed: invalid_nonce"); };
    flow.openkey.signOut = async () => { throw new OpenKeyNativeError("NETWORK", "offline"); };
    await expect(signInNative(config, undefined, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_NONCE_MESSAGE);
  });
});

describe("native boot", () => {
  test("restores a valid native session through adapter, activate, then restore", async () => {
    const flow = makeFlow();
    let constructed = 0;
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation, sessionKey });
    flow.storage.load = async () => { flow.order.push("load"); return null; };
    const boot = await restoreNativeAtBoot(config, true, { ...flow.deps,
      createOpenKeyNative: () => { constructed++; return flow.openkey; },
    });
    expect(boot.kind).toBe("restored");
    expect(constructed).toBe(1);
    expect(flow.order).toEqual(["load", "save", "activate", "restore"]);
  });

  test("constructs the client even without a current session so pending revokes retry", async () => {
    const flow = makeFlow();
    let constructed = 0;
    expect((await restoreNativeAtBoot(config, true, { ...flow.deps,
      createOpenKeyNative: () => { constructed++; return flow.openkey; },
    })).kind).toBe("none");
    expect(constructed).toBe(1);
    expect(flow.order).toEqual([]);
  });

  test("reuses the same SDK client for boot, sign-in and sign-out", async () => {
    const flow = makeFlow();
    let constructed = 0;
    const createOpenKeyNative = () => { constructed++; return flow.openkey; };
    expect((await restoreNativeAtBoot(config, true, { ...flow.deps, createOpenKeyNative })).kind).toBe("none");
    await signInNative(config, undefined, { ...flow.deps, createOpenKeyNative });
    await signOutNative({ env: config.env, createOpenKeyNative });
    expect(constructed).toBe(1);
    expect(flow.order.at(-1)).toBe("signOut");
  });

  test("renews near expiry and replaces an expired backend JWT", async () => {
    const flow = makeFlow();
    const old = { ...delegation, issuedAt: new Date(Date.now() - 270_000).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation: old, sessionKey });
    flow.openkey.renew = async () => {
      flow.order.push("renew");
      return { tokens: { accessToken: "a", refreshToken: "r2" }, delegation: { ...delegation, delegationCid: "new-cid" }, sessionKey };
    };
    const near = await restoreNativeAtBoot(config, true, flow.deps);
    expect(near.kind).toBe("restored");
    expect(flow.order.indexOf("renew")).toBeLessThan(flow.order.indexOf("activate"));
    expect(flow.storage.saved.at(-1)?.record.tinycloudSession?.delegationCid).toBe("new-cid");
    resetNativeOpenKeyClientForTests();
    flow.order.length = 0;
    const expiredJwt = await restoreNativeAtBoot(config, false, flow.deps);
    expect(expiredJwt.kind).toBe("restored");
    if (expiredJwt.kind === "restored") expect(expiredJwt.verified?.token).toBeDefined();
    expect(flow.order).toContain("verify");
  });

  test("a valid delegation renews to replace only an expired backend JWT", async () => {
    const flow = makeFlow();
    const live = { ...delegation, issuedAt: new Date(Date.now() - 300_000).toISOString(), expiresAt: new Date(Date.now() + 3_300_000).toISOString() };
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation: live, sessionKey });
    flow.openkey.renew = async () => {
      flow.order.push("renew");
      return { tokens: { accessToken: "a", refreshToken: "r2" }, delegation: { ...delegation, delegationCid: "jwt-renewed" }, sessionKey };
    };
    const boot = await restoreNativeAtBoot(config, false, flow.deps);
    expect(boot.kind).toBe("restored");
    if (boot.kind === "restored") expect(boot.verified?.token).toBe("jwt");
    expect(flow.order.indexOf("renew")).toBeLessThan(flow.order.indexOf("activate"));
    expect(flow.order).toContain("verify");
  });

  test("a renewal inside the minimum restores immediately and schedules background renewal", async () => {
    const flow = makeFlow();
    const live = { ...delegation, issuedAt: new Date(Date.now() - 5_000).toISOString(), expiresAt: new Date(Date.now() + 295_000).toISOString() };
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation: live, sessionKey });
    flow.openkey.renew = async () => { throw new Error("boot must not wait for a too-soon renewal"); };
    const boot = await restoreNativeAtBoot(config, false, flow.deps);
    expect(boot.kind).toBe("restored");
    if (boot.kind === "restored") {
      expect(boot.verified).toBeUndefined();
      expect(boot.renewAt).toBeGreaterThan(Date.now());
      expect(boot.renewAt).toBeLessThan(Date.now() + 60_000);
    }
    expect(flow.order).not.toContain("renew");
  });

  test("reconciles a stale adapter CID from an interrupted renewal before activation", async () => {
    const flow = makeFlow();
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation, sessionKey });
    flow.storage.load = async () => ({
      address: ADDRESS, chainId: 1, sessionKey: "{}", siwe: "old", signature: "old",
      tinycloudSession: { delegationHeader: { Authorization: "old" }, delegationCid: "stale", spaceId: SPACE_ID },
      expiresAt: delegation.expiresAt, createdAt: new Date().toISOString(), version: "1", tinycloudHosts: [HOST],
    });
    expect((await restoreNativeAtBoot(config, true, flow.deps)).kind).toBe("restored");
    expect(flow.order.slice(0, 3)).toEqual(["save", "activate", "restore"]);
    expect(flow.storage.saved.at(-1)?.record.tinycloudSession?.delegationCid).toBe(delegation.delegationCid);
  });

  test("only network errors show offline; other failures preserve the session and offer sign-in", async () => {
    for (const [error, kind] of [
      [new OpenKeyNativeError("NETWORK", "offline"), "unavailable"],
      [new OpenKeyNativeError("SERVER", "error", 503), "failed"],
      [new OpenKeyNativeError("UNAVAILABLE", "busy"), "failed"],
      [new Error("unexpected restore failure"), "failed"],
    ] as const) {
      resetNativeOpenKeyClientForTests();
      const flow = makeFlow();
      flow.openkey.current = async () => { throw error; };
      expect((await restoreNativeAtBoot(config, true, flow.deps)).kind).toBe(kind);
      expect(flow.order).not.toContain("signOut");
    }
  });

  test("restores a recent tee.node delegation without a host-migration renewal", async () => {
    const flow = makeFlow();
    const recent = { ...delegation, issuedAt: new Date(Date.now() - 5_000).toISOString(), expiresAt: new Date(Date.now() + 295_000).toISOString() };
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation: recent, sessionKey });
    const boot = await restoreNativeAtBoot(config, true, flow.deps);
    expect(boot.kind).toBe("restored");
    expect(flow.order).not.toContain("renew");
    expect(flow.activation[0]?.host).toBe(HOST);
    expect(flow.restore[0]?.config.tinycloudHosts).toEqual([HOST]);
  });

  test("renews an expiring tee.node delegation on the same host", async () => {
    const flow = makeFlow();
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation, sessionKey });
    flow.openkey.renew = async () => ({ tokens: { accessToken: "a", refreshToken: "new" }, delegation, sessionKey });
    const boot = await restoreNativeAtBoot(config, false, flow.deps);
    expect(boot.kind).toBe("restored");
    expect(flow.activation[0]?.host).toBe(HOST);
    expect(flow.verify).toHaveLength(1);
  });

  test("classifies terminal and storage errors separately", async () => {
    const flow = makeFlow();
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation, sessionKey });
    flow.openkey.renew = async () => { throw new OpenKeyNativeError("CONSENT_REQUIRED", "withdrawn"); };
    const terminal = await restoreNativeAtBoot(config, false, flow.deps);
    expect(terminal.kind).toBe("terminal");
    expect(flow.order).not.toContain("signOut");
    if (terminal.kind === "terminal") await terminal.revoke();
    expect(flow.order).toContain("signOut");
    resetNativeOpenKeyClientForTests();
    flow.openkey.current = async () => { throw new OpenKeyNativeError("STORAGE", "secure store failed"); };
    expect((await restoreNativeAtBoot(config, true, flow.deps)).kind).toBe("storage");
  });

  test("deferred terminal revoke reports only secure-store failures as storage", async () => {
    const flow = makeFlow();
    flow.openkey.current = async () => { throw new OpenKeyNativeError("INVALID_GRANT", "expired"); };
    flow.openkey.signOut = async () => { throw new OpenKeyNativeError("STORAGE", "secure store failed"); };
    const boot = await restoreNativeAtBoot(config, true, flow.deps);
    expect(boot.kind).toBe("terminal");
    if (boot.kind === "terminal") {
      await expect(boot.revoke()).rejects.toMatchObject({ code: "STORAGE" });
    }
  });

  test("a deferred terminal revoke also has the native sign-out deadline", async () => {
    const flow = makeFlow();
    flow.openkey.current = async () => { throw new OpenKeyNativeError("INVALID_GRANT", "expired"); };
    flow.openkey.signOut = () => new Promise<void>(() => {});
    const boot = await restoreNativeAtBoot(config, true, flow.deps);
    expect(boot.kind).toBe("terminal");
    if (boot.kind === "terminal") {
      const started = Date.now();
      let caught: unknown;
      try { await boot.revoke(); } catch (error) { caught = error; }
      expect((caught as Error).message).toBe("OpenKey sign-out timed out");
      expect(isNativeStorageError(caught)).toBe(false);
      expect(Date.now() - started).toBeLessThan(NATIVE_SIGN_OUT_DEADLINE_MS + 2_000);
    }
  }, 13_000);
});

test("renewed handoff saves the new CID, activates it, then restores on the live client", async () => {
  const flow = makeFlow();
  const live = { restoreSession: async () => { flow.order.push("liveRestore"); return { status: "restored" }; } } as never;
  const next = { tokens: { accessToken: "a", refreshToken: "new" }, sessionKey,
    delegation: { ...delegation, delegationCid: "bafyrenewed", delegationHeader: { Authorization: "Bearer renewed" } } } as NativeSession;
  await installNativeSession(flow.openkey, next, config, flow.deps, live);
  expect(flow.order).toEqual(["save", "activate", "liveRestore"]);
  expect(flow.storage.saved.at(-1)?.record.tinycloudSession?.delegationCid).toBe("bafyrenewed");
  expect(flow.activation.at(-1)?.header.Authorization).toBe("Bearer renewed");
});

describe("error message mapping", () => {
  test("maps SDK codes to user-facing copy", () => {
    expect(nativeSignInErrorMessage(new OpenKeyNativeError("USER_CANCELLED", "x"))).toBe(
      NATIVE_SIGN_IN_CANCELLED_MESSAGE,
    );
    expect(nativeSignInErrorMessage(new OpenKeyNativeError("ACCESS_DENIED", "x"))).toBe(
      NATIVE_SIGN_IN_DENIED_MESSAGE,
    );
    expect(nativeSignInErrorMessage(new Error("SIWE verification failed: Nonce is invalid, expired, or already used"))).toBe(NATIVE_SIGN_IN_NONCE_MESSAGE);
    expect(nativeSignInErrorMessage(new OpenKeyNativeError("SPACE_UNAVAILABLE", "x"))).toBe(NATIVE_SIGN_IN_SPACE_MESSAGE);
    expect(nativeSignInErrorMessage(new OpenKeyNativeError("NETWORK", "x"))).toBe(NATIVE_SIGN_IN_NETWORK_MESSAGE);
    expect(nativeSignInErrorMessage(new OpenKeyNativeError("STORAGE", "network-looking detail"))).toBe(NATIVE_SIGN_IN_STORAGE_MESSAGE);
    expect(nativeSignInErrorMessage(new OpenKeyNativeError("SERVER", "x"))).toBe(NATIVE_SIGN_IN_SERVER_MESSAGE);
    expect(nativeSignInErrorMessage(new Error("boom"))).toMatch(/failed/i);
    expect(nativeSignInErrorMessage("boom")).toMatch(/failed/i);
  });

  test("logs name, code, status and a redacted message", () => {
    const prior = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => { lines.push(line); };
    try {
      const sdkError = new OpenKeyNativeError("SERVER", "secret detail");
      sdkError.rotatedRefreshToken = "secret refresh token";
      logNativeOpenKeyError("sign-in", sdkError);
      logNativeOpenKeyError("sign-out", new OpenKeyNativeError("STORAGE", "secret storage detail"));
      logNativeOpenKeyError("boot restore", new OpenKeyNativeError("INVALID_GRANT", "invalid_grant: secret", 400, "invalid_grant"));
      logNativeOpenKeyError("boot restore", new OpenKeyNativeError("SERVER", "Renew failed: HTTP 502", 502));
      logNativeOpenKeyError("renew", new OpenKeyNativeError("SERVER", "x", 400, "Bearer rt_SECRET"));
      logNativeOpenKeyError("verify", new Error("verification failed"));
    } finally {
      console.warn = prior;
    }
    expect(lines).toEqual([
      "[OpenKey native] sign-in: OpenKeyNativeError code=SERVER message=secret detail",
      "[OpenKey native] sign-out: OpenKeyNativeError code=STORAGE message=secret storage detail",
      "[OpenKey native] boot restore: OpenKeyNativeError code=INVALID_GRANT status=400 serverError=invalid_grant message=invalid_grant: secret",
      "[OpenKey native] boot restore: OpenKeyNativeError code=SERVER status=502 message=Renew failed: HTTP 502",
      "[OpenKey native] renew: OpenKeyNativeError code=SERVER status=400 message=x",
      "[OpenKey native] verify: Error message=verification failed",
    ]);
  });

  test("redacts credentials in non-native error messages", () => {
    const token = "rt_SYNTHETIC_TOKEN_IN_MESSAGE";
    const lines: string[] = [];
    const prior = console.warn;
    console.warn = (line: string) => { lines.push(line); };
    try {
      logNativeOpenKeyError("sign-in", new Error(`exchange failed for refresh_token=${token}`));
      logNativeOpenKeyError("restore", new TypeError(`Bearer ${token}`));
      logNativeOpenKeyError("sign-in", { message: token });
      logNativeOpenKeyError("sign-in", token);
    } finally {
      console.warn = prior;
    }
    expect(lines).toEqual([
      "[OpenKey native] sign-in: Error message=exchange failed for refresh_token=[redacted]",
      "[OpenKey native] restore: TypeError message=Bearer [redacted]",
      "[OpenKey native] sign-in: unknown error",
      "[OpenKey native] sign-in: unknown error",
    ]);
    expect(lines.join("\n")).not.toContain(token);
  });

  test("storage sign-out failures keep the session available for retry", () => {
    expect(isNativeStorageError(new OpenKeyNativeError("STORAGE", "read failed"))).toBe(true);
    expect(isNativeStorageError(new OpenKeyNativeError("NETWORK", "offline"))).toBe(false);
    expect(NATIVE_SIGN_OUT_STORAGE_WARNING).toMatch(/session may still be stored/i);
    expect(NATIVE_SIGN_OUT_STORAGE_WARNING).toMatch(/try signing out again/i);
  });
});

describe("native sign-out", () => {
  test("a sign-out whose SDK call never settles times out without becoming a storage error", async () => {
    const openkey = { signOut: () => new Promise<void>(() => {}) } as unknown as OpenKeyNative;
    const started = Date.now();
    let caught: unknown;
    try {
      await signOutNative({
        env: { VITE_OPENKEY_NATIVE_CLIENT_ID: "exo-native" },
        createOpenKeyNative: () => openkey,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("OpenKey sign-out timed out");
    expect(isNativeStorageError(caught)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(NATIVE_SIGN_OUT_DEADLINE_MS);
    expect(Date.now() - started).toBeLessThan(NATIVE_SIGN_OUT_DEADLINE_MS + 2_000);
  }, 13_000);

  test("a transient SDK rejection reaches the app so it can show retry guidance", async () => {
    const error = new OpenKeyNativeError("SERVER", "revoke temporarily unavailable");
    const openkey = { signOut: async () => { throw error; } } as unknown as OpenKeyNative;
    await expect(signOutNative({
      env: { VITE_OPENKEY_NATIVE_CLIENT_ID: "exo-native" },
      createOpenKeyNative: () => openkey,
    })).rejects.toBe(error);
  });

  test("a resolved SDK sign-out also resolves here", async () => {
    let calls = 0;
    const openkey = { signOut: async () => { calls++; } } as unknown as OpenKeyNative;
    await signOutNative({
      env: { VITE_OPENKEY_NATIVE_CLIENT_ID: "exo-native" },
      createOpenKeyNative: () => openkey,
    });
    expect(calls).toBe(1);
  });
});

describe("normalizeLoginHint", () => {
  test("trims and lowercases a plausible address", () => {
    expect(normalizeLoginHint("  Sam@Mailinator.com ")).toBe("sam@mailinator.com");
  });

  test("refuses anything the PAR would refuse", () => {
    for (const bad of ["", "   ", "sam", "@mailinator.com", "sam@", "a@b@c.com", "sam smith@mailinator.com", `${"a".repeat(250)}@b.co`]) {
      expect(normalizeLoginHint(bad)).toBeNull();
    }
    expect(normalizeLoginHint(`${"a".repeat(248)}@b.co`)).toBe(`${"a".repeat(248)}@b.co`);
  });
});

describe("Android browser theme", () => {
  test("Custom Tabs are dark with the OpenKey page's background", () => {
    expect(NATIVE_BROWSER_THEME).toEqual({ toolbarColor: "#09090B", colorScheme: "dark" });
  });

  test("the default client is built with it", () => {
    const source = readFileSync(join(__dirname, "openkeyNative.ts"), "utf-8");
    const deps = source.slice(source.indexOf("async function defaultDeps"), source.indexOf("function delegationExpiryIso"));
    expect(deps).toContain("browserTheme: NATIVE_BROWSER_THEME");
  });
});

describe("platform routing (source)", () => {
  const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf-8");

  test("signIn takes the native branch before the widget path", () => {
    const signIn = app.slice(app.indexOf("const signIn = useCallback"), app.indexOf("const signOut = useCallback"));
    expect(signIn).toContain("if (isNativeOpenKeySignIn())");
    expect(signIn).toContain("signInNative(");
    // Native first, the embedded-widget path second — web/desktop never reach it.
    expect(signIn.indexOf("signInNative(")).toBeLessThan(signIn.indexOf("connectWallet("));
  });

  test("signOut calls OpenKeyNative.signOut on the native path", () => {
    const signOut = app.slice(app.indexOf("const signOut = useCallback"), app.indexOf("const isReady"));
    expect(signOut).toContain("signOutNative()");
    expect(signOut.indexOf("isNativeOpenKeySession()")).toBeLessThan(signOut.indexOf("signOutOpenKeySession("));
    expect(signOut.indexOf("if (isNativeStorageError(caught))")).toBeLessThan(signOut.indexOf("completeLocalSignOut(openKeyWarning"));
    expect(signOut.indexOf("nativeRenewalRef.current?.stop()")).toBeLessThan(signOut.indexOf("await "));
    const storageFailure = signOut.slice(signOut.indexOf("if (isNativeStorageError(caught))"), signOut.indexOf("if (caught instanceof Error"));
    expect(storageFailure).toContain('setState("ready")');
    expect(storageFailure).toContain("void nativeRenewalRef.current?.resume()");
    expect(signOut).not.toContain("await nativeRenewalRef.current?.resume()");
    expect(storageFailure).not.toContain("setNativeSessionActive(false)");
    expect(signOut).toContain("openKeyWarning = NATIVE_SIGN_OUT_WARNING");
    expect(signOut).toContain("if (nativeSession && !options.terminal)");
    expect(signOut).toContain("completeLocalSignOut(openKeyWarning, Boolean(options.terminal))");
    const terminal = app.slice(app.indexOf("onTerminal: (message) =>"), app.indexOf("onStorage: () =>"));
    expect(terminal).toContain("signOutRef.current?.({ terminal: message })");
    expect(app).toContain("signOutInFlightRef.current = true");
  });

  test("terminal handoff failure keeps renewal stopped; manual sign-out failure resumes it", () => {
    const signOut = app.slice(app.indexOf("const signOut = useCallback"), app.indexOf("const isReady"));
    const stop = signOut.indexOf("nativeRenewalRef.current?.stop()");
    const handoff = signOut.indexOf("if (!await captureHandoff())");
    const failure = signOut.slice(handoff, signOut.indexOf("let openKeyWarning", handoff));
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(handoff);
    expect(failure).toMatch(/if \(!options\.terminal\) void nativeRenewalRef\.current\?\.resume\(\);\s+return;/);
    expect(failure).not.toMatch(/^\s*void nativeRenewalRef\.current\?\.resume\(\);/m);
    expect(app).toContain("signOutRef.current?.({ terminal: message })");
  });

  test("restoreSession never reaches the widget restore on a native platform", () => {
    const boot = app.slice(app.indexOf("const restoreSession = useCallback"), app.indexOf("useEffect(() => {\n    if (restoredRef.current)"));
    const nativeBranch = boot.slice(boot.indexOf("if (isNativeOpenKeySignIn())"), boot.indexOf("restorePersistedSession("));
    expect(nativeBranch.indexOf("restoreNativeAtBoot(")).toBeGreaterThan(-1);
    expect(nativeBranch).toContain('boot.kind === "restored"');
    // No outcome inside the native branch — including the "none"/"terminal"
    // cleanup below — ever calls the widget's own restore: a persisted widget
    // session cannot be restored from here, only cleared.
    expect(nativeBranch).not.toContain("restoreTinyCloudWebSession");
    expect(nativeBranch).not.toContain("connectWallet(");
    const cleanup = nativeBranch.slice(nativeBranch.indexOf('if (boot.kind === "configuration")'), nativeBranch.length);
    expect(cleanup.indexOf("await captureHandoff()")).toBeLessThan(cleanup.indexOf("clearPersistedSession(storedAddress)"));
    expect(cleanup.indexOf("clearPersistedSession(storedAddress)")).toBeLessThan(cleanup.indexOf("await boot.revoke()"));
    expect(cleanup).toContain('setError(NATIVE_STORAGE_MESSAGE)');
    expect(cleanup).toContain("sessionStoreRef.current.clear()");
    expect(cleanup).toContain('setState("unauthenticated")');
  });
});

describe("persisted widget session on a native cold boot", () => {
  // Covers restoreNativeAtBoot plus the storage helpers App.restoreSession's
  // "none"/"terminal" cleanup calls (clearPersistedSession for the SDK's
  // localStorage TinyCloud session, SessionStore.clear() for the backend
  // bearer session), using the real functions, not mocks. The cleanup lines
  // are repeated here; that App runs them in that branch is pinned by the
  // source assertions above, not by this test.
  test("restoreNativeAtBoot restores nothing and the cleanup helpers remove a pre-native widget session", async () => {
    const address = "0x2222222222222222222222222222222222222222";
    const values = new Map<string, string>();
    const prior = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const restoreSdkGlobals = stubSdkDomGlobals();
    try {
      // @tinyboilerplate/client evaluates @tinycloud/web-sdk at module load and
      // reads DOM globals then (see billingApi.test.ts). restoreSdkGlobals above
      // stubs them and restores each exact prior descriptor in the finally.
      const { SessionStore, clearPersistedSession, loadPersistedSession } = await import("@tinyboilerplate/client");
      // A widget sign-in before this build: a bearer session plus the SDK's
      // own persisted TinyCloud session for that address.
      values.set(`tinycloud:session:${address.toLowerCase()}`, JSON.stringify({
        address, chainId: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }));
      const sessionStore = new SessionStore(`t-${address}`);
      sessionStore.setSession("bearer-token", 3600, address);
      expect(sessionStore.hasSession()).toBe(true);
      expect(loadPersistedSession(address)).not.toBeNull();

      // Cold native launch: no native delegation exists yet (restoreNativeAtBoot
      // -> "none"), so restoreSession's cleanup runs instead of any restore.
      const flow = makeFlow();
      const boot = await restoreNativeAtBoot(
        config,
        sessionStore.hasSession() && !sessionStore.isExpired(),
        flow.deps,
      );
      expect(boot.kind).toBe("none");
      expect(flow.order).toEqual([]); // nothing was restored

      const storedAddress = sessionStore.getAddress();
      if (storedAddress) clearPersistedSession(storedAddress);
      sessionStore.clear();
      setNativeSessionActive(false);

      expect(sessionStore.hasSession()).toBe(false);
      expect(loadPersistedSession(address)).toBeNull();
      expect(isNativeOpenKeySession()).toBe(false);
    } finally {
      if (prior === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else (globalThis as { localStorage?: unknown }).localStorage = prior;
      restoreSdkGlobals();
    }
  });
});

describe("describeAuthFailure redaction", () => {
  test("logs only a code or a message string, never the error object, its cause or token fields", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const secret = "rt_SYNTHETIC_REFRESH_TOKEN";
    const jwk = { kty: "OKP", crv: "Ed25519", d: "SYNTHETIC_PRIVATE_D" };
    const sdkError = Object.assign(new Error("exchange failed"), {
      name: "OpenKeyNativeError", code: "INVALID_GRANT", rotatedRefreshToken: secret, privateJwk: jwk,
    });
    const wrapped = Object.assign(new Error("outer", { cause: sdkError }), { token: secret, privateJwk: jwk });
    const plainObject = { code: "TIMEOUT", message: "slow", rotatedRefreshToken: secret, privateJwk: jwk };
    const messages = [describeAuthFailure(sdkError), describeAuthFailure(wrapped), describeAuthFailure(plainObject),
      describeAuthFailure(new UserFacingError("Sign-in was cancelled.", { cause: sdkError }))];
    const calls = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls];
    warn.mockRestore(); error.mockRestore(); log.mockRestore();

    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      for (const arg of args) expect(typeof arg).toBe("string");
      const text = args.join(" ");
      expect(text).not.toContain(secret);
      expect(text).not.toContain("SYNTHETIC_PRIVATE_D");
    }
    expect(calls.some((args) => args.join(" ").includes("INVALID_GRANT"))).toBe(true);
    for (const message of messages) expect(message).not.toMatch(/SYNTHETIC|exchange failed|outer|slow/);
  });
});
