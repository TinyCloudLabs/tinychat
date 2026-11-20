import { describe, expect, jest, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { TranscriptSentence } from "@tinyboilerplate/core";

import type {
  GranolaNote,
  GranolaNotePage,
  GranolaResult,
  GranolaTranscriptItem,
} from "./granolaClient";
import type {
  NormalizedMeeting,
  StoreResult,
  UpdateSyncStateInput,
  UpsertMeetingOutcome,
} from "./connectorStore";
import {
  normalizeGranolaNote,
  syncGranola,
  abortGranolaSync,
  runGranolaSpaceWrite,
  type GranolaSyncClient,
  type GranolaSyncStore,
} from "./granolaSync";
import { createConnectorWebhooksClient } from "./webhooksApi";
const realSetImmediate = setImmediate;

const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });
const tcw = {} as TinyCloudWeb;

// ── Fixtures (shaped from docs.granola.ai, 2026-11-18) ──────────────────

function noteSummary(id: string, updated = "2026-11-10T15:00:00Z") {
  return {
    id,
    title: `Note ${id}`,
    owner: { name: "Ada Owner", email: "ada@example.com" },
    created_at: "2026-11-10T14:00:00Z",
    updated_at: updated,
    deleted_at: null,
  };
}

function noteDetail(id: string): GranolaNote {
  return {
    ...noteSummary(id),
    web_url: "https://notes.granola.ai/t/" + id,
    calendar_event: {
      event_title: "Weekly standup",
      invitees: [{ email: "bob@example.com" }, { email: "ada@example.com" }],
      organiser: "bob@example.com",
      scheduled_start_time: "2026-11-10T14:00:00Z",
      scheduled_end_time: "2026-11-10T14:30:00Z",
    },
    attendees: [
      { name: "Ada Owner", email: "ada@example.com" },
      { name: null, email: "carol@example.com" },
    ],
    folder_membership: [{ name: "Team meetings" }],
    space_membership: [{ name: "Engineering" }],
    summary_text: "Plain summary",
    summary_markdown: "# Standup\nDiscussed roadmap.",
    attachment_count: 2,
  };
}

function transcriptItems(): GranolaTranscriptItem[] {
  return [
    {
      speaker: { source: "microphone", attribution: "me", diarization_label: null, name: null },
      text: "hello from me",
      start_time: "2026-11-10T14:00:00Z",
      end_time: "2026-11-10T14:00:04Z",
    },
    {
      speaker: { source: "speaker", attribution: "them", diarization_label: "Speaker B", name: null },
      text: "and from them",
      start_time: "2026-11-10T14:00:10Z",
      end_time: "2026-11-10T14:00:12Z",
    },
    {
      speaker: { source: "speaker", attribution: null, diarization_label: null, name: "Carol" },
      text: "named line",
      start_time: "2026-11-10T14:00:20Z",
      end_time: "2026-11-10T14:00:22Z",
    },
  ];
}

// ── Fakes ───────────────────────────────────────────────────────────────

class FakeStore implements GranolaSyncStore {
  meetings: NormalizedMeeting[] = [];
  bodies = new Map<string, TranscriptSentence[]>();
  state: UpdateSyncStateInput | null = null;
  connectionStatus: "connected" | "disconnected" | null = "connected";
  lastSyncedAt: string | null = null;
  failUpsertFor: string | null = null;

