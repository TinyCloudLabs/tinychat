import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { DelegationResponse } from "@tinyboilerplate/core";
import {
  beginTranscriptConsentStatus, clearTranscriptConsentStatus, resolveTranscriptConsentStatus,
  subscribeTranscriptConsent, transcriptConsentState,
} from "./transcriptDeliveryState";
const previousHTMLElement = globalThis.HTMLElement;
const previousCustomElements = globalThis.customElements;
globalThis.HTMLElement ??= class {} as never;
globalThis.customElements ??= { define: () => {}, get: () => undefined } as never;
// Test-only module-loading boundary: web-sdk defines a custom element at import time.
const { clearTranscriptDelegationSchedule, ensureTranscriptWriterDelegation, nextTranscriptAttempt, serverDeliveryActive } = await import("./transcriptDelegation");
const DAY = 86_400_000;

const address = "0x0000000000000000000000000000000000000abc";
const originalFetch = globalThis.fetch;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterAll(() => {
  if (previousHTMLElement) globalThis.HTMLElement = previousHTMLElement;
  else Reflect.deleteProperty(globalThis, "HTMLElement");
  if (previousCustomElements) globalThis.customElements = previousCustomElements;
  else Reflect.deleteProperty(globalThis, "customElements");
});


function memoryStorage(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() { return rows.size; },
    clear: () => rows.clear(),
    getItem: (key) => rows.get(key) ?? null,
    key: (index) => [...rows.keys()][index] ?? null,
    removeItem: (key) => { rows.delete(key); },
    setItem: (key, value) => { rows.set(key, value); },
  };
}

afterEach(() => {
  clearTranscriptDelegationSchedule(address);
  globalThis.fetch = originalFetch;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("per-account transcript consent status", () => {
  it("requires an observed active grant, keeps unknown conservative, and ignores a previous account", () => {
    const other = "0x0000000000000000000000000000000000000def";
    const observed: string[] = [];
    const unsubscribe = subscribeTranscriptConsent(() => observed.push(transcriptConsentState()));
    try {
      beginTranscriptConsentStatus(address);
      resolveTranscriptConsentStatus(address, { status: "none", verified: false, delivery: "enabled", expiresAt: null });
      expect(transcriptConsentState()).toBe("inactive");
      beginTranscriptConsentStatus(other);
      resolveTranscriptConsentStatus(address, { status: "active", verified: true, delivery: "enabled", expiresAt: null });
      expect(transcriptConsentState()).toBe("unknown");
      resolveTranscriptConsentStatus(other, { status: "active", verified: true, delivery: "schema_missing", expiresAt: null });
      expect(transcriptConsentState()).toBe("unknown");
      resolveTranscriptConsentStatus(other, { status: "active", verified: true, delivery: "enabled", expiresAt: null });
      clearTranscriptConsentStatus(address);
      expect(transcriptConsentState()).toBe("active");
      clearTranscriptConsentStatus(other);
      expect(observed).toEqual(["inactive", "unknown", "active", "unknown"]);
    } finally {
      clearTranscriptConsentStatus(other);
      unsubscribe();
    }
  });
});

function setup(schemaFails: boolean, status: "none" | "schema_missing" = "none") {
  const operations: string[] = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, _options: unknown, action: (lock: object) => Promise<unknown>) => action({}) } },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    operations.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/delegations/status") {
      return Response.json(status === "schema_missing"
        ? { status: "active", expiresAt: new Date(Date.now() + 28 * 86_400_000).toISOString(), verified: true, delivery: "schema_missing" }
        : { status: "none", expiresAt: null, verified: false, delivery: "enabled" });
    }
    if (path === "/api/server-info") return Response.json({ did: `did:pkh:eip155:1:${address}` });
    if (path === "/api/delegations") return Response.json({ status: "active", verified: true, delivery: "enabled", expiresAt: null });
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  const db = {
    query: async (sql: string) => {
      operations.push(`SQL ${sql.trim().split(/\s+/, 1)[0]}`);
      return { ok: true, data: { rows: [] } };
    },
    execute: async (sql: string) => {
      operations.push(`SQL ${sql.trim().split(/\s+/, 1)[0]}`);
      return schemaFails
        ? { ok: false, error: { code: "SCHEMA_DENIED", message: "Schema unavailable" } }
        : { ok: true, data: {} };
    },
  };
  const tcw = {
    address: () => address,
    session: () => ({ siwe: `Expiration Time: ${new Date(Date.now() + 30 * 86_400_000).toISOString()}`, signature: "signed" }),
    sql: { db: () => db },
    delegateTo: async () => { operations.push("delegateTo"); throw new Error("Stop before serialization"); },
  } as unknown as TinyCloudWeb;
  const sessionStore = {
    getToken: () => "test-token", getAddress: () => address, isExpired: () => false,
  } as unknown as SessionStore;
  return { operations, tcw, sessionStore };
}

