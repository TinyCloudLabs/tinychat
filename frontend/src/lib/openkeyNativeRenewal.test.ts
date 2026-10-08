import { describe, expect, test } from "bun:test";
import { OpenKeyNativeError, type NativeSession, type OpenKeyNative } from "@openkey/sdk-capacitor";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { NativeRenewal, guardNativeTinyCloudCalls, nativeRenewAt, nativeRetryDelay, terminalRenewalError } from "./openkeyNativeRenewal";

const issue = 1_000_000;
function session(cid: string, issued = issue, ttl = 300_000): NativeSession {
  return {
    tokens: { accessToken: "access", refreshToken: cid },
    sessionKey: { did: "did:key:test", keyId: "did:key:test#key", publicJwk: { kty: "OKP", crv: "Ed25519", x: "x" }, privateJwk: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" } },
    delegation: { address: "0x1111111111111111111111111111111111111111", chainId: 1, spaceId: "space", verificationMethod: "did:key:test#key", siwe: "siwe", signature: "signature", delegationHeader: { Authorization: cid }, delegationCid: cid, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + ttl).toISOString(), permissions: [], tinycloudHost: "https://node.example" },
  } as NativeSession;
}

function harness(now: number, original = session("old")) {
  let time = now;
  let installed = original.delegation.delegationCid;
  let busy = false;
  let release!: () => void;
  let idle = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const calls: string[] = [];
  const raw = {
    restoreSession: async () => ({ status: "restored" }),
    kv: { put: async () => { calls.push(installed!); return { ok: true }; } },
  } as unknown as TinyCloudWeb;
  const openkey = { current: async () => original, renew: async () => { events.push("renew"); return session("new", issue + 225_000); } } as unknown as OpenKeyNative;
  const renewal = new NativeRenewal({
    openkey, tcw: raw, session: original,
    sessionStore: { setSession: () => { events.push("jwt"); } },
    requestNonce: async () => "nonce", verifySession: async () => ({ token: "jwt", expiresIn: 86_400, address: original.delegation.address! }),
    install: async (next, live) => { expect(live).toBe(raw); installed = next.delegation.delegationCid; events.push("swap"); },
    onTerminal: () => events.push("terminal"), onStorage: () => events.push("storage"),
    saveBusy: () => busy, whenSaveIdle: () => idle,
    recoverPendingSave: () => events.push("retry pending"), now: () => time, jitter: () => 0,
  });
  return { renewal, raw, events, calls, openkey,
    setTime: (value: number) => { time = value; },
    setBusy: (value: boolean) => { busy = value; if (!value) { release(); idle = new Promise<void>((resolve) => { release = resolve; }); } },
  };
}

