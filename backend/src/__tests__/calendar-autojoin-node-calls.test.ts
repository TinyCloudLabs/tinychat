import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { ACCESS_TOKEN_TTL_MS, CalendarAutojoinConnection, GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE } from "../services/calendar-autojoin-connection.js";
import { KvCalendarAutojoinStore, kvCalendarAutojoinStores, TenantCoordinator, type CalendarConnection, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import { CredentialCustody, CredentialStore, KvCredentialRowStore } from "../services/credential-store.js";
import { fakeBackendNode } from "./helpers/fake-backend-node.js";
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

/** The shared realistic node (content-hash ETags, conditional put and delete), counting its KV calls
 *  as `op:kind`, where kind is the key's first segment(s). */
function countingNode(values = new Map<string, unknown>()) {
  const calls: string[] = [];
  const kind = (key: string) => key.startsWith("credentials/") ? "credentials" : key.replace(/^calendar-autojoin\/v1\/([a-z]+)\/.*$/, "$1");
  const { node } = fakeBackendNode(values, { before(op, key) { calls.push(`${op}:${kind(key)}`); } });
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
  test("an idle hour costs each connected user one scan bookkeeping write, one token refresh and one policy read per scan, and a disabled user nothing", async () => {
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
      // get:credentials, 14 per user: a cached token serves at most ACCESS_TOKEN_TTL_MS (5 min) after
      // its custody read, so custody is read 12 times an hour (one of them the refresh's), and the one
      // token refresh adds the rotation's read before its write and its read-back after it.
      // get:connections: the refresh's policy re-read (5), the node read before each hourly write
      // below (5), and the policy read from the node before each of the 300 Google scans (60 per user).
      "get:credentials": 14 * enabled.length, "get:connections": 310, "put:credentials": enabled.length,
      // lastScanAt/nextScanAt reach the node when the hour turns (18:00).
      "put:connections": enabled.length,
    });
    expect(world.scans).toHaveLength(300);
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
    // While the bot is in the call, each minute's recording poll reads consent from the node twice
    // (before the Google check and before the stop check) and writes its next attempt; each of the
    // two Google scans reads it once.
    calls.length = 0;
    await ticks(b, world, 4);
    expect(tally(calls)).toEqual({ "put:occurrences": 2, "get:connections": 6 });
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

  test("N idle connections x K ticks: once warm, one policy read per Google scan and nothing else", async () => {
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
    // The policy read from the node before each Google scan, and a custody read when a cached token
    // passes its 5-minute TTL (twice per connected user in these 10 minutes); disabled users and
    // finished meetings cost 0.
    expect(world.scans).toHaveLength(100);
    expect(tally(calls)).toEqual({ "get:connections": 100, "get:credentials": 2 * N });
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
    // 20 backfill reads plus the policy read before each of the 10 scans.
    expect(calls.filter(call => call === "get:connections")).toHaveLength(30);
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

  // Bobbie's #693 review (P1): writes made outside this process must never be overwritten or ignored.
  test("an external disable survives 31+ minutes of ticks, and a later meeting gets no bot", async () => {
    const { node, values } = countingNode();
    const world = outside(); const b = backend(node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 50 * 60_000);
    await b.worker.tick();
    const key = [...values.keys()].find(k => k.startsWith("calendar-autojoin/v1/connections/"))!;
    const stored = values.get(key) as CalendarConnection;
    values.set(key, { ...stored, state: "disabled", generation: 2, offReason: "user_disabled" });
    world.scans.length = 0;
    await ticks(b, world, 62);
    expect(values.get(key)).toMatchObject({ state: "disabled", generation: 2, offReason: "user_disabled" });
    world.events.set(owner, [meetEvent(owner, "late", world.clock.now + 30_000)]);
    await ticks(b, world, 3);
    expect(world.posts).toHaveLength(0);
    expect(world.scans).toEqual([]);
    expect(values.get(key)).toMatchObject({ state: "disabled", generation: 2 });
  });

  test("an external deletion stays deleted, and the account is no longer scanned", async () => {
    const { node, values } = countingNode();
    const world = outside(); const b = backend(node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 50 * 60_000);
    await b.worker.tick();
    const key = [...values.keys()].find(k => k.startsWith("calendar-autojoin/v1/connections/"))!;
    values.delete(key);
    world.scans.length = 0;
    await ticks(b, world, 62);
    expect(values.has(key)).toBe(false);
    world.events.set(owner, [meetEvent(owner, "late", world.clock.now + 30_000)]);
    await ticks(b, world, 3);
    expect(values.has(key)).toBe(false);
    expect(world.posts).toHaveLength(0);
    expect(world.scans).toEqual([]);
  });

  test("an external disable during a recording stops the bot at the next recording poll", async () => {
    const { node, values } = countingNode();
    const world = outside(); const b = backend(node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 86_400_000);
    const start = T0 + 5 * 60_000;
    const event = meetEvent(owner, "soon", start);
    world.events.set(owner, [event]);
    await b.worker.tick();
    await ticks(b, world, 12);
    expect(world.posts).toHaveLength(1);
    const stop = spyOn(world.api, "stopMeeting");
    const key = [...values.keys()].find(k => k.startsWith("calendar-autojoin/v1/connections/"))!;
    values.set(key, { ...(values.get(key) as CalendarConnection), state: "disabled", generation: 2, offReason: "user_disabled" });
    await ticks(b, world, 2);
    expect(stop).toHaveBeenCalledTimes(1);
    const row = await b.stores.request.getOccurrence(owner, occurrenceId(owner, event));
    expect(row?.stopRequested).toBe(true);
    expect(values.get(key)).toMatchObject({ state: "disabled", generation: 2 });
  });

  test("a credential deleted through another CredentialStore is not used from the token cache", async () => {
    const { node } = countingNode();
    const world = outside(); const b = backend(node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 86_400_000);
    await b.worker.tick(); // caches the access token
    // Another store instance in this process (as a connector route would hold) ends custody.
    const other = new CredentialStore(new KvCredentialRowStore(node, new BackendStorageLane()), { master: () => MASTER, previousMaster: () => null });
    await other.delete(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, owner);
    world.scans.length = 0;
    world.events.set(owner, [meetEvent(owner, "soon", world.clock.now + 90_000)]);
    await ticks(b, world, 8);
    expect(world.scans).toEqual([]);
    expect(world.posts).toHaveLength(0);
    expect((await b.stores.request.getConnection(owner))?.state).toBe("needs_reconnect");
  });

  test("an expired setup whose connection was deleted elsewhere stays deleted", async () => {
    const { node, values } = countingNode();
    const world = outside(); const b = backend(node, world); const owner = tenant(1);
    await b.stores.request.putConnection({ tenant: owner, subject: null, state: "enabling", generation: 1, scopes: [],
      nextScanAt: 0, scanComplete: false, setupId: "setup", setupExpiresAt: T0 + 5 * 60_000 });
    await b.worker.tick();
    const key = [...values.keys()].find(k => k.startsWith("calendar-autojoin/v1/connections/"))!;
    values.delete(key);
    await ticks(b, world, 12);
    expect(values.has(key)).toBe(false);
  });

  test("a credential deleted elsewhere while a token refresh is in flight is not written back or cached", async () => {
    const { node, values } = countingNode();
    const world = outside(); const b = backend(node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 30_000); // the first scan refreshes
    const refresh = world.oauth.refresh.bind(world.oauth);
    const other = new CredentialStore(new KvCredentialRowStore(node, new BackendStorageLane()), { master: () => MASTER, previousMaster: () => null });
    const spy = spyOn(world.oauth, "refresh").mockImplementation(async token => {
      await other.delete(GOOGLE_AUTOJOIN_CREDENTIAL_SOURCE, owner);
      return refresh(token);
    });
    try { await ticks(b, world, 8); } finally { spy.mockRestore(); }
    expect([...values.keys()].filter(k => k.startsWith("credentials/"))).toEqual([]);
    expect(world.scans).toEqual([]);
    expect((await b.stores.request.getConnection(owner))?.state).toBe("needs_reconnect");
  });
});

// ── TC-2917 (#697, Bobbie's review): races with writers outside the worker ─────────────────────
// The shared realistic node, with hooks to act between calls; its `values` are the node's data, so
// setting or deleting one is a write by a writer outside the backend.

interface NodeHooks {
  afterGet?(key: string): void | Promise<void>;
  beforePut?(key: string, value: unknown): void | Promise<void>;
  /** After the put is applied, before the caller gets its answer. */
  afterPut?(key: string): void | Promise<void>;
  beforeDelete?(key: string): void | Promise<void>;
}
/** `values`: share one node's data between two of these, each its own process's view with its own hooks. */
function versionedNode(values = new Map<string, unknown>()) {
  const hooks: NodeHooks = {};
  const { node } = fakeBackendNode(values, {
    async before(op, key, value) {
      if (op === "put") await hooks.beforePut?.(key, value);
      if (op === "delete") await hooks.beforeDelete?.(key);
    },
    async after(op, key) {
      if (op === "get") await hooks.afterGet?.(key);
      if (op === "put") await hooks.afterPut?.(key);
    },
  });
  return {
    node, hooks, values,
    /** An external write: the node changes without the backend. */
    set(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    remove(key: string) { values.delete(key); },
    value(key: string) { return structuredClone(values.get(key)); },
    keyOf(prefix: string) { return [...values.keys()].find(key => key.startsWith(prefix))!; },
  };
}

/** As backend(), exposing the lane and credential options, with the token-map bound settable. */
function wired(node: TinyCloudNode, world: ReturnType<typeof outside>, options: { accessTokenCacheMax?: number; custody?: CredentialCustody } = {}) {
  const now = () => world.clock.now;
  const lane = new BackendStorageLane();
  const stores = kvCalendarAutojoinStores(node, lane);
  const credentialOptions = { master: () => MASTER, previousMaster: () => null, now, custody: options.custody };
  const credentials = new CredentialStore(new KvCredentialRowStore(node, lane), credentialOptions);
  const backfillCredentials = new CredentialStore(new KvCredentialRowStore(node, lane, { priority: "background" }), credentialOptions);
  const coordinator = new TenantCoordinator();
  const connection = new CalendarAutojoinConnection({ store: stores.request, workerStore: stores.worker, credentials, backfillCredentials,
    oauth: world.oauth, coordinator, calendar: world.calendar, now, accessTokenCacheMax: options.accessTokenCacheMax });
  const worker = new CalendarAutojoinWorker({ store: stores.worker, dispatchStore: stores.dispatch, coordinator, connection,
    calendar: world.calendar, api: world.api, index: new MemoryTranscriberIndexStore(), now, random: () => 0 });
  /** A second CredentialStore on the same lane, as another route of this backend would hold. */
  const otherCredentials = () => new CredentialStore(new KvCredentialRowStore(node, lane), credentialOptions);
  return { stores, credentials, connection, worker, lane, otherCredentials };
}
const CONNECTIONS = "calendar-autojoin/v1/connections/";
const credentialKey = (owner: string) => `credentials/${SOURCE}/${owner.toLowerCase()}`;
// The service's private token map: these tests assert what it holds.
const tokenMap = (connection: CalendarAutojoinConnection): Map<string, unknown> => connection["accessTokens"];

describe("TC-2917 writers outside the worker (Bobbie's #697 probes)", () => {
  test("1a: a credential deleted while its OAuth refresh is in flight stays deleted, and nothing is served or scanned", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 30_000); // the first use refreshes
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refresh = world.oauth.refresh.bind(world.oauth);
    const spy = spyOn(world.oauth, "refresh").mockImplementation(async token => { entered.resolve(); await release.promise; return refresh(token); });
    const other = b.otherCredentials();
    try {
      const served = b.connection.accessToken(owner);
      await entered.promise;
      await other.delete(SOURCE, owner);
      expect(await other.status(SOURCE, owner)).toBeNull();
      release.resolve();
      await expect(served).rejects.toThrow("connection_changed");
    } finally { spy.mockRestore(); }
    expect(await other.status(SOURCE, owner)).toBeNull();
    expect(tokenMap(b.connection).size).toBe(0);
    world.scans.length = 0;
    await ticks(b, world, 4);
    expect(world.scans).toEqual([]);
    expect(await other.status(SOURCE, owner)).toBeNull();
  });

  test("1b: a delete queued on the lane between the rotation's read and its write wins; the rotation is refused", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 30_000);
    const other = b.otherCredentials();
    let reads = 0;
    let deleted: Promise<void> | undefined;
    v.hooks.afterGet = key => {
      // Read 1: the custody read before the refresh. Read 2: the rotation's own read.
      if (key === credentialKey(owner) && ++reads === 2) deleted = other.delete(SOURCE, owner);
    };
    await expect(b.connection.accessToken(owner)).rejects.toThrow("connection_changed");
    v.hooks.afterGet = undefined;
    expect(deleted).toBeDefined();
    await deleted;
    expect(await other.status(SOURCE, owner)).toBeNull();
    expect(tokenMap(b.connection).size).toBe(0);
    world.scans.length = 0;
    await ticks(b, world, 4);
    expect(world.scans).toEqual([]);
  });

  test("a credential stored by another CredentialStore during an in-flight refresh is kept; the refresh is refused", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 30_000);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refresh = world.oauth.refresh.bind(world.oauth);
    const spy = spyOn(world.oauth, "refresh").mockImplementation(async token => { entered.resolve(); await release.promise; return refresh(token); });
    const other = b.otherCredentials();
    try {
      const served = b.connection.accessToken(owner);
      await entered.promise;
      await other.store({ source: SOURCE, address: owner, secret: { kind: "oauth", accessToken: `access-${owner}-new`, refreshToken: "refresh-new",
        expiresAt: new Date(world.clock.now + 3_600_000).toISOString(), scope: GOOGLE_AUTOJOIN_SCOPES } });
      release.resolve();
      await expect(served).rejects.toThrow("connection_changed");
    } finally { spy.mockRestore(); }
    const stored = await other.getCredential(SOURCE, owner, "fetch-worker");
    expect(stored).toMatchObject({ refreshToken: "refresh-new", accessToken: `access-${owner}-new` });
    expect(tokenMap(b.connection).size).toBe(0);
  });

  test("a token read while a delete elsewhere is in flight is not served once the delete settles", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 50 * 60_000);
    const gate = Promise.withResolvers<void>();
    const kv = v.node.kv;
    const remove = kv.delete.bind(kv);
    const spy = spyOn(kv, "delete").mockImplementation(async (key: string) => {
      if (key === credentialKey(owner)) await gate.promise;
      return remove(key);
    });
    // A CredentialStore on another lane: its delete is requested, then held at the node.
    const elsewhere = new CredentialStore(new KvCredentialRowStore(v.node, new BackendStorageLane()), { master: () => MASTER, previousMaster: () => null });
    try {
      const deleted = elsewhere.delete(SOURCE, owner);
      await b.connection.accessToken(owner).catch(() => undefined); // may read and cache the old secret
      gate.resolve();
      await deleted;
    } finally { spy.mockRestore(); }
    expect(await elsewhere.status(SOURCE, owner)).toBeNull();
    await expect(b.connection.accessToken(owner)).rejects.toThrow();
    expect(tokenMap(b.connection).size).toBe(0);
  });

  test("3a: an expired cached setup whose connection was deleted on the node stays deleted", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await b.stores.request.putConnection({ tenant: owner, subject: null, state: "enabling", generation: 1, scopes: [],
      nextScanAt: 0, scanComplete: false, setupId: "setup", setupExpiresAt: T0 + 5 * 60_000 });
    await b.worker.tick();
    const key = v.keyOf(CONNECTIONS);
    v.remove(key);
    world.clock.now = T0 + 6 * 60_000;
    await b.worker.tick();
    expect(v.value(key)).toBeUndefined();
  });

  for (const between of ["the reads", "the read and the write"] as const) {
    test(`3b: a connection deleted between ${between} of the expired-setup disable is not recreated`, async () => {
      const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
      await b.stores.request.putConnection({ tenant: owner, subject: null, state: "enabling", generation: 1, scopes: [],
        nextScanAt: 0, scanComplete: false, setupId: "setup", setupExpiresAt: T0 + 5 * 60_000 });
      await b.worker.tick();
      const key = v.keyOf(CONNECTIONS);
      world.clock.now = T0 + 6 * 60_000;
      let deleted = false;
      if (between === "the reads") {
        // The node shows the valid expired setup to the first read, then the row goes.
        v.hooks.afterGet = k => { if (k === key && !deleted) { deleted = true; v.remove(key); } };
      } else {
        v.hooks.beforePut = k => { if (k === key && !deleted) { deleted = true; v.remove(key); } };
      }
      await b.worker.tick();
      expect(deleted).toBe(true);
      expect(v.value(key)).toBeUndefined();
      await ticks(b, world, 4);
      expect(v.value(key)).toBeUndefined();
    });
  }

  {
    test("mid-scan disable: a disable stored while a scan runs is kept, and no bot is sent", async () => {
      const v = versionedNode();
      const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
      await seedEnabled(b, owner, T0 + 86_400_000);
      // The first scan's bookkeeping reaches the node in the 17:00 hour; the blocked one is past 18:00,
      // so its bookkeeping is a durable write.
      world.clock.now = T0 + 29 * 60_000 + 30_000;
      await b.worker.tick();
      const key = v.keyOf(CONNECTIONS);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const list = world.calendar.listEvents.bind(world.calendar);
      const spy = spyOn(world.calendar, "listEvents").mockImplementation(async (token, now) => {
        entered.resolve(); await release.promise; return list(token, now);
      });
      world.clock.now += 60_000;
      const tick = b.worker.tick();
      await entered.promise;
      v.set(key, { ...(v.value(key) as CalendarConnection), state: "disabled", generation: 2, offReason: "user_disabled" });
      release.resolve();
      await tick;
      spy.mockRestore();
      expect(v.value(key)).toMatchObject({ state: "disabled", generation: 2, offReason: "user_disabled" });
      world.events.set(owner, [meetEvent(owner, "later", world.clock.now + 10 * 60_000)]);
      await ticks(b, world, 62);
      expect(v.value(key)).toMatchObject({ state: "disabled", generation: 2 });
      expect(world.posts).toHaveLength(0);
    });
  }

  for (const change of ["disables", "deletes"] as const) {
    test(`CAS: a writer that ${change} the connection between the worker's read and its PUT wins (412, re-read)`, async () => {
      const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
      await seedEnabled(b, owner, T0 + 86_400_000);
      world.clock.now = T0 + 29 * 60_000 + 30_000;
      await b.worker.tick();
      const key = v.keyOf(CONNECTIONS);
      let changed = false;
      v.hooks.beforePut = (k, value) => {
        if (k !== key || changed || (value as CalendarConnection).state !== "enabled") return;
        changed = true;
        if (change === "deletes") v.remove(key);
        else v.set(key, { ...(v.value(key) as CalendarConnection), state: "disabled", generation: 2, offReason: "user_disabled" });
      };
      // The next scan is past 18:00: its bookkeeping is the worker's durable connection write.
      await ticks(b, world, 3);
      expect(changed).toBe(true);
      v.hooks.beforePut = undefined;
      if (change === "deletes") expect(v.value(key)).toBeUndefined();
      else expect(v.value(key)).toMatchObject({ state: "disabled", generation: 2 });
      world.events.set(owner, [meetEvent(owner, "later", world.clock.now + 10 * 60_000)]);
      await ticks(b, world, 62);
      if (change === "deletes") expect(v.value(key)).toBeUndefined();
      else expect(v.value(key)).toMatchObject({ state: "disabled", generation: 2 });
      expect(world.posts).toHaveLength(0);
    });
  }

  test("an external disable reaches a running recording at its next poll, with no scan due to refresh memory", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 86_400_000);
    const start = T0 + 5 * 60_000;
    const event = meetEvent(owner, "soon", start);
    world.events.set(owner, [event]);
    await b.worker.tick();
    await ticks(b, world, 12);
    expect(world.posts).toHaveLength(1);
    // Keep the next Google scan (and its fresh policy read) out of the window: memory only.
    await b.stores.worker.updateConnection(owner, row => row && { ...row, nextScanAt: world.clock.now + 30 * 60_000 });
    const key = v.keyOf(CONNECTIONS);
    v.set(key, { ...(v.value(key) as CalendarConnection), state: "disabled", generation: 2, offReason: "user_disabled" });
    const stop = spyOn(world.api, "stopMeeting");
    world.scans.length = 0;
    await ticks(b, world, 2);
    expect(world.scans).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await b.stores.request.getOccurrence(owner, occurrenceId(owner, event)))?.stopRequested).toBe(true);
    expect(v.value(key)).toMatchObject({ state: "disabled", generation: 2 });
  });

  test("token map: a cached token is evicted when the connection is seen disabled, and stays gone a day later", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 50 * 60_000);
    await b.worker.tick();
    expect(tokenMap(b.connection).size).toBe(1);
    const key = v.keyOf(CONNECTIONS);
    v.set(key, { ...(v.value(key) as CalendarConnection), state: "disabled", generation: 2, offReason: "user_disabled" });
    await ticks(b, world, 4);
    expect(tokenMap(b.connection).size).toBe(0);
    world.clock.now += 86_400_000;
    await ticks(b, world, 2);
    expect(tokenMap(b.connection).size).toBe(0);
  });

  test("token map: bounded, least recently used out, and expired entries swept", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world, { accessTokenCacheMax: 2 }); const owners = [1, 2, 3].map(tenant);
    for (const owner of owners) await seedEnabled(b, owner, T0 + 50 * 60_000);
    await b.worker.tick();
    expect(tokenMap(b.connection).size).toBe(2);
    expect([...tokenMap(b.connection).keys()]).toEqual(owners.slice(1).map(owner => owner.toLowerCase()));
    // Past expiry, with no scan due (Google is failing): the sweep still drops them.
    world.calendar.listEvents = async () => { throw new Error("synthetic outage"); };
    world.clock.now = T0 + 51 * 60_000;
    await b.connection.cleanupEnabling(owners[0]!);
    expect(tokenMap(b.connection).size).toBe(0);
  });
});