  async ensureSchema(): Promise<StoreResult<void>> { return ok(undefined); }
  async listMeetingMetadataValues(
    _: TinyCloudWeb, source: string, key: string,
  ): Promise<StoreResult<Record<string, string | null>>> {
    const out: Record<string, string | null> = {};
    for (const m of this.meetings.filter((m) => m.source === source)) {
      const v = m.metadata[key];
      out[m.sourceId] = typeof v === "string" ? v : null;
    }
    return ok(out);
  }
  async upsertMeeting(
    _: TinyCloudWeb, meeting: NormalizedMeeting, sentences: TranscriptSentence[],
  ): Promise<StoreResult<UpsertMeetingOutcome>> {
    if (this.failUpsertFor === meeting.sourceId) {
      return { ok: false, error: { code: "X", message: "upsert failed" } };
    }
    const existing = this.meetings.findIndex(
      (m) => m.source === meeting.source && m.sourceId === meeting.sourceId);
    const inserted = existing < 0;
    if (inserted) this.meetings.push(meeting);
    else this.meetings[existing] = meeting;
    this.bodies.set(`${meeting.source}/${meeting.sourceId}`, sentences);
    return ok({ id: meeting.id, inserted, createdAt: "2026-11-10T00:00:00Z" });
  }
  async updateSyncState(_: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>> {
    this.state = input;
    return ok(undefined);
  }
  async getConnection(): Promise<StoreResult<{
    status: "connected" | "disconnected"; lastSyncedAt: string | null;
  } | null>> {
    return ok(this.connectionStatus === null
      ? null
      : { status: this.connectionStatus, lastSyncedAt: this.lastSyncedAt });
  }
  async countMeetings(_: TinyCloudWeb, source: string): Promise<StoreResult<number>> {
    return ok(this.meetings.filter((m) => m.source === source).length);
  }
}

class MockClient implements GranolaSyncClient {
  readonly delayMs = 0;
  pages: GranolaNotePage[];
  details = new Map<string, GranolaResult<GranolaNote>>();
  transcripts = new Map<string, GranolaResult<{ items: GranolaTranscriptItem[]; truncated: boolean }>>();
  listCalls: { cursor: string | null; updatedAfter: string | null }[] = [];
  noteCalls: string[] = [];

  constructor(pages: GranolaNotePage[]) { this.pages = [...pages]; }

