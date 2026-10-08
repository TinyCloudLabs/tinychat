import { describe, expect, test } from "bun:test";
import { CalendarAutojoinWorker, type CalendarAutojoinWorkerOptions } from "../services/calendar-autojoin-worker.js";
import { CalendarAutojoinConnection, CalendarAutojoinError } from "../services/calendar-autojoin-connection.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator, type CalendarConnection, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
import { calendarOccurrenceIdentity, eligibleCalendarEvent, ExternalOperationLimiter, GoogleCalendarError, type GoogleCalendarEvent, type GoogleCalendarPort } from "../services/google-calendar.js";
import { MemoryTranscriberIndexStore } from "../services/transcriber-index.js";
import { computeCreateRequestHash, TranscriptionApiError, type CreateMeetingInput, type TranscriptionApiClient, type TranscriptionMeeting } from "../services/transcription-api.js";

const TENANT = "0xaaaa";
const SUBJECT = "google-subject";
const START = Date.parse("2026-09-25T12:00:00Z");
const event = (patch: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent => ({
  id: "event-1", status: "confirmed", summary: "Calendar title", organizer: { self: true },
  start: { dateTime: new Date(START).toISOString() }, end: { dateTime: new Date(START + 1_800_000).toISOString() },
  hangoutLink: "https://meet.google.com/abc-defg-hij", ...patch,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

async function fixture(config: Pick<CalendarAutojoinWorkerOptions, "webhookUrl" | "onRecordingCompleted"> = {}) {
  let now = START - 30_000;
  const store = new MemoryCalendarAutojoinStore();
  const index = new MemoryTranscriberIndexStore();
  const coordinator = new TenantCoordinator();
  const current = { events: [event()] };
  const records = new Map<string, TranscriptionMeeting>();
  const hashes = new Map<string, string>();
  const posts: { input: CreateMeetingInput; key: string; retryTransport: boolean | undefined }[] = [];
  const lookups: string[] = [];
  const stops: string[] = [];
  const gets: string[] = [];
  const refreshes: boolean[] = [];
  const sleeps: number[] = [];
  const calendar: GoogleCalendarPort = {
    async listEvents() { return structuredClone(current.events); },
    async getEvent(_token, id) { gets.push(id); return structuredClone(current.events.find(e => e.id === id) ?? null); },
    async probePrimary() {},
  };
  const api: TranscriptionApiClient = {
    async createMeeting(input, options) {
      const key = options?.idempotencyKey ?? "unexpected-random-key";
      posts.push({ input: structuredClone(input), key, retryTransport: options?.retryTransport });
      if (!records.has(key)) {
        records.set(key, { id: `mtg_${records.size + 1}`, status: "in_progress", platform: "google_meet",
          meeting_url: input.meeting_url, metadata: input.metadata, created_at: new Date(now).toISOString() });
        hashes.set(key, computeCreateRequestHash(input));
      }
      return structuredClone(records.get(key)!);
    },
    async lookupMeetingByIdempotencyKey(key) {
      lookups.push(key);
      const meeting = records.get(key);
      return meeting ? { meeting: structuredClone(meeting), requestHash: hashes.get(key)! } : null;
    },
    async getMeeting(id) {
      const meeting = [...records.values()].find(m => m.id === id);
      if (!meeting) throw new TranscriptionApiError(404, "meeting_not_found", "Missing");
      return structuredClone(meeting);
    },
    async stopMeeting(id) {
      stops.push(id);
      const meeting = [...records.values()].find(m => m.id === id)!;
      meeting.status = "cancelled";
      return { id, status: "cancelled" };
    },
    async deleteMeeting() {},
    async getTranscript() { return { pending: true, status: "processing" }; },
  };
  const connection = {
    async accessToken(tenant: string, forceRefresh = false) { refreshes.push(forceRefresh); return `tok:${tenant}`; },
    async cleanupEnabling() {},
    async needsReconnect(tenant: string, generation: number) {
      await store.updateConnection(tenant, c => c?.generation === generation ? { ...c, state: "needs_reconnect" } : c);
    },
  };
  const worker = () => new CalendarAutojoinWorker({ store, index, coordinator, calendar, api, connection,
    now: () => now, random: () => 0, sleep: async ms => { sleeps.push(ms); now += ms; }, ...config });
  await store.putConnection({ tenant: TENANT, subject: SUBJECT, state: "enabled", generation: 1,
    scopes: [], nextScanAt: 0, scanComplete: true });
  const id = calendarOccurrenceIdentity(TENANT, SUBJECT, current.events[0]!)!;
  const row = () => store.getOccurrence(TENANT, id);
  const disable = async (reenable = false, subject = SUBJECT) => coordinator.run(TENANT, async () => {
    await store.updateConnection(TENANT, c => c && { ...c, state: "disabled", generation: c.generation + 1 });
    for (const occurrence of await store.listOccurrences(TENANT)) {
      await store.updateOccurrence(TENANT, occurrence.id, r => r && { ...r, stopRequested: true, nextAttemptAt: now });
    }
    if (reenable) await store.updateConnection(TENANT, c => c && { ...c, state: "enabled", subject, scanComplete: true });
  });
  const seedUnknown = async (patch: Partial<CalendarOccurrence> = {}) => {
    const eligible = eligibleCalendarEvent(current.events[0]!)!;
    const body: CreateMeetingInput = { meeting_url: eligible.meetingUrl, platform: "google_meet", bot_name: "Frozen bot",
      metadata: { tinychat_address: TENANT, source: "google-calendar-autojoin", calendar_occurrence_id: id,
        calendar_title: eligible.title, scheduled_start: new Date(eligible.start).toISOString() } };
    const occurrence: CalendarOccurrence = { id, tenant: TENANT, subject: SUBJECT, ...eligible,
      phase: "outcome_unknown", generation: 1, nextAttemptAt: now, attemptCount: 1, stopRequested: false,
      createBody: body, requestHash: computeCreateRequestHash(body), idempotencyKey: `calendar-v1-${id}`, updatedAt: now, ...patch };
    await store.putOccurrence(occurrence);
    return occurrence;
  };
  return { store, index, coordinator, current, records, hashes, posts, lookups, stops, gets, refreshes, sleeps,
    calendar, api, connection, worker, row, id, disable, seedUnknown,
    now: () => now, setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; } };
}

describe("calendar dispatch crash and policy boundaries", () => {
  test("new calendar intents carry the webhook in their hash and completion wakes once", async () => {
    const wakes: Array<[string, string]> = [];
    const webhookUrl = "https://tinychat.example/api/transcriber/webhooks/ptx";
    const f = await fixture({ webhookUrl, onRecordingCompleted: async (tenant, id) => { wakes.push([tenant, id]); } });
    await f.worker().tick();
    const sent = f.posts[0]!;
    expect(sent.input.webhook_url).toBe(webhookUrl);
    expect(f.hashes.get(sent.key)).toBe(computeCreateRequestHash(sent.input));
    f.records.get(sent.key)!.status = "completed";
    f.advance(60_000);
    await f.worker().tick();
    expect(wakes).toEqual([[TENANT, "mtg_1"]]);
    f.advance(60_000);
    await f.worker().tick();
    expect(wakes).toEqual([[TENANT, "mtg_1"]]);
  });

  test("pre-existing frozen calendar intents retain their exact body across a webhook deployment", async () => {
    const f = await fixture({ webhookUrl: "https://tinychat.example/api/transcriber/webhooks/ptx" });
    const frozen = await f.seedUnknown();
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.input).toEqual(frozen.createBody);
    expect(f.posts[0]!.input.webhook_url).toBeUndefined();
    expect(f.hashes.get(f.posts[0]!.key)).toBe(frozen.requestHash);
  });

  test("a failed intent write cannot POST; the next tick can retry safely", async () => {
    const f = await fixture();
    const put = f.store.putOccurrence.bind(f.store);
    let fail = true;
    f.store.putOccurrence = async row => {
      if (row.idempotencyKey && fail) throw new Error("write failed");
      return put(row);
    };
    await f.worker().tick();
    expect(f.posts).toHaveLength(0);
    expect((await f.row())?.idempotencyKey).toBeUndefined();
    fail = false;
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.retryTransport).toBe(false);
  });

  test("KV latency crossing cutoff after freezing intent cannot send a late POST", async () => {
    const f = await fixture();
    const put = f.store.putOccurrence.bind(f.store);
    f.store.putOccurrence = async row => {
      await put(row);
      if (row.idempotencyKey) f.setNow(START + 300_000);
    };
    await f.worker().tick();
    expect(f.posts).toHaveLength(0);
    expect(await f.row()).toMatchObject({ phase: "outcome_unknown", stopRequested: true });
  });

  test("lost create response recovers one recording and its ownership via lookup", async () => {
    const f = await fixture();
    const create = f.api.createMeeting;
    const add = f.index.add.bind(f.index);
    f.index.add = async (...args) => {
      // The accepted lookup must clear a resolved create error before ownership repair.
      expect((await f.row())?.errorCode).toBeUndefined();
      await add(...args);
    };
    f.api.createMeeting = async (...args) => { await create(...args); throw new Error("socket closed unexpectedly"); };
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(f.records.size).toBe(1);
    expect(f.lookups).toHaveLength(1);
    expect(await f.index.list(TENANT)).toEqual(["mtg_1"]);
    expect(await f.row()).toMatchObject({ phase: "sent", meetingId: "mtg_1" });
    expect((await f.row())?.errorCode).toBeUndefined();
    [...f.records.values()][0]!.status = "completed";
    f.advance(60_000);
    await f.worker().tick();
    expect(await f.row()).toMatchObject({ phase: "terminal", disposition: "completed" });
    expect((await f.row())?.errorCode).toBeUndefined();
  });

  test("successful active and completed polls clear a prior transient error", async () => {
    const f = await fixture();
    await f.worker().tick();
    const get = f.api.getMeeting;
    for (const status of ["in_progress", "completed"] as const) {
      f.api.getMeeting = async () => { throw new TranscriptionApiError(503, "unavailable", "Unavailable"); };
      f.advance(60_000);
      await f.worker().tick();
      expect((await f.row())?.errorCode).toBe("autojoin_retry");
      [...f.records.values()][0]!.status = status;
      f.api.getMeeting = get;
      f.advance(60_000);
      await f.worker().tick();
      expect((await f.row())?.errorCode).toBeUndefined();
    }
    expect(await f.row()).toMatchObject({ phase: "terminal", disposition: "completed" });
  });

  test("immediate lost-response lookup after a short event ends secures ownership then stops", async () => {
    const f = await fixture();
    f.current.events = [event({ end: { dateTime: new Date(START + 10_000).toISOString() } })];
    const create = f.api.createMeeting;
    f.api.createMeeting = async (...args) => {
      await create(...args);
      f.setNow(START + 10_000);
      throw new Error("socket closed unexpectedly");
    };
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(f.stops).toEqual(["mtg_1"]);
    expect(await f.index.list(TENANT)).toEqual(["mtg_1"]);
    expect(await f.row()).toMatchObject({ stopRequested: true, phase: "terminal", errorCode: "missed_window" });
  });

  test("lost ID write restarts with lookup, never a second create", async () => {
    const f = await fixture();
    const update = f.store.updateOccurrence.bind(f.store);
    let fail = true;
    f.store.updateOccurrence = (tenant, id, fn) => update(tenant, id, current => {
      const next = fn(current);
      if (next?.meetingId && fail) { fail = false; throw new Error("ID write lost"); }
      return next;
    });
    await f.worker().tick();
    expect(await f.row()).toMatchObject({ phase: "outcome_unknown" });
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(await f.index.list(TENANT)).toEqual(["mtg_1"]);
  });

  test("lost ownership acknowledgement retries idempotent index add after restart", async () => {
    const f = await fixture();
    const add = f.index.add.bind(f.index);
    let fail = true;
    f.index.add = async (...args) => { await add(...args); if (fail) { fail = false; throw new Error("ack lost"); } };
    await f.worker().tick();
    expect(await f.row()).toMatchObject({ phase: "ownership_pending", meetingId: "mtg_1" });
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(await f.index.list(TENANT)).toEqual(["mtg_1"]);
    expect(await f.store.getMarker(TENANT, f.id)).toMatchObject({ meetingId: "mtg_1" });
  });

  test("disable persists during an in-flight POST and its returned bot is owned then stopped", async () => {
    const f = await fixture();
    const started = deferred<void>();
    const release = deferred<void>();
    const create = f.api.createMeeting;
    f.api.createMeeting = async (...args) => { const meeting = await create(...args); started.resolve(); await release.promise; return meeting; };
    const tick = f.worker().tick();
    await started.promise;
    await f.disable();
    expect((await f.row())?.stopRequested).toBe(true);
    release.resolve();
    await tick;
    expect(f.posts).toHaveLength(1);
    expect(f.stops).toEqual(["mtg_1"]);
    expect(await f.index.list(TENANT)).toEqual(["mtg_1"]);
  });

  test("unknown lookup misses survive disable/re-enable and a late commit is stopped", async () => {
    const f = await fixture();
    const unknown = await f.seedUnknown();
    await f.disable(true);
    await f.worker().tick();
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(0);
    expect(await f.row()).toMatchObject({ phase: "outcome_unknown", stopRequested: true });
    // An upstream request from before the timeout commits after multiple read-only misses.
    await f.api.createMeeting(unknown.createBody!, { idempotencyKey: unknown.idempotencyKey });
    f.posts.length = 0;
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(0);
    expect(f.stops).toEqual(["mtg_1"]);
    expect(await f.index.list(TENANT)).toEqual(["mtg_1"]);
  });

  test("account replacement proceeds while an old subject lookup remains not found", async () => {
    const f = await fixture();
    const old = await f.seedUnknown();
    await f.disable(true, "replacement-subject");
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(f.posts[0]!.key).not.toBe(old.idempotencyKey);
    expect(await f.row()).toMatchObject({ stopRequested: true, phase: "outcome_unknown", subject: SUBJECT });
    expect((await f.store.listOccurrences(TENANT))).toHaveLength(2);
  });

  test("recovery past cutoff and long retention never re-POSTs or forgets uncertainty", async () => {
    const f = await fixture();
    await f.seedUnknown();
    f.setNow(START + 40 * 86_400_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(0);
    expect(f.lookups).toHaveLength(1);
    expect(await f.row()).toMatchObject({ phase: "outcome_unknown", stopRequested: true });
    f.advance(60_000);
    await f.worker().tick();
    expect(await f.row()).not.toBeNull();
  });

  test("hash or tenant mismatch never grants ownership or dispatches a replacement", async () => {
    for (const mismatch of ["hash", "tenant"]) {
      const f = await fixture();
      const old = await f.seedUnknown();
      const meeting = await f.api.createMeeting(old.createBody!, { idempotencyKey: old.idempotencyKey });
      f.posts.length = 0;
      if (mismatch === "hash") f.hashes.set(old.idempotencyKey!, "a".repeat(64));
      else f.records.set(old.idempotencyKey!, { ...meeting, metadata: { ...meeting.metadata, tinychat_address: "another-tenant" } });
      await f.worker().tick();
      expect(f.posts).toHaveLength(0);
      expect(await f.index.list(TENANT)).toEqual([]);
      expect(await f.row()).toMatchObject({ stopRequested: true, errorCode: "lookup_identity_mismatch" });
    }
  });

  test("sent markers survive recording deletion, terminal compaction, and far-future reschedule", async () => {
    const f = await fixture();
    await f.worker().tick();
    f.records.clear();
    f.advance(60_000);
    await f.worker().tick();
    expect(await f.row()).toMatchObject({ phase: "terminal", disposition: "recording_deleted" });
    f.setNow(START + 40 * 86_400_000);
    f.current.events = [];
    await f.worker().tick();
    expect(await f.row()).toBeNull();
    const next = f.now() + 30_000;
    f.current.events = [event({ start: { dateTime: new Date(next).toISOString() }, end: { dateTime: new Date(next + 600_000).toISOString() } })];
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(await f.store.getMarker(TENANT, f.id)).toMatchObject({ meetingId: "mtg_1" });
  });

  test("a sparse cancellation finishes a pending event before dispatch", async () => {
    const f = await fixture();
    f.setNow(START - 120_000);
    await f.worker().tick();
    f.current.events = [{ id: "event-1", status: "cancelled" }];
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(0);
    expect(await f.row()).toMatchObject({ phase: "terminal", disposition: "event_ineligible" });
  });

  test("pre-dispatch reschedule updates frozen title, time, and URL", async () => {
    const f = await fixture();
    const replacement = event({ summary: "Updated title", start: { dateTime: new Date(START + 10_000).toISOString() }, hangoutLink: "https://meet.google.com/xyz-abcd-efg" });
    f.calendar.getEvent = async () => replacement;
    await f.worker().tick();
    expect(f.posts[0]!.input).toMatchObject({ meeting_url: replacement.hangoutLink,
      metadata: { calendar_title: "Updated title", scheduled_start: replacement.start!.dateTime } });
  });

  test("every immediate retry rechecks attendance and cannot create after its withdrawal", async () => {
    const f = await fixture();
    let attempts = 0;
    f.api.createMeeting = async () => { attempts++; f.current.events = [event({ attendees: [{ self: true, responseStatus: "declined" }] })]; throw new Error("network down"); };
    await f.worker().tick();
    expect(attempts).toBe(1);
    expect(f.gets).toHaveLength(2);
    expect(await f.row()).toMatchObject({ stopRequested: true });
  });

  test("permanent create rejection becomes lookup-only across later eligible ticks", async () => {
    const f = await fixture();
    let calls = 0;
    f.api.createMeeting = async () => { calls++; throw new TranscriptionApiError(400, "invalid_request", "Rejected"); };
    await f.worker().tick();
    f.advance(60_000);
    await f.worker().tick();
    expect(calls).toBe(1);
    expect(await f.row()).toMatchObject({ stopRequested: true, errorCode: "create_rejected" });
    expect(f.lookups.length).toBeGreaterThanOrEqual(2);
  });

  test("Retry-After persists its full delay, while ordinary jittered backoff caps at 15 minutes", async () => {
    const f = await fixture();
    f.api.createMeeting = async () => { throw new TranscriptionApiError(429, "capacity", "Busy", 3_600_000); };
    const before = f.now();
    await f.worker().tick();
    expect((await f.row())!.nextAttemptAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(f.sleeps).toEqual([]);
    const unknown = (await f.row())!;
    await f.store.putOccurrence({ ...unknown, stopRequested: true, attemptCount: 100, nextAttemptAt: f.now() });
    const worker = new CalendarAutojoinWorker({ store: f.store, index: f.index, coordinator: f.coordinator,
      calendar: f.calendar, api: f.api, connection: f.connection, now: f.now, random: () => 0.99 });
    await worker.tick();
    expect((await f.row())!.nextAttemptAt - f.now()).toBe(900_000);
  });

  test("incomplete discovery blocks new creates but does not strand an individually verified unknown", async () => {
    const f = await fixture();
    await f.seedUnknown();
    f.calendar.listEvents = async () => { throw new GoogleCalendarError("scan_incomplete", 0); };
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect((await f.row())?.stopRequested).toBe(false);
    const fresh = await fixture();
    fresh.calendar.listEvents = f.calendar.listEvents;
    await fresh.worker().tick();
    expect(fresh.posts).toHaveLength(0);
    expect(await fresh.store.getConnection(TENANT)).toMatchObject({ scanComplete: false });
  });

  test("a recovery lookup failure cannot shorten a create Retry-After across restart", async () => {
    const f = await fixture();
    let creates = 0;
    f.api.createMeeting = async () => { creates++; throw new TranscriptionApiError(429, "capacity", "Busy", 3_600_000); };
    f.api.lookupMeetingByIdempotencyKey = async () => { throw new Error("network reset"); };
    const deadline = f.now() + 3_600_000;
    await f.worker().tick();
    expect((await f.row())?.nextAttemptAt).toBe(deadline);
    f.advance(30_000);
    f.api.lookupMeetingByIdempotencyKey = async () => null;
    await f.worker().tick();
    expect(creates).toBe(1);
    expect((await f.row())?.nextAttemptAt).toBe(deadline);
  });

  test("stop failure persists its intent and succeeds after restart without another create", async () => {
    const f = await fixture();
    await f.worker().tick();
    await f.disable();
    const stop = f.api.stopMeeting;
    f.api.stopMeeting = async () => { throw new TranscriptionApiError(503, "unavailable", "Unavailable"); };
    await f.worker().tick();
    expect(await f.row()).toMatchObject({ stopRequested: true });
    f.api.stopMeeting = stop;
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(1);
    expect(f.stops).toEqual(["mtg_1"]);
  });

  test("scheduled end alone leaves an existing capture running", async () => {
    const f = await fixture();
    await f.worker().tick();
    f.setNow(START + 1_800_001);
    await f.worker().tick();
    expect(f.stops).toEqual([]);
    expect(await f.row()).toMatchObject({ phase: "sent", stopRequested: false });
    // Polling continues beyond the scheduled end, so a later provider completion is observed.
    const recording = [...f.records.values()][0]!;
    recording.status = "completed";
    f.advance(60_000);
    await f.worker().tick();
    expect(await f.row()).toMatchObject({ phase: "terminal", disposition: "completed" });
  });

  test("cancellation, reschedule, link change, and withdrawn attendance stop a sent recording", async () => {
    for (const patch of [
      { status: "cancelled" },
      { start: { dateTime: new Date(START + 60_000).toISOString() } },
      { hangoutLink: "https://meet.google.com/xyz-abcd-efg" },
      { attendees: [{ self: true, responseStatus: "tentative" }] },
    ]) {
      const f = await fixture();
      await f.worker().tick();
      f.current.events = [event(patch)];
      f.advance(60_000);
      await f.worker().tick();
      expect(f.stops).toEqual(["mtg_1"]);
      expect(f.posts).toHaveLength(1);
      expect(await f.row()).toMatchObject({ phase: "terminal", disposition: "cancelled" });
    }
  });

  test("Google rate-limit 403 persists full Retry-After without requiring reconnect or posting", async () => {
    const f = await fixture();
    await f.seedUnknown();
    f.calendar.listEvents = async () => { throw new GoogleCalendarError("calendar_rate_limited", 403, 3_600_000, false, true); };
    f.calendar.getEvent = async () => { throw new GoogleCalendarError("calendar_rate_limited", 403, 3_600_000, false, true); };
    const now = f.now();
    await f.worker().tick();
    expect(await f.store.getConnection(TENANT)).toMatchObject({ state: "enabled", nextScanAt: now + 3_600_000 });
    expect((await f.row())!.nextAttemptAt).toBe(now + 3_600_000);
    expect(f.sleeps).toEqual([]);
    expect(f.posts).toHaveLength(0);
  });

  test("a Google 401 refreshes exactly once before successful dispatch", async () => {
    const f = await fixture();
    let calls = 0;
    const get = f.calendar.getEvent;
    f.calendar.getEvent = async (...args) => {
      if (++calls === 1) throw new GoogleCalendarError("calendar_unauthorized", 401, null, true);
      return get(...args);
    };
    await f.worker().tick();
    expect(f.refreshes.filter(Boolean)).toHaveLength(1);
    expect(f.posts).toHaveLength(1);
    expect((await f.store.getConnection(TENANT))?.state).toBe("enabled");
  });

  test("persistent Google authorization loss forbids create but still recovers ownership and stops", async () => {
    const f = await fixture();
    const unknown = await f.seedUnknown();
    let calls = 0;
    f.calendar.listEvents = async () => { calls++; throw new GoogleCalendarError("calendar_unauthorized", 401, null, true); };
    await f.worker().tick();
    expect(calls).toBe(2);
    expect(f.refreshes.filter(Boolean)).toHaveLength(1);
    expect((await f.store.getConnection(TENANT))?.state).toBe("needs_reconnect");
    expect(f.posts).toHaveLength(0);
    expect((await f.row())?.stopRequested).toBe(true);
    await f.api.createMeeting(unknown.createBody!, { idempotencyKey: unknown.idempotencyKey });
    f.posts.length = 0;
    f.advance(60_000);
    await f.worker().tick();
    expect(f.posts).toHaveLength(0);
    expect(f.stops).toEqual(["mtg_1"]);
    expect(await f.index.list(TENANT)).toEqual(["mtg_1"]);
    expect(calls).toBe(2);
  });

  test("shared operation capacity stays at four across seven tenants; each tenant dispatches serially", async () => {
    const f = await fixture();
    const limiter = new ExternalOperationLimiter();
    f.current.events.push(event({ id: "overlapping-event" }));
    for (let tenant = 1; tenant < 7; tenant++) {
      await f.store.putConnection({ tenant: `tenant-${tenant}`, subject: SUBJECT, state: "enabled", generation: 1,
        nextScanAt: 0, scanComplete: true, scopes: [] });
    }
    let active = 0;
    let maximum = 0;
    const tenantActive = new Map<string, number>();
    const tenantMaximum = new Map<string, number>();
    const operation = async <T>(fn: () => Promise<T>) => {
      active++; maximum = Math.max(maximum, active);
      try { await new Promise(resolve => setTimeout(resolve, 1)); return await fn(); }
      finally { active--; }
    };
    // Each tenant is in its own Meet: one shared link would (correctly) collapse to one capture (TC-581).
    const room = (token: string) => `https://meet.google.com/abc-defg-hi${"abcdefg"[token === `tok:${TENANT}` ? 0 : Number(token.slice(-1))]}`;
    const list = f.calendar.listEvents;
    const get = f.calendar.getEvent;
    f.calendar.listEvents = (token, ...rest) => limiter.run(() => operation(async () =>
      (await list(token, ...rest)).map(e => ({ ...e, hangoutLink: room(token) }))));
    f.calendar.getEvent = (token, id) => limiter.run(() => operation(async () => {
      const found = await get(token, id);
      return found && { ...found, hangoutLink: room(token) };
    }));
    const create = f.api.createMeeting;
    f.api.createMeeting = (body, options) => operation(async () => {
      const tenant = String(body.metadata!.tinychat_address);
      tenantActive.set(tenant, (tenantActive.get(tenant) ?? 0) + 1);
      tenantMaximum.set(tenant, Math.max(tenantMaximum.get(tenant) ?? 0, tenantActive.get(tenant)!));
      try { return await create(body, options); }
      finally { tenantActive.set(tenant, tenantActive.get(tenant)! - 1); }
    });
    const getMeeting = f.api.getMeeting;
    f.api.getMeeting = (...args) => operation(() => getMeeting(...args));
    const worker = new CalendarAutojoinWorker({ store: f.store, index: f.index, coordinator: f.coordinator,
      calendar: f.calendar, api: f.api, connection: f.connection, limiter, now: f.now, random: () => 0 });
    await worker.tick();
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(f.posts).toHaveLength(14);
    expect([...tenantMaximum.values()]).toEqual(Array(7).fill(1));
  });

  test("ticks do not overlap while an upstream create is unresolved", async () => {
    const f = await fixture();
    const release = deferred<void>();
    const started = deferred<void>();
    const create = f.api.createMeeting;
    f.api.createMeeting = async (...args) => { started.resolve(); await release.promise; return create(...args); };
    const worker = f.worker();
    const tick = worker.tick();
    await started.promise;
    expect(worker.tick()).toBe(tick);
    release.resolve();
    await tick;
    expect(f.posts).toHaveLength(1);
  });
});

// TC-581 share-if-on-invite. Two tenants, each with their own Google calendar (the access token
// names the tenant), auto-joining the same Meet.
const A = "0xaaaa";
const B = "0xbbbb";
const SUBJECT_A = "subject-a";
const SUBJECT_B = "subject-b";
const B_EMAIL = "bee@example.test";
const A_EMAIL = "owner@example.test";
const ROOM = "https://meet.google.com/abc-defg-hij";

async function twoTenants(options: { sharing?: boolean; bResponse?: string | null; bEmail?: string; aEmail?: string | null } = {}) {
  let now = START - 30_000;
  const store = new MemoryCalendarAutojoinStore();
  const index = new MemoryTranscriberIndexStore();
  const coordinator = new TenantCoordinator();
  const meetingCoordinator = new TenantCoordinator();
  const ownerAttendees = (response: string | null) => [
    { email: "owner@example.test", self: true, responseStatus: "accepted" },
    ...(response === null ? [] : [{ email: B_EMAIL, responseStatus: response }]),
  ];
  const events: Record<string, GoogleCalendarEvent[]> = {
    [A]: [event({ id: "event-a", attendees: ownerAttendees(options.bResponse === undefined ? "accepted" : options.bResponse) })],
    [B]: [event({ id: "event-b", organizer: { self: false }, attendees: [
      { email: B_EMAIL, self: true, responseStatus: "accepted" }, { email: A_EMAIL, responseStatus: "accepted" }] })],
  };
  const tenantOf = (token: string) => token.slice("tok:".length);
  const googleErrors: Record<string, (() => never) | undefined> = {};
  const tokenErrors: Record<string, (() => never) | undefined> = {};
  const gets: { tenant: string; id: string }[] = [];
  const calendar: GoogleCalendarPort = {
    async listEvents(token) { return structuredClone(events[tenantOf(token)] ?? []); },
    async getEvent(token, id) {
      const tenant = tenantOf(token);
      gets.push({ tenant, id });
      googleErrors[tenant]?.();
      return structuredClone(events[tenant]?.find(e => e.id === id) ?? null);
    },
    async probePrimary() {},
  };
  const records = new Map<string, TranscriptionMeeting>();
  const hashes = new Map<string, string>();
  const posts: { tenant: string; key: string }[] = [];
  const stops: string[] = [];
  const deletes: string[] = [];
  const api: TranscriptionApiClient = {
    async createMeeting(input, opts) {
      const key = opts!.idempotencyKey!;
      posts.push({ tenant: String(input.metadata!.tinychat_address), key });
      if (!records.has(key)) {
        records.set(key, { id: `mtg_${records.size + 1}`, status: "in_progress", platform: "google_meet",
          meeting_url: input.meeting_url, metadata: input.metadata, created_at: new Date(now).toISOString() });
        hashes.set(key, computeCreateRequestHash(input));
      }
      return structuredClone(records.get(key)!);
    },
    async lookupMeetingByIdempotencyKey(key) {
      const meeting = records.get(key);
      return meeting ? { meeting: structuredClone(meeting), requestHash: hashes.get(key)! } : null;
    },
    async getMeeting(id) {
      const meeting = [...records.values()].find(m => m.id === id);
      if (!meeting) throw new TranscriptionApiError(404, "meeting_not_found", "Missing");
      return structuredClone(meeting);
    },
    async stopMeeting(id) {
      stops.push(id);
      const meeting = [...records.values()].find(m => m.id === id)!;
      meeting.status = "processing";
      return { id, status: meeting.status };
    },
    async deleteMeeting(id) { deletes.push(id); },
    async getTranscript() { return { pending: true, status: "processing" }; },
  };
  const connection = {
    async accessToken(tenant: string) { tokenErrors[tenant]?.(); return `tok:${tenant}`; },
    async cleanupEnabling() {},
    async needsReconnect(tenant: string, generation: number) {
      await store.updateConnection(tenant, c => c?.generation === generation ? { ...c, state: "needs_reconnect" } : c);
    },
  };
  const worker = () => new CalendarAutojoinWorker({ store, index, coordinator, meetingCoordinator, calendar, api, connection,
    sharingEnabled: options.sharing ?? true, now: () => now, random: () => 0, sleep: async ms => { now += ms; } });
  const connect = (tenant: string, subject: string, patch: Partial<CalendarConnection> = {}) => store.putConnection({
    tenant, subject, state: "enabled", generation: 1, scopes: [], nextScanAt: 0, scanComplete: true, ...patch });
  await connect(A, SUBJECT_A, options.aEmail === null ? {} : { verifiedEmail: options.aEmail ?? A_EMAIL });
  const connectB = () => connect(B, SUBJECT_B, { verifiedEmail: options.bEmail ?? B_EMAIL });
  const idOf = (tenant: string, subject: string) => calendarOccurrenceIdentity(tenant, subject, events[tenant]![0]!)!;
  const rowA = () => store.getOccurrence(A, idOf(A, SUBJECT_A));
  const rowB = () => store.getOccurrence(B, idOf(B, SUBJECT_B));
  const meeting = (id = "mtg_1") => [...records.values()].find(m => m.id === id)!;
  const status = (tenant: string) => new CalendarAutojoinConnection({ store, coordinator, credentials: null as never,
    oauth: null as never, calendar: null as never, now: () => now }).getStatus(tenant);
  /** A sends its bot, then B (connected afterwards) collides with it and attaches. */
  const attach = async () => {
    await worker().tick();
    expect(meeting().metadata?.tinychat_address).toBe(A);
    await connectB();
    await worker().tick();
    expect((await rowB())?.sharedCapture?.ownerTenant).toBe(A);
  };
  /** Keep A's own worker from observing its terminal meeting first, to pin B's view of it. */
  const holdA = () => store.updateOccurrence(A, idOf(A, SUBJECT_A), r => r && { ...r, nextAttemptAt: now + 86_400_000 * 10 });
  return { store, index, events, posts, stops, deletes, records, gets, googleErrors, tokenErrors, api, calendar, worker, connect,
    connectB, rowA, rowB, meeting, status, attach, holdA, idOf,
    now: () => now, setNow: (value: number) => { now = value; }, advance: (ms: number) => { now += ms; },
    /** Past B's dispatch window (start + 5 min): a dead owner can no longer be replaced by B's own bot. */
    afterWindow: () => { now = START + 300_000; } };
}

describe("TC-907 ptx capacity_exhausted", () => {
  const busy = () => new TranscriptionApiError(429, "capacity_exhausted", "All 2 meeting notetakers are busy right now.", 60_000);
  const status = (f: Awaited<ReturnType<typeof fixture>>) => new CalendarAutojoinConnection({ store: f.store, coordinator: f.coordinator,
    credentials: null as never, oauth: null as never, calendar: null as never, now: f.now }).getStatus(TENANT);

  test("each create attempt increments attemptCount exactly once", async () => {
    const f = await fixture();
    let creates = 0;
    f.api.createMeeting = async () => { creates++; throw busy(); };
    for (let tick = 1; tick <= 3; tick++) {
      await f.worker().tick();
      expect(creates).toBe(tick);
      expect((await f.row())?.attemptCount).toBe(tick);
      f.advance(60_000);
    }
  });

  test("a lookup failure after a failed create does not count the attempt twice", async () => {
    const f = await fixture();
    f.api.createMeeting = async () => { throw busy(); };
    f.api.lookupMeetingByIdempotencyKey = async () => { throw new Error("network reset"); };
    await f.worker().tick();
    expect((await f.row())?.attemptCount).toBe(1);
  });

  /** Ticks every minute until `until`. */
  const runUntil = async (f: Awaited<ReturnType<typeof fixture>>, until: number) => {
    while (f.now() < until) { await f.worker().tick(); f.advance(60_000); }
  };
  const CUTOFF = START + 300_000;
  const MARGIN = 600_000;

  test("an occurrence ptx kept refusing for capacity ends as capacity_exhausted after its window and margin, then is cleaned up", async () => {
    const f = await fixture();
    let creates = 0;
    f.api.createMeeting = async () => { creates++; throw busy(); };
    await runUntil(f, CUTOFF + 60_000);
    // Retried at ptx's Retry-After for the whole joining window, then lookup-only inside the margin.
    expect(creates).toBe(6);
    expect((await f.row())?.phase).not.toBe("terminal");
    let endedAt = 0;
    for (let i = 0; i < 60 && (await f.row())?.phase !== "terminal"; i++) {
      endedAt = f.now();
      await f.worker().tick();
      f.advance(60_000);
    }
    expect(endedAt).toBeGreaterThanOrEqual(CUTOFF + MARGIN);
    expect(endedAt).toBeLessThan(CUTOFF + MARGIN + 900_000);
    expect(creates).toBe(6);
    expect(await f.row()).toMatchObject({ phase: "terminal", disposition: "capacity_exhausted", errorCode: undefined });
    expect(await f.store.getMarker(TENANT, f.id)).toMatchObject({ disposition: "capacity_exhausted" });
    expect((await status(f)).outcomes).toEqual([expect.objectContaining({ reason: "capacity_exhausted" })]);
    const lookups = f.lookups.length;
    f.advance(900_000);
    await f.worker().tick();
    expect(f.lookups).toHaveLength(lookups);
    // Terminal rows are compacted after 30 days; the marker keeps it from being re-sent.
    f.advance(31 * 86_400_000);
    await f.worker().tick();
    expect(await f.row()).toBeNull();
    expect(creates).toBe(6);
  });

  test("a slow earlier POST that commits late, inside the margin, is found by lookup and owned normally", async () => {
    const f = await fixture();
    const create = f.api.createMeeting;
    f.api.createMeeting = async () => { throw busy(); };
    await runUntil(f, CUTOFF + 60_000);
    const row = (await f.row())!;
    expect(row).toMatchObject({ capacityExhausted: true });
    expect(row.phase).not.toBe("terminal");
    // The late commit: ptx now has a meeting under this occurrence's key.
    const late = await create(row.createBody!, { idempotencyKey: row.idempotencyKey });
    await runUntil(f, CUTOFF + MARGIN + 900_000);
    expect(await f.index.list(TENANT)).toEqual([late.id]);
    expect(await f.store.getMarker(TENANT, f.id)).toMatchObject({ meetingId: late.id });
    expect((await f.row())?.meetingId).toBe(late.id);
    expect((await f.row())?.disposition).not.toBe("capacity_exhausted");
  });

  test("a failure before any POST is sent still grows the backoff", async () => {
    const f = await fixture();
    const put = f.store.putOccurrence.bind(f.store);
    f.store.putOccurrence = async row => {
      if (row.idempotencyKey) throw new Error("write failed");
      return put(row);
    };
    let creates = 0;
    f.api.createMeeting = async () => { creates++; throw busy(); };
    // A failed intent write is retryable: three immediate attempts per tick, each counted once.
    await f.worker().tick();
    expect((await f.row())?.attemptCount).toBe(3);
    f.advance(60_000);
    await f.worker().tick();
    expect(creates).toBe(0);
    expect((await f.row())?.attemptCount).toBe(6);
    expect((await f.row())?.capacityExhausted).toBeUndefined();
  });

  test("a create whose last outcome is unknown keeps lookup-only recovery past the window", async () => {
    const f = await fixture();
    let creates = 0;
    f.api.createMeeting = async () => { creates++; if (creates === 1) throw busy(); throw new Error("socket closed"); };
    for (let i = 0; i < 10; i++) {
      await f.worker().tick();
      f.advance(60_000);
    }
    expect(f.now()).toBeGreaterThan(START + 300_000);
    expect(creates).toBeGreaterThan(1);
    const row = (await f.row())!;
    expect(row.phase).not.toBe("terminal");
    expect(row.capacityExhausted).toBeUndefined();
  });
});

describe("TC-581 shared capture across tenants", () => {
  test("A dispatches and B overlaps: B makes zero POSTs, shows shared_capture_pending, and its status has no meeting id", async () => {
    const f = await twoTenants();
    await f.attach();
    expect(f.posts.map(p => p.tenant)).toEqual([A]);
    expect(await f.rowB()).toMatchObject({ phase: "pending", errorCode: "shared_capture_pending" });
    expect((await f.rowB())?.sharedCapture?.corroborated).toBe(true);
    expect((await f.rowB())?.meetingId).toBeUndefined();
    const status = await f.status(B);
    expect(status.outcomes).toEqual([expect.objectContaining({ reason: "shared_capture_pending" })]);
    expect(status.outcomes[0]).not.toHaveProperty("meetingId");
    expect(JSON.stringify(status)).not.toContain("mtg_1");
    expect(JSON.stringify(status)).not.toContain(A);
    expect(await f.index.list(B)).toEqual([]);
  });

  test("A completes with B accepted: B's index gets A's id and provenance, disposition shared, marker written, rescan keeps it", async () => {
    const f = await twoTenants();
    await f.attach();
    f.meeting().status = "completed";
    f.afterWindow();
    await f.worker().tick();
    expect(await f.index.list(B)).toEqual(["mtg_1"]);
    const provenance = (await f.index.shares(B))["mtg_1"];
    expect(provenance).toMatchObject({ ownerTenant: A, ownerOccurrenceId: f.idOf(A, SUBJECT_A), recipientOccurrenceId: f.idOf(B, SUBJECT_B),
      title: "Calendar title", scheduledStart: new Date(START).toISOString() });
    expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "shared", sharedCapture: { result: "shared" } });
    expect((await f.rowB())?.errorCode).toBeUndefined();
    expect((await f.rowB())?.meetingId).toBeUndefined();
    expect(await f.store.getMarker(B, f.idOf(B, SUBJECT_B))).toMatchObject({ disposition: "shared" });
    expect(f.gets.filter(g => g.tenant === A && g.id === "event-a").length).toBeGreaterThan(0);
    // A rescan (and a rescan after detail compaction) never recreates or re-dispatches it.
    f.advance(120_000);
    await f.worker().tick();
    await f.store.deleteOccurrence(B, f.idOf(B, SUBJECT_B));
    await f.store.updateConnection(B, c => c && { ...c, nextScanAt: 0 });
    await f.worker().tick();
    expect(await f.rowB()).toBeNull();
    expect(f.posts.map(p => p.tenant)).toEqual([A]);
    expect(f.stops).toEqual([]);
    expect(await f.index.list(A)).toEqual(["mtg_1"]);
  });

  for (const response of ["tentative", "declined", "needsAction", null]) {
    test(`B ${response ?? "not invited"} on A's event: already_recorded, B's index untouched`, async () => {
      const f = await twoTenants({ bResponse: response });
      await f.attach();
      f.meeting().status = "completed";
      f.afterWindow();
      await f.worker().tick();
      expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "already_recorded",
        sharedCapture: { result: "not_shared", reason: "not_accepted_attendee" } });
      expect((await f.rowB())?.errorCode).toBeUndefined();
      expect(await f.index.list(B)).toEqual([]);
      expect(await f.index.shares(B)).toEqual({});
      expect(await f.store.getMarker(B, f.idOf(B, SUBJECT_B))).toMatchObject({ disposition: "already_recorded" });
      expect((await f.status(B)).outcomes).toEqual([expect.objectContaining({ reason: "already_recorded" })]);
    });
  }

  test("B has no verified email: already_recorded", async () => {
    const f = await twoTenants({ bEmail: "" });
    await f.attach();
    f.meeting().status = "completed";
    f.afterWindow();
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ disposition: "already_recorded", sharedCapture: { reason: "no_verified_email" } });
    expect(await f.index.list(B)).toEqual([]);
  });

  test("the sharing flag off: dedupe still holds, the grant is denied", async () => {
    const f = await twoTenants({ sharing: false });
    await f.attach();
    expect(f.posts.map(p => p.tenant)).toEqual([A]);
    f.meeting().status = "completed";
    f.afterWindow();
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ disposition: "already_recorded", sharedCapture: { reason: "sharing_disabled" } });
    expect(await f.index.list(B)).toEqual([]);
  });

  const revocations: [string, (f: Awaited<ReturnType<typeof twoTenants>>) => Promise<void>][] = [
    ["A's token is revoked (accessToken throws)", async f => { f.tokenErrors[A] = () => { throw new CalendarAutojoinError("needs_reconnect", 401); }; }],
    ["A's Google answers 401 twice", async f => { f.googleErrors[A] = () => { throw new GoogleCalendarError("calendar_unauthorized", 401, null, true); }; }],
    ["A's connection is disabled", async f => { await f.store.updateConnection(A, c => c && { ...c, state: "disabled", generation: c.generation + 1 }); }],
  ];
  for (const [name, revoke] of revocations) {
    test(`${name}: already_recorded`, async () => {
      const f = await twoTenants();
      await f.attach();
      f.meeting().status = "completed";
      await f.holdA();
      await revoke(f);
      f.afterWindow();
      await f.worker().tick();
      expect(await f.rowB()).toMatchObject({ disposition: "already_recorded", sharedCapture: { result: "not_shared" } });
      expect(await f.index.list(B)).toEqual([]);
      expect(f.stops).toEqual([]);
    });
  }

  test("A's Google returns transient 503s: the check retries, then denies after end + 24h", async () => {
    const f = await twoTenants();
    await f.attach();
    f.meeting().status = "completed";
    await f.holdA();
    f.googleErrors[A] = () => { throw new GoogleCalendarError("calendar_unavailable", 503, null, false, true); };
    f.afterWindow();
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "pending", errorCode: "shared_capture_pending" });
    const deferredUntil = (await f.rowB())!.nextAttemptAt;
    expect(deferredUntil).toBeGreaterThan(f.now());
    f.setNow(deferredUntil);
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "pending", errorCode: "shared_capture_pending" });
    f.setNow(START + 1_800_000 + 86_400_000);
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ disposition: "already_recorded", sharedCapture: { reason: "owner_calendar_unavailable" } });
    expect(await f.index.list(B)).toEqual([]);
  });

  test("A sent its bot manually (no claim) and ptx fails B with meeting_already_captured: cleaned up, already_recorded, nothing stopped", async () => {
    const f = await twoTenants();
    f.events[A] = [];
    await f.connectB();
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([B]);
    expect(await f.index.list(B)).toEqual(["mtg_1"]);
    Object.assign(f.meeting(), { status: "failed", error: { type: "meeting_join_failed", code: "meeting_already_captured",
      message: "Another notetaker from this service is already in this meeting." } });
    f.advance(60_000);
    await f.worker().tick();
    expect(await f.index.list(B)).toEqual([]);
    expect(f.deletes).toEqual(["mtg_1"]);
    expect(f.stops).toEqual([]);
    expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "already_recorded" });
    expect((await f.rowB())?.errorCode).toBeUndefined();
    expect(await f.index.shares(B)).toEqual({});
  });

  const variants: [string, Partial<GoogleCalendarEvent>][] = [
    ["uppercase", { hangoutLink: "https://meet.google.com/ABC-DEFG-HIJ" }],
    ["trailing slash", { hangoutLink: `${ROOM}/` }],
    ["?authuser=1", { hangoutLink: `${ROOM}?authuser=1` }],
    ["conferenceData instead of hangoutLink", { hangoutLink: undefined, conferenceData: { entryPoints: [{ entryPointType: "video", uri: `${ROOM}?authuser=1` }] } }],
  ];
  for (const [name, patch] of variants) {
    test(`URL variants collide: ${name}`, async () => {
      const f = await twoTenants();
      f.events[B] = [{ ...f.events[B]![0]!, ...patch }];
      await f.attach();
      expect(f.posts.map(p => p.tenant)).toEqual([A]);
    });
  }

  test("weekly recurrence: last week's completed claim does not block", async () => {
    const f = await twoTenants();
    f.events[A] = [];
    const week = 7 * 86_400_000;
    const lastWeek: CalendarOccurrence = { id: "last-week", tenant: A, subject: SUBJECT_A, eventId: "event-a", start: START - week,
      end: START - week + 1_800_000, meetingUrl: ROOM, title: "Calendar title", phase: "terminal", disposition: "completed",
      meetingId: "mtg_old", nextAttemptAt: 0, attemptCount: 0, stopRequested: false, updatedAt: START - week };
    await f.store.putOccurrence(lastWeek);
    await f.store.updateCaptureClaims(ROOM, () => [{ tenant: A, occurrenceId: "last-week", start: lastWeek.start, end: lastWeek.end, updatedAt: lastWeek.start }], START - week);
    await f.connectB();
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([B]);
    expect((await f.rowB())?.sharedCapture).toBeUndefined();
  });

  test("back-to-back meetings in the same room: B dispatches its own bot", async () => {
    const f = await twoTenants();
    const earlier = START - 1_800_000;
    f.events[A] = [event({ id: "event-a", start: { dateTime: new Date(earlier).toISOString() }, end: { dateTime: new Date(START).toISOString() } })];
    f.setNow(earlier - 30_000);
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([A]);
    f.setNow(START - 30_000);
    await f.connectB();
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([A, B]);
    expect(f.meeting("mtg_1").status).toBe("in_progress");
    expect(f.stops).toEqual([]);
  });

  test("A's meeting fails inside B's window: B sends its own bot", async () => {
    const f = await twoTenants();
    await f.attach();
    Object.assign(f.meeting(), { status: "failed", error: { type: "meeting_join_failed", code: "meeting_join_failed", message: "x" } });
    for (let i = 0; i < 4 && f.posts.length < 2; i++) { f.advance(30_000); await f.worker().tick(); }
    expect(f.posts.map(p => p.tenant)).toEqual([A, B]);
    expect((await f.rowB())?.sharedCapture).toBeUndefined();
    expect(await f.rowB()).toMatchObject({ meetingId: "mtg_2" });
    expect(f.stops).toEqual([]);
  });

  test("A's create is rejected after B attached, inside B's window: B sends its own bot", async () => {
    const f = await twoTenants();
    await f.connectB();
    const started = deferred<void>();
    const release = deferred<void>();
    const create = f.api.createMeeting;
    f.api.createMeeting = async (input, opts) => {
      if (input.metadata?.tinychat_address === A) {
        started.resolve(); await release.promise;
        throw new TranscriptionApiError(400, "invalid_request", "Rejected");
      }
      return create(input, opts);
    };
    // Only A is due first, so A holds the claim; B then attaches while A's POST is in flight.
    await f.store.updateConnection(B, c => c && { ...c, nextScanAt: f.now() + 3_600_000 });
    const first = f.worker().tick();
    await started.promise;
    await f.store.updateConnection(B, c => c && { ...c, nextScanAt: 0 });
    await f.worker().tick();
    expect((await f.rowB())?.sharedCapture?.ownerTenant).toBe(A);
    release.resolve();
    await first;
    expect(await f.rowA()).toMatchObject({ stopRequested: true, errorCode: "create_rejected" });
    for (let i = 0; i < 3 && !f.records.size; i++) { f.advance(30_000); await f.worker().tick(); }
    expect(f.records.size).toBe(1);
    expect(f.meeting().metadata?.tinychat_address).toBe(B);
  });

  test("after B's window: a dead owner is missed_window", async () => {
    const f = await twoTenants();
    await f.attach();
    await f.store.deleteOccurrence(A, f.idOf(A, SUBJECT_A));
    f.afterWindow();
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "missed_window" });
    expect((await f.rowB())?.errorCode).toBeUndefined();
    expect((await f.status(B)).outcomes[0]?.reason).toBe("missed_window");
    expect(f.posts.map(p => p.tenant)).toEqual([A]);
  });

  for (const [response, disposition] of [["accepted", "failed"], ["declined", "already_recorded"]] as const) {
    test(`after B's window: A's failed capture is ${disposition} when B is ${response}`, async () => {
      const f = await twoTenants({ bResponse: response });
      await f.attach();
      await f.holdA();
      f.meeting().status = "failed";
      f.setNow(START + 300_000);
      await f.worker().tick();
      expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition, sharedCapture: { result: "not_shared" } });
      expect((await f.rowB())?.errorCode).toBeUndefined();
      expect((await f.status(B)).outcomes[0]?.reason).toBe(disposition);
      expect(await f.index.list(B)).toEqual([]);
      expect(f.posts.map(p => p.tenant)).toEqual([A]);
    });
  }

  test("B turns auto-join off while attached: autojoin_disabled, nothing stopped", async () => {
    const f = await twoTenants();
    await f.attach();
    await f.store.updateConnection(B, c => c && { ...c, state: "disabled", generation: c.generation + 1 });
    f.advance(30_000);
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "autojoin_disabled" });
    expect(await f.store.getMarker(B, f.idOf(B, SUBJECT_B))).toBeNull();
    expect((await f.rowB())?.sharedCapture).toBeUndefined();
    expect(f.stops).toEqual([]);
    expect(f.meeting().status).toBe("in_progress");
  });

  test("5: toggling auto-join off and on while attached rediscovers the occurrence and can still send", async () => {
    const f = await twoTenants();
    await f.attach();
    await f.store.updateConnection(B, c => c && { ...c, state: "disabled", generation: c.generation + 1 });
    f.advance(30_000);
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "autojoin_disabled" });
    expect(await f.store.getMarker(B, f.idOf(B, SUBJECT_B))).toBeNull();
    await f.connect(B, SUBJECT_B, { generation: 3, verifiedEmail: B_EMAIL });
    f.meeting().status = "failed";
    for (let i = 0; i < 3 && f.posts.length < 2; i++) { f.advance(30_000); await f.worker().tick(); }
    expect(f.posts.map(p => p.tenant)).toEqual([A, B]);
    expect((await f.rowB())?.meetingId).toBe("mtg_2");
  });

  test("A and B due in the same tick, with the first POST still in flight: exactly one POST", async () => {
    const f = await twoTenants();
    await f.connectB();
    const started = deferred<void>();
    const release = deferred<void>();
    const create = f.api.createMeeting;
    f.api.createMeeting = async (...args) => { started.resolve(); await release.promise; return create(...args); };
    const tick = f.worker().tick();
    await started.promise;
    // The other tenant attaches while the first create is unresolved.
    for (let i = 0; i < 200; i++) {
      const rows = [await f.rowA(), await f.rowB()];
      if (rows.some(r => r?.sharedCapture)) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const attached = [await f.rowA(), await f.rowB()].filter(r => r?.sharedCapture);
    expect(attached).toHaveLength(1);
    release.resolve();
    await tick;
    expect(f.posts).toHaveLength(1);
    expect(f.records.size).toBe(1);
  });

  test("1a: an owner whose long block already completed does not hold B off; B sends its own bot", async () => {
    const f = await twoTenants();
    f.events[A] = [event({ id: "event-a", start: { dateTime: new Date(START - 3_600_000).toISOString() },
      end: { dateTime: new Date(START + 3 * 3_600_000).toISOString() } })];
    f.setNow(START - 3_600_000 - 30_000);
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([A]);
    f.meeting().status = "completed";
    f.advance(60_000);
    await f.worker().tick();
    expect(await f.rowA()).toMatchObject({ phase: "terminal", disposition: "completed" });
    f.setNow(START - 30_000);
    await f.connectB();
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([A, B]);
    expect((await f.rowB())?.sharedCapture).toBeUndefined();
    expect((await f.rowB())?.meetingId).toBe("mtg_2");
    f.meeting("mtg_2").status = "completed";
    f.afterWindow();
    await f.worker().tick();
    expect(await f.index.shares(B)).toEqual({});
    expect(await f.index.list(B)).toEqual(["mtg_2"]);
  });

  test("1a: an owner row lagging behind a meeting that is already processing does not hold B off", async () => {
    const f = await twoTenants();
    await f.worker().tick();
    f.meeting().status = "processing";
    await f.holdA();
    await f.connectB();
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([A, B]);
    expect((await f.rowA())?.phase).toBe("sent");
  });

  test("1b: the owner disabling auto-join mid-call releases an attached B to send its own bot", async () => {
    const f = await twoTenants();
    await f.attach();
    await f.store.updateConnection(A, c => c && { ...c, state: "disabled", generation: c.generation + 1 });
    await f.store.updateOccurrence(A, f.idOf(A, SUBJECT_A), r => r && { ...r, stopRequested: true, nextAttemptAt: f.now() });
    for (let i = 0; i < 3 && f.posts.length < 2; i++) { f.advance(30_000); await f.worker().tick(); }
    expect(f.posts.map(p => p.tenant)).toEqual([A, B]);
    // Only A's own bot is ever stopped (A's worker repeats its idempotent stop while ptx is processing).
    expect(f.stops.length).toBeGreaterThan(0);
    expect(new Set(f.stops)).toEqual(new Set(["mtg_1"]));
    expect((await f.rowB())?.meetingId).toBe("mtg_2");
  });

  test("4: an attached B released inside its window sends its own bot in the same pass, without re-attaching", async () => {
    const f = await twoTenants();
    await f.attach();
    f.meeting().status = "failed";
    await f.holdA();
    f.advance(30_000);
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([A, B]);
    expect((await f.rowB())?.sharedCapture).toBeUndefined();
    expect((await f.rowB())?.meetingId).toBe("mtg_2");
  });

  test("4: an owner that never got a meeting id does not keep B pending forever", async () => {
    const f = await twoTenants();
    f.api.createMeeting = async () => { throw new TranscriptionApiError(503, "unavailable", "Unavailable"); };
    f.api.lookupMeetingByIdempotencyKey = async () => null;
    await f.worker().tick();
    expect((await f.rowA())?.meetingId).toBeUndefined();
    await f.connectB();
    await f.worker().tick();
    expect((await f.rowB())?.sharedCapture?.ownerTenant).toBe(A);
    f.setNow(START + 360_000);
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "missed_window" });
    expect((await f.rowB())?.errorCode).toBeUndefined();
  });

  test("with sharing off, a corroborated attach shows capture_in_progress and never promises a transcript", async () => {
    const f = await twoTenants({ sharing: false });
    await f.attach();
    expect((await f.rowB())?.sharedCapture?.corroborated).toBe(true);
    expect((await f.rowB())?.errorCode).toBe("capture_in_progress");
    expect((await f.status(B)).outcomes[0]?.reason).toBe("capture_in_progress");
    f.advance(30_000);
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "pending", errorCode: "capture_in_progress" });
  });

  test("with sharing on, a corroborated attach shows shared_capture_pending", async () => {
    const f = await twoTenants({ sharing: true });
    await f.attach();
    expect((await f.status(B)).outcomes[0]?.reason).toBe("shared_capture_pending");
    f.advance(30_000);
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "pending", errorCode: "shared_capture_pending" });
  });

  /** B's long block in A's room, which A's own invite does not corroborate. B sends first. */
  async function hijack() {
    const f = await twoTenants({ bResponse: null });
    f.events[B] = [{ ...f.events[B]![0]!, start: { dateTime: new Date(START - 600_000).toISOString() },
      end: { dateTime: new Date(START + 4 * 3_600_000).toISOString() } }];
    await f.connectB();
    f.setNow(START - 630_000);
    await f.worker().tick();
    expect(f.posts.map(p => p.tenant)).toEqual([B]);
    f.setNow(START - 30_000);
    await f.worker().tick();
    return f;
  }

  test("2: an attach the attaching account's own invite does not corroborate is unverified and never shared", async () => {
    const f = await hijack();
    expect((await f.rowA())?.sharedCapture).toMatchObject({ ownerTenant: B, corroborated: false });
    expect((await f.rowA())?.errorCode).toBe("unverified_capture");
    expect(f.posts.map(p => p.tenant)).toEqual([B]);
    expect((await f.status(A)).outcomes[0]?.reason).toBe("unverified_capture");
    f.meeting().status = "completed";
    f.afterWindow();
    await f.worker().tick();
    expect(await f.rowA()).toMatchObject({ phase: "terminal", disposition: "unverified_capture",
      sharedCapture: { result: "not_shared", reason: "owner_not_on_invite" } });
    expect((await f.rowA())?.errorCode).toBeUndefined();
    expect(await f.index.list(A)).toEqual([]);
    expect(await f.store.getMarker(A, f.idOf(A, SUBJECT_A))).toMatchObject({ disposition: "unverified_capture" });
  });

  test("2: an unverified capture that ends inside the window lets the attached account send its own bot", async () => {
    const f = await hijack();
    expect((await f.rowA())?.sharedCapture?.corroborated).toBe(false);
    f.setNow(START + 60_000);
    f.meeting().status = "failed";
    for (let i = 0; i < 3 && f.posts.length < 2; i++) { await f.worker().tick(); f.advance(30_000); }
    expect(f.posts.map(p => p.tenant)).toEqual([B, A]);
  });

  test("2: an owner with no verified email can only be attached to as unverified", async () => {
    const f = await twoTenants({ aEmail: null });
    await f.attach();
    expect((await f.rowB())?.sharedCapture?.corroborated).toBe(false);
    expect((await f.rowB())?.errorCode).toBe("unverified_capture");
    f.meeting().status = "completed";
    f.afterWindow();
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "unverified_capture" });
    expect(await f.index.list(B)).toEqual([]);
  });

  test("6c: a non-authorization error reading the owner's token retries, then grants", async () => {
    const f = await twoTenants();
    await f.attach();
    f.meeting().status = "completed";
    await f.holdA();
    f.tokenErrors[A] = () => { throw new Error("kv unavailable"); };
    f.afterWindow();
    await f.worker().tick();
    const pending = (await f.rowB())!;
    expect(pending).toMatchObject({ phase: "pending", errorCode: "shared_capture_pending" });
    expect(pending.nextAttemptAt).toBeGreaterThan(f.now());
    f.tokenErrors[A] = undefined;
    f.setNow(pending.nextAttemptAt);
    await f.worker().tick();
    expect(await f.rowB()).toMatchObject({ disposition: "shared" });
    expect(await f.index.list(B)).toEqual(["mtg_1"]);
  });

  test("reconcileShared running twice (lost finish) leaves one index entry", async () => {
    const f = await twoTenants();
    await f.attach();
    f.meeting().status = "completed";
    const update = f.store.updateOccurrence.bind(f.store);
    let fail = true;
    f.store.updateOccurrence = (tenant, id, fn) => update(tenant, id, current => {
      const next = fn(current);
      if (fail && next?.disposition === "shared") { fail = false; throw new Error("finish lost"); }
      return next;
    });
    f.afterWindow();
    await f.worker().tick();
    expect(await f.index.list(B)).toEqual(["mtg_1"]);
    expect((await f.rowB())?.phase).not.toBe("terminal");
    f.setNow((await f.rowB())!.nextAttemptAt);
    await f.worker().tick();
    expect(await f.index.list(B)).toEqual(["mtg_1"]);
    expect(Object.keys(await f.index.shares(B))).toEqual(["mtg_1"]);
    expect(await f.rowB()).toMatchObject({ phase: "terminal", disposition: "shared" });
  });
});
