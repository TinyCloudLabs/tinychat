import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane, BackendStorageLaneTimeout, type BackendStorageLaneRunOptions } from "../services/backend-storage-lane.js";
import { CalendarAutojoinConnection } from "../services/calendar-autojoin-connection.js";
import {
  kvCalendarAutojoinStores, MemoryCalendarAutojoinStore, TenantCoordinator,
  type CalendarAutojoinStore, type CalendarConnection, type CalendarOccurrence,
} from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import { CredentialStore, InMemoryCredentialRowStore } from "../services/credential-store.js";
import { calendarOccurrenceIdentity, eligibleCalendarEvent, type GoogleCalendarEvent, type GoogleCalendarPort } from "../services/google-calendar.js";
import type { GoogleOAuthPort } from "../services/google-oauth.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import type { CreateMeetingInput, TranscriptionApiClient, TranscriptionMeeting } from "../services/transcription-api.js";

// TC-1047: a row awaiting dispatch is reconciled at its nextAttemptAt by a due-time timer, not
// whenever the (on prod, ~2 min) tick next reaches it. All tests run on fake timers: Date.now, the
// worker's timers, the lane's wait budgets and the slow fake node all share one clock.

const T0 = Date.parse("2026-10-13T17:30:00Z");
const QA = `0x${"a".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;
const SUBJECT = "google-subject";
const TITLE = "Private standup";
const EMAIL = "someone@example.test";

const meetEvent = (start: number, patch: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent => ({
  id: "event-qa", status: "confirmed", summary: TITLE, organizer: { self: true, email: EMAIL },
  start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 1_800_000).toISOString() },
  hangoutLink: "https://meet.google.com/abc-defg-hij", ...patch,
});
const connectionRow = (tenant: string, patch: Partial<CalendarConnection> = {}): CalendarConnection => ({
  tenant, subject: SUBJECT, state: "enabled", generation: 1, scopes: [], nextScanAt: 0, scanComplete: true, ...patch,
});
const pendingRow = (tenant: string, event: GoogleCalendarEvent): CalendarOccurrence => {
  const eligible = eligibleCalendarEvent(event)!;
  return { id: calendarOccurrenceIdentity(tenant, SUBJECT, event)!, tenant, subject: SUBJECT, ...eligible,
    phase: "pending", nextAttemptAt: eligible.start - 60_000, attemptCount: 0, stopRequested: false,
    firstSeenAt: T0, updatedAt: T0 };
};
const gate = <T>() => {
  let open!: (value: T) => void;
  const opened = new Promise<T>(resolve => { open = resolve; });
  return { open, opened };
};

/** Lets every promise chain started by the timers that just fired run to its next timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}
async function advance(ms: number, step = 5, until: () => boolean = () => false): Promise<void> {
  for (let elapsed = 0; elapsed < ms && !until(); elapsed += step) {
    jest.advanceTimersByTime(step);
    await flush();
  }
}

function harness(store: CalendarAutojoinStore, dispatchStore?: CalendarAutojoinStore) {
  const events = new Map<string, GoogleCalendarEvent[]>();
  const posts: { input: CreateMeetingInput; key: string; at: number }[] = [];
  const gets: { tenant: string; at: number }[] = [];
  const records = new Map<string, TranscriptionMeeting>();
  const hooks: { getEvent?: (tenant: string, event: GoogleCalendarEvent | null) => Promise<GoogleCalendarEvent | null> } = {};
  const tenantOf = (token: string) => token.slice("tok:".length);
  const calendar: GoogleCalendarPort = {
    async listEvents(token) { return structuredClone(events.get(tenantOf(token)) ?? []); },
    async getEvent(token, id) {
      const tenant = tenantOf(token);
      gets.push({ tenant, at: Date.now() });
      const found = structuredClone(events.get(tenant)?.find(e => e.id === id) ?? null);
      return hooks.getEvent ? hooks.getEvent(tenant, found) : found;
    },
    async probePrimary() {},
  };
  const api: TranscriptionApiClient = {
    async createMeeting(input, options) {
      const key = options!.idempotencyKey!;
      posts.push({ input: structuredClone(input), key, at: Date.now() });
      if (!records.has(key)) {
        records.set(key, { id: `mtg_${records.size + 1}`, status: "in_progress", platform: "google_meet",
          meeting_url: input.meeting_url, metadata: input.metadata, created_at: new Date().toISOString() });
      }
      return structuredClone(records.get(key)!);
    },
    async lookupMeetingByIdempotencyKey() { return null; },
    async getMeeting(id) { return structuredClone([...records.values()].find(m => m.id === id)!); },
    async stopMeeting(id) { return { id, status: "cancelled" }; },
    async deleteMeeting() {},
    async getTranscript() { return { pending: true, status: "processing" }; },
  };
  const coordinator = new TenantCoordinator();
  const worker = new CalendarAutojoinWorker({
    store, dispatchStore, coordinator, calendar, api, index: new MemoryTranscriberIndexStore(), random: () => 0,
    connection: {
      async accessToken(tenant: string) { return `tok:${tenant}`; },
      async cleanupEnabling() {},
      async needsReconnect() {},
    },
  });
  async function stop(): Promise<void> {
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await advance(60_000, 50, () => stopped);
    await stopping;
  }
  return { events, posts, gets, hooks, coordinator, worker, stop };
}

let logs: string[] = [];
beforeEach(() => {
  // Not setSystemTime: on bun 1.3 it does not move the fake clock that advanceTimersByTime drives.
  jest.useFakeTimers({ now: T0 });
  logs = [];
  spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  spyOn(console, "warn").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/** A backend node whose KV calls each take `delay.ms` on the fake clock: a prod node call, scaled down. */
function slowNode(values: Map<string, unknown>, delay: { ms: number }, onOp: (op: string, key: string) => void = () => {}) {
  // Zero-delay seeding must not wait for the fake clock.
  const wait = async () => { if (delay.ms > 0) await new Promise(resolve => setTimeout(resolve, delay.ms)); };
  return { kv: {
    async get(key: string) {
      await wait(); onOp("get", key);
      if (!values.has(key)) return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      return { ok: true, data: { data: structuredClone(values.get(key)) } };
    },
    async put(key: string, value: unknown) { await wait(); onOp("put", key); values.set(key, structuredClone(value)); return { ok: true, data: {} }; },
    async list({ prefix }: { prefix: string }) {
      await wait(); onOp("list", prefix);
      return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } };
    },
    async delete(key: string) { await wait(); onOp("delete", key); values.delete(key); return { ok: true, data: {} }; },
  } } as unknown as TinyCloudNode;
}

describe("TC-1047 due-time dispatch on a slow lane", () => {
  test("a row that becomes due mid-tick is sent within 2 s of nextAttemptAt, before that tick even ends", async () => {
    const values = new Map<string, unknown>();
    const delay = { ms: 0 };
    const lane = new BackendStorageLane();
    const stores = kvCalendarAutojoinStores(slowNode(values, delay), lane);
    const h = harness(stores.worker, stores.dispatch);
    // Three busy tenants, each listing 60 rows twice per tick (scan + row loop): one serial lane.
    const busy = ["1", "2", "3"].map(digit => `0x${digit.repeat(40)}`);
    for (const tenant of busy) {
      await stores.request.putConnection(connectionRow(tenant));
      for (let i = 0; i < 60; i++) {
        await stores.request.putOccurrence({ ...pendingRow(tenant, meetEvent(T0 + 86_400_000, { id: `e${i}` })),
          id: `row-${i}`, phase: "terminal", disposition: "not_accepted" });
      }
    }
    await stores.request.putConnection(connectionRow(QA, { scanComplete: false }));
    // Created two minutes ahead, as in the TC-988 live check: the window opens 10 s into the tick.
    const start = T0 + 70_000;
    const dueAt = start - 60_000;
    h.events.set(QA, [meetEvent(start)]);
    delay.ms = 50;

    h.worker.start();
    const tickDone = () => logs.some(line => line.includes("code=tick_done"));
    await advance(dueAt - T0 - 1, 5);
    // The QA tenant's pass is long over, so only a timer can send this row before the next tick.
    expect(h.posts).toHaveLength(0);
    expect(tickDone()).toBe(false);
    await advance(10_000, 5, () => h.posts.length > 0);

    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.at - dueAt).toBeGreaterThanOrEqual(0);
    expect(h.posts[0]!.at - dueAt).toBeLessThanOrEqual(2_000);
    // Tick-only dispatch would have waited for this tick to end and the next one to reach the row.
    expect(tickDone()).toBe(false);
    await advance(60_000, 50, tickDone);
    expect(tickDone()).toBe(true);
    expect(logs.find(line => line.includes("code=tick_done"))).toMatch(/ tenants=4 rows=181 scans=4 /);
    expect(h.posts).toHaveLength(1);
    await h.stop();
  }, 30_000);

  test("the dispatch path runs at request priority, and the recording poll stays in the background", async () => {
    const values = new Map<string, unknown>();
    const ops: { op: string; key: string; priority: string }[] = [];
    let current = "none";
    const lane = new BackendStorageLane();
    const run = lane.run.bind(lane);
    // Jobs run one at a time, so the priority of the job that started last is that of every node op it makes.
    lane.run = (<T>(fn: () => Promise<T>, options?: BackendStorageLaneRunOptions) =>
      run(() => { current = options?.priority ?? "foreground"; return fn(); }, options)) as typeof lane.run;
    const delay = { ms: 0 };
    const stores = kvCalendarAutojoinStores(slowNode(values, delay, (op, key) => {
      ops.push({ op, key: key.replace(/^calendar-autojoin\/v1\/([a-z]+)\/.*$/, "$1"), priority: current });
    }), lane);
    const h = harness(stores.worker, stores.dispatch);
    const event = meetEvent(T0 + 65_000);
    h.events.set(QA, [event]);
    await stores.request.putConnection(connectionRow(QA, { nextScanAt: T0 + 3_600_000 }));
    await stores.request.putOccurrence(pendingRow(QA, event));
    delay.ms = 10;

    h.worker.start();
    await advance(2_000, 5);
    // The tick listed the row, found it not yet due, and armed its timer.
    expect(h.posts).toHaveLength(0);
    ops.length = 0;
    await advance(10_000, 5, () => ops.some(o => o.op === "get" && o.key === "connections" && o.priority === "background"));

    expect(h.posts).toHaveLength(1);
    const marker = ops.findIndex(o => o.key === "sent");
    expect(marker).toBeGreaterThan(0);
    // Up to the ownership write after the marker (one read-modify-write job): the dispatch path.
    const dispatchPath = ops.slice(0, marker + 3);
    expect(dispatchPath.map(o => `${o.op}:${o.key}`)).toEqual([
      "get:occurrences", "get:connections", // reconcileOccurrence
      "get:captures", // observeOwners
      "get:occurrences", "get:connections", // the locked re-read
      "get:captures", "get:captures", "put:captures", // the capture claim: read, then read-modify-write
      "put:occurrences", // the intent
      "get:connections", "put:connections", // lastDispatchLag
      "get:occurrences", "put:occurrences", // acceptRecording
      "put:sent", "get:occurrences", "put:occurrences", // ownership
    ]);
    expect(dispatchPath.filter(o => o.priority !== "foreground")).toEqual([]);
    // reconcileRecording's own reads keep the worker's background priority.
    expect(ops[marker + 3]).toEqual({ op: "get", key: "connections", priority: "background" });
    await h.stop();
  });
});

describe("TC-1047 due-time timers", () => {
  async function seeded(dispatchStore?: (store: MemoryCalendarAutojoinStore) => CalendarAutojoinStore) {
    const store = new MemoryCalendarAutojoinStore();
    const h = harness(store, dispatchStore?.(store));
    const event = meetEvent(T0 + 65_000);
    const row = pendingRow(QA, event);
    h.events.set(QA, [event]);
    await store.putConnection(connectionRow(QA, { nextScanAt: T0 + 3_600_000 }));
    await store.putOccurrence(row);
    return { ...h, store, event, row, dueAt: row.nextAttemptAt, read: () => store.getOccurrence(QA, row.id) };
  }

  test("timer first, then the tick: one dispatch, one POST", async () => {
    const f = await seeded();
    const held = gate<void>();
    f.hooks.getEvent = async (_tenant, found) => { await held.opened; return found; };
    f.worker.start();
    await advance(f.dueAt - T0, 5);
    expect(f.gets).toHaveLength(1); // the timer's dispatch, waiting on Google

    const tick = f.worker.tick(); // the row is due, but busy: the tick skips it
    await flush();
    expect(f.gets).toHaveLength(1);
    held.open();
    await tick;
    await advance(1_000, 5);
    expect(f.posts).toHaveLength(1);
    expect((await f.read())?.phase).toBe("sent");
    await advance(65_000, 50); // later ticks reconcile the recording, never a second POST
    expect(f.posts).toHaveLength(1);
    // A sent row is not awaiting dispatch: its timer was cancelled, and ticks do not re-arm it.
    expect(logs.filter(line => line.includes("code=tick_done")).at(-1)).toEndWith(" timers=0");
    await f.stop();
  });

  test("tick first, then the timer: one dispatch, one POST", async () => {
    // Discovered with its window already open: the scan's write arms a timer for now, and the
    // tick's row loop takes the row before that timer runs.
    const store = new MemoryCalendarAutojoinStore();
    const h = harness(store);
    h.events.set(QA, [meetEvent(T0 + 30_000)]);
    await store.putConnection(connectionRow(QA, { scanComplete: false }));
    const held = gate<void>();
    h.hooks.getEvent = async (_tenant, found) => { await held.opened; return found; };
    h.worker.start();
    await flush();
    expect(h.gets).toHaveLength(1); // the tick's dispatch, waiting on Google
    jest.advanceTimersByTime(1); // the row's timer fires while the tick holds the row
    await flush();
    expect(h.gets).toHaveLength(1);
    held.open();
    await advance(1_000, 5);
    expect(h.posts).toHaveLength(1);
    await h.stop();
  });

  test("a scan that ends the row while its timer's dispatch waits on Google sends nothing", async () => {
    const f = await seeded();
    const held = gate<void>();
    f.hooks.getEvent = async (_tenant, found) => { await held.opened; return found; };
    f.worker.start();
    await advance(f.dueAt - T0, 5);
    expect(f.gets).toHaveLength(1);
    // The user declines; the next scan finishes the pending row before the dispatch takes the lock.
    f.events.set(QA, [meetEvent(T0 + 65_000, { organizer: { self: false }, attendees: [{ self: true, responseStatus: "declined" }] })]);
    await f.store.updateConnection(QA, c => c && { ...c, nextScanAt: 0 });
    await f.worker.tick();
    expect(await f.read()).toMatchObject({ phase: "terminal", disposition: "event_ineligible" });
    held.open();
    await advance(1_000, 5);
    expect(f.posts).toHaveLength(0);
    expect(await f.read()).toMatchObject({ phase: "terminal", disposition: "event_ineligible" });
    await f.stop();
  });

  for (const action of ["disable", "disconnect", "needsReconnect"] as const) {
    test(`${action} cancels the tenant's timers; the tick still settles the row`, async () => {
      const f = await seeded();
      const service = new CalendarAutojoinConnection({
        store: f.store, coordinator: f.coordinator, calendar: { async probePrimary() {} },
        credentials: new CredentialStore(new InMemoryCredentialRowStore(), {
          master: () => "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=", previousMaster: () => null,
        }),
        oauth: { async revoke() {} } as unknown as GoogleOAuthPort,
        onDisabled: tenant => f.worker.cancelTenant(tenant),
      });
      f.worker.start();
      await advance(1_000, 5);
      if (action === "disable") await service.disable(QA);
      else if (action === "disconnect") await service.disconnect(QA);
      else await service.needsReconnect(QA, 1);
      await advance(f.dueAt - T0 + 5_000, 5);
      // A fired timer would have reconciled the row; nothing ran before the next tick.
      expect(f.gets).toHaveLength(0);
      expect((await f.read())?.phase).toBe("pending");
      await advance(30_000, 50);
      expect(await f.read()).toMatchObject({ phase: "terminal", disposition: "autojoin_disabled" });
      expect(f.posts).toHaveLength(0);
      await f.stop();
    });
  }

  test("a reschedule cancels the old timer; a later tick arms the new time", async () => {
    const store = new MemoryCalendarAutojoinStore();
    const h = harness(store);
    h.events.set(QA, [meetEvent(T0 + 65_000)]);
    await store.putConnection(connectionRow(QA));
    h.worker.start();
    await advance(1_000, 5);
    const id = calendarOccurrenceIdentity(QA, SUBJECT, meetEvent(T0 + 65_000))!;
    expect((await store.getOccurrence(QA, id))?.nextAttemptAt).toBe(T0 + 5_000);
    // The meeting moves; the next scan rewrites the row's due time past the timer horizon.
    const moved = T0 + 200_000;
    h.events.set(QA, [meetEvent(moved)]);
    await store.updateConnection(QA, c => c && { ...c, nextScanAt: 0 });
    await h.worker.tick();
    expect((await store.getOccurrence(QA, id))?.nextAttemptAt).toBe(moved - 60_000);
    // A fired stale timer would re-read the row (and find it not yet in its window).
    const reads = spyOn(store, "getOccurrence");
    await advance(10_000, 5);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(h.gets).toHaveLength(0);
    await advance(moved - 60_000 - Date.now() + 2_000, 20, () => h.posts.length > 0);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.at - (moved - 60_000)).toBeLessThanOrEqual(2_000);
    await h.stop();
  });

  test("a reschedule within the horizon moves the timer to the new time", async () => {
    const store = new MemoryCalendarAutojoinStore();
    const h = harness(store);
    h.events.set(QA, [meetEvent(T0 + 65_000)]);
    await store.putConnection(connectionRow(QA));
    h.worker.start();
    await advance(1_000, 5);
    const moved = T0 + 100_000;
    h.events.set(QA, [meetEvent(moved)]);
    await store.updateConnection(QA, c => c && { ...c, nextScanAt: 0 });
    await h.worker.tick();
    const reads = spyOn(store, "getOccurrence");
    await advance(10_000, 5);
    expect(reads).not.toHaveBeenCalled(); // nothing at the old time
    reads.mockRestore();
    await advance(moved - 60_000 - Date.now() + 2_000, 5, () => h.posts.length > 0);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]!.at - (moved - 60_000)).toBeGreaterThanOrEqual(0);
    expect(h.posts[0]!.at - (moved - 60_000)).toBeLessThanOrEqual(2_000);
    await h.stop();
  });

  test("a lane timeout before the intent write sends no POST and the row is retried soon after", async () => {
    let failIntent = true;
    const f = await seeded(store => Object.assign(Object.create(store) as CalendarAutojoinStore, {
      async putOccurrence(row: CalendarOccurrence) {
        if (failIntent && row.phase === "outcome_unknown") throw new BackendStorageLaneTimeout("backend storage lane wait exceeded 12000ms");
        await store.putOccurrence(row);
      },
    }));
    f.worker.start();
    await advance(f.dueAt - T0 + 100, 5);
    expect(f.posts).toHaveLength(0);
    const deferred = await f.read();
    expect(deferred).toMatchObject({ phase: "pending", errorCode: "autojoin_retry" });
    expect(deferred?.idempotencyKey).toBeUndefined();
    expect(deferred!.nextAttemptAt - Date.now()).toBeLessThan(30_000);
    failIntent = false;
    await advance(10_000, 5, () => f.posts.length > 0);
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.at).toBeLessThan(T0 + 30_000); // a timer retry, not the next tick
    await advance(1_000, 5);
    expect((await f.read())?.phase).toBe("sent");
    await f.stop();
  });

  test("tick_done reports duration and counts only", async () => {
    const f = await seeded();
    await f.store.putConnection(connectionRow(OTHER, { nextScanAt: 0 }));
    f.worker.start();
    await advance(1_000, 5);
    const done = logs.filter(line => line.includes("code=tick_done"));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatch(/^\[calendar-autojoin\] code=tick_done ms=\d+ tenants=2 rows=1 scans=1 timers=1$/);
    for (const value of [QA, OTHER, SUBJECT, TITLE, EMAIL, f.row.id, f.event.id, f.event.hangoutLink!]) {
      expect(done[0]).not.toContain(value);
    }
    await f.stop();
  });
});