// ── TC-2917 (#697, Bobbie's round 5): two backend processes on one realistic node ──────────────────
// Each process has its own lane, row cache, coordinator, token map and custody registry, as two
// backend processes would; only the node (content-hash ETags, conditional put and delete) is shared.

function twoProcesses(world: ReturnType<typeof outside>) {
  const values = new Map<string, unknown>();
  const nodeA = versionedNode(values);
  const nodeB = versionedNode(values);
  return { nodeA, nodeB, values,
    A: wired(nodeA.node, world, { custody: new CredentialCustody() }),
    B: wired(nodeB.node, world, { custody: new CredentialCustody() }) };
}
/** Holds every OAuth refresh until `release`; `entered` resolves once one is waiting. */
function gateRefresh(world: ReturnType<typeof outside>) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const refresh = world.oauth.refresh.bind(world.oauth);
  const spy = spyOn(world.oauth, "refresh").mockImplementation(async token => { entered.resolve(); await release.promise; return refresh(token); });
  return { entered: entered.promise, release: () => release.resolve(), restore: () => spy.mockRestore() };
}
const newGrant = (world: ReturnType<typeof outside>, owner: string) => ({ kind: "oauth" as const, accessToken: `access-${owner}-new-grant`,
  refreshToken: "synthetic-new-refresh", expiresAt: new Date(world.clock.now + 3_600_000).toISOString(), scope: GOOGLE_AUTOJOIN_SCOPES });