  async listNotes(opts: {
    cursor?: string | null; updatedAfter?: string | null;
  }): Promise<GranolaResult<GranolaNotePage>> {
    this.listCalls.push({ cursor: opts.cursor ?? null, updatedAfter: opts.updatedAfter ?? null });
    const page = this.pages.shift();
    if (!page) return { ok: false, error: { kind: "api-error", message: "no more pages" } };
    return { ok: true, data: page };
  }
  async getNote(id: string): Promise<GranolaResult<GranolaNote>> {
    this.noteCalls.push(id);
    return this.details.get(id) ?? { ok: false, error: { kind: "api-error", message: "missing", httpStatus: 500 } };
  }
  async getTranscript(id: string): Promise<GranolaResult<{ items: GranolaTranscriptItem[]; truncated: boolean }>> {
    return this.transcripts.get(id)
      ?? { ok: true, data: { items: transcriptItems(), truncated: false } };
  }
}

function syncOpts(store: FakeStore, client: MockClient): Parameters<typeof syncGranola>[0] {
  return { client, store, tcw, checkPurge: async () => false, sleepImpl: async () => true, now: () => "2026-11-18T12:00:00Z" };
}

// ── Mapper ──────────────────────────────────────────────────────────────

describe("normalizeGranolaNote", () => {
  test("maps the detail + transcript into connector_meeting shape", async () => {
    const { meeting, sentences } = await normalizeGranolaNote(noteDetail("not_0001"), transcriptItems(), false);
    expect(meeting.source).toBe("granola");
    expect(meeting.sourceId).toBe("not_0001");
    expect(meeting.title).toBe("Note not_0001");
    // Calendar event wins for start and organiser; 30-minute event → 1800 s.
    expect(meeting.startedAt).toBe("2026-11-10T14:00:00.000Z");
    expect(meeting.durationSecs).toBe(1800);
    expect(meeting.organizerEmail).toBe("bob@example.com");
    expect(meeting.summaryOverview).toBe("# Standup\nDiscussed roadmap.");
    expect(meeting.summaryActionItems).toBeNull();
    // Attendees + invitees merged, deduped: ada (attendee+invitee), carol (email-as-name), bob.
    expect(meeting.participants).toEqual([
      { name: "Ada Owner", email: "ada@example.com" },
      { name: "carol@example.com", email: "carol@example.com" },
      { name: "bob@example.com", email: "bob@example.com" },
    ]);
    // Metadata carries the web URL and memberships but NEVER private notes or attachment URLs.
    expect(meeting.metadata.web_url).toBe("https://notes.granola.ai/t/not_0001");
    expect(meeting.metadata.folders).toEqual(["Team meetings"]);
    expect(meeting.metadata.attachment_count).toBe(2);
    expect(JSON.stringify(meeting.metadata)).not.toContain("private_notes");
    expect(JSON.stringify(meeting.metadata)).not.toContain("attachments");
    // Three utterances: "me" resolves to the owner name, unnamed "them" to the
    // diarization label, a named speaker to the name. Times are SECONDS from
    // the first utterance (ISO instants in, offsets out).
    expect(sentences.map((s) => s.speaker_name)).toEqual(["Ada Owner", "Speaker B", "Carol"]);
    expect(sentences.map((s) => s.start_time)).toEqual([0, 10, 20]);
    expect(sentences.map((s) => s.end_time)).toEqual([4, 12, 22]);
    expect(meeting.metadata.transcript_state).toBe("stored");
  });

  test("a note with no transcript still maps, transcript_state absent", async () => {
    const { meeting, sentences } = await normalizeGranolaNote(noteDetail("not_2"), [], false);
    expect(sentences).toEqual([]);
    expect(meeting.metadata.transcript_state).toBe("absent");
    expect(meeting.durationSecs).toBe(1800); // still from the calendar event
  });

  test("no calendar event falls back to created_at and title stays the note title", async () => {
    const note = { ...noteDetail("not_3"), calendar_event: null, title: null };
    const { meeting } = await normalizeGranolaNote(note, [], false);
    expect(meeting.startedAt).toBe("2026-11-10T14:00:00.000Z");
    expect(meeting.title).toBeNull();
    expect(meeting.durationSecs).toBeNull();
  });
});

// ── Engine ──────────────────────────────────────────────────────────────

describe("syncGranola", () => {
  for (const mode of ["timeout", "stop"] as const) {
    test(`${mode} releases a pending purge request and the shared write lane without saving or advancing progress`, async () => {
      const store = new FakeStore();
      store.lastSyncedAt = "2026-11-17T12:00:00Z";
      const client = new MockClient([{ notes: [noteSummary("not_0001")], hasMore: false, cursor: null }]);
      client.details.set("not_0001", { ok: true, data: noteDetail("not_0001") });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<Response>();
      const webhooks = createConnectorWebhooksClient("https://backend.example", {
        sessionStore: { getToken: () => "test-session", isExpired: () => false } as never,
        fetchImpl: ((_input, init) => {
          const pending = Promise.withResolvers<Response>();
          const signal = init?.signal;
          if (signal?.aborted) pending.reject(signal.reason);
          else signal?.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
          entered.resolve();
          void release.promise.then(pending.resolve);
          return pending.promise;
        }) as typeof fetch,
      });
      jest.useFakeTimers();
      const syncing = syncGranola({
        ...syncOpts(store, client),
        checkPurge: (id, timestamp, signal) => webhooks.checkPurge(id, timestamp, "granola", signal),
      });
      await entered.promise;
      const nextWrite = runGranolaSpaceWrite(async () => "lane available");
      const stopped = mode === "stop" ? abortGranolaSync() : Promise.resolve();
      if (mode === "timeout") jest.advanceTimersByTime(20_000);
      let finished = false;
      void Promise.all([syncing, nextWrite, stopped]).then(() => { finished = true; });
      try {
        // Drain the native promise chain after the controlled timer or abort, without a wall-clock wait.
        const turn = Promise.withResolvers<void>();
        realSetImmediate(turn.resolve);
        await turn.promise;
        expect(finished).toBe(true);
        expect(await syncing).toMatchObject({ ok: true, data: { added: 0 } });
        expect(await nextWrite).toBe("lane available");
        expect(store.meetings).toEqual([]);
        expect(store.bodies.size).toBe(0);
        expect(store.state).toMatchObject({ lastSyncStatus: "partial", lastSyncedAt: "2026-11-17T12:00:00Z" });
      } finally {
        release.resolve(Response.json({ blocked: false }));
        await syncing;
        await nextWrite;
        await stopped;
        jest.useRealTimers();
      }
    });
  }

  test("REST sync skips a deleted note without recreating its row or transcript", async () => {
    const store = new FakeStore();
    const client = new MockClient([{ notes: [noteSummary("not_0001")], hasMore: false, cursor: null }]);
    client.details.set("not_0001", { ok: true, data: noteDetail("not_0001") });
    const result = await syncGranola({
      ...syncOpts(store, client),
      checkPurge: async () => true,
    });
    expect(result).toMatchObject({ ok: true, data: { added: 0, skipped: 1 } });
    expect(store.meetings).toEqual([]);
    expect(store.bodies.has("granola/not_0001")).toBe(false);
  });

  test("an unreadable purge ledger prevents REST sync from writing the note", async () => {
    const store = new FakeStore();
    const client = new MockClient([{ notes: [noteSummary("not_0001")], hasMore: false, cursor: null }]);
    client.details.set("not_0001", { ok: true, data: noteDetail("not_0001") });
    const result = await syncGranola({
      ...syncOpts(store, client),
      checkPurge: async () => { throw new Error("purge ledger unavailable"); },
    });
    expect(result).toMatchObject({ ok: true, data: { added: 0 } });
    expect(store.meetings).toEqual([]);
    expect(store.bodies.has("granola/not_0001")).toBe(false);
    expect(store.state?.lastSyncStatus).toBe("partial");
    expect(store.state?.lastSyncedAt).toBeNull();
  });

  test("full sync stores the meeting row and the transcript body", async () => {
    const store = new FakeStore();
    const client = new MockClient([
      { notes: [noteSummary("not_0001"), noteSummary("not_0002")], hasMore: false, cursor: null },
    ]);
    client.details.set("not_0001", { ok: true, data: noteDetail("not_0001") });
    client.details.set("not_0002", { ok: true, data: noteDetail("not_0002") });
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.added).toBe(2);
      expect(res.data.errors).toEqual([]);
    }
    expect(store.meetings).toHaveLength(2);
    expect(store.bodies.get("granola/not_0001")).toHaveLength(3);
    // First page has no updated_after (no watermark yet).
    expect(client.listCalls[0]!.updatedAfter).toBeNull();
    expect(store.state?.lastSyncStatus).toBe("ok");
    expect(store.state?.lastSyncedAt).toBe("2026-11-18T12:00:00Z");
    expect(store.state?.itemCount).toBe(2);
  });

