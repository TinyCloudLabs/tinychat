// Native sign-in for an owner the SDK refuses because they have no TinyCloud account yet: the sign-in stops on the
// account-setup message, nothing is verified with the backend, and the OpenKey grant that was just given is revoked.
import { afterEach, expect, test } from "bun:test";
import type { NativeSession, OpenKeyNative, TinyCloudDelegation } from "@openkey/sdk-capacitor";
import type { ISessionStorage, PersistedSessionData } from "@tinycloud/web-sdk";
import type { Manifest } from "@tinycloud/sdk-core";
import APP_MANIFEST from "../../../manifest.json";
import { ACCOUNT_SETUP_MESSAGE, AccountSetupRequiredError } from "./accountSetup";
import { UserFacingError } from "./authErrors";
import {
  nativePermissions, resetNativeOpenKeyClientForTests, setNativeSessionActive, signInNative, type NativeSignInDeps,
} from "./openkeyNative";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const HOST = "https://node.tinycloud.xyz";
const SPACE_ID = `did:pkh:eip155:1:${ADDRESS}/applications`;

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
  permissions: nativePermissions(APP_MANIFEST as unknown as Manifest),
  tinycloudHost: HOST,
};
const sessionKey = {
  did: "did:key:z6MkTest",
  keyId: "did:key:z6MkTest#z6MkTest",
  publicJwk: { kty: "OKP", crv: "Ed25519", x: "x" },
  privateJwk: { kty: "OKP", crv: "Ed25519", x: "x", d: "private" },
} as NativeSession["sessionKey"];
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

function flow(checkAccount?: NativeSignInDeps["checkAccount"]) {
  const order: string[] = [];
  const storage: ISessionStorage = {
    save: async (_address: string, _record: PersistedSessionData) => { order.push("save"); },
    load: async () => null,
    clear: async () => {},
    exists: () => true,
    isAvailable: () => true,
    activeAddress: () => ADDRESS,
  };
  const openkey = {
    current: async () => null,
    signOut: async () => { order.push("signOut"); },
    signIn: async () => ({ tokens: { accessToken: "a", refreshToken: "r" }, delegation, sessionKey }),
    sessionStorageAdapter: () => storage,
  } as unknown as OpenKeyNative;
  const tcw = { fake: true, cleanup: () => { order.push("cleanup"); } };
  const deps: NativeSignInDeps = {
    createOpenKeyNative: () => openkey,
    requestNonce: async () => "backend-nonce-1",
    loadManifest: async () => APP_MANIFEST as unknown as Manifest,
    activateSession: async () => ({ success: true, status: 200, activated: [SPACE_ID], skipped: [], commitEventCid: "bafyreceipt" }),
    restoreSession: async () => ({ tcw, status: "restored" }) as never,
    verifySession: async () => { order.push("verify"); return { token: "jwt", expiresIn: 3600, address: ADDRESS }; },
    ...(checkAccount ? { checkAccount: async (client) => { order.push("check"); await checkAccount(client); } } : {}),
  };
  return { deps, order, tcw };
}

test("an owner the SDK refuses reads the account-setup message and is left signed out", async () => {
  const { deps, order, tcw } = flow(async () => { throw new AccountSetupRequiredError(); });
  const failure = await signInNative(config, undefined, deps).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(UserFacingError);
  expect((failure as Error).message).toBe(ACCOUNT_SETUP_MESSAGE);
  // The check runs before the backend session is verified; the session is dropped, then the OpenKey grant revoked.
  expect(order).toEqual(["save", "check", "cleanup", "signOut"]);
  expect(tcw).toBeDefined();
});

test("the SDK's own refusal, thrown from the check, reads the same message", async () => {
  const { deps } = flow(async () => { throw Object.assign(new Error("setup"), { name: "AccountSetupRequiredError", code: "ACCOUNT_SETUP_REQUIRED" }); });
  const failure = await signInNative(config, undefined, deps).catch((error: unknown) => error);
  expect((failure as Error).message).toBe(ACCOUNT_SETUP_MESSAGE);
});

test("an owner with an account signs in: the check passes and the backend session is verified after it", async () => {
  const { deps, order } = flow(async () => {});
  const result = await signInNative(config, undefined, deps);
  expect(result.verified.address).toBe(ADDRESS);
  expect(order).toEqual(["save", "check", "verify"]);
});

test("a check that fails for any other reason does not turn into the account-setup message", async () => {
  const { deps } = flow(async () => { throw new Error("storage is full"); });
  const failure = await signInNative(config, undefined, deps).catch((error: unknown) => error);
  expect((failure as Error).message).not.toBe(ACCOUNT_SETUP_MESSAGE);
});
