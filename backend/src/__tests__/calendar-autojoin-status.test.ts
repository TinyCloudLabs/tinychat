import { describe, expect, spyOn, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { createCalendarAutojoinRouter } from "../routes/calendar-autojoin.js";
import { BackendStorageLane, BackendStorageLaneTimeout } from "../services/backend-storage-lane.js";
import { CalendarAutojoinConnection, CalendarAutojoinError, type CalendarAutojoinConnectionOptions } from "../services/calendar-autojoin-connection.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator, kvCalendarAutojoinStores, type CalendarConnection, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinStatusCache, STATUS_CACHE_MAX_AGE_MS, STATUS_CACHE_MAX_TENANTS, type CalendarAutojoinStatus } from "../services/calendar-autojoin-status-cache.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import type { CredentialStore } from "../services/credential-store.js";
import type { GoogleCalendarPort } from "../services/google-calendar.js";
import { GoogleOAuthError, type GoogleOAuthPort } from "../services/google-oauth.js";
import type { TranscriptionApiClient } from "../services/transcription-api.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import { calendarAutojoinOutcomes } from "../services/calendar-autojoin-status-summary.js";

const TENANT = "tenant-a";
const OTHER = "tenant-b";
const AT = Date.parse("2026-10-14T12:00:00Z");
const on: CalendarAutojoinStatus = { state: "on", enabled: true, lastScanAt: AT, lastDispatchLag: null, errorCode: null, outcomes: [] };
const connectionRow = (tenant = TENANT): CalendarConnection => ({ tenant, subject: "subject", state: "enabled", generation: 1,
  scopes: [], nextScanAt: 0, lastScanAt: AT, scanComplete: true });
const occurrenceRow = (tenant = TENANT): CalendarOccurrence => ({ tenant, subject: "subject", id: "occurrence", eventId: "event",
  start: AT, end: AT + 60_000, meetingUrl: "https://meet.google.com/abc-defg-hij", title: "Synthetic metadata",
  phase: "terminal", disposition: "missed_window", nextAttemptAt: 0, attemptCount: 0, stopRequested: false, updatedAt: AT });

function fixture() {
  let now = AT;
  const cache = new CalendarAutojoinStatusCache(() => now);
  const store = new MemoryCalendarAutojoinStore(cache);
  const credentials = { async getCredential() { return null; }, async status() { return null; }, async delete() {} } as unknown as CredentialStore;
  const options: CalendarAutojoinConnectionOptions = { store, credentials, oauth: {} as GoogleOAuthPort,
    calendar: { async probePrimary() {} }, coordinator: new TenantCoordinator() };
  const connection = new CalendarAutojoinConnection(options);
  return { store, cache, connection, options, now: () => now, advance(ms: number) { now += ms; },
    async publishOutcomes() { await store.putStatusSummary(TENANT, { version: 1, outcomes: calendarAutojoinOutcomes(await store.listOccurrences(TENANT)) }); },
  };
}

async function withRoute(f: ReturnType<typeof fixture>, run: (request: (tenant?: string, query?: string) => Promise<Response>, lines: string[]) => Promise<void>) {
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers["x-test-tenant"]) req.user = { address: req.headers["x-test-tenant"] } as typeof req.user;
    next();
  });
  app.use("/autojoin", createCalendarAutojoinRouter({ connection: f.connection }));
  const server = app.listen(0);
  await new Promise<void>(done => server.once("listening", done));
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line) => { lines.push(line); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/autojoin/status`;
  try {
    await run((tenant, query = "") => fetch(url + query, { headers: tenant ? { "x-test-tenant": tenant } : {} }), lines);
    expect(log.mock.calls.every(call => call.length === 1)).toBe(true);
  } finally {
    log.mockRestore();
    await new Promise<void>(done => server.close(() => done()));
  }
}

function timing(response: Response, outcome: string, reads: number, line: string) {
  expect(line).toMatch(new RegExp(`^\\[calendar-autojoin\\] code=status_read outcome=${outcome} ms=\\d+ reads=${reads}$`));
  const ms = line.match(/ ms=(\d+) /)![1];
  expect(response.headers.get("server-timing")).toBe(`status;dur=${ms};desc="reads=${reads}"`);
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("TC-1086 status fallback and metadata", () => {
  test("a never-connected tenant returns off with one read and no stale fields", async () => {
    const f = fixture();
    await withRoute(f, async (request, lines) => {
      const response = await request(TENANT);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...on, state: "off", enabled: false, lastScanAt: null });
      timing(response, "ok", 1, lines[0]);
    });
  });

  test("deadline timeout serves the cached body with stale and the successful read time", async () => {
    const f = fixture();
    await f.store.putConnection(connectionRow());
    await f.store.putOccurrence(occurrenceRow());
    await f.publishOutcomes();
    await withRoute(f, async (request, lines) => {
      const fresh = await request(TENANT.toUpperCase());
      const body = await fresh.json();
      expect(body.stale).toBeUndefined();
      timing(fresh, "ok", 2, lines[0]);
      f.advance(5_000);
      f.options.statusBudgetMs = 0;
      const stale = await request(TENANT);
      expect(stale.status).toBe(200);
      expect(await stale.json()).toEqual({ ...body, stale: true, asOf: new Date(AT).toISOString() });
      timing(stale, "stale", 1, lines[1]);
      expect(stale.headers.get("retry-after")).toBeNull();
      expect(lines).toHaveLength(2);
    });
  });

  for (const warmed of [false, true]) {
    test(`timeout with ${warmed ? "an expired" : "no"} cached response returns 503 and Retry-After`, async () => {
      const f = fixture();
      if (warmed) { await f.connection.getStatus(TENANT); f.advance(STATUS_CACHE_MAX_AGE_MS); }
      f.options.statusBudgetMs = 0;
      await withRoute(f, async (request, lines) => {
        const response = await request(TENANT);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "calendar_autojoin_unavailable" });
        expect(response.headers.get("retry-after")).toBe("5");
        timing(response, "unavailable", 1, lines[0]);
        expect(lines).toHaveLength(1);
      });
    });
  }

  test("lane wait failure and node read failure both use a fresh cached response", async () => {
    const f = fixture();
    await f.store.putConnection(connectionRow());
    const body = await f.connection.getStatus(TENANT);
    await withRoute(f, async (request, lines) => {
      for (const error of [new BackendStorageLaneTimeout("synthetic wait timeout"), new Error(`${TENANT} Synthetic metadata https://example.test`)]) {
        const lane = spyOn(BackendStorageLane.prototype, "run").mockRejectedValueOnce(error);
        try {
          const response = await request(TENANT);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ ...body, stale: true, asOf: new Date(AT).toISOString() });
          timing(response, "stale", 1, lines.at(-1)!);
        } finally { lane.mockRestore(); }
      }
      expect(lines).toHaveLength(2);
    });
  });

  test("a successful read refreshes both the cached response and its age", async () => {
    const f = fixture();
    await f.store.putConnection(connectionRow());
    await f.connection.getStatus(TENANT);
    f.advance(STATUS_CACHE_MAX_AGE_MS - 1);
    await withRoute(f, async (request, lines) => {
      expect((await request(TENANT)).status).toBe(200);
      const asOf = new Date(AT + STATUS_CACHE_MAX_AGE_MS - 1).toISOString();
      f.advance(2);
      f.options.statusBudgetMs = 0;
      const response = await request(TENANT);
      expect(await response.json()).toEqual({ ...on, stale: true, asOf });
      timing(response, "stale", 1, lines[1]);
    });
  });

  test("a summary-read failure reports two attempts and keeps the complete cached body", async () => {
    const f = fixture();
    await f.store.putConnection(connectionRow());
    await f.store.putOccurrence(occurrenceRow());
    await f.store.putOccurrence({ ...occurrenceRow(), id: "second-occurrence", start: AT + 1_000 });
    await f.publishOutcomes();
    await withRoute(f, async (request, lines) => {
      const fresh = await request(TENANT);
      const body = await fresh.json();
      expect(body.outcomes).toHaveLength(2);
      timing(fresh, "ok", 2, lines[0]);
      const lane = spyOn(BackendStorageLane.prototype, "run")
        .mockImplementationOnce(fn => fn()) // connection
        .mockRejectedValueOnce(new Error("synthetic summary read failure"));
      try {
        const response = await request(TENANT);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ...body, stale: true, asOf: new Date(AT).toISOString() });
        timing(response, "stale", 2, lines[1]);
        expect(f.connection.getLastGoodStatus(TENANT)!.body).toEqual(body);
      } finally { lane.mockRestore(); }
    });
  });

  test("tenant B cannot use A's response, even when a request supplies A in its query", async () => {
    const f = fixture();
    await f.store.putConnection(connectionRow());
    await f.connection.getStatus(TENANT);
    f.options.statusBudgetMs = 0;
    await withRoute(f, async (request, lines) => {
      const response = await request(OTHER, `?tenant=${TENANT}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "calendar_autojoin_unavailable" });
      timing(response, "unavailable", 1, lines[0]);
      const a = await request(TENANT.toUpperCase());
      expect(a.status).toBe(200);
      expect((await a.json()).enabled).toBe(true);
    });
  });

  for (const code of ["calendar_state_invalid", "calendar_listing_invalid"]) {
    test(`${code} retains unavailable behaviour despite a fresh cache`, async () => {
      const f = fixture();
      await f.connection.getStatus(TENANT);
      const read = spyOn(f.store, "getConnection").mockRejectedValue(new Error(code));
      try {
        await withRoute(f, async (request, lines) => {
          const response = await request(TENANT);
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({ error: "calendar_autojoin_unavailable" });
          timing(response, "unavailable", 0, lines[0]);
        });
      } finally { read.mockRestore(); }
    });
  }

  test("domain and Google errors preserve their existing status and body", async () => {
    const f = fixture();
    await f.connection.getStatus(TENANT);
    await withRoute(f, async (request, lines) => {
      for (const [error, status, code] of [
        [new CalendarAutojoinError("connection_changed", 409), 409, "connection_changed"],
        [new GoogleOAuthError({ operation: "refresh", status: 400, error: "invalid_grant" }), 400, "invalid_grant"],
        [new GoogleOAuthError({ operation: "refresh", status: 500, error: "server_error" }), 503, "google_unavailable"],
      ] as const) {
        const read = spyOn(f.store, "getConnection").mockRejectedValueOnce(error);
        try {
          const response = await request(TENANT);
          expect(response.status).toBe(status);
          expect(await response.json()).toEqual({ error: code });
          timing(response, "unavailable", 0, lines.at(-1)!);
        } finally { read.mockRestore(); }
      }
    });
  });

  test("unauthenticated requests have one metadata line and timing, with no reads", async () => {
    const f = fixture();
    await withRoute(f, async (request, lines) => {
      const response = await request();
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      timing(response, "unavailable", 0, lines[0]);
      expect(lines).toHaveLength(1);
    });
  });
});

describe("TC-1086 bounded last-good cache", () => {
  test("in-flight reader sets and tenant entries drain after concurrent success and failure", async () => {
    const cache = new CalendarAutojoinStatusCache(() => AT);
    // Inspect counts only: retaining empty tenant entries would grow without the LRU bound.
    const reading = (cache as unknown as { reading: Map<string, Set<unknown>> }).reading;
    let finish!: (body: CalendarAutojoinStatus) => void;
    let fail!: (error: Error) => void;
    const success = cache.refresh(TENANT, () => new Promise(done => { finish = done; }));
    const failure = cache.refresh(TENANT.toUpperCase(), () => new Promise((_done, reject) => { fail = reject; }));
    const rejected = failure.then(() => false, () => true);
    expect(reading.size).toBe(1);
    expect(reading.get(TENANT)!.size).toBe(2);
    await cache.refresh(OTHER, async () => on);
    expect(reading.size).toBe(1);
    finish(on); await success;
    expect(reading.get(TENANT)!.size).toBe(1);
    fail(new Error("synthetic read failure")); expect(await rejected).toBe(true);
    expect(reading.size).toBe(0);
    await expect(cache.refresh(OTHER, async () => { throw new Error("synthetic failure"); })).rejects.toThrow();
    expect(reading.size).toBe(0);
  });

  test("the default 1,000-tenant LRU bounds tenants, honors reads, and expires by read time", async () => {
    let now = AT;
    const cache = new CalendarAutojoinStatusCache(() => now);
    for (let i = 0; i < STATUS_CACHE_MAX_TENANTS; i++) await cache.refresh(`tenant-${i}`, async () => on);
    expect(cache.get("TENANT-0")).toBeDefined();
    await cache.refresh("tenant-new", async () => on);
    expect(cache.get("tenant-1")).toBeUndefined();
    expect(cache.get("tenant-0")).toBeDefined();
    expect(Array.from({ length: STATUS_CACHE_MAX_TENANTS }, (_, i) => cache.get(`tenant-${i}`)).filter(Boolean)).toHaveLength(999);
    now += STATUS_CACHE_MAX_AGE_MS - 1;
    expect(cache.get("tenant-new")).toBeDefined();
    now++;
    expect(cache.get("tenant-new")).toBeUndefined();
  });

  test("refresh replaces the body and isolates stored and returned copies", async () => {
    const cache = new CalendarAutojoinStatusCache(() => AT);
    const body = structuredClone(on);
    await cache.refresh(TENANT, async () => body);
    body.enabled = false;
    cache.get(TENANT)!.body.state = "off";
    expect(cache.get(TENANT)!.body).toEqual(on);
    const off = { ...on, state: "off" as const, enabled: false };
    await cache.refresh(TENANT, async () => off);
    expect(cache.get(TENANT)!.body).toEqual(off);
    expect(cache.get(OTHER)).toBeUndefined();
  });

  for (const during of [false, true]) {
    test(`a read started ${during ? "during" : "before"} a mutation cannot repopulate the cache`, async () => {
      const cache = new CalendarAutojoinStatusCache(() => AT);
      await cache.refresh(TENANT, async () => on);
      await cache.refresh(OTHER, async () => on);
      let finishRead!: (body: CalendarAutojoinStatus) => void;
      let finishWrite!: () => void;
      const read = () => cache.refresh(TENANT, () => new Promise(done => { finishRead = done; }));
      let pendingRead = during ? undefined : read();
      const pendingWrite = cache.mutate(TENANT, () => new Promise<void>(done => { finishWrite = done; }));
      if (during) pendingRead = read();
      expect(cache.get(TENANT)).toBeUndefined();
      finishWrite(); await pendingWrite;
      finishRead(on); await pendingRead;
      expect(cache.get(TENANT)).toBeUndefined();
      expect(cache.get(OTHER)).toBeDefined();
    });
  }

  test("a read completed during a write and an ambiguous failed write both invalidate", async () => {
    const cache = new CalendarAutojoinStatusCache(() => AT);
    await cache.refresh(TENANT, async () => on);
    let finishWrite!: () => void;
    const writing = cache.mutate(TENANT, () => new Promise<void>(done => { finishWrite = done; }));
    await cache.refresh(TENANT, async () => on);
    finishWrite(); await writing;
    expect(cache.get(TENANT)).toBeUndefined();
    await cache.refresh(TENANT, async () => on);
    await expect(cache.mutate(TENANT, async () => { throw new Error("synthetic write failure"); })).rejects.toThrow();
    expect(cache.get(TENANT)).toBeUndefined();
  });
});

describe("TC-1086 store mutation coverage", () => {
  test("only connection policy changes invalidate, through both writers in all three stores", async () => {
    const values = new Map<string, unknown>();
    const node = { kv: {
      async get(key: string) { return values.has(key) ? { ok: true, data: { data: values.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } }; },
      async put(key: string, value: unknown) { values.set(key, value); return { ok: true, data: {} }; },
      async delete(key: string) { values.delete(key); return { ok: true, data: {} }; },
      async list({ prefix }: { prefix: string }) { return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } }; },
    } } as unknown as TinyCloudNode;
    const stores = kvCalendarAutojoinStores(node, new BackendStorageLane());
    const cache = stores.request.statusCache;
    expect(stores.worker.statusCache).toBe(cache);
    expect(stores.dispatch.statusCache).toBe(cache);
    for (const store of Object.values(stores)) {
      for (const patch of [{ state: "disabled" as const }, { generation: 2 }, { subject: "replacement" }, { errorCode: "scan_incomplete" }]) {
        for (const writer of ["put", "update"]) {
          await store.putConnection(connectionRow());
          await cache.refresh(TENANT, async () => on);
          await cache.refresh(OTHER, async () => on);
          if (writer === "put") await store.putConnection({ ...connectionRow(TENANT.toUpperCase()), ...patch });
          else await store.updateConnection(TENANT, row => row && { ...row, ...patch });
          expect(cache.get(TENANT)).toBeUndefined();
          expect(cache.get(OTHER)).toBeDefined();
        }
      }
      await store.putConnection({ ...connectionRow(), errorCode: "scan_incomplete" });
      await cache.refresh(TENANT, async () => on);
      await store.updateConnection(TENANT, row => row && { ...row, errorCode: undefined });
      expect(cache.get(TENANT)).toBeUndefined();

      const bookkeeping = { ...connectionRow(), lastScanAt: AT + 1, nextScanAt: AT + 60_000, scanComplete: false,
        lastDispatchLag: { sentAt: AT, seconds: 1, discovered: AT }, consentAt: AT, scopes: ["synthetic-scope"],
        credentialRef: "synthetic-reference", setupId: "synthetic-setup", setupExpiresAt: AT + 1, verifiedEmail: "synthetic@example.test" };
      const retainedWrites = [
        () => store.putConnection(bookkeeping),
        () => store.updateConnection(TENANT, row => row && { ...bookkeeping, lastScanAt: AT + 2 }),
        () => store.updateConnection(TENANT, () => null),
        () => store.putOccurrence(occurrenceRow()),
        () => store.updateOccurrence(TENANT, "occurrence", row => row && { ...row, errorCode: "failed" }),
        () => store.deleteOccurrence(TENANT, "occurrence"),
      ];
      for (const write of retainedWrites) {
        await cache.refresh(TENANT, async () => on);
        await cache.refresh(OTHER, async () => on);
        await write();
        expect(cache.get(TENANT)!.body).toEqual(on);
        expect(cache.get(OTHER)).toBeDefined();
      }
    }
  });

  test("creating a connection invalidates an off response; bookkeeping preserves in-flight readers", async () => {
    const f = fixture();
    await f.connection.getStatus(TENANT);
    await f.store.putConnection(connectionRow());
    expect(f.cache.get(TENANT)).toBeUndefined();
    let finish!: (body: CalendarAutojoinStatus) => void;
    const read = f.cache.refresh(TENANT, () => new Promise(done => { finish = done; }));
    await f.store.updateConnection(TENANT, row => row && { ...row, lastScanAt: AT + 1 });
    await f.store.putOccurrence(occurrenceRow());
    finish(on); await read;
    expect(f.cache.get(TENANT)!.body).toEqual(on);
    await f.store.updateConnection(TENANT, row => { if (row) row.errorCode = "scan_incomplete"; return row; });
    expect(f.cache.get(TENANT)).toBeUndefined();
  });
});

describe("TC-1086 fallback with a running worker", () => {
  const jitters = [0, 0.5, 0.999];
  for (const jitter of jitters) {
    for (const disconnect of [false, true]) {
      test(`30 minutes of 30s ticks and 60s polls, jitter=${jitter}, disconnect=${disconnect}`, async () => {
        const f = fixture();
        const calendar: GoogleCalendarPort = { async listEvents() { return []; }, async getEvent() { return null; }, async probePrimary() {} };
        const worker = new CalendarAutojoinWorker({ store: f.store, coordinator: f.options.coordinator, calendar,
          index: new MemoryTranscriberIndexStore(), api: {} as TranscriptionApiClient, now: f.now, random: () => jitter,
          connection: { async accessToken() { return "synthetic-token"; }, async cleanupEnabling() {},
            needsReconnect: (tenant, generation) => f.connection.needsReconnect(tenant, generation) },
        });
        f.options.onDisabled = tenant => worker.cancelTenant(tenant);
        await f.store.putConnection(connectionRow());
        // Seeded pseudo-random disconnect time keeps each jitter scenario reproducible.
        const seed = (Math.imul(1_664_525, 10_860 + jitters.indexOf(jitter)) + 1_013_904_223) >>> 0;
        const disconnectSecond = 60 + Math.floor(seed / 2 ** 32 * 1_680);
        let polls = 0, stale = 0, unavailable = 0, ticks = 0, scans = 0;
        const list = spyOn(calendar, "listEvents").mockImplementation(async () => { scans++; return []; });
        try {
          await withRoute(f, async (request, lines) => {
            let lastGood: CalendarAutojoinStatus | undefined;
            for (let second = 0; second < 30 * 60; second++) {
              if (disconnect && second === disconnectSecond) {
                await f.connection.disconnect(TENANT);
                expect(f.connection.getLastGoodStatus(TENANT)).toBeUndefined();
              }
              if (second % 30 === 0) { await worker.tick(); ticks++; }
              if (second % 60 === 15) {
                if (polls > 0) f.options.statusBudgetMs = 0; // Inject a real lane deadline rejection, only on status reads.
                const response = await request(TENANT);
                const body = await response.json();
                if (polls === 0) {
                  expect(response.status).toBe(200);
                  expect(body.enabled).toBe(true);
                  lastGood = body;
                } else if (disconnect && second > disconnectSecond) {
                  unavailable++;
                  expect(response.status).toBe(503);
                  expect(body).toEqual({ error: "calendar_autojoin_unavailable" });
                  expect(response.headers.get("retry-after")).toBe("5");
                  expect(f.connection.getLastGoodStatus(TENANT)).toBeUndefined();
                } else {
                  stale++;
                  expect(response.status).toBe(200);
                  expect(body).toEqual({ ...lastGood, stale: true, asOf: new Date(AT + 15_000).toISOString() });
                }
                polls++;
              }
              f.advance(1_000);
            }
            expect(ticks).toBe(60);
            expect(polls).toBe(30);
            expect(scans).toBeGreaterThan(0);
            expect(stale + unavailable).toBe(29);
            expect(lines.filter(line => line.startsWith("[calendar-autojoin] code=status_read"))).toHaveLength(30);
            if (disconnect) expect(unavailable).toBeGreaterThan(0);
            else { expect(stale).toBe(29); expect(unavailable).toBe(0); }
          });
        } finally { list.mockRestore(); await worker.stop(); }
      });
    }
  }
});