describe("native renewal", () => {
  test("lead is bounded by lifetime for 300 s and 3600 s grants", () => {
    expect(nativeRenewAt(session("short"), 0)).toBe(issue + 225_000);
    expect(nativeRenewAt(session("long", issue, 3_600_000), 0)).toBe(issue + 3_000_000);
  });

  test("live handoff changes the CID used by a TinyCloud invocation after the old grant expires", async () => {
    const h = harness(issue + 225_000);
    const guarded = guardNativeTinyCloudCalls(h.raw, h.renewal);
    await guarded.kv.put("key", "value");
    expect(h.events).toEqual(["renew", "swap", "jwt"]);
    h.setTime(issue + 301_000);
    await guarded.kv.put("key", "later");
    expect(h.calls).toEqual(["new", "new"]);
    h.renewal.stop();
  });

  test("waits for a save, and a forced swap retries after its guard settles", async () => {
    const deferred = harness(issue + 225_000);
    deferred.setBusy(true);
    const pending = deferred.renewal.check();
    await Promise.resolve(); await Promise.resolve();
    expect(deferred.events).not.toContain("swap");
    deferred.setBusy(false);
    await pending;
    expect(deferred.events).toContain("swap");
    deferred.renewal.stop();

    const forced = harness(issue + 240_000);
    forced.setBusy(true);
    await forced.renewal.check();
    expect(forced.events).toContain("swap");
    expect(forced.events).not.toContain("retry pending");
    forced.setBusy(false);
    await Promise.resolve(); await Promise.resolve();
    expect(forced.events).toContain("retry pending");
    forced.renewal.stop();
  });

  test("retry policy honors Retry-After, exponential backoff, and terminal codes", () => {
    expect(nativeRetryDelay(new OpenKeyNativeError("RENEWAL_TOO_SOON", "too soon", 429, "renewal_too_soon", 7), 0, 70_000)).toBe(7_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("TEMPORARILY_UNAVAILABLE", "busy", 503, "temporarily_unavailable", 2), 0, 70_000)).toBe(2_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("NETWORK", "offline"), 0, 100_000)).toBe(15_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("SERVER", "rate limited", 429), 0, 100_000)).toBe(15_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("NETWORK", "offline"), 2, 100_000)).toBe(50_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("NETWORK", "offline"), 0, -1)).toBeNull();
    expect(nativeRetryDelay(new OpenKeyNativeError("RENEWAL_CONFLICT", "raced"), 0, 100_000)).toBeNull();
    expect(terminalRenewalError(new OpenKeyNativeError("RENEWAL_CONFLICT", "SDK reload and retry failed"))).toBe(true);
    for (const code of ["INVALID_GRANT", "CONSENT_REQUIRED", "ACCESS_DENIED", "SPACE_UNAVAILABLE"] as const) {
      expect(terminalRenewalError(new OpenKeyNativeError(code, "ended"))).toBe(true);
    }
    expect(terminalRenewalError(new OpenKeyNativeError("STORAGE", "failed"))).toBe(false);
  });

  test("transient failures wait for backoff; terminal and storage messages diverge", async () => {
    const transient = harness(issue + 225_000);
    let renews = 0;
    transient.openkey.renew = async () => {
      renews++;
      throw new OpenKeyNativeError("NETWORK", "offline");
    };
    await transient.renewal.check();
    await transient.renewal.check();
    expect(renews).toBe(1);
    transient.setTime(issue + 240_000);
    await transient.renewal.check();
    expect(renews).toBe(2);
    transient.setTime(issue + 301_000);
    await expect(transient.renewal.check()).rejects.toThrow("temporarily unavailable");
    transient.renewal.stop();

    const terminal = harness(issue + 225_000);
    terminal.openkey.renew = async () => { throw new OpenKeyNativeError("CONSENT_REQUIRED", "withdrawn"); };
    await terminal.renewal.check();
    expect(terminal.events).toEqual(["terminal"]);

    const storage = harness(issue + 225_000);
    storage.openkey.renew = async () => { throw new OpenKeyNativeError("STORAGE", "secure store failed"); };
    await storage.renewal.check();
    expect(storage.events).toEqual(["storage"]);
    storage.renewal.stop();
  });

  test("a failed live restore retries the persisted delegation without rotating again", async () => {
    const old = session("old");
    let now = issue + 225_000;
    let renews = 0;
    let installs = 0;
    const renewal = new NativeRenewal({
      openkey: { current: async () => old, renew: async () => { renews++; return session("new", issue + 225_000); } } as unknown as OpenKeyNative,
      tcw: {} as TinyCloudWeb, session: old,
      sessionStore: { setSession: () => {} }, requestNonce: async () => "nonce",
      verifySession: async () => ({ token: "jwt", expiresIn: 60, address: old.delegation.address! }),
      install: async () => { if (++installs === 1) throw Object.assign(new Error("restore failed"), { code: "HANDOFF_RETRY" }); },
      onTerminal: () => {}, onStorage: () => {}, now: () => now, jitter: () => 0,
    });
    await renewal.check();
    expect([renews, installs]).toEqual([1, 1]);
    now += 15_000;
    await renewal.check();
    expect([renews, installs]).toEqual([1, 2]);
    renewal.stop();
  });
});
