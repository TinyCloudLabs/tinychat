import { describe, expect, test } from "bun:test";
import { CalendarAutojoinWorker } from "../services/calendar-autojoin-worker.js";
import { MemoryCalendarAutojoinStore, TenantCoordinator, type CalendarOccurrence } from "../services/calendar-autojoin-store.js";
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

async function fixture() {
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
    async accessToken(_tenant: string, forceRefresh = false) { refreshes.push(forceRefresh); return "access"; },
    async cleanupEnabling() {},
    async needsReconnect(tenant: string, generation: number) {
      await store.updateConnection(tenant, c => c?.generation === generation ? { ...c, state: "needs_reconnect" } : c);
    },
  };
  const worker = () => new CalendarAutojoinWorker({ store, index, coordinator, calendar, api, connection,
    now: () => now, random: () => 0, sleep: async ms => { sleeps.push(ms); now += ms; } });
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
    const list = f.calendar.listEvents;
    const get = f.calendar.getEvent;
    f.calendar.listEvents = (...args) => limiter.run(() => operation(() => list(...args)));
    f.calendar.getEvent = (...args) => limiter.run(() => operation(() => get(...args)));
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