describe("TC-2917 two backend processes on one node (Bobbie's #697 round 5)", () => {
  test("B deletes while A's refresh is in flight: A refuses, and custody stays absent", async () => {
    const world = outside(); const { A, B } = twoProcesses(world); const owner = tenant(1);
    await seedEnabled(A, owner, T0 + 30_000);
    const gate = gateRefresh(world);
    try {
      const served = A.connection.accessToken(owner);
      await gate.entered;
      await B.credentials.delete(SOURCE, owner);
      gate.release();
      await expect(served).rejects.toThrow("connection_changed");
    } finally { gate.restore(); }
    expect(await B.credentials.status(SOURCE, owner)).toBeNull();
    expect(tokenMap(A.connection).size).toBe(0);
  });

  test("B deletes between A's rotation read and its PUT: the node refuses A's write, and custody stays absent", async () => {
    const world = outside(); const { A, B, nodeA } = twoProcesses(world); const owner = tenant(1);
    await seedEnabled(A, owner, T0 + 30_000);
    let reads = 0;
    // Read 1: the custody read before the refresh. Read 2: the rotation's own read.
    nodeA.hooks.afterGet = async key => { if (key === credentialKey(owner) && ++reads === 2) await B.credentials.delete(SOURCE, owner); };
    await expect(A.connection.accessToken(owner)).rejects.toThrow("connection_changed");
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await B.credentials.status(SOURCE, owner)).toBeNull();
    expect(tokenMap(A.connection).size).toBe(0);
  });

  test("B deletes after A's rotation PUT commits but before A sees it: A re-reads custody, refuses, and caches nothing", async () => {
    const world = outside(); const { A, B, nodeA } = twoProcesses(world); const owner = tenant(1);
    await seedEnabled(A, owner, T0 + 30_000);
    let deleted = false;
    nodeA.hooks.afterPut = async key => { if (key === credentialKey(owner) && !deleted) { deleted = true; await B.credentials.delete(SOURCE, owner); } };
    await expect(A.connection.accessToken(owner)).rejects.toThrow("connection_changed");
    nodeA.hooks.afterPut = undefined;
    expect(deleted).toBe(true);
    expect(await B.credentials.status(SOURCE, owner)).toBeNull();
    expect(tokenMap(A.connection).size).toBe(0);
    world.scans.length = 0;
    await ticks(A, world, 4);
    expect(world.scans).toEqual([]);
  });

  test("B stores a new grant while A's refresh is in flight: A's rotation is bound to the grant it read and refuses", async () => {
    const world = outside(); const { A, B } = twoProcesses(world); const owner = tenant(1);
    await seedEnabled(A, owner, T0 + 30_000);
    const gate = gateRefresh(world);
    try {
      const served = A.connection.accessToken(owner);
      await gate.entered;
      await B.credentials.store({ source: SOURCE, address: owner, secret: newGrant(world, owner) });
      gate.release();
      await expect(served).rejects.toThrow("connection_changed");
    } finally { gate.restore(); }
    expect(await B.credentials.getCredential(SOURCE, owner, "fetch-worker")).toMatchObject({ refreshToken: "synthetic-new-refresh" });
    expect(tokenMap(A.connection).size).toBe(0);
  });

  test("rotate If-Match: B stores a new grant between A's rotation read and its PUT; the node refuses A's write", async () => {
    const world = outside(); const { A, B, nodeA } = twoProcesses(world); const owner = tenant(1);
    await seedEnabled(A, owner, T0 + 30_000);
    let replaced = false;
    nodeA.hooks.beforePut = async key => {
      if (key !== credentialKey(owner) || replaced) return;
      replaced = true;
      await B.credentials.store({ source: SOURCE, address: owner, secret: newGrant(world, owner) });
    };
    await expect(A.connection.accessToken(owner)).rejects.toThrow("connection_changed");
    expect(replaced).toBe(true);
    expect(await B.credentials.getCredential(SOURCE, owner, "fetch-worker")).toMatchObject({ refreshToken: "synthetic-new-refresh" });
    expect(tokenMap(A.connection).size).toBe(0);
  });

  test("B deletes after A cached a token: A serves it at most ACCESS_TOKEN_TTL_MS after its custody read, then stops scanning", async () => {
    const world = outside(); const { A, B } = twoProcesses(world); const owner = tenant(1);
    await seedEnabled(A, owner, T0 + 50 * 60_000);
    expect(await A.connection.accessToken(owner)).toBe(`access-${owner}`);
    await B.credentials.delete(SOURCE, owner);
    // The documented residual window: B's delete is not visible to A until A reads custody again.
    world.clock.now += ACCESS_TOKEN_TTL_MS - 1_000;
    expect(await A.connection.accessToken(owner)).toBe(`access-${owner}`);
    world.clock.now += 1_000;
    await expect(A.connection.accessToken(owner)).rejects.toThrow();
    expect(tokenMap(A.connection).size).toBe(0);
    world.scans.length = 0;
    await ticks(A, world, 10);
    expect(world.scans).toEqual([]);
    expect(await B.credentials.status(SOURCE, owner)).toBeNull();
  });

  test("ABA: a row changed and changed back since it was read is still a changed row; the write is decided again", async () => {
    const world = outside(); const { A, B, nodeA } = twoProcesses(world); const owner = tenant(1);
    const row: CalendarOccurrence = { ...terminalRow(owner, 1), phase: "pending", disposition: undefined, nextAttemptAt: T0 + 3_600_000 };
    await A.stores.request.putOccurrence(row);
    let changed = false;
    nodeA.hooks.beforePut = async key => {
      if (!key.includes("/occurrences/") || changed) return;
      changed = true;
      // Another process changes the row and changes it back: the same content, so (without a
      // version in the record) the same content-hash ETag.
      await B.stores.request.updateOccurrence(owner, row.id, latest => latest && { ...latest, stopRequested: true });
      await B.stores.request.updateOccurrence(owner, row.id, latest => latest && { ...latest, stopRequested: false });
    };
    let decisions = 0;
    await A.stores.request.updateOccurrence(owner, row.id, latest => { decisions++; return latest && { ...latest, title: "decided by A" }; });
    expect(changed).toBe(true);
    expect(decisions).toBe(2);
    expect(await A.stores.request.getOccurrence(owner, row.id)).toMatchObject({ title: "decided by A", stopRequested: false });
  });
});

