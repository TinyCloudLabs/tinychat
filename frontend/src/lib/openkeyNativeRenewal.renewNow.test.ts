import { afterEach, describe, expect, test } from "bun:test";
import { OpenKeyNativeError, type NativeSession, type OpenKeyNative } from "@openkey/sdk-capacitor";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { NativeRenewal } from "./openkeyNativeRenewal";
import { registerSessionSignedOutHook, renewSessionOnce } from "./sessionSignedOut";

// A 401 on the phone app asks for one renewal at once (model selection, through renewSessionOnce), not at the
// scheduled time; OpenKey's minimum renewal interval and a failed renewal's retry wait still hold.

const ISSUED = 1_000_000;
const HOUR = 3_600_000;
function session(cid: string, issued: number): NativeSession {
  return {
    tokens: { accessToken: "access", refreshToken: cid },
    sessionKey: { did: "did:key:test", keyId: "did:key:test#key", publicJwk: { kty: "OKP", crv: "Ed25519", x: "x" }, privateJwk: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" } },
    delegation: { address: "0x1111111111111111111111111111111111111111", chainId: 1, spaceId: "space", verificationMethod: "did:key:test#key", siwe: "siwe", signature: "signature", delegationHeader: { Authorization: cid }, delegationCid: cid, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + HOUR).toISOString(), permissions: [], tinycloudHost: "https://node.example" },
  } as NativeSession;
}

const live: NativeRenewal[] = [];
afterEach(() => { for (const renewal of live.splice(0)) renewal.stop(); });

function harness(now: number, renew?: () => Promise<NativeSession>) {
  let time = now;
  let bearer: string | null = "refused-jwt";
  const events: string[] = [];
  const original = session("old", ISSUED);
  const renewal = new NativeRenewal({
    openkey: {
      current: async () => original,
      renew: async () => { events.push("renew"); return renew ? renew() : session("new", time); },
    } as unknown as OpenKeyNative,
    tcw: {} as TinyCloudWeb, session: original,
    sessionStore: { setSession: (token: string) => { bearer = token; events.push("jwt"); } },
    requestNonce: async () => "nonce",
    verifySession: async () => ({ token: "renewed-jwt", expiresIn: 86_400, address: original.delegation.address! }),
    install: async () => { events.push("install"); },
    onTerminal: () => events.push("terminal"), onStorage: () => events.push("storage"), onUnavailable: () => events.push("unavailable"),
    saveBusy: () => false, whenSaveIdle: async () => {}, recoverPendingSave: () => {}, now: () => time, jitter: () => 0,
  });
  live.push(renewal);
  const sessionStore = { getToken: () => bearer, isExpired: () => false, clear: () => { bearer = null; } };
  return { renewal, events, sessionStore, setTime: (value: number) => { time = value; } };
}

describe("renewing a refused native session", () => {
  test("renews at once, long before the scheduled renewal that check() waits for", async () => {
    const h = harness(ISSUED + 120_000);
    await h.renewal.check(true);
    expect(h.events).toEqual([]);
    await h.renewal.renewNow();
    expect(h.events).toEqual(["renew", "install", "jwt"]);
  });

  test("a 401 handed to renewSessionOnce gets the renewed bearer", async () => {
    const h = harness(ISSUED + 120_000);
    const unregister = registerSessionSignedOutHook(h.sessionStore, async () => true, undefined, () => h.renewal.renewNow());
    try {
      expect(await renewSessionOnce(h.sessionStore, "refused-jwt")).toBe("renewed-jwt");
      expect(h.events.filter((event) => event === "renew")).toEqual(["renew"]);
    } finally { unregister(); }
  });

  test("inside OpenKey's minimum renewal interval it renews nothing, and the 401 has no new bearer", async () => {
    const h = harness(ISSUED + 30_000);
    const unregister = registerSessionSignedOutHook(h.sessionStore, async () => true, undefined, () => h.renewal.renewNow());
    try {
      expect(await renewSessionOnce(h.sessionStore, "refused-jwt")).toBeNull();
      expect(h.events).toEqual([]);
    } finally { unregister(); }
  });

  test("a renewal OpenKey refused as too soon is not asked again before its retry time", async () => {
    const h = harness(ISSUED + 120_000, async () => { throw new OpenKeyNativeError("RENEWAL_TOO_SOON", "too soon", 429, "renewal_too_soon", 30); });
    await h.renewal.renewNow();
    expect(h.events).toEqual(["renew", "unavailable"]);
    h.setTime(ISSUED + 140_000);
    await h.renewal.renewNow();
    expect(h.events).toEqual(["renew", "unavailable"]);
  });

  test("overlapping requests share one renewal", async () => {
    const h = harness(ISSUED + 120_000);
    await Promise.all([h.renewal.renewNow(), h.renewal.renewNow()]);
    expect(h.events).toEqual(["renew", "install", "jwt"]);
  });
});
