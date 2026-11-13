import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { CalendarAutojoinConnection, GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE } from "../services/calendar-autojoin-connection.js";
import { kvCalendarAutojoinStores, TenantCoordinator, type CalendarConnection, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import { CredentialStore, KvCredentialRowStore } from "../services/credential-store.js";
import { calendarOccurrenceIdentity, type GoogleCalendarEvent, type GoogleCalendarPort } from "../services/google-calendar.js";
import { GOOGLE_AUTOJOIN_SCOPES, type GoogleOAuthPort } from "../services/google-oauth.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import {
  computeCreateRequestHash, type CreateMeetingInput, type TranscriptionApiClient, type TranscriptionMeeting,
} from "../services/transcription-api.js";

// Node invocations of the calendar autojoin worker, counted at a fake backend node: every KV
// get/list/put/delete is one invocation. Google and ptx calls are not node calls.

const T0 = Date.parse("2026-10-13T17:30:00Z");
const TICK = 30_000;
const SUBJECT = "synthetic-subject";
const SOURCE = GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE;
const MASTER = Buffer.alloc(32, 3).toString("base64");
const tenant = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const meetEvent = (owner: string, id: string, start: number): GoogleCalendarEvent => ({
  id, status: "confirmed", summary: "Synthetic meeting", organizer: { self: true, email: "owner@example.test" },
  start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + 1_800_000).toISOString() },
  // One Meet per tenant and event: no cross-tenant capture sharing in these tests.
  hangoutLink: `https://meet.google.com/${owner.slice(-3).replace(/\d/g, digit => "abcdefghij"[Number(digit)]!)}-${id.padEnd(4, "x").slice(0, 4)}-xyz`,
});

/** A backend node that counts its KV calls as `op:kind`, where kind is the key's first segment(s). */
function countingNode(values = new Map<string, unknown>()) {
  const calls: string[] = [];
  const kind = (key: string) => key.startsWith("credentials/") ? "credentials" : key.replace(/^calendar-autojoin\/v1\/([a-z]+)\/.*$/, "$1");
  const node = { kv: {
    async get(key: string) {
      calls.push(`get:${kind(key)}`);
      return values.has(key) ? { ok: true, data: { data: structuredClone(values.get(key)) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
    },
    async put(key: string, value: unknown) { calls.push(`put:${kind(key)}`); values.set(key, structuredClone(value)); return { ok: true, data: {} }; },
    async delete(key: string) { calls.push(`delete:${kind(key)}`); values.delete(key); return { ok: true, data: {} }; },
    async list({ prefix }: { prefix: string }) {
      calls.push(`list:${kind(prefix)}`);
      return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } };
    },
  } } as unknown as TinyCloudNode;
  return { node, values, calls };
}

const tally = (calls: string[]) => calls.reduce<Record<string, number>>((all, call) => ({ ...all, [call]: (all[call] ?? 0) + 1 }), {});