describe("TC-2917 decisions are made on the stored row (Bobbie's #697 round 5)", () => {
  async function seedSetup(b: ReturnType<typeof wired>, owner: string) {
    await b.stores.request.putConnection({ tenant: owner, subject: SUBJECT, state: "enabling", generation: 1, scopes: GOOGLE_AUTOJOIN_SCOPES.split(" "),
      credentialRef: SOURCE, nextScanAt: 0, scanComplete: false, setupId: "setup", setupExpiresAt: T0 + 5 * 60_000 });
    await b.credentials.store({ source: SOURCE, address: owner, secret: { kind: "oauth", accessToken: `access-${owner}`,
      refreshToken: `refresh-${owner}`, expiresAt: new Date(T0 + 3_600_000).toISOString(), scope: GOOGLE_AUTOJOIN_SCOPES } });
  }

  test("a stale enable never turns an external disable (gen 2) into enabled/gen 1: it re-decides on the fresh row", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedSetup(b, owner);
    const key = v.keyOf(CONNECTIONS);
    let reads = 0;
    // Read 1: enable's first read. Read 2: its read under tenant coordination, which decides to enable.
    // Before the write's own read, another writer disables at generation 2.
    v.hooks.afterGet = k => { if (k === key && ++reads === 2) v.set(key, { ...(v.value(key) as CalendarConnection), state: "disabled", generation: 2, setupId: undefined, offReason: "user_disabled" }); };
    await expect(b.connection.enable(owner, "setup")).rejects.toThrow("connection_changed");
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(v.value(key)).toMatchObject({ state: "disabled", generation: 2, offReason: "user_disabled" });
  });

  test("a stale OAuth exchange never writes its setup over a newer external disable", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 3_600_000);
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const exchange = spyOn(world.oauth, "exchangeCode").mockResolvedValue({ access_token: `access-${owner}-x`, refresh_token: "refresh-x",
      expires_in: 3_600, scope: GOOGLE_AUTOJOIN_SCOPES, subject: SUBJECT });
    try {
      await b.connection.begin(owner, { state: "synthetic-state-0001", challenge, consent: true });
      const key = v.keyOf(CONNECTIONS);
      let disabledWrites = 0;
      // After the exchange's own disable (gen 2) lands, another writer disables at generation 9.
      v.hooks.afterPut = k => {
        if (k === key && ++disabledWrites === 1) v.set(key, { ...(v.value(key) as CalendarConnection), generation: 9, offReason: "user_disabled" });
      };
      await expect(b.connection.exchange(owner, { state: "synthetic-state-0001", code: "code", verifier })).rejects.toThrow("connection_changed");
      expect(v.value(key)).toMatchObject({ state: "disabled", generation: 9, offReason: "user_disabled" });
      expect(await b.credentials.status(SOURCE, owner)).toBeNull();
    } finally { exchange.mockRestore(); }
  });

  test("T1: a disable builds on the row its compare-and-set read", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 3_600_000);
    const key = v.keyOf(CONNECTIONS);
    let changed = false;
    v.hooks.afterGet = k => { if (k === key && !changed) { changed = true; v.set(key, { ...(v.value(key) as CalendarConnection), generation: 7, subject: "new-subject", verifiedEmail: "new@example.test" }); } };
    await b.connection.disable(owner);
    expect(v.value(key)).toMatchObject({ state: "disabled", generation: 8, subject: "new-subject", verifiedEmail: "new@example.test" });
    expect(await b.credentials.status(SOURCE, owner)).toBeNull();
  });

  test("T2: a disable that keeps finding the row changed stops after 3 attempts, and tears nothing down", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 3_600_000);
    const key = v.keyOf(CONNECTIONS);
    let puts = 0;
    v.hooks.beforePut = k => { if (k === key) { puts++; v.set(key, { ...(v.value(key) as CalendarConnection), generation: 10 + puts }); } };
    await expect(b.connection.disable(owner)).rejects.toThrow("calendar_row_changed");
    expect(puts).toBe(3);
    expect(v.value(key)).toMatchObject({ state: "enabled", generation: 13 });
    expect(await b.credentials.status(SOURCE, owner)).not.toBeNull();
  });

  test("T3: needsReconnect keeps the fields of the row it read last", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 3_600_000);
    const key = v.keyOf(CONNECTIONS);
    let changed = false;
    v.hooks.afterGet = k => {
      if (k === key && (v.value(key) as CalendarConnection | undefined)?.state === "disabled" && !changed) {
        changed = true; v.set(key, { ...(v.value(key) as CalendarConnection), verifiedEmail: "fresh@example.test" });
      }
    };
    await b.connection.needsReconnect(owner, 1);
    expect(changed).toBe(true);
    expect(v.value(key)).toMatchObject({ state: "needs_reconnect", generation: 2, verifiedEmail: "fresh@example.test" });
  });

  test("a status read that shows a disable evicts the cached token at once", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    await seedEnabled(b, owner, T0 + 50 * 60_000);
    await b.connection.accessToken(owner);
    expect(tokenMap(b.connection).size).toBe(1);
    const key = v.keyOf(CONNECTIONS);
    v.set(key, { ...(v.value(key) as CalendarConnection), state: "disabled", generation: 2, offReason: "user_disabled" });
    expect(await b.connection.getStatus(owner)).toMatchObject({ enabled: false });
    expect(tokenMap(b.connection).size).toBe(0);
  });

  test("an occurrence put is written only on the version it was decided on", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    const row: CalendarOccurrence = { ...terminalRow(owner, 1), phase: "pending", disposition: undefined };
    await b.stores.request.putOccurrence(row);
    const read = (await b.stores.request.getOccurrence(owner, row.id))!;
    const key = v.keyOf("calendar-autojoin/v1/occurrences/");
    // Another writer moves the row on after it was read.
    v.set(key, { ...(v.value(key) as CalendarOccurrence), phase: "outcome_unknown", idempotencyKey: "elsewhere", rev: read.rev! + 1 });
    await expect(b.stores.request.putOccurrence({ ...read, title: "decided on the old row" })).rejects.toThrow("calendar_row_changed");
    expect(v.value(key)).toMatchObject({ phase: "outcome_unknown", idempotencyKey: "elsewhere", title: row.title });
  });

  test("an occurrence delete is conditional: a row changed since its read is decided again and kept", async () => {
    const v = versionedNode(); const world = outside(); const b = wired(v.node, world); const owner = tenant(1);
    const row = terminalRow(owner, 1);
    await b.stores.request.putOccurrence(row);
    const key = v.keyOf("calendar-autojoin/v1/occurrences/");
    let changed = false;
    v.hooks.beforeDelete = k => { if (k === key && !changed) { changed = true; v.set(key, { ...(v.value(key) as CalendarOccurrence), phase: "pending" }); } };
    expect(await b.stores.request.deleteOccurrence(owner, row.id, stored => stored.phase === "terminal")).toBe(false);
    expect(changed).toBe(true);
    expect(v.value(key)).toMatchObject({ phase: "pending" });
  });
});

