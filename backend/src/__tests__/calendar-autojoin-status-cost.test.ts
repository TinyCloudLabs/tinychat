import { describe, expect, spyOn, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane, BackendStorageLaneTimeout } from "../services/backend-storage-lane.js";
import { CalendarAutojoinConnection, GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE } from "../services/calendar-autojoin-connection.js";
import { TenantCoordinator, kvCalendarAutojoinStores, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import { CredentialStore, KvCredentialRowStore } from "../services/credential-store.js";
import type { GoogleCalendarPort } from "../services/google-calendar.js";
import type { GoogleOAuthPort } from "../services/google-oauth.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import type { TranscriptionApiClient } from "../services/transcription-api.js";
import express from "express";
import type { AddressInfo } from "node:net";
import { createCalendarAutojoinRouter } from "../routes/calendar-autojoin.js";

const TENANT = `0x${"1".repeat(40)}`;
const AT = Date.parse("2026-10-14T12:00:00Z");
const occurrence = (index: number): CalendarOccurrence => ({ tenant: TENANT, subject: "synthetic-subject", id: `row-${index}`,
  eventId: `event-${index}`, start: AT + index, end: AT + 60_000, meetingUrl: "https://meet.google.com/abc-defg-hij",
  title: "Synthetic metadata", phase: "terminal", disposition: "missed_window", nextAttemptAt: 0,
  attemptCount: 0, stopRequested: false, updatedAt: AT });

function fixture(values = new Map<string, unknown>()) {
  let now = AT;
  let summaryFailures = 0;
  const node = { kv: {
    async get(key: string) { return values.has(key) ? { ok: true, data: { data: structuredClone(values.get(key)) } }
      : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } }; },
    async put(key: string, value: unknown) {
      if (key.startsWith("calendar-autojoin/v1/status/") && summaryFailures > 0) {
        summaryFailures--; return { ok: false, error: { code: "FAILED", message: "Synthetic summary write failure" } };
      }
      values.set(key, structuredClone(value)); return { ok: true, data: {} };
    },
    async delete(key: string) { values.delete(key); return { ok: true, data: {} }; },
    async list({ prefix }: { prefix: string }) { return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } }; },
  } } as unknown as TinyCloudNode;
  const lane = new BackendStorageLane();
  const stores = kvCalendarAutojoinStores(node, lane);
  const coordinator = new TenantCoordinator();
  const credentials = new CredentialStore(new KvCredentialRowStore(node, lane), {
    master: () => Buffer.alloc(32, 1).toString("base64"), previousMaster: () => null, now: () => now,
  });
  const calendar: GoogleCalendarPort = { async listEvents() { return []; }, async getEvent() { return null; }, async probePrimary() {} };
  const options = { store: stores.request, credentials, calendar, coordinator,
    oauth: { async revoke() {} } as GoogleOAuthPort, now: () => now, statusBudgetMs: 12_000 };
  const connection = new CalendarAutojoinConnection(options);
  const worker = new CalendarAutojoinWorker({ store: stores.worker, dispatchStore: stores.dispatch, connection,
    coordinator, calendar, index: new MemoryTranscriberIndexStore(), api: {} as TranscriptionApiClient, now: () => now, random: () => 0 });
  return { values, node, options, lane, stores, connection, worker, calendar, credentials, advance(ms: number) { now += ms; },
    failNextSummaryWrite() { summaryFailures++; },
    async seed(n: number) {
      await stores.request.putConnection({ tenant: TENANT, subject: "synthetic-subject", state: "enabled", generation: 1,
        scopes: [], nextScanAt: 0, scanComplete: true });
      await credentials.store({ source: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, address: TENANT, secret: {
        kind: "oauth", accessToken: "synthetic-token", refreshToken: "synthetic-refresh",
        expiresAt: new Date(AT + 86_400_000).toISOString(),
      } });
      for (let i = 0; i < n; i++) await stores.worker.putOccurrence(occurrence(i));
    },
  };
}

