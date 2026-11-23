import { afterEach, expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { OpenKeyNativeError, type OpenKeyNative } from "@openkey/sdk-capacitor";
import type { Manifest, PersistedSessionData, TinyCloudWeb } from "@tinycloud/web-sdk";
import manifest from "../../../manifest.json";
import {
  nativePermissions, nativeRenewalServices, resetNativeOpenKeyClientForTests, restoreNativeAtBoot, signInNative,
  type NativeSignInConfig, type NativeSignInDeps, type NativeSignInSession,
} from "./openkeyNative";
import { NativeRenewal } from "./openkeyNativeRenewal";
import { clearSessionAfterHandoff, registerSessionSignedOutHook } from "./sessionSignedOut";
import { fixture, originalEnd } from "./renewalReceipt.fixture";

afterEach(resetNativeOpenKeyClientForTests);

async function phone(admissionStatus = 200) {
  const { record, receipt, lease } = await fixture();
  const calls: string[] = [];
  const requests: unknown[] = [];
  let secure: PersistedSessionData | null = null;
  let current: NativeSignInSession | null = null;
  const effectiveEnd = Math.floor(originalEnd / 1000) + 86_400;
  const host = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/.well-known/tinycloud/node-keys") return Response.json(receipt.receipt.nodeIdentity);
      if (pathname === "/delegate") {
        calls.push("admit");
        expect(request.headers.get("Authorization")).toBe(lease.authorization);
        return Response.json({ activated: [], skipped: [] }, { status: admissionStatus });
      }
      if (pathname === "/api/auth/verify-renewal") {
        calls.push("reissue");
        const body = await request.json();
        expect(body).toMatchObject({
          address: record.address, nonce: "backend-nonce", leaseAuthorization: lease.authorization,
          delegation: { delegationCid: record.tinycloudSession!.delegationCid },
        });
        expect(body.holderProof).toBeTruthy();
        expect(body.statusInvocation).toBeTruthy();
        return Response.json({ token: "renewed", expiresIn: 3_600, address: record.address, renewal: { effectiveEnd } });
      }
      return new Response(null, { status: 404 });
    },
  });
  const origin = host.url.origin;
  const delegation = {
    ...record.tinycloudSession,
    address: record.address, chainId: 1, siwe: "native-siwe", signature: "native-signature",
    expiresAt: record.expiresAt, tinycloudHost: origin, permissions: nativePermissions(manifest as Manifest),
  } as NativeSignInSession["delegation"];
  const leased = { delegation, renewalMode: "leased", renewal: receipt, renewalArrivedAt: performance.now(),
    sessionKey: { privateJwk: {} } } as NativeSignInSession;
  const finite = { delegation, sessionKey: leased.sessionKey } as NativeSignInSession;
  const storage = {
    load: async () => secure,
    save: async (_address: string, data: PersistedSessionData) => { secure = data; },
    clear: async () => { secure = null; },
    exists: () => secure !== null,
    isAvailable: () => true,
    activeAddress: () => current?.delegation.address,
  };
  const issue = (session: NativeSignInSession) => {
    // OpenKey stores the mode and original grant, and only returns the receipt in signIn().
    current = { ...session, renewal: undefined, renewalArrivedAt: undefined };
    return session;
  };
  const signIn = mock(async (options: unknown) => {
    requests.push(options);
    return issue(leased);
  });
  const renew = mock(async () => issue(finite));
  const signOut = mock(async () => { current = null; await storage.clear(); });
  const openkey = {
    signIn, renew, signOut, current: async () => current, sessionStorageAdapter: () => storage,
  } as unknown as OpenKeyNative;
  const activeNodeIdentity = async () => ({ origin, nodeDid: receipt.receipt.nodeIdentity.nodeDid });
  const config: NativeSignInConfig = { backendUrl: origin, tinycloudHost: origin, env: { VITE_OPENKEY_NATIVE_CLIENT_ID: "test" } };
  const deps: NativeSignInDeps = {
    createOpenKeyNative: () => openkey,
    requestNonce: async () => "backend-nonce",
    loadManifest: async () => manifest as Manifest,
    activateSession: async () => {
      calls.push("activate");
      return { success: true, status: 200, activated: [], skipped: [] };
    },
    restoreSession: async (address, options) => {
      const candidateStorage = options.sessionStorage as {
        loadRenewalCandidate?: (address: string) => Promise<{ status: string; data: PersistedSessionData }>;
      };
      const restoreLease = async (authorization: string) => {
        expect(authorization).toBe(lease.authorization);
        const candidate = await candidateStorage.loadRenewalCandidate?.(address);
        expect(candidate?.status).toBe("renewal-candidate");
        expect(candidate?.data.tinycloudSession?.delegationCid).toBe(delegation.delegationCid);
        calls.push("restore-lease");
        return { status: "restored" as const };
      };
      if (options.renewalLeaseAuthorization) await restoreLease(options.renewalLeaseAuthorization);
      const tcw = {
        activeNodeIdentity, restoreSessionWithRenewal: restoreLease, cleanup: () => undefined,
        kv: { list: async () => { calls.push("read"); return { ok: true }; } },
        session: () => delegation, accountAuthorizationCid: () => delegation.delegationCid,
        sessionDid: "did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z",
        signSessionBytes: async (bytes: Uint8Array) => ed25519.sign(bytes, new Uint8Array(32).fill(7)),
      } as unknown as TinyCloudWeb;
      return { status: "restored", tcw };
    },
    verifySession: async () => ({ token: "signed", expiresIn: 3_600, address: record.address }),
    readSignOutFence: () => false,
    activationMarker: { read: () => null, write: () => undefined },
  };
  return { host, config, deps, leased, finite, receipt, requests, calls, issue, signIn, signOut, renew,
    openkey, storage, effectiveEnd };
}