  test("incremental sync passes updated_after with the overlap and skips unchanged notes", async () => {
    const store = new FakeStore();
    store.lastSyncedAt = "2026-11-17T12:00:00Z";
    // Seed a stored row whose upstream updated_at is unchanged.
    const seeded = (await normalizeGranolaNote(noteDetail("not_0001"), transcriptItems(), false)).meeting;
    store.meetings.push(seeded);
    const client = new MockClient([
      { notes: [noteSummary("not_0001"), noteSummary("not_0002", "2026-11-17T13:00:00Z")], hasMore: false, cursor: null },
    ]);
    client.details.set("not_0002", { ok: true, data: noteDetail("not_0002") });
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(true);
    // updated_after = watermark - 60 s overlap.
    expect(client.listCalls[0]!.updatedAfter).toBe("2026-11-17T11:59:00.000Z");
    // not_0001's updated_at matches the stored metadata → no detail fetch.
    expect(client.noteCalls).toEqual(["not_0002"]);
    expect(store.meetings).toHaveLength(2);
  });

  test("a changed note is re-fetched and upserts over the stored row", async () => {
    const store = new FakeStore();
    const seeded = (await normalizeGranolaNote(noteDetail("not_0001"), transcriptItems(), false)).meeting;
    store.meetings.push(seeded);
    const client = new MockClient([
      { notes: [noteSummary("not_0001", "2026-11-18T09:00:00Z")], hasMore: false, cursor: null },
    ]);
    const edited = { ...noteDetail("not_0001"), summary_markdown: "# Edited" };
    client.details.set("not_0001", { ok: true, data: edited });
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(true);
    expect(client.noteCalls).toEqual(["not_0001"]);
    expect(store.meetings[0]!.summaryOverview).toBe("# Edited");
  });

  test("a note deleted upstream (deleted_at set) is skipped without a detail call", async () => {
    const store = new FakeStore();
    const client = new MockClient([
      { notes: [{ ...noteSummary("not_0001"), deleted_at: "2026-11-18T00:00:00Z" }], hasMore: false, cursor: null },
    ]);
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(true);
    expect(client.noteCalls).toEqual([]);
    expect(store.meetings).toHaveLength(0);
  });

