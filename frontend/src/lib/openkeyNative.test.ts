// TC-775 E1 — the Exo native OpenKey sign-in.
//
// The SDK and the node are mocked (O3/O4 are not deployed): OpenKeyNative and
// the handoff deps are fakes that record calls, so the tests pin the flow
// contract — unbound nonce → capabilities → secure-store handoff → activate →
// restore with a read-only provider → verify — plus the flag/platform routing
// and the cancel/deny messages.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenKeyNativeError } from "@openkey/sdk-capacitor";
import type {
  NativeSession,
  OpenKeyNative,
  TinyCloudDelegation,
} from "@openkey/sdk-capacitor";
import type { ISessionStorage, PersistedSessionData } from "@tinycloud/web-sdk";
import type { Manifest } from "@tinycloud/sdk-core";

import {
  nativeOpenKeyEnabled,
  nativePermissions,
  nativeSignInErrorMessage,
  isNativeOpenKeySession,
  isNativeOpenKeySignIn,
  logNativeOpenKeyError,
  nativeSessionWasActive,
  isNativeStorageError,
  resetNativeOpenKeyClientForTests,
  retireNativeSessionAtBoot,
  secretsAvailable,
  setNativeSessionActive,
  signInNative,
  signOutNative,
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
  signInArgs: { capabilities: unknown; siweNonce?: string }[];
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
    signIn: async (args: { capabilities: unknown; siweNonce?: string }) => {
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
  tinycloudHosts: [HOST],
  env: { VITE_OPENKEY_NATIVE_CLIENT_ID: "exo-native" },
};

afterEach(() => {
  setNativeSessionActive(false);
  resetNativeOpenKeyClientForTests();
});

describe("native sign-in gate", () => {
  test("runs only on ios/android with the build flag", () => {
    for (const platform of ["ios", "android"] as const) {
      expect(isNativeOpenKeySignIn(platform, { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(true);
    }
    // Web and desktop keep the iframe widget even when the flag is set.
    for (const platform of ["web", "tauri"] as const) {
      expect(isNativeOpenKeySignIn(platform, { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(false);
    }
    // The flag alone gates too, whatever the platform.
    for (const platform of ["ios", "android"] as const) {
      expect(isNativeOpenKeySignIn(platform, {})).toBe(false);
      expect(isNativeOpenKeySignIn(platform, { VITE_EXO_NATIVE_OPENKEY: "false" })).toBe(false);
    }
    expect(nativeOpenKeyEnabled({ VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(true);
  });

  test("test env is web, so secrets stay available by default", () => {
    expect(secretsAvailable()).toBe(true);
  });

  test("a restored widget session keeps vault access even with native sign-in enabled", () => {
    expect(isNativeOpenKeySignIn("android", { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(true);
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
    const result = await signInNative(config, flow.deps);

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

  test("an already active space with no new activation restores and verifies", async () => {
    const flow = makeFlow();
    const activate = flow.deps.activateSession;
    flow.deps.activateSession = async (host, header) => ({
      ...await activate(host, header), activated: [], skipped: [],
    });

    const result = await signInNative(config, flow.deps);
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
    try { await signInNative(config, flow.deps); } catch (error) { caught = error; }
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
      await signInNative(config, makeFlow().deps);
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
    await expect(signInNative(config, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_CANCELLED_MESSAGE);
    expect(flow.verify).toEqual([]);
    expect(flow.storage.saved).toEqual([]);
  });

  test("ACCESS_DENIED reports a denial and never reaches verify", async () => {
    const flow = makeFlow();
    flow.openkey.signIn = async () => {
      throw new OpenKeyNativeError("ACCESS_DENIED", "user denied");
    };
    await expect(signInNative(config, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_DENIED_MESSAGE);
    expect(flow.verify).toEqual([]);
  });

  test("an unspecified failure gets the generic message", async () => {
    const flow = makeFlow();
    flow.deps.activateSession = async () => ({ success: false, status: 503, error: "node unreachable" });
    await expect(signInNative(config, flow.deps)).rejects.toThrow(/failed/i);
    expect(flow.verify).toEqual([]);
  });

  test("a delegation for another TinyCloud node is refused", async () => {
    const flow = makeFlow();
    flow.openkey.signIn = async () => ({
      tokens: { accessToken: "a", refreshToken: "r" },
      delegation: { ...delegation, tinycloudHost: "https://other.example" },
      sessionKey,
    });
    await expect(signInNative(config, flow.deps)).rejects.toThrow();
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
      await expect(signInNative(config, flow.deps)).rejects.toThrow(
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
    await expect(signInNative(config, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_DENIED_MESSAGE);
    expect(flow.order).toEqual(["nonce"]);
    expect(await flow.openkey.current()).not.toBeNull();
  });

  test("a failed immediate renewal is handled by the SDK without another revoke", async () => {
    const flow = makeFlow();
    flow.openkey.signIn = async () => { throw new OpenKeyNativeError("NETWORK", "renew failed"); };
    await expect(signInNative(config, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_NETWORK_MESSAGE);
    expect(flow.order).toEqual(["nonce"]);
  });

  test("a failed cleanup revoke leaves the handoff error visible", async () => {
    const flow = makeFlow();
    flow.deps.verifySession = async () => { throw new Error("SIWE verification failed: invalid_nonce"); };
    flow.openkey.signOut = async () => { throw new OpenKeyNativeError("NETWORK", "offline"); };
    await expect(signInNative(config, flow.deps)).rejects.toThrow(NATIVE_SIGN_IN_NONCE_MESSAGE);
  });
});

describe("native boot", () => {
  test("constructs the client and revokes a surviving session before widget restore", async () => {
    const flow = makeFlow();
    let constructed = 0;
    flow.openkey.current = async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation, sessionKey });
    const hadSession = await retireNativeSessionAtBoot(config, {
      createOpenKeyNative: () => { constructed++; return flow.openkey; },
    });
    expect(hadSession).toBe(true);
    expect(constructed).toBe(1);
    expect(flow.order).toEqual(["signOut"]);
  });

  test("constructs the client even without a current session so pending revokes retry", async () => {
    const flow = makeFlow();
    let constructed = 0;
    expect(await retireNativeSessionAtBoot(config, {
      createOpenKeyNative: () => { constructed++; return flow.openkey; },
    })).toBe(false);
    expect(constructed).toBe(1);
    expect(flow.order).toEqual([]);
  });

  test("reuses the same SDK client for boot, sign-in and sign-out", async () => {
    const flow = makeFlow();
    let constructed = 0;
    const createOpenKeyNative = () => { constructed++; return flow.openkey; };
    expect(await retireNativeSessionAtBoot(config, { createOpenKeyNative })).toBe(false);
    await signInNative(config, { ...flow.deps, createOpenKeyNative });
    await signOutNative({ env: config.env, createOpenKeyNative });
    expect(constructed).toBe(1);
    expect(flow.order.at(-1)).toBe("signOut");
  });
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

  test("logs only an SDK code, and a plain error message", () => {
    const prior = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => { lines.push(line); };
    try {
      const sdkError = new OpenKeyNativeError("SERVER", "secret detail");
      sdkError.rotatedRefreshToken = "secret refresh token";
      logNativeOpenKeyError("sign-in", sdkError);
      logNativeOpenKeyError("sign-out", new OpenKeyNativeError("STORAGE", "secret storage detail"));
      logNativeOpenKeyError("verify", new Error("verification failed"));
    } finally {
      console.warn = prior;
    }
    expect(lines).toEqual([
      "[OpenKey native] sign-in: SERVER",
      "[OpenKey native] sign-out: STORAGE",
      "[OpenKey native] verify: verification failed",
    ]);
  });

  test("storage sign-out failures keep the session available for retry", () => {
    expect(isNativeStorageError(new OpenKeyNativeError("STORAGE", "read failed"))).toBe(true);
    expect(isNativeStorageError(new OpenKeyNativeError("NETWORK", "offline"))).toBe(false);
    expect(NATIVE_SIGN_OUT_STORAGE_WARNING).toMatch(/session may still be stored/i);
    expect(NATIVE_SIGN_OUT_STORAGE_WARNING).toMatch(/try signing out again/i);
  });
});

describe("native sign-out", () => {
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
    expect(signOut.indexOf("if (isNativeStorageError(caught))")).toBeLessThan(signOut.indexOf("sessionStoreRef.current.clear()"));
  });

  test("boot retires native grants before trying the legacy widget restore", () => {
    const boot = app.slice(app.indexOf("const restoreSession = useCallback"), app.indexOf("useEffect(() => {\n    if (restoredRef.current)"));
    expect(boot.indexOf("retireNativeSessionAtBoot(")).toBeLessThan(boot.indexOf("restorePersistedSession("));
    expect(boot).toContain("if (wasNative)");
  });
});