/** Google, ptx and the clock, which survive a backend restart. */
function outside() {
  const clock = { now: T0 };
  const events = new Map<string, GoogleCalendarEvent[]>();
  const scans: string[] = [];
  const posts: { key: string; at: number }[] = [];
  const meetings = new Map<string, { meeting: TranscriptionMeeting; requestHash: string }>();
  let refreshes = 0;
  const owner = (token: string) => /^access-(0x[0-9a-f]{40})/.exec(token)![1]!;
  const calendar: GoogleCalendarPort = {
    async listEvents(token) { scans.push(owner(token)); return structuredClone(events.get(owner(token)) ?? []); },
    async getEvent(token, id) { return structuredClone(events.get(owner(token))?.find(event => event.id === id) ?? null); },
    async probePrimary() {},
  };
  const oauth: GoogleOAuthPort = {
    authorizeUrl() { return "https://accounts.google.com/o/oauth2/v2/auth"; },
    async exchangeCode() { throw new Error("unused"); },
    async refresh(token) {
      return { access_token: `access-${token.slice("refresh-".length)}-r${++refreshes}`, expires_in: 3_600, scope: GOOGLE_AUTOJOIN_SCOPES };
    },
    async revoke() {},
  };
  const hooks: { create?: () => Promise<void> } = {};
  const api: TranscriptionApiClient = {
    async createMeeting(input: CreateMeetingInput, options) {
      const key = options!.idempotencyKey!;
      posts.push({ key, at: clock.now });
      if (!meetings.has(key)) {
        meetings.set(key, { requestHash: computeCreateRequestHash(input), meeting: { id: `mtg_${meetings.size + 1}`, status: "in_progress",
          platform: "google_meet", meeting_url: input.meeting_url, metadata: input.metadata, created_at: new Date(clock.now).toISOString() } });
      }
      await hooks.create?.();
      return structuredClone(meetings.get(key)!.meeting);
    },
    async lookupMeetingByIdempotencyKey(key) { return structuredClone(meetings.get(key) ?? null); },
    async getMeeting(id) { return structuredClone([...meetings.values()].find(entry => entry.meeting.id === id)!.meeting); },
    async stopMeeting(id) { return { id, status: "cancelled" }; },
    async deleteMeeting() {},
    async getTranscript() { return { pending: true, status: "processing" }; },
  };
  return { clock, events, scans, posts, hooks, calendar, oauth, api };
}

/** One backend process, as index.ts wires it, on `node`. A restart is another backend() on the same node. */
function backend(node: TinyCloudNode, world: ReturnType<typeof outside>) {
  const now = () => world.clock.now;
  const lane = new BackendStorageLane();
  const stores = kvCalendarAutojoinStores(node, lane);
  const credentialOptions = { master: () => MASTER, previousMaster: () => null, now };
  const credentials = new CredentialStore(new KvCredentialRowStore(node, lane), credentialOptions);
  const backfillCredentials = new CredentialStore(new KvCredentialRowStore(node, lane, { priority: "background" }), credentialOptions);
  const coordinator = new TenantCoordinator();
  const connection = new CalendarAutojoinConnection({ store: stores.request, workerStore: stores.worker, credentials, backfillCredentials,
    oauth: world.oauth, coordinator, calendar: world.calendar, now });
  const worker = new CalendarAutojoinWorker({ store: stores.worker, dispatchStore: stores.dispatch, coordinator, connection,
    calendar: world.calendar, api: world.api, index: new MemoryTranscriberIndexStore(), now, random: () => 0 });
  return { stores, credentials, connection, worker };
}

async function seedEnabled(b: ReturnType<typeof backend>, owner: string, tokenExpiresAt: number, patch: Partial<CalendarConnection> = {}) {
  await b.stores.request.putConnection({ tenant: owner, subject: SUBJECT, state: "enabled", generation: 1,
    scopes: GOOGLE_AUTOJOIN_SCOPES.split(" "), credentialRef: SOURCE, nextScanAt: 0, scanComplete: true, ...patch });
  await b.credentials.store({ source: SOURCE, address: owner, secret: { kind: "oauth", accessToken: `access-${owner}`,
    refreshToken: `refresh-${owner}`, expiresAt: new Date(tokenExpiresAt).toISOString(), scope: GOOGLE_AUTOJOIN_SCOPES } });
}
const terminalRow = (owner: string, i: number): CalendarOccurrence => ({ id: `old-${i}`, tenant: owner, subject: SUBJECT, eventId: `old-${i}`,
  start: T0 - 2 * 86_400_000, end: T0 - 2 * 86_400_000 + 1_800_000, meetingUrl: "https://meet.google.com/old-meet-xyz", title: "Past",
  phase: "terminal", disposition: i % 2 ? "completed" : "missed_window", nextAttemptAt: 0, attemptCount: 0, stopRequested: false,
  updatedAt: T0 - 2 * 86_400_000 });
const occurrenceId = (owner: string, event: GoogleCalendarEvent) => calendarOccurrenceIdentity(owner, SUBJECT, event)!;

/** Ticks as the 30 s interval would, with the clock moving `TICK` before each. */
async function ticks(b: ReturnType<typeof backend>, world: ReturnType<typeof outside>, n: number, after?: () => void) {
  for (let i = 0; i < n; i++) { world.clock.now += TICK; await b.worker.tick(); after?.(); }
}