describe("transcript delegation schema prerequisite", () => {
  it("ensures the user's connector schema inside the lock before asking the session to mint", async () => {
    const { operations, tcw, sessionStore } = setup(false);
    expect(await ensureTranscriptWriterDelegation({ tcw, sessionStore, backendUrl: "https://localhost:31314" })).toBe("unavailable");
    expect(operations.filter((op) => op === "SQL CREATE")).toHaveLength(2);
    expect(operations.indexOf("delegateTo")).toBeGreaterThan(operations.lastIndexOf("SQL CREATE"));
  });

  it("does not mint or POST when the user's schema ensure fails", async () => {
    const { operations, tcw, sessionStore } = setup(true);
    expect(await ensureTranscriptWriterDelegation({ tcw, sessionStore, backendUrl: "https://localhost:31314" })).toBe("unavailable");
    expect(operations).toContain("SQL CREATE");
    expect(operations).not.toContain("delegateTo");
    expect(operations).not.toContain("POST /api/delegations");
  });
  it("repairs a missing schema without replacing a healthy signed grant", async () => {
    const { operations, tcw, sessionStore } = setup(false, "schema_missing");
    expect(await ensureTranscriptWriterDelegation({ tcw, sessionStore, backendUrl: "https://localhost:31314" })).toBe("active");
    expect(operations.filter((op) => op === "SQL CREATE")).toHaveLength(2);
    expect(operations).not.toContain("delegateTo");
    expect(operations).not.toContain("POST /api/delegations");
  });
});

function mintHarness(initial: Partial<DelegationResponse> = {}, sessionDays = 30,
  hooks: { onMint?: () => Promise<void>; onPost?: () => Promise<void> } = {}) {
  const operations: string[] = [];
  const payloads: Array<Record<string, unknown>> = [];
  const storage = memoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, _options: unknown, action: (lock: object) => Promise<unknown>) => action({}) } },
  });
  let status: DelegationResponse = { status: "none", expiresAt: null, verified: false, delivery: "enabled", ...initial };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    operations.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/delegations/status") return Response.json(status);
    if (path === "/api/server-info") return Response.json({ did: `did:pkh:eip155:1:${address}` });
    if (path === "/api/delegations") {
      await hooks.onPost?.();
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      status = {
        status: "active", verified: true, delivery: "enabled",
        expiresAt: new Date(Date.now() + Math.min(29, sessionDays) * DAY).toISOString(),
      };
      return Response.json(status);
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  const db = {
    query: async () => ({ ok: true, data: { rows: [["connector_state"], ["connector_meeting"]] } }),
    execute: async () => { throw new Error("The schema already exists"); },
  };
  const tcw = {
    address: () => address, chainId: () => 1, hosts: ["https://node.tinycloud.xyz"],
    session: () => ({
      siwe: `Expiration Time: ${new Date(Date.now() + sessionDays * DAY).toISOString()}`,
      signature: "0xsigned",
      chainId: 1,
    }),
    sql: { db: () => db },
    delegateTo: async (_did: string, _permissions: unknown, options: Record<string, unknown>) => {
      operations.push("delegateTo");
      await hooks.onMint?.();
      expect(options).not.toHaveProperty("forceWalletSign");
      return { prompted: false, delegation: {
        cid: "bafy-transcript-test", delegationHeader: { Authorization: "Bearer eyJhbGciOiJFZERTQSJ9.eyJhdHQiOnt9fQ.signature" },
        spaceId: `did:pkh:eip155:1:${address}:applications`, path: "xyz.tinycloud.tinychat/connectors",
        actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
        resources: [],
        expiry: new Date(Date.now() + 29 * DAY), delegateDID: `did:pkh:eip155:1:${address}`,
      } };
    },
  } as unknown as TinyCloudWeb;
  const sessionStore = {
    getToken: () => "test-token", getAddress: () => address, isExpired: () => false,
  } as unknown as SessionStore;
  const run = () => ensureTranscriptWriterDelegation({ tcw, sessionStore, backendUrl: "https://localhost:31314" });
  return { operations, payloads, storage, tcw, sessionStore, run, getStatus: () => status,
    setStatus: (value: DelegationResponse) => { status = value; } };
}