describe("TC-2917 credential and row writes are never blind (Bobbie's #697 round 5)", () => {
  const credentialOptions = { master: () => MASTER, previousMaster: () => null, lastUsedThrottleMs: 0 };
  const secret = { kind: "oauth" as const, accessToken: "synthetic-access", refreshToken: "synthetic-refresh", scope: GOOGLE_AUTOJOIN_SCOPES };
  const owner = tenant(1);

  test("markUsed never recreates a credential deleted after its read", async () => {
    const v = versionedNode();
    const credentials = new CredentialStore(new KvCredentialRowStore(v.node), credentialOptions);
    await credentials.store({ source: SOURCE, address: owner, secret });
    v.hooks.afterGet = key => { if (key === credentialKey(owner)) v.remove(key); };
    await credentials.markUsed(SOURCE, owner);
    v.hooks.afterGet = undefined;
    expect(v.value(credentialKey(owner))).toBeUndefined();
    await credentials.markUsed(SOURCE, owner);
    expect(v.value(credentialKey(owner))).toBeUndefined();
  });

  test("markUsed never overwrites a grant stored after its read", async () => {
    const v = versionedNode();
    const credentials = new CredentialStore(new KvCredentialRowStore(v.node), credentialOptions);
    const other = new CredentialStore(new KvCredentialRowStore(v.node), { ...credentialOptions, custody: new CredentialCustody() });
    await credentials.store({ source: SOURCE, address: owner, secret });
    let replaced = false;
    v.hooks.beforePut = async key => {
      if (key !== credentialKey(owner) || replaced) return;
      replaced = true;
      await other.store({ source: SOURCE, address: owner, secret: { ...secret, refreshToken: "synthetic-new-refresh" } });
    };
    await credentials.markUsed(SOURCE, owner);
    expect(replaced).toBe(true);
    expect(await credentials.getCredential(SOURCE, owner, "fetch-worker")).toMatchObject({ refreshToken: "synthetic-new-refresh" });
  });

  /** A node that sends no ETag with its reads: no change to a stored row can be conditional. */
  function etaglessNode() {
    const values = new Map<string, unknown>();
    const { node } = fakeBackendNode(values, { before(op, key) {
      if (op === "get" && values.has(key)) return { ok: true, data: { data: structuredClone(values.get(key)) } };
    } });
    return { node, values };
  }

  test("a calendar row the node sends without an ETag is never written", async () => {
    const { node, values } = etaglessNode();
    const store = new KvCalendarAutojoinStore(node, new BackendStorageLane());
    await store.putConnection({ tenant: owner, subject: SUBJECT, state: "enabled", generation: 1, scopes: [], nextScanAt: 0, scanComplete: true });
    await expect(store.updateConnection(owner, row => row && { ...row, state: "disabled", generation: 2 })).rejects.toThrow("calendar_row_unversioned");
    expect([...values.values()].find(value => (value as CalendarConnection).tenant === owner)).toMatchObject({ state: "enabled", generation: 1 });
  });

  test("a credential the node sends without an ETag is neither replaced nor deleted", async () => {
    const { node, values } = etaglessNode();
    const credentials = new CredentialStore(new KvCredentialRowStore(node), credentialOptions);
    await credentials.store({ source: SOURCE, address: owner, secret });
    const stored = structuredClone(values.get(credentialKey(owner)));
    await expect(credentials.store({ source: SOURCE, address: owner, secret: { ...secret, refreshToken: "other" } })).rejects.toThrow("credential_unversioned");
    await expect(credentials.delete(SOURCE, owner)).rejects.toThrow("credential_unversioned");
    expect(values.get(credentialKey(owner))).toEqual(stored);
  });
});