async function withStatus(f: ReturnType<typeof fixture>, run: (request: () => Promise<Response>) => Promise<void>) {
  const app = express();
  app.use((req, _res, next) => { req.user = { address: TENANT } as typeof req.user; next(); });
  app.use("/autojoin", createCalendarAutojoinRouter({ connection: f.connection }));
  const server = app.listen(0); await new Promise<void>(done => server.once("listening", done));
  try { await run(() => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/autojoin/status`)); }
  finally { await new Promise<void>(done => server.close(() => done())); }
}

describe("TC-1086 status cost", () => {
  for (const n of [0, 30, 500]) {
    test(`bounded status and measured tick lane jobs N=${n}`, async () => {
      const f = fixture(); await f.seed(n);
      const run = spyOn(f.lane, "run");
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await f.worker.tick();
        const tickJobs = run.mock.calls.length;
        expect(tickJobs).toBe(2 * n + 11 + (n === 0 ? 0 : 1));
        run.mockClear();
        await withStatus(f, async request => {
          const response = await request();
          expect(response.status).toBe(200);
          const status = await response.json();
          expect(run.mock.calls.length).toBe(2);
          expect(run.mock.calls.length).toBeLessThanOrEqual(3);
          expect(status.outcomes).toHaveLength(Math.min(n, 30));
          expect(response.headers.get("server-timing")).toMatch(/^status;dur=\d+;desc="reads=2"$/);
        });
        run.mockClear();
        f.advance(30_000); // No scan due, no changed summary.
        await f.worker.tick();
        expect(run.mock.calls.length).toBe(n + 6);
      } finally { run.mockRestore(); log.mockRestore(); await f.worker.stop(); }
    });
  }

  test("cold process reads a persisted summary in two jobs without any occurrence listing", async () => {
    const f = fixture(); await f.seed(500); await f.worker.tick();
    const restarted = fixture(f.values);
    const listing = spyOn(restarted.node.kv, "list").mockRejectedValue(new Error("foreground listing forbidden"));
    const run = spyOn(restarted.lane, "run");
    try {
      const status = await restarted.connection.getStatus(TENANT);
      expect(status.outcomes).toHaveLength(30);
      expect(status.outcomes[0].id).toBe("row-499");
      expect(run.mock.calls).toHaveLength(2);
      expect(listing).not.toHaveBeenCalled();
    } finally { listing.mockRestore(); run.mockRestore(); await f.worker.stop(); await restarted.worker.stop(); }
  });

  for (const n of [0, 30, 500]) {
    test(`a cold legacy tenant uses N+2 listing jobs until the next tick N=${n}`, async () => {
      const f = fixture(); await f.seed(n);
      for (const key of f.values.keys()) if (key.startsWith("calendar-autojoin/v1/status/")) f.values.delete(key);
      const run = spyOn(f.lane, "run");
      const listing = spyOn(f.node.kv, "list");
      const log = spyOn(console, "log").mockImplementation(() => {});
      try {
        await withStatus(f, async request => {
          const cold = await request();
          expect(cold.status).toBe(200);
          const outcomes = Array.from({ length: Math.min(n, 30) }, (_, i) => ({
            id: `row-${n - 1 - i}`, title: "Synthetic metadata", start: AT + n - 1 - i, reason: "missed_window",
          }));
          expect(await cold.json()).toEqual({ state: "on", enabled: true, lastScanAt: null,
            lastDispatchLag: null, errorCode: null, outcomes });
          expect(run.mock.calls).toHaveLength(n + 2);
          expect(listing).toHaveBeenCalledTimes(1);
          expect(cold.headers.get("server-timing")).toMatch(new RegExp(`^status;dur=\\d+;desc="reads=${n + 2}"$`));
          expect(log.mock.calls).toHaveLength(1);
          expect(log.mock.calls[0]).toHaveLength(1);
          expect(log.mock.calls[0][0]).toMatch(new RegExp(`^\\[calendar-autojoin\\] code=status_read outcome=ok ms=\\d+ reads=${n + 2}$`));
          await f.worker.tick(); run.mockClear(); listing.mockClear(); log.mockClear();
          const warmed = await request();
          expect(warmed.status).toBe(200);
          expect(await warmed.json()).toEqual({ state: "on", enabled: true, lastScanAt: AT,
            lastDispatchLag: null, errorCode: null, outcomes });
          expect(run.mock.calls).toHaveLength(2);
          expect(warmed.headers.get("server-timing")).toMatch(/^status;dur=\d+;desc="reads=2"$/);
          expect(listing).not.toHaveBeenCalled();
        });
      } finally { run.mockRestore(); listing.mockRestore(); log.mockRestore(); await f.worker.stop(); }
    });
  }

  test("a legacy listing timeout uses fix 1's last-good body", async () => {
    const f = fixture(); await f.seed(30);
    for (const key of f.values.keys()) if (key.startsWith("calendar-autojoin/v1/status/")) f.values.delete(key);
    const get = f.node.kv.get.bind(f.node.kv);
    const read = spyOn(f.node.kv, "get");
    try {
      await withStatus(f, async request => {
        const good = await request();
        const body = await good.json();
        expect(good.status).toBe(200);
        read.mockImplementation(async key => {
          if (key.startsWith("calendar-autojoin/v1/occurrences/")) throw new BackendStorageLaneTimeout("Synthetic timeout");
          return get(key);
        });
        const stale = await request();
        expect(stale.status).toBe(200);
        expect(await stale.json()).toEqual({ ...body, stale: true, asOf: expect.any(String) });
        expect(stale.headers.get("server-timing")).toMatch(/^status;dur=\d+;desc="reads=3"$/);
      });
    } finally { read.mockRestore(); await f.worker.stop(); }
  });

  test("the summary probe cannot start a legacy listing after the shared deadline", async () => {
    const f = fixture(); await f.seed(30); f.options.statusBudgetMs = 10;
    for (const key of f.values.keys()) if (key.startsWith("calendar-autojoin/v1/status/")) f.values.delete(key);
    let wallClock = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => wallClock);
    const get = f.node.kv.get.bind(f.node.kv);
    const read = spyOn(f.node.kv, "get").mockImplementation(async key => {
      if (key.startsWith("calendar-autojoin/v1/status/")) wallClock += 11;
      return get(key);
    });
    const listing = spyOn(f.node.kv, "list");
    try {
      await withStatus(f, async request => {
        const response = await request();
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        expect(listing).not.toHaveBeenCalled();
        expect(response.headers.get("server-timing")).toMatch(/^status;dur=\d+;desc="reads=2"$/);
      });
    } finally { clock.mockRestore(); read.mockRestore(); listing.mockRestore(); await f.worker.stop(); }
  });

  test("legacy occurrence reads retain the same deadline instead of restarting the budget", async () => {
    const f = fixture(); await f.seed(30); f.options.statusBudgetMs = 10;
    for (const key of f.values.keys()) if (key.startsWith("calendar-autojoin/v1/status/")) f.values.delete(key);
    let wallClock = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => wallClock);
    const get = f.node.kv.get.bind(f.node.kv);
    const read = spyOn(f.node.kv, "get").mockImplementation(async key => {
      if (key.startsWith("calendar-autojoin/v1/occurrences/")) wallClock += 11;
      return get(key);
    });
    try {
      await withStatus(f, async request => {
        const response = await request();
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        expect(read.mock.calls).toHaveLength(3); // Connection, summary probe, first occurrence.
        expect(response.headers.get("server-timing")).toMatch(/^status;dur=\d+;desc="reads=4"$/);
      });
    } finally { clock.mockRestore(); read.mockRestore(); await f.worker.stop(); }
  });

  test("a disconnect invalidates a last-good connected body populated by the legacy listing", async () => {
    const f = fixture(); await f.seed(30);
    for (const key of f.values.keys()) if (key.startsWith("calendar-autojoin/v1/status/")) f.values.delete(key);
    try {
      await withStatus(f, async request => {
        expect((await (await request()).json()).enabled).toBe(true);
        await f.connection.disconnect(TENANT);
        f.options.statusBudgetMs = 0;
        const response = await request();
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: "calendar_autojoin_unavailable" });
        expect(f.connection.getLastGoodStatus(TENANT)).toBeUndefined();
      });
    } finally { await f.worker.stop(); }
  });

  test("a new connection is immediately readable before its first tick", async () => {
    const f = fixture(); await f.seed(0);
    expect(await f.connection.getStatus(TENANT)).toMatchObject({ enabled: true, outcomes: [] });
  });

  test("enabling a setup persisted before summary deployment immediately backfills its history", async () => {
    const f = fixture(); await f.seed(30);
    const setupId = "s".repeat(43);
    await f.stores.request.updateConnection(TENANT, row => row && { ...row, state: "enabling", setupId, setupExpiresAt: AT + 60_000 });
    for (const key of f.values.keys()) if (key.startsWith("calendar-autojoin/v1/status/")) f.values.delete(key);
    const restarted = fixture(f.values);
    try {
      const status = await restarted.connection.enable(TENANT, setupId);
      expect(status).toMatchObject({ state: "on", enabled: true });
      expect(status.outcomes).toHaveLength(30);
    } finally { await f.worker.stop(); await restarted.worker.stop(); }
  });

  test("a dispatch outcome created after the tick's listing is visible when that tick finishes", async () => {
    const f = fixture(); await f.seed(0);
    await f.stores.worker.putOccurrence({ ...occurrence(0), end: AT + 1_800_000, disposition: undefined, phase: "pending" });
    expect((await f.connection.getStatus(TENANT)).outcomes).toEqual([]);
    try {
      await f.worker.tick();
      expect((await f.connection.getStatus(TENANT)).outcomes).toEqual([
        { id: "row-0", title: "Synthetic metadata", start: AT, reason: "event_ineligible" },
      ]);
      const summaryWrites = [...f.values.keys()].filter(key => key.startsWith("calendar-autojoin/v1/status/"));
      expect(summaryWrites).toHaveLength(1);
    } finally { await f.worker.stop(); }
  });

  test("a changed outcome and dispatch lag are fresh within one tick, with no extra summary reads", async () => {
    const f = fixture(); await f.seed(1); await f.worker.tick();
    await f.stores.dispatch.updateOccurrence(TENANT, "row-0", row => row && { ...row, errorCode: "capacity_exhausted" });
    await f.stores.dispatch.updateConnection(TENANT, row => row && { ...row, lastDispatchLag: { sentAt: AT, seconds: 2, discovered: AT } });
    const summaryRead = spyOn(f.stores.worker, "getStatusSummary");
    try {
      await f.worker.tick();
      const status = await f.connection.getStatus(TENANT);
      expect(status.outcomes[0].reason).toBe("capacity_exhausted");
      expect(status.lastDispatchLag).toEqual({ sentAt: AT, seconds: 2, discovered: AT });
      expect(summaryRead).not.toHaveBeenCalled();
    } finally { summaryRead.mockRestore(); await f.worker.stop(); }
  });

  test("retention deletion is reflected in the same tick's summary", async () => {
    const f = fixture(); await f.seed(1); await f.worker.tick();
    await f.stores.request.updateConnection(TENANT, row => row && { ...row, state: "disabled" });
    f.advance(31 * 86_400_000);
    try {
      await f.worker.tick();
      expect((await f.connection.getStatus(TENANT)).outcomes).toEqual([]);
    } finally { await f.worker.stop(); }
  });

  test("user publication cannot leave a worker's deduplication state pointing at an older summary", async () => {
    const f = fixture(); await f.seed(1); await f.worker.tick();
    await f.stores.dispatch.updateOccurrence(TENANT, "row-0", row => row && { ...row, errorCode: "capacity_exhausted" });
    await f.connection.disable(TENANT); // User teardown publishes the changed history.
    expect((await f.connection.getStatus(TENANT)).outcomes[0].reason).toBe("capacity_exhausted");
    await f.stores.dispatch.updateOccurrence(TENANT, "row-0", row => row && { ...row, errorCode: undefined });
    try {
      await f.worker.tick();
      expect((await f.connection.getStatus(TENANT)).outcomes[0].reason).toBe("missed_window");
    } finally { await f.worker.stop(); }
  });

  test("a failed summary publication leaves dispatch outcomes durable and is retried next tick", async () => {
    const f = fixture(); await f.seed(0);
    await f.stores.worker.putOccurrence({ ...occurrence(0), end: AT + 1_800_000, disposition: undefined, phase: "pending" });
    f.failNextSummaryWrite();
    try {
      await f.worker.tick();
      expect(await f.stores.worker.getOccurrence(TENANT, "row-0")).toMatchObject({ phase: "terminal", disposition: "event_ineligible" });
      expect((await f.connection.getStatus(TENANT)).outcomes).toEqual([]);
      await f.worker.tick();
      expect((await f.connection.getStatus(TENANT)).outcomes[0].reason).toBe("event_ineligible");
    } finally { await f.worker.stop(); }
  });

  test("summaries remain tenant-isolated and status always overlays current connection policy", async () => {
    const f = fixture(); await f.seed(1);
    const other = `0x${"2".repeat(40)}`;
    await f.stores.request.putConnection({ tenant: other, subject: "other-subject", state: "enabled", generation: 1,
      scopes: [], nextScanAt: 0, scanComplete: true });
    await f.credentials.store({ source: GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, address: other, secret: {
      kind: "oauth", accessToken: "synthetic-other-token", refreshToken: "synthetic-other-refresh", expiresAt: new Date(AT + 86_400_000).toISOString(),
    } });
    await f.stores.worker.putOccurrence({ ...occurrence(2), tenant: other, subject: "other-subject", id: "other-row" });
    try {
      await f.worker.tick();
      expect((await f.connection.getStatus(TENANT.toUpperCase())).outcomes.map(row => row.id)).toEqual(["row-0"]);
      expect((await f.connection.getStatus(other)).outcomes.map(row => row.id)).toEqual(["other-row"]);
      await f.stores.request.updateConnection(TENANT, row => row && { ...row, errorCode: "needs_reconnect", state: "needs_reconnect", generation: 2 });
      expect(await f.connection.getStatus(TENANT)).toMatchObject({ state: "needs_reconnect", enabled: false, errorCode: "needs_reconnect" });
    } finally { await f.worker.stop(); }
  });

  for (const operation of ["disable", "browserReconnect", "disconnect", "needsReconnect"] as const) {
    test(`${operation} is immediately reflected with history, even on a legacy missing-summary tenant`, async () => {
      const f = fixture(); await f.seed(30);
      for (const key of f.values.keys()) if (key.startsWith("calendar-autojoin/v1/status/")) f.values.delete(key);
      try {
        if (operation === "needsReconnect") await f.connection.needsReconnect(TENANT, 1);
        else await f.connection[operation](TENANT);
        const status = await f.connection.getStatus(TENANT);
        expect(status.enabled).toBe(false);
        expect(status.state).toBe(operation === "needsReconnect" ? "needs_reconnect" : "off");
        expect(status.outcomes).toHaveLength(30);
      } finally { await f.worker.stop(); }
    });
  }
});