describe("silent transcript-writer renewal", () => {
  it("mints once through 20 reloads, posting only the portable grant and signed session", async () => {
    const f = mintHarness();
    const first = await f.run();
    expect(f.operations).toContain("POST /api/delegations");
    expect(first).toBe("active");
    for (let i = 0; i < 20; i++) expect(await f.run()).toBe("active");
    expect(f.operations.filter((op) => op === "delegateTo")).toHaveLength(1);
    expect(f.payloads).toHaveLength(1);
    expect(f.payloads[0]).toEqual({
      serialized: expect.any(String),
      siwe: expect.stringContaining("Expiration Time:"),
      signature: "0xsigned",
    });
  });
  it("uses observed grant status for consent and discloses during an uncertain POST", async () => {
    const disabled = mintHarness({ delivery: "disabled" });
    expect(transcriptConsentState()).toBe("unknown");
    expect(await disabled.run()).toBe("disabled");
    expect(transcriptConsentState()).toBe("inactive");

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const enabled = mintHarness({}, 30, {
      onPost: async () => { entered.resolve(); await release.promise; },
    });
    const pending = enabled.run();
    await entered.promise;
    expect(transcriptConsentState()).toBe("unknown");
    release.resolve();
    expect(await pending).toBe("active");
    expect(transcriptConsentState()).toBe("active");
  });

  it("keeps the inactive consent when schema repair fails before any grant POST", async () => {
    const { tcw, sessionStore } = setup(true);
    expect(await ensureTranscriptWriterDelegation({ tcw, sessionStore, backendUrl: "https://localhost:31314" })).toBe("unavailable");
    expect(transcriptConsentState()).toBe("inactive");
  });

  it("uses the conservative consent state when a later status request fails", async () => {
    const f = mintHarness({ delivery: "disabled" });
    expect(await f.run()).toBe("disabled");
    expect(transcriptConsentState()).toBe("inactive");
    globalThis.fetch = (async () => { throw new Error("Status unavailable"); }) as typeof fetch;
    expect(await f.run()).toBe("unavailable");
    expect(transcriptConsentState()).toBe("unknown");
  });
  it("re-mints at once when the backend drops a node-rejected grant and status flips to none", async () => {
    const f = mintHarness();
    expect(await f.run()).toBe("active");
    expect(transcriptConsentState()).toBe("active");
    // What the worker leaves behind after a 401/403 at activation (backend transcript-delivery test).
    f.setStatus({ status: "none", expiresAt: null, verified: false, delivery: "enabled" });
    expect(await f.run()).toBe("active");
    expect(f.operations.filter((op) => op === "delegateTo")).toHaveLength(2);
    expect(f.payloads).toHaveLength(2);
    expect(transcriptConsentState()).toBe("active");
  });
  it("does not re-mint a grant near the end of a three-day session without useful extension", async () => {
    const f = mintHarness({}, 3);
    expect(await f.run()).toBe("active");
    for (let i = 0; i < 5; i++) expect(await f.run()).toBe("active");
    expect(f.operations.filter((op) => op === "delegateTo")).toHaveLength(1);
  });

  it("replaces expired, stale and unverified grants but never mints when delivery is disabled", async () => {
    for (const original of [
      { status: "expired", expiresAt: new Date(Date.now() - DAY).toISOString(), verified: false },
      { status: "stale", expiresAt: null, verified: false },
      { status: "active", expiresAt: new Date(Date.now() + 28 * DAY).toISOString(), verified: false },
    ] as const) {
      const f = mintHarness(original);
      expect(await f.run()).toBe("active");
      expect(f.payloads).toHaveLength(1);
    }
    const disabled = mintHarness({ delivery: "disabled" });
    expect(await disabled.run()).toBe("disabled");
    expect(disabled.operations).not.toContain("delegateTo");
  });

  it("treats a status without a known delivery value as off: no mint and no browser deferral", async () => {
    const on = mintHarness();
    expect(await on.run()).toBe("active");
    expect(serverDeliveryActive()).toBe(true);
    for (const delivery of [undefined, "paused"]) {
      const f = mintHarness({ delivery } as unknown as Partial<DelegationResponse>);
      expect(await f.run()).toBe("disabled");
      expect(f.operations).toEqual(["GET /api/delegations/status"]);
      expect(f.operations).not.toContain("delegateTo");
      expect(f.payloads).toEqual([]);
      // `serverDeliveryActive` is what defers the browser's own save by ten minutes.
      expect(serverDeliveryActive()).toBe(false);
    }
    // Schema repair stays a known, enabled value (the browser's cue to re-ensure tables).
    const repair = mintHarness({ status: "active", verified: true, delivery: "schema_missing",
      expiresAt: new Date(Date.now() + 28 * DAY).toISOString() });
    expect(await repair.run()).toBe("active");
    expect(serverDeliveryActive()).toBe(true);
    expect(repair.operations).not.toContain("delegateTo");
  });

  it("clamps jittered backoff after the cap and reconsiders urgency on each evaluation", async () => {
    const now = Date.now();
    for (let failures = 1; failures <= 20; failures++) {
      for (const jitter of [0, 0.5, 0.999999]) {
        const record = { failures, lastFailureAt: now, jitter };
        expect(nextTranscriptAttempt(record, true) - now).toBeLessThanOrEqual(5 * 60_000);
        expect(nextTranscriptAttempt(record, false) - now).toBeLessThanOrEqual(6 * 60 * 60_000);
      }
    }
    const f = mintHarness({
      status: "active", verified: true, expiresAt: new Date(now + 3 * DAY).toISOString(),
    });
    f.storage.setItem(`tinychat.transcriptWriter.${address}`, JSON.stringify({
      failures: 8, lastFailureAt: now - 60 * 60_000, jitter: 0.99,
    }));
    expect(await f.run()).toBe("busy");
    expect(f.operations).not.toContain("delegateTo");
    f.setStatus({ status: "stale", expiresAt: null, verified: false, delivery: "enabled" });
    expect(await f.run()).toBe("active");
    expect(f.storage.getItem(`tinychat.transcriptWriter.${address}`)).toBeNull();
    expect(f.payloads).toHaveLength(1);
  });
  it("uses the exclusive Web Lock across two tabs, then the losing tab observes the active grant", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = mintHarness({}, 30, { onMint: async () => { entered.resolve(); await release.promise; } });
    let held = false;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: async (_name: string, _options: unknown, action: (lock: object | null) => Promise<unknown>) => {
        if (held) return action(null);
        held = true;
        try { return await action({}); }
        finally { held = false; }
      } } },
    });
    // Test-only module-loading boundary: query variants model separate browser tabs with separate module state.
    const otherTab = await import("./transcriptDelegation?tab=web-lock");
    try {
      const first = f.run();
      await entered.promise;
      expect(await otherTab.ensureTranscriptWriterDelegation({
        tcw: f.tcw, sessionStore: f.sessionStore, backendUrl: "https://localhost:31314",
      })).toBe("busy");
      // The losing tab read "none" before the lock; the holder may be minting, so it discloses.
      expect(transcriptConsentState()).toBe("unknown");
      release.resolve();
      expect(await first).toBe("active");
      expect(await otherTab.ensureTranscriptWriterDelegation({
        tcw: f.tcw, sessionStore: f.sessionStore, backendUrl: "https://localhost:31314",
      })).toBe("active");
      expect(f.operations.filter((op) => op === "delegateTo")).toHaveLength(1);
      expect(f.payloads).toHaveLength(1);
    } finally {
      release.resolve();
      otherTab.clearTranscriptDelegationSchedule(address);
    }
  });
  it("discloses instead of the inactive copy while another tab holds the localStorage lease", async () => {
    const f = mintHarness();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    const leaseKey = `tinychat.transcriptWriter.lease.${address}`;
    f.storage.setItem(leaseKey, JSON.stringify({ owner: "other-tab", until: Date.now() + 60_000 }));
    expect(await f.run()).toBe("busy");
    expect(transcriptConsentState()).toBe("unknown");
    expect(f.operations).not.toContain("delegateTo");

    // Lost the lease while confirming it: another tab overwrote it during the settle window.
    f.storage.removeItem(leaseKey);
    const setItem = f.storage.setItem.bind(f.storage);
    f.storage.setItem = (key, value) => {
      setItem(key, value);
      if (key === leaseKey && !value.includes("other-tab")) {
        setTimeout(() => setItem(leaseKey, JSON.stringify({ owner: "other-tab", until: Date.now() + 60_000 })), 0);
      }
    };
    clearTranscriptDelegationSchedule(address);
    expect(await f.run()).toBe("busy");
    expect(transcriptConsentState()).toBe("unknown");
    expect(f.operations).not.toContain("delegateTo");
  });

  it("keeps at most one mint in a simultaneous localStorage lease race", async () => {
    const f = mintHarness();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    // Test-only module-loading boundary: independent module state models a second tab.
    const otherTab = await import("./transcriptDelegation?tab=lease-race");
    try {
      const results = await Promise.all([
        f.run(),
        otherTab.ensureTranscriptWriterDelegation({
          tcw: f.tcw, sessionStore: f.sessionStore, backendUrl: "https://localhost:31314",
        }),
      ]);
      expect(results.sort()).toEqual(["active", "busy"]);
      expect(f.payloads).toHaveLength(1);
      expect(f.operations.filter((op) => op === "delegateTo")).toHaveLength(1);
    } finally { otherTab.clearTranscriptDelegationSchedule(address); }
  });

  it("does not clear a successor's lease when an older POST outlives its two-minute lease", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const successor = Promise.withResolvers<void>();
    const f = mintHarness({}, 30, { onPost: async () => { entered.resolve(); await release.promise; } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    const otherTab = await import("./transcriptDelegation?tab=late-lease");
    const realNow = Date.now;
    const leaseKey = `tinychat.transcriptWriter.lease.${address}`;
    try {
      const first = f.run();
      await entered.promise;
      const firstLease = f.storage.getItem(leaseKey);
      const save = f.storage.setItem.bind(f.storage);
      f.storage.setItem = (key, value) => {
        save(key, value);
        if (key === leaseKey && value !== firstLease) successor.resolve();
      };
      Date.now = () => realNow() + 121_000;
      const second = otherTab.ensureTranscriptWriterDelegation({
        tcw: f.tcw, sessionStore: f.sessionStore, backendUrl: "https://localhost:31314",
      });
      await successor.promise;
      const secondLease = f.storage.getItem(leaseKey);
      release.resolve();
      expect(await first).toBe("active");
      expect(f.storage.getItem(leaseKey)).toBe(secondLease);
      expect(await second).toBe("active");
      expect(f.storage.getItem(leaseKey)).toBeNull();
      expect(f.payloads).toHaveLength(1);
    } finally {
      Date.now = realNow;
      release.resolve();
      otherTab.clearTranscriptDelegationSchedule(address);
    }
  });
  it("renews a grant with 30 minutes left despite older failures", async () => {
    const now = Date.now();
    const f = mintHarness({
      status: "active", verified: true, expiresAt: new Date(now + 30 * 60_000).toISOString(),
    });
    f.storage.setItem(`tinychat.transcriptWriter.${address}`, JSON.stringify({
      failures: 12, lastFailureAt: now - 60 * 60_000, jitter: 0.99,
    }));
    expect(await f.run()).toBe("active");
    expect(f.payloads).toHaveLength(1);
    expect(f.storage.getItem(`tinychat.transcriptWriter.${address}`)).toBeNull();
  });
  it("bounds the pre-lock status request, aborts it, and clears the pending attempt", async () => {
    const f = mintHarness();
    const fetchStatus = globalThis.fetch;
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    let requests = 0;
    let locks = 0;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: async () => { locks++; throw new Error("Unexpected Web Lock"); } } },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/delegations/status" && ++requests === 1) {
        signal = init?.signal ?? undefined;
        entered.resolve();
        return late.promise; // Deliberately ignore abort: the caller must still settle.
      }
      return fetchStatus(input, init);
    }) as typeof fetch;
    const realSetTimeout = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 90_000) {
        expire = () => { if (typeof handler === "function") handler(...args); };
        return realSetTimeout(() => {}, 1_000_000);
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;
    try {
      const running = f.run();
      await entered.promise;
      expect(signal?.aborted).toBe(false);
      expect(expire).toBeDefined();
      expire!();
      expect(await running).toBe("unavailable");
      expect(signal?.aborted).toBe(true);
      expect(locks).toBe(0);
      expect(JSON.parse(f.storage.getItem(`tinychat.transcriptWriter.${address}`)!).failures).toBe(1);
      late.resolve(Response.json({ status: "none", expiresAt: null, verified: false, delivery: "enabled" }));
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
      expect(locks).toBe(0);
      expect(f.operations).not.toContain("delegateTo");
      expect(await f.run()).toBe("busy");
      expect(requests).toBe(2);
    } finally { globalThis.setTimeout = realSetTimeout; }
  });

  it("bounds a suspended in-lock status request, aborts it, and releases the Web Lock", async () => {
    const f = mintHarness();
    const fetchStatus = globalThis.fetch;
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    let signal: AbortSignal | undefined;
    let requests = 0;
    let held = false;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: async (_name: string, _options: unknown, action: (lock: object) => Promise<unknown>) => {
        held = true;
        try { return await action({}); }
        finally { held = false; }
      } } },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/delegations/status" && ++requests === 2) {
        signal = init?.signal ?? undefined;
        entered.resolve();
        return late.promise; // An uncooperative fetch must not hold the Web Lock indefinitely.
      }
      return fetchStatus(input, init);
    }) as typeof fetch;
    const realSetTimeout = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 90_000) {
        expire = () => { if (typeof handler === "function") handler(...args); };
        return realSetTimeout(() => {}, 1_000_000);
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;
    try {
      const running = f.run();
      await entered.promise;
      expect(held).toBe(true);
      expect(signal?.aborted).toBe(false);
      expect(expire).toBeDefined();
      expire!();
      expect(await running).toBe("unavailable");
      expect(signal?.aborted).toBe(true);
      expect(held).toBe(false);
      expect(JSON.parse(f.storage.getItem(`tinychat.transcriptWriter.${address}`)!).failures).toBe(1);
      late.resolve(Response.json({ status: "none", expiresAt: null, verified: false, delivery: "disabled" }));
      await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
      expect(serverDeliveryActive()).toBe(true);
      expect(f.operations).not.toContain("delegateTo");
      expect(f.operations).not.toContain("POST /api/delegations");
      expect(await f.run()).toBe("busy");
      expect(requests).toBe(3);
    } finally { globalThis.setTimeout = realSetTimeout; }
  });

  it("times out a hung POST, records a retry, and releases the Web Lock", async () => {
    const f = mintHarness({}, 30, { onPost: () => new Promise<void>(() => {}) });
    let held = false;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: { request: async (_name: string, _options: unknown, action: (lock: object | null) => Promise<unknown>) => {
        held = true;
        try { return await action({}); }
        finally { held = false; }
      } } },
    });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      realSetTimeout(handler, delay === 90_000 ? 0 : delay, ...args)) as typeof setTimeout;
    try {
      expect(await f.run()).toBe("unavailable");
      expect(held).toBe(false);
      expect(f.operations).toContain("POST /api/delegations");
      expect(JSON.parse(f.storage.getItem(`tinychat.transcriptWriter.${address}`)!).failures).toBe(1);
    } finally { globalThis.setTimeout = realSetTimeout; }
  });

  it("fires its own retry timer without a reload, and stops scheduling when delivery is disabled", async () => {
    let posts = 0;
    const f = mintHarness({}, 30, { onPost: async () => { if (++posts === 1) throw new Error("Transient backend failure"); } });
    const realSetTimeout = globalThis.setTimeout;
    const realNow = Date.now;
    let retry: (() => void) | undefined;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof delay === "number" && delay >= 60_000 && delay < 80_000) {
        retry = () => { if (typeof handler === "function") handler(...args); };
        return realSetTimeout(() => {}, 1_000_000);
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;
    try {
      expect(await f.run()).toBe("unavailable");
      expect(retry).toBeDefined();
      Date.now = () => realNow() + 80_000;
      retry!();
      expect(await f.run()).toBe("active");
      expect(posts).toBe(2);
      expect(f.storage.getItem(`tinychat.transcriptWriter.${address}`)).toBeNull();
      f.setStatus({ status: "active", verified: true, expiresAt: f.getStatus().expiresAt, delivery: "disabled" });
      expect(await f.run()).toBe("disabled");
    } finally {
      Date.now = realNow;
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
