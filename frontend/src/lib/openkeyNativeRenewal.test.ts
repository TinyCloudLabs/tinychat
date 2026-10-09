import { describe, expect, test } from "bun:test";
import { OpenKeyNativeError, type NativeSession, type OpenKeyNative } from "@openkey/sdk-capacitor";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { NativeRenewal, guardNativeTinyCloudCalls, nativeRenewAt, nativeRetryDelay, terminalRenewalError } from "./openkeyNativeRenewal";
import { putAudio } from "./audio/audioStore";

const issue = 1_000_000;
function session(cid: string, issued = issue, ttl = 300_000): NativeSession {
  return {
    tokens: { accessToken: "access", refreshToken: cid },
    sessionKey: { did: "did:key:test", keyId: "did:key:test#key", publicJwk: { kty: "OKP", crv: "Ed25519", x: "x" }, privateJwk: { kty: "OKP", crv: "Ed25519", x: "x", d: "d" } },
    delegation: { address: "0x1111111111111111111111111111111111111111", chainId: 1, spaceId: "space", verificationMethod: "did:key:test#key", siwe: "siwe", signature: "signature", delegationHeader: { Authorization: cid }, delegationCid: cid, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(issued + ttl).toISOString(), permissions: [], tinycloudHost: "https://node.example" },
  } as NativeSession;
}

function harness(now: number, original = session("old"), onUnavailable?: (message: string) => void, verify?: () => Promise<{ token: string; expiresIn: number; address: string }>) {
  let time = now;
  let installed = original.delegation.delegationCid;
  let busy = false;
  let release!: () => void;
  let idle = new Promise<void>((resolve) => { release = resolve; });
  const events: string[] = [];
  const calls: string[] = [];
  const graph = () => {
    let retired = false;
    return {
      retire: () => { retired = true; },
      kv: {
        put: async () => { if (retired) throw new Error("Service graph has been retired by session replacement."); calls.push(installed!); return { ok: true }; },
        list: async () => { if (retired) throw new Error("Service graph has been retired by session replacement."); return { ok: true, data: { keys: [], truncated: false } }; },
        withPrefix(prefix: string) { const service = this; return { put: (key: string) => service.put(prefix + key) }; },
      },
      sql: {
        db(_name: string) { return {
          query: async () => { if (retired) throw new Error("Service graph has been retired by session replacement."); return installed; },
          migrations: { apply: async () => { if (retired) throw new Error("Service graph has been retired by session replacement."); return installed; } },
        }; },
      },
    };
  };
  let live = graph();
  const raw = {
    get kv() { return live.kv; },
    get sql() { return live.sql; },
    restoreSession: async () => {
      live.retire();
      live = graph();
      return { status: "restored" };
    },
  } as unknown as TinyCloudWeb;
  const openkey = { current: async () => original, renew: async () => { events.push("renew"); return session("new", issue + 225_000); } } as unknown as OpenKeyNative;
  const renewal = new NativeRenewal({
    openkey, tcw: raw, session: original,
    sessionStore: { setSession: () => { events.push("jwt"); } },
    requestNonce: async () => "nonce", verifySession: verify ?? (async () => ({ token: "jwt", expiresIn: 86_400, address: original.delegation.address! })),
    install: async (next, live) => { expect(live).toBe(raw); installed = next.delegation.delegationCid; await live.restoreSession(original.delegation.address!); events.push("swap"); },
    onTerminal: () => events.push("terminal"), onStorage: () => events.push("storage"),
    onUnavailable,
    saveBusy: () => busy, whenSaveIdle: () => idle,
    recoverPendingSave: () => events.push("retry pending"), now: () => time, jitter: () => 0,
  });
  return { renewal, raw, events, calls, openkey,
    setTime: (value: number) => { time = value; },
    setBusy: (value: boolean) => { busy = value; if (!value) { release(); idle = new Promise<void>((resolve) => { release = resolve; }); } },
  };
}