test("the phone admits the exact consent CID, reissues its bearer and boots through the secure receipt after expiry", async () => {
  const p = await phone();
  const clock = Date.now;
  let renewal: NativeRenewal | undefined;
  try {
    const signed = await signInNative(p.config, undefined, p.deps);
    expect(p.requests).toMatchObject([{ ttlSeconds: 3_600, renewal: { version: 1, leaseLifetimeSeconds: 7_776_000, purpose: "standing" } }]);
    expect(p.calls).toEqual(["activate", "admit"]);
    expect(signed.leaseAdmissionUnavailable).toBe(false);
    expect(await p.storage.load()).toMatchObject({ admittedRenewal: p.receipt });
    expect(signed.verified.token).toBe("signed");

    Date.now = () => originalEnd + 1000;
    const boot = await restoreNativeAtBoot(p.config, false, p.deps);
    expect(boot).toMatchObject({ kind: "restored", effectiveEnd: p.effectiveEnd, verified: { token: "renewed" } });
    expect(p.calls).toEqual(["activate", "admit", "restore-lease", "read", "reissue"]);

    const services = await nativeRenewalServices(p.config, p.openkey, p.deps, signed.session);
    const setSession = mock(() => {});
    const sessionStore = { setSession, clear: mock(() => {}) };
    renewal = new NativeRenewal({
      openkey: p.openkey, tcw: signed.tcw as TinyCloudWeb, session: signed.session, sessionStore,
      ...services, saveBusy: () => false, onTerminal: () => { throw new Error("lease should work"); }, onStorage: () => {},
    });
    const handoff = mock(async () => true);
    const active = renewal;
    const releaseHook = registerSessionSignedOutHook(sessionStore, handoff, undefined, undefined, () => active.renewNow());
    try {
      await expect(clearSessionAfterHandoff(sessionStore)).rejects.toThrow("Try your request again.");
      expect(handoff).not.toHaveBeenCalled();
      expect(sessionStore.clear).not.toHaveBeenCalled();
    } finally {
      releaseHook();
    }
    expect(setSession).toHaveBeenCalledWith("renewed", 3_600, signed.address);
    expect(p.calls.slice(-3)).toEqual(["restore-lease", "read", "reissue"]);
    expect(p.renew).not.toHaveBeenCalled();

    await p.openkey.signOut();
    expect(await p.storage.load()).toBeNull();
  } finally {
    renewal?.stop();
    Date.now = clock;
    p.host.stop(true);
  }
});

test("refused admission keeps the signed window and never falls back to a rotating grant", async () => {
  const p = await phone(403);
  const clock = Date.now;
  try {
    const signed = await signInNative(p.config, undefined, p.deps);
    expect(signed.leaseAdmissionUnavailable).toBe(true);
    expect(await p.storage.load()).not.toHaveProperty("admittedRenewal");
    expect(await restoreNativeAtBoot(p.config, true, p.deps)).toMatchObject({ kind: "restored" });
    Date.now = () => originalEnd + 1000;
    const boot = await restoreNativeAtBoot(p.config, false, p.deps);
    expect(boot.kind).toBe("terminal");
    if (boot.kind === "terminal") await boot.revoke();
    expect(p.renew).not.toHaveBeenCalled();
    expect(await p.storage.load()).toBeNull();
  } finally {
    Date.now = clock;
    p.host.stop(true);
  }
});

test("only the old PAR rejection retries with finite access and preserves rotation", async () => {
  const p = await phone();
  try {
    p.signIn.mockImplementationOnce(async (options) => {
      p.requests.push(options);
      throw new OpenKeyNativeError("SERVER", "PAR rejected the extra member", 400, "invalid_authorization_details");
    }).mockImplementationOnce(async (options) => {
      p.requests.push(options);
      return p.issue(p.finite);
    });
    await signInNative(p.config, undefined, p.deps);
    expect(p.requests).toHaveLength(2);
    expect(p.requests[0]).toHaveProperty("renewal");
    expect(p.requests[1]).not.toHaveProperty("renewal");
    expect(await restoreNativeAtBoot(p.config, false, p.deps)).toMatchObject({ kind: "restored" });
    expect(p.renew).toHaveBeenCalledTimes(1);
    expect(p.calls).not.toContain("admit");
  } finally {
    p.host.stop(true);
  }
});

test("the build flag omits the renewal ask and an OpenKey setup failure never downgrades consent", async () => {
  const p = await phone();
  try {
    p.signIn.mockImplementationOnce(async (options) => {
      p.requests.push(options);
      return p.issue(p.finite);
    }).mockImplementationOnce(async (options) => {
      p.requests.push(options);
      throw new OpenKeyNativeError("TEMPORARILY_UNAVAILABLE", "Nothing was approved", 503, "renewal_failed");
    });
    await signInNative({ ...p.config, env: { ...p.config.env, VITE_OPENKEY_NATIVE_RENEWAL: "false" } }, undefined, p.deps);
    expect(p.requests[0]).not.toHaveProperty("renewal");
    await expect(signInNative(p.config, undefined, p.deps)).rejects.toThrow();
    expect(p.signIn).toHaveBeenCalledTimes(2);
  } finally {
    p.host.stop(true);
  }
});
