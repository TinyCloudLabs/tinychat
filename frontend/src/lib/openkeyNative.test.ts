// TC-775 E1 — the Exo native OpenKey sign-in.
//
// The SDK and the node are mocked (O3/O4 are not deployed): OpenKeyNative and
// the handoff deps are fakes that record calls, so the tests pin the flow
// contract — unbound nonce → capabilities → secure-store handoff → activate →
// restore with a read-only provider → verify — plus the flag/platform routing
// and the cancel/deny messages.

import { describe, expect, test } from "bun:test";
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
  secretsAvailable,
  signInNative,
  signOutNative,
  useNativeOpenKey,
  NATIVE_SIGN_IN_CANCELLED_MESSAGE,
  NATIVE_SIGN_IN_DENIED_MESSAGE,
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
function fakeStorage() {
  const saved: Array<{ address: string; record: PersistedSessionData }> = [];
  const storage: ISessionStorage & { saved: typeof saved } = {
    saved,
    save: async (address, record) => {
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
  const flow = {
    order: [] as string[],
    storage: fakeStorage(),
    signInArgs: [] as Flow["signInArgs"],
    nonceCalls: [] as Flow["nonceCalls"],
    activation: [] as Flow["activation"],
    restore: [] as Flow["restore"],
    verify: [] as Flow["verify"],
  } as Flow;
  flow.openkey = {
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
      return { success: true, activated: [SPACE_ID] };
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

describe("native sign-in gate", () => {
  test("runs only on ios/android with the build flag", () => {
    for (const platform of ["ios", "android"] as const) {
      expect(useNativeOpenKey(platform, { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(true);
    }
    // Web and desktop keep the iframe widget even when the flag is set.
    for (const platform of ["web", "tauri"] as const) {
      expect(useNativeOpenKey(platform, { VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(false);
    }
    // The flag alone gates too, whatever the platform.
    for (const platform of ["ios", "android"] as const) {
      expect(useNativeOpenKey(platform, {})).toBe(false);
      expect(useNativeOpenKey(platform, { VITE_EXO_NATIVE_OPENKEY: "false" })).toBe(false);
    }
    expect(nativeOpenKeyEnabled({ VITE_EXO_NATIVE_OPENKEY: "true" })).toBe(true);
  });

  test("test env is web, so secrets stay available by default", () => {
    expect(secretsAvailable()).toBe(true);
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
  test("runs nonce → sign-in → handoff → activate → restore → verify", async () => {
    const flow = makeFlow();
    const result = await signInNative(config, flow.deps);

    expect(flow.order).toEqual(["nonce", "signIn", "activate", "restore", "verify"]);
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
    flow.deps.activateSession = async () => ({ success: false, error: "node unreachable" });
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
});

describe("error message mapping", () => {
  test("maps SDK codes to user-facing copy", () => {
    expect(nativeSignInErrorMessage(new OpenKeyNativeError("USER_CANCELLED", "x"))).toBe(
      NATIVE_SIGN_IN_CANCELLED_MESSAGE,
    );
    expect(nativeSignInErrorMessage(new OpenKeyNativeError("ACCESS_DENIED", "x"))).toBe(
      NATIVE_SIGN_IN_DENIED_MESSAGE,
    );
    expect(nativeSignInErrorMessage(new Error("boom"))).toMatch(/failed/i);
    expect(nativeSignInErrorMessage("boom")).toMatch(/failed/i);
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
    expect(signIn).toContain("if (useNativeOpenKey())");
    expect(signIn).toContain("signInNative(");
    // Native first, the embedded-widget path second — web/desktop never reach it.
    expect(signIn.indexOf("signInNative(")).toBeLessThan(signIn.indexOf("connectWallet("));
  });

  test("signOut calls OpenKeyNative.signOut on the native path", () => {
    const signOut = app.slice(app.indexOf("const signOut = useCallback"), app.indexOf("const isReady"));
    expect(signOut).toContain("signOutNative()");
    expect(signOut.indexOf("useNativeOpenKey()")).toBeLessThan(signOut.indexOf("signOutOpenKeySession("));
  });
});