describe("native renewal", () => {
  test("retired in-flight parts replay, but uncertain SQL appends do not", async () => {
    let finishPart!: (value: unknown) => void;
    let finishBatch!: (value: unknown) => void;
    let partStarted!: () => void;
    let batchStarted!: () => void;
    const atPart = new Promise<void>((resolve) => { partStarted = resolve; });
    const atBatch = new Promise<void>((resolve) => { batchStarted = resolve; });
    const old = {
      kv: { put: () => { partStarted(); return new Promise((resolve) => { finishPart = resolve; }); } },
      sql: { db: () => ({ batch: () => { batchStarted(); return new Promise((resolve) => { finishBatch = resolve; }); } }) },
    };
    let newPartCalls = 0;
    let newBatchCalls = 0;
    const next = {
      kv: { put: async () => { newPartCalls++; return { ok: true }; } },
      sql: { db: () => ({ batch: async () => { newBatchCalls++; return { ok: true }; } }) },
    };
    let live: typeof old | typeof next = old;
    const raw = { get kv() { return live.kv; }, get sql() { return live.sql; } } as unknown as TinyCloudWeb;
    const guarded = guardNativeTinyCloudCalls(raw, { check: async () => {} } as NativeRenewal);
    const part = guarded.kv.put("audio/one/p/0", new Uint8Array([1]));
    const batch = guarded.sql.db("notes").batch([{ sql: "INSERT INTO messages ..." }]);
    await Promise.all([atPart, atBatch]);
    live = next;
    finishPart({ ok: false, error: { code: "ABORTED", message: "Request was aborted.", service: "kv" } });
    finishBatch({ ok: false, error: { code: "NETWORK_ERROR", message: "Service graph has been retired by session replacement.", service: "sql" } });
    expect((await part).ok).toBe(true);
    expect(await batch).toMatchObject({ ok: false, error: { code: "NETWORK_ERROR" } });
    expect(newPartCalls).toBe(1);
    expect(newBatchCalls).toBe(0);
  });

  test("lead is bounded by lifetime for 300 s and 3600 s grants", () => {
    expect(nativeRenewAt(session("short"), 0)).toBe(issue + 225_000);
    expect(nativeRenewAt(session("long", issue, 3_600_000), 0)).toBe(issue + 3_000_000);
  });

  test("live handoff changes the CID used by a TinyCloud invocation after the old grant expires", async () => {
    const h = harness(issue + 225_000);
    const guarded = guardNativeTinyCloudCalls(h.raw, h.renewal);
    const heldKv = guarded.kv;
    const heldPrefix = guarded.kv.withPrefix("prefix/");
    const heldDb = (guarded.sql as unknown as { db(name: string): { query(): Promise<string> } }).db("notes");
    const heldMigrations = (guarded.sql as unknown as { db(name: string): { migrations: { apply(): Promise<string> } } }).db("notes").migrations;
    await heldKv.put("key", "value");
    expect(h.events).toEqual(["renew", "swap", "jwt"]);
    h.setTime(issue + 301_000);
    await heldKv.put("key", "later");
    await heldPrefix.put("later", "value");
    expect(await heldDb.query()).toBe("new");
    expect(await heldMigrations.apply()).toBe("new");
    expect(h.calls).toEqual(["new", "new", "new"]);
    h.renewal.stop();
    await expect(heldKv.put("key", "after sign-out")).rejects.toThrow("signed out");
  });

  test("waits for a save, and a forced swap retries after its guard settles", async () => {
    const deferred = harness(issue + 225_000);
    deferred.setBusy(true);
    const pending = deferred.renewal.check();
    await Promise.resolve(); await Promise.resolve();
    expect(deferred.events).not.toContain("swap");
    deferred.setBusy(false);
    await pending;
    await deferred.renewal.check();
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

  test("a multipart upload crosses the forced swap and completes without waiting for recovery", async () => {
    const h = harness(issue + 200_000);
    const guarded = guardNativeTinyCloudCalls(h.raw, h.renewal);
    h.setBusy(true);
    let releaseSecond!: () => void;
    let secondStarted!: () => void;
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const atSecond = new Promise<void>((resolve) => { secondStarted = resolve; });
    const upload = putAudio(guarded.kv, "audio/one", {
      size: 2,
      readPart: async (offset: number) => {
        if (offset === 1) { secondStarted(); await second; }
        return new Uint8Array([offset]);
      },
    }, { partSize: 1, mimeType: "audio/webm", fileName: "one.webm" });
    await atSecond;
    expect(h.calls).toEqual(["old"]);
    h.setTime(issue + 240_000);
    await h.renewal.check();
    expect(h.events).toContain("swap");
    releaseSecond();
    const saved = await upload;
    expect(saved.parts).toHaveLength(2);
    expect(h.calls).toEqual(["old", "new", "new"]);
    expect(h.events).not.toContain("retry pending");
    h.setBusy(false);
    await Promise.resolve(); await Promise.resolve();
    expect(h.events).toContain("retry pending");
    h.renewal.stop();
  });

  test("multipart save calls use the old graph while renewal waits for the save", async () => {
    const h = harness(issue + 225_000);
    const guarded = guardNativeTinyCloudCalls(h.raw, h.renewal);
    h.setBusy(true);
    const manifest = await putAudio(guarded.kv, "audio/old", {
      size: 2,
      readPart: async (offset: number) => new Uint8Array([offset]),
    }, { partSize: 1, mimeType: "audio/webm", fileName: "old.webm" });
    expect(manifest.parts).toHaveLength(2);
    expect(h.calls).toEqual(["old", "old", "old"]);
    expect(h.events).not.toContain("swap");
    h.setBusy(false);
    await h.renewal.check();
    expect(h.events).toContain("swap");
    h.renewal.stop();
  });

  test("retry policy honors Retry-After, exponential backoff, and terminal codes", () => {
    expect(nativeRetryDelay(new OpenKeyNativeError("RENEWAL_TOO_SOON", "too soon", 429, "renewal_too_soon", 7), 0, 70_000)).toBe(7_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("TEMPORARILY_UNAVAILABLE", "busy", 503, "temporarily_unavailable", 2), 0, 70_000)).toBe(15_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("TEMPORARILY_UNAVAILABLE", "busy", 503, "temporarily_unavailable", 2), 2, 70_000)).toBe(60_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("NETWORK", "offline"), 0, 100_000)).toBe(15_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("SERVER", "rate limited", 429), 0, 100_000)).toBe(15_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("NETWORK", "offline"), 2, 100_000)).toBe(60_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("NETWORK", "offline"), 0, -1)).toBe(15_000);
    expect(nativeRetryDelay(new OpenKeyNativeError("RENEWAL_CONFLICT", "raced"), 0, 100_000)).toBe(15_000);
    expect(terminalRenewalError(new OpenKeyNativeError("RENEWAL_CONFLICT", "SDK reload and retry failed"))).toBe(false);
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

  test("unclassified live failures show a message and keep a bounded retry after expiry", async () => {
    for (const error of [
      new OpenKeyNativeError("SERVER", "bad gateway", 400),
      new OpenKeyNativeError("UNAVAILABLE", "node offline"),
      new Error("unexpected failure"),
    ]) {
      let renews = 0;
      const messages: string[] = [];
      const h = harness(issue + 225_000, session("old"), (message) => messages.push(message));
      h.openkey.renew = async () => { renews++; throw error; };
      await h.renewal.check();
      expect(messages).toHaveLength(1);
      await h.renewal.check();
      expect(renews).toBe(1);
      h.setTime(issue + 301_000);
      await expect(h.renewal.check()).rejects.toThrow("temporarily unavailable");
      expect(renews).toBe(2);
      h.renewal.stop();
    }
  });

  test("backend verification failure after a swap remains visible and retries", async () => {
    const messages: string[] = [];
    const h = harness(issue + 225_000, session("old"), (message) => messages.push(message),
      async () => { throw new Error("backend unavailable"); });
    await h.renewal.check();
    expect(h.events).toEqual(["renew", "swap"]);
    expect(messages).toHaveLength(1);
    h.setTime(issue + 240_000);
    await h.renewal.check();
    expect(h.events.filter((event) => event === "renew")).toHaveLength(2);
    h.renewal.stop();
  });

  test("stopping during backend verification cannot write a late JWT", async () => {
    const old = session("old");
    let verifyEntered!: () => void;
    let releaseVerify!: () => void;
    const entered = new Promise<void>((resolve) => { verifyEntered = resolve; });
    const verify = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const written: string[] = [];
    const renewal = new NativeRenewal({
      openkey: { current: async () => old, renew: async () => session("new", issue + 225_000) } as unknown as OpenKeyNative,
      tcw: {} as TinyCloudWeb, session: old,
      sessionStore: { setSession: (token) => { written.push(token); } },
      requestNonce: async () => "nonce",
      verifySession: async () => { verifyEntered(); await verify; return { token: "late", expiresIn: 60, address: old.delegation.address! }; },
      install: async () => {}, onTerminal: () => {}, onStorage: () => {},
      now: () => issue + 225_000, jitter: () => 0,
    });
    const flight = renewal.check();
    await entered;
    renewal.stop();
    releaseVerify();
    await flight;
    expect(written).toEqual([]);
  });

  test("stopping during install cannot start backend verification", async () => {
    const old = session("old");
    let installEntered!: () => void;
    let releaseInstall!: () => void;
    const entered = new Promise<void>((resolve) => { installEntered = resolve; });
    const install = new Promise<void>((resolve) => { releaseInstall = resolve; });
    let verifies = 0;
    const renewal = new NativeRenewal({
      openkey: { current: async () => old, renew: async () => session("new", issue + 225_000) } as unknown as OpenKeyNative,
      tcw: {} as TinyCloudWeb, session: old,
      sessionStore: { setSession: () => { throw new Error("late JWT"); } },
      requestNonce: async () => "nonce",
      verifySession: async () => { verifies++; return { token: "late", expiresIn: 60, address: old.delegation.address! }; },
      install: async () => { installEntered(); await install; },
      onTerminal: () => {}, onStorage: () => {}, now: () => issue + 225_000, jitter: () => 0,
    });
    const flight = renewal.check();
    await entered;
    renewal.stop();
    releaseInstall();
    await flight;
    expect(verifies).toBe(0);
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