  test("a 404 between list and detail is a skip, not an error", async () => {
    const store = new FakeStore();
    const client = new MockClient([
      { notes: [noteSummary("not_0001")], hasMore: false, cursor: null },
    ]);
    client.details.set("not_0001", { ok: false, error: { kind: "api-error", message: "gone", httpStatus: 404, notFound: true } });
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.errors).toEqual([]);
  });

  test("a 401 is terminal auth — the run stops and lastSyncedAt is preserved", async () => {
    const store = new FakeStore();
    store.lastSyncedAt = "2026-11-10T00:00:00Z";
    const client = new MockClient([
      { notes: [noteSummary("not_0001"), noteSummary("not_0002")], hasMore: false, cursor: null },
    ]);
    client.details.set("not_0001", { ok: false, error: { kind: "invalid-key", message: "bad key", httpStatus: 401 } });
    client.details.set("not_0002", { ok: true, data: noteDetail("not_0002") });
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("auth");
    // Terminal stops the queue: oldest-first means not_0002 already stored, then
    // the 401 ends the run and the watermark does not move.
    expect(client.noteCalls).toEqual(["not_0002", "not_0001"]);
    expect(store.state?.lastSyncedAt).toBe("2026-11-10T00:00:00Z");
    expect(store.state?.lastSyncStatus).toBe("error");
  });

  test("a stubborn 429 (Retry-After over the cap) ends the run rate-limited", async () => {
    const store = new FakeStore();
    const client = new MockClient([
      { notes: [noteSummary("not_0001")], hasMore: false, cursor: null },
    ]);
    client.details.set("not_0001", {
      ok: false,
      error: { kind: "rate-limited", message: "slow", retryAfterMs: 120_000 },
    });
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("rate-limited");
  });

  test("a transcript still throttled after retries pauses the entire run, not just the note", async () => {
    const store = new FakeStore();
    const oldest = "not_0002";
    const newest = "not_0001";
    const client = new MockClient([
      { notes: [noteSummary(newest), noteSummary(oldest)], hasMore: false, cursor: null },
    ]);
    client.details.set(oldest, { ok: true, data: noteDetail(oldest) });
    client.transcripts.set(oldest, {
      ok: false, error: { kind: "rate-limited", message: "slow", retryAfterMs: 5_000 },
    });
    const result = await syncGranola(syncOpts(store, client));
    expect(result).toMatchObject({ ok: false, error: { kind: "rate-limited", retryAfterMs: 5_000 } });
    expect(client.noteCalls).toEqual([oldest]);
  });

  test("a failed listing persists a fixed code, never upstream error text", async () => {
    const store = new FakeStore();
    const client = new MockClient([]);
    client.listNotes = async () => ({
      ok: false,
      error: { kind: "api-error", message: "PRIVATE_UPSTREAM_ERROR", httpStatus: 502 },
    });
    await syncGranola(syncOpts(store, client));
    expect(store.state).toMatchObject({
      lastSyncStatus: "error",
      lastSyncError: "granola:sync-failed",
    });
  });

  test("a failed detail persists a fixed partial code rather than a note count or upstream text", async () => {
    const store = new FakeStore();
    const client = new MockClient([
      { notes: [noteSummary("not_0001")], hasMore: false, cursor: null },
    ]);
    client.details.set("not_0001", { ok: false, error: { kind: "api-error", message: "PRIVATE_UPSTREAM_ERROR", httpStatus: 502 } });
    await syncGranola(syncOpts(store, client));
    expect(store.state).toMatchObject({
      lastSyncStatus: "partial",
      lastSyncError: "granola:sync-partial",
    });
  });

  test("listing pagination follows the cursor to exhaustion", async () => {
    const store = new FakeStore();
    const client = new MockClient([
      { notes: [noteSummary("not_0001")], hasMore: true, cursor: "c2" },
      { notes: [noteSummary("not_0002")], hasMore: false, cursor: null },
    ]);
    client.details.set("not_0001", { ok: true, data: noteDetail("not_0001") });
    client.details.set("not_0002", { ok: true, data: noteDetail("not_0002") });
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(true);
    expect(client.listCalls.map((c) => c.cursor)).toEqual([null, "c2"]);
    expect(store.meetings).toHaveLength(2);
  });

  test("not connected refuses without touching the upstream", async () => {
    const store = new FakeStore();
    store.connectionStatus = "disconnected";
    const client = new MockClient([]);
    const res = await syncGranola(syncOpts(store, client));
    expect(res.ok).toBe(false);
    expect(client.listCalls).toHaveLength(0);
  });
});