let log: ReturnType<typeof spyOn<typeof console, "log">>;
let warn: ReturnType<typeof spyOn<typeof console, "warn">>;
beforeEach(() => {
  log = spyOn(console, "log").mockImplementation(() => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); warn.mockRestore(); });

describe("TC-2917 calendar autojoin node invocations", () => {
  test("an idle hour costs each connected user one scan bookkeeping write and one token refresh, and a disabled user nothing", async () => {
    const { node, calls } = countingNode();
    const world = outside();
    const b = backend(node, world);
    const enabled = [1, 2, 3, 4, 5].map(tenant);
    const disabled = [6, 7, 8].map(tenant);
    for (const owner of enabled) {
      // Google access tokens last an hour: this one is refreshed once within the measured hour.
      await seedEnabled(b, owner, T0 + 20 * 60_000);
      world.events.set(owner, [meetEvent(owner, "later", T0 + 6 * 3_600_000), meetEvent(owner, "evening", T0 + 8 * 3_600_000)]);
      for (let i = 0; i < 2; i++) await b.stores.request.putOccurrence(terminalRow(owner, i));
    }
    for (const [i, owner] of disabled.entries()) {
      await b.stores.request.putConnection({ tenant: owner, subject: SUBJECT, state: i ? "disabled" : "needs_reconnect", generation: 2,
        scopes: [], nextScanAt: 0, scanComplete: false, offReason: i ? "user_disabled" : "needs_reconnect" });
      for (let j = 0; j < 2; j++) await b.stores.request.putOccurrence(terminalRow(owner, j));
    }

    // A fresh process: the first tick reads every row once and discovers the upcoming meetings.
    const restarted = backend(node, world);
    calls.length = 0;
    await restarted.worker.tick();
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
    world.scans.length = 0;

    await ticks(restarted, world, 120); // one hour
    expect(tally(calls)).toEqual({
      // One token refresh per connected user: read custody, re-read policy, rotate (read + write).
      "get:credentials": 2 * enabled.length, "get:connections": enabled.length, "put:credentials": enabled.length,
      // lastScanAt/nextScanAt reach the node when the hour turns (18:00).
      "put:connections": enabled.length,
    });
    // Discovery is unchanged: every connected user is still scanned every 60-90 s.
    for (const owner of enabled) expect(world.scans.filter(scan => scan === owner).length).toBeGreaterThanOrEqual(40);
    for (const owner of disabled) expect(world.scans).not.toContain(owner);
    // Terminal history is retained and still reported.
    for (const owner of [...enabled, ...disabled]) {
      expect((await restarted.stores.request.listOccurrences(owner)).filter(row => row.phase === "terminal")).toHaveLength(2);
    }
    const status = await restarted.connection.getStatus(enabled[0]!);
    expect(status.lastScanAt).toBe(world.clock.now);
    expect(status.outcomes.map(outcome => outcome.id)).toEqual(["old-0"]);
  });

  test("a join is sent once, at the first tick of its window, with the policy read from the node", async () => {
    const { node, calls } = countingNode();
    const world = outside();
    const b = backend(node, world);
    const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 86_400_000);
    const start = T0 + 10 * 60_000;
    const event = meetEvent(owner, "soon", start);
    world.events.set(owner, [event]);
    await b.worker.tick();
    await ticks(b, world, 30, () => {
      if (world.posts.length === 0) expect(world.clock.now).toBeLessThan(start - 60_000 + TICK);
    });
    expect(world.posts).toHaveLength(1);
    expect(world.posts[0]!.at).toBeGreaterThanOrEqual(start - 60_000);
    expect(world.posts[0]!.at).toBeLessThan(start - 60_000 + TICK);
    const row = await b.stores.request.getOccurrence(owner, occurrenceId(owner, event));
    expect(row?.meetingId).toBe("mtg_1");
    expect(row?.phase).toBe("sent");
    // While the bot is in the call, each minute's recording poll writes its next attempt.
    calls.length = 0;
    await ticks(b, world, 4);
    expect(tally(calls)).toEqual({ "put:occurrences": 2 });
    expect(world.posts).toHaveLength(1);
  });

  test("a connection disabled behind the cache sends nothing: dispatch reads policy from the node", async () => {
    const { node, values } = countingNode();
    const world = outside();
    const b = backend(node, world);
    const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 86_400_000);
    const start = T0 + 5 * 60_000;
    world.events.set(owner, [meetEvent(owner, "soon", start)]);
    await b.worker.tick();
    const key = [...values.keys()].find(k => k.startsWith("calendar-autojoin/v1/connections/"))!;
    values.set(key, { ...(values.get(key) as CalendarConnection), state: "disabled", generation: 2 });
    await ticks(b, world, 12);
    expect(world.posts).toHaveLength(0);
    expect((await b.stores.request.listOccurrences(owner))[0]?.disposition).toBe("autojoin_disabled");
  });

  test("a restart rebuilds from the node and joins on time", async () => {
    const { node } = countingNode();
    const world = outside();
    const first = backend(node, world);
    const owner = tenant(1);
    await seedEnabled(first, owner, T0 + 86_400_000);
    const start = T0 + 10 * 60_000;
    world.events.set(owner, [meetEvent(owner, "soon", start)]);
    await first.worker.tick(); // discovers the meeting, then the process ends
    await ticks(first, world, 4);
    await first.worker.stop();

    const second = backend(node, world);
    await ticks(second, world, 20);
    expect(world.posts).toHaveLength(1);
    expect(world.posts[0]!.at).toBeGreaterThanOrEqual(start - 60_000);
    expect(world.posts[0]!.at).toBeLessThan(start - 60_000 + TICK);
  });

  test("a restart after the durable intent recovers the sent join instead of sending another", async () => {
    const { node } = countingNode();
    const world = outside();
    const first = backend(node, world);
    const owner = tenant(1);
    await seedEnabled(first, owner, T0 + 86_400_000);
    const start = T0 + 2 * 60_000;
    const event = meetEvent(owner, "soon", start);
    world.events.set(owner, [event]);
    await first.worker.tick();
    // The process dies while the POST is in flight: ptx created the meeting, the backend never heard.
    const sent = Promise.withResolvers<void>();
    world.hooks.create = () => { sent.resolve(); return Promise.withResolvers<void>().promise; };
    world.clock.now = start - 60_000;
    void first.worker.tick();
    await sent.promise;
    expect(world.posts).toHaveLength(1);
    world.hooks.create = undefined;

    const second = backend(node, world);
    await ticks(second, world, 4);
    expect(world.posts).toHaveLength(1);
    const row = await second.stores.request.getOccurrence(owner, occurrenceId(owner, event));
    expect(row?.meetingId).toBe("mtg_1");
    expect(row?.phase).toBe("sent");
  });

  test("a disconnected user stops costing node calls and Google scans", async () => {
    const { node, calls } = countingNode();
    const world = outside();
    const b = backend(node, world);
    const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 86_400_000);
    world.events.set(owner, [meetEvent(owner, "later", T0 + 6 * 3_600_000)]);
    await b.worker.tick();
    await b.connection.disconnect(owner);
    await ticks(b, world, 1); // removes nothing more, and checks once that no custody is left
    calls.length = 0;
    world.scans.length = 0;
    await ticks(b, world, 120);
    expect(calls).toEqual([]);
    expect(world.scans).toEqual([]);
    expect((await b.connection.getStatus(owner)).offReason).toBe("disconnected");
  });

  test("a write that fails stays out of memory: the next read goes to the node", async () => {
    const { node, values, calls } = countingNode();
    const world = outside();
    const b = backend(node, world);
    const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 86_400_000);
    await b.stores.worker.getConnection(owner);
    const put = node.kv.put.bind(node.kv);
    const failing = spyOn(node.kv, "put").mockImplementation(async (key: string, value: unknown) => {
      await put(key, value); // committed, but the response is lost
      return { ok: false, error: { code: "FAILED", message: "Synthetic lost response" } } as never;
    });
    try {
      await expect(b.stores.worker.updateConnection(owner, row => row && { ...row, errorCode: "synthetic" })).rejects.toThrow();
    } finally { failing.mockRestore(); }
    calls.length = 0;
    expect((await b.stores.worker.getConnection(owner))?.errorCode).toBe("synthetic");
    expect(calls).toEqual(["get:connections"]);
    expect([...values.values()].some(value => (value as CalendarConnection).errorCode === "synthetic")).toBe(true);
  });

  test("N idle connections x K ticks: zero node calls once warm", async () => {
    // Run against cdf60bf8 too (copy this file to the baseline worktree); the stderr line is the
    // before/after count in the PR. Idle: no meeting in the scan window, a valid token for the
    // whole window, no hour boundary. Each user keeps 2 finished meetings; 5 more are disabled.
    const N = 10, DISABLED = 5, K = 20;
    const { node, calls } = countingNode();
    const world = outside();
    const b = backend(node, world);
    for (let n = 1; n <= N; n++) {
      const owner = tenant(n);
      await seedEnabled(b, owner, T0 + 86_400_000);
      world.events.set(owner, [meetEvent(owner, "later", T0 + 6 * 3_600_000)]);
      for (let i = 0; i < 2; i++) await b.stores.request.putOccurrence(terminalRow(owner, i));
    }
    for (let n = N + 1; n <= N + DISABLED; n++) {
      const owner = tenant(n);
      await b.stores.request.putConnection({ tenant: owner, subject: SUBJECT, state: "disabled", generation: 2,
        scopes: [], nextScanAt: 0, scanComplete: false, offReason: "user_disabled" });
      for (let i = 0; i < 2; i++) await b.stores.request.putOccurrence(terminalRow(owner, i));
    }
    const restarted = backend(node, world);
    await restarted.worker.tick(); // warm-up: the first tick after a restart reads every row
    calls.length = 0;
    world.scans.length = 0;
    await ticks(restarted, world, K);
    console.error(`[TC-2917 count] connections=${N}+${DISABLED}disabled ticks=${K} node_calls=${calls.length} google_scans=${world.scans.length}`);
    expect(calls).toEqual([]);
    // Discovery keeps its cadence: every connected user is scanned every 60-90 s.
    for (let n = 1; n <= N; n++) expect(world.scans.filter(scan => scan === tenant(n)).length).toBeGreaterThanOrEqual(6);
  });

  test("a grant backfill on every tick re-reads connections from the node, and keeps the scan cadence", async () => {
    const { node, calls } = countingNode();
    const world = outside();
    const b = backend(node, world);
    const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 86_400_000);
    world.events.set(owner, [meetEvent(owner, "later", T0 + 6 * 3_600_000)]);
    await b.worker.tick();
    world.scans.length = 0;
    calls.length = 0;
    // An untrusted grant index backfills on each tick: its reads come from the node, but the scan
    // times staged in memory (persisted hourly) survive them.
    for (let i = 0; i < 20; i++) { b.connection.invalidateGrantReferences(); world.clock.now += TICK; await b.worker.tick(); }
    expect(calls.filter(call => call === "get:connections")).toHaveLength(20);
    expect(world.scans).toHaveLength(10);
  });

  test("a second worker on the same store is refused, and stopping it keeps the first's claim", async () => {
    const { node } = countingNode();
    const world = outside();
    const b = backend(node, world);
    const second = new CalendarAutojoinWorker({ store: b.stores.worker, dispatchStore: b.stores.dispatch, coordinator: new TenantCoordinator(),
      connection: b.connection, calendar: world.calendar, api: world.api, index: new MemoryTranscriberIndexStore(), now: () => world.clock.now });
    b.worker.start();
    try {
      expect(() => second.start()).toThrow("calendar_autojoin_worker_already_started");
      await second.stop();
      expect(() => second.start()).toThrow("calendar_autojoin_worker_already_started");
    } finally { await b.worker.stop(); }
    // Released by its owner: a restarted worker can take the store.
    second.start();
    await second.stop();
  });
});
