import { describe, expect, spyOn, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { createCalendarAutojoinRouter } from "../routes/calendar-autojoin.js";
import { BackendStorageLane, BackendStorageLaneTimeout } from "../services/backend-storage-lane.js";
import { CalendarAutojoinConnection, CalendarAutojoinError, type CalendarAutojoinConnectionOptions } from "../services/calendar-autojoin-connection.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator, kvCalendarAutojoinStores, type CalendarConnection, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinStatusCache, STATUS_CACHE_MAX_AGE_MS, STATUS_CACHE_MAX_TENANTS, type CalendarAutojoinStatus } from "../services/calendar-autojoin-status-cache.js";
import type { CredentialStore } from "../services/credential-store.js";
import { GoogleOAuthError, type GoogleOAuthPort } from "../services/google-oauth.js";

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
  const options: CalendarAutojoinConnectionOptions = { store, credentials: {} as CredentialStore, oauth: {} as GoogleOAuthPort,
    calendar: { async probePrimary() {} }, coordinator: new TenantCoordinator() };
  const connection = new CalendarAutojoinConnection(options);
  return { store, cache, connection, options, advance(ms: number) { now += ms; } };
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
    await withRoute(f, async (request, lines) => {
      const fresh = await request(TENANT.toUpperCase());
      const body = await fresh.json();
      expect(body.stale).toBeUndefined();
      timing(fresh, "ok", 3, lines[0]);
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

  test("a failure partway through the N+2 reads reports attempts and keeps the complete cached body", async () => {
    const f = fixture();
    await f.store.putConnection(connectionRow());
    await f.store.putOccurrence(occurrenceRow());
    await f.store.putOccurrence({ ...occurrenceRow(), id: "second-occurrence", start: AT + 1_000 });
    await withRoute(f, async (request, lines) => {
      const fresh = await request(TENANT);
      const body = await fresh.json();
      expect(body.outcomes).toHaveLength(2);
      timing(fresh, "ok", 4, lines[0]);
      const lane = spyOn(BackendStorageLane.prototype, "run")
        .mockImplementationOnce(fn => fn()) // connection
        .mockImplementationOnce(fn => fn()) // keys
        .mockImplementationOnce(fn => fn()) // first occurrence
        .mockRejectedValueOnce(new Error("synthetic row read failure"));
      try {
        const response = await request(TENANT);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ...body, stale: true, asOf: new Date(AT).toISOString() });
        timing(response, "stale", 4, lines[1]);
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
  test("every status-changing write in every store invalidates the shared tenant cache", async () => {
    const values = new Map<string, unknown>();
    const node = { kv: {
      async get(key: string) { return { ok: true, data: { data: values.get(key) ?? null } }; },
      async put(key: string, value: unknown) { values.set(key, value); return { ok: true, data: {} }; },
      async delete(key: string) { values.delete(key); return { ok: true, data: {} }; },
      async list({ prefix }: { prefix: string }) { return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } }; },
    } } as unknown as TinyCloudNode;
    const stores = kvCalendarAutojoinStores(node, new BackendStorageLane());
    const cache = stores.request.statusCache;
    expect(stores.worker.statusCache).toBe(cache);
    expect(stores.dispatch.statusCache).toBe(cache);
    for (const store of Object.values(stores)) {
      await store.putConnection(connectionRow());
      await store.putOccurrence(occurrenceRow());
      const mutations = [
        () => store.putConnection(connectionRow(TENANT.toUpperCase())),
        () => store.updateConnection(TENANT, row => row && { ...row, state: "disabled" }),
        () => store.putOccurrence(occurrenceRow()),
        () => store.updateOccurrence(TENANT, "occurrence", row => row && { ...row, errorCode: "failed" }),
        () => store.deleteOccurrence(TENANT, "occurrence"),
      ];
      for (const mutate of mutations) {
        await cache.refresh(TENANT, async () => on);
        await cache.refresh(OTHER, async () => on);
        await mutate();
        expect(cache.get(TENANT)).toBeUndefined();
        expect(cache.get(OTHER)).toBeDefined();
      }
    }
  });
});
