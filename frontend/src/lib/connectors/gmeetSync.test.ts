import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesSentence } from "./firefliesClient";
import type {
  NormalizedMeeting,
  StoreResult,
  UpdateSyncStateInput,
  UpsertMeetingOutcome,
} from "./connectorStore";
import type {
  GmeetConferenceRecord,
  GmeetError,
  GmeetParticipant,
  GmeetResult,
  GmeetTranscript,
  GmeetTranscriptEntry,
} from "./gmeetClient";
import {
  GMEET_LAG_BUFFER_MS,
  GMEET_MAX_BACKFILL_MS,
  _resetGmeetSyncSingleFlightForTests,
  gmeetSyncWindowStartIso,
  gmeetSyncWindowStartMs,
  isGmeetSyncInFlight,
  isPersistableTranscriptState,
  isTerminalGmeetError,
  syncGoogleMeet,
  type GmeetSyncClient,
  type GmeetSyncProgress,
  type GmeetSyncStore,
} from "./gmeetSync";
import type { ConnectorConnection, ConnectorId } from "./types";

const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });

const TCW = {} as unknown as TinyCloudWeb;

const NOW_MS = Date.parse("2026-08-17T12:00:00.000Z");
const now = () => NOW_MS;

// ── Fakes ───────────────────────────────────────────────────────────────
//
// The store fake mirrors the real upsertMeeting semantics closely enough for the
// engine: dedup on (source, source_id), keep-existing-on-null scalars, metadata
// shallow-merge, preserved id/created_at. Every storage call is appended to a
// shared call log so the KV-before-row ordering can be asserted directly.

interface StoredRow {
  id: string;
  createdAt: string;
  meeting: NormalizedMeeting;
}

class FakeStore implements GmeetSyncStore {
  rows: StoredRow[] = [];
  bodies = new Map<string, FirefliesSentence[]>();
  connection: ConnectorConnection | null = null;
  state: UpdateSyncStateInput | null = null;
  stateWrites = 0;
  calls: string[] = [];
  getConnectionError = false;
  /** Fires after each upsert lands — the seam an abort test aborts from. */
  afterUpsert: ((sourceId: string) => void) | null = null;
  /** Source ids whose KV write must fail (per-item storage error). */
  failBodyFor = new Set<string>();

  async getConnection(
    _: TinyCloudWeb,
    connectorId: ConnectorId,
  ): Promise<StoreResult<ConnectorConnection | null>> {
    this.calls.push(`getConnection:${connectorId}`);
    if (this.getConnectionError) {
      return { ok: false, error: { code: "STORE", message: "db unreadable" } };
    }
    return ok(this.connection);
  }

  async putTranscriptBody(
    _: TinyCloudWeb,
    source: string,
    sourceId: string,
    sentences: FirefliesSentence[],
  ): Promise<StoreResult<void>> {
    this.calls.push(`putTranscriptBody:${sourceId}`);
    if (this.failBodyFor.has(sourceId)) {
      return { ok: false, error: { code: "KV", message: "kv write refused" } };
    }
    this.bodies.set(`${source}/${sourceId}`, sentences);
    return ok(undefined);
  }

  async upsertMeeting(
    _: TinyCloudWeb,
    meeting: NormalizedMeeting,
    sentences: FirefliesSentence[],
  ): Promise<StoreResult<UpsertMeetingOutcome>> {
    this.calls.push(`upsertMeeting:${meeting.sourceId}`);
    const existing = this.rows.find(
      (r) => r.meeting.source === meeting.source && r.meeting.sourceId === meeting.sourceId,
    );
    let outcome: UpsertMeetingOutcome;
    if (!existing) {
      this.rows.push({ id: meeting.id, createdAt: "created-at", meeting: { ...meeting } });
      this.bodies.set(`${meeting.source}/${meeting.sourceId}`, sentences);
      outcome = { id: meeting.id, inserted: true, createdAt: "created-at" };
    } else {
      existing.meeting = {
        ...existing.meeting,
        title: meeting.title ?? existing.meeting.title,
        startedAt: meeting.startedAt ?? existing.meeting.startedAt,
        durationSecs: meeting.durationSecs ?? existing.meeting.durationSecs,
        participants:
          meeting.participants.length > 0 ? meeting.participants : existing.meeting.participants,
        metadata: { ...existing.meeting.metadata, ...meeting.metadata },
      };
      if (sentences.length > 0) this.bodies.set(`${meeting.source}/${meeting.sourceId}`, sentences);
      outcome = { id: existing.id, inserted: false, createdAt: existing.createdAt };
    }
    this.afterUpsert?.(meeting.sourceId);
    return ok(outcome);
  }

  async updateSyncState(_: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>> {
    this.calls.push("updateSyncState");
    this.stateWrites++;
    this.state = input;
    return ok(undefined);
  }

  async countMeetings(_: TinyCloudWeb, source: string): Promise<StoreResult<number>> {
    return ok(this.rows.filter((r) => r.meeting.source === source).length);
  }
}

interface RecordFixture {
  record: GmeetConferenceRecord;
  participants?: GmeetParticipant[];
  transcripts?: GmeetTranscript[];
  entries?: Record<string, GmeetTranscriptEntry[]>;
  /** Inject a client failure for exactly one call on this record. */
  fail?: { on: "participants" | "transcripts" | "entries"; error: GmeetError };
}

class FakeClient implements GmeetSyncClient {
  readonly delayMs = 0;
  calls: string[] = [];
  windowStarts: string[] = [];
  listError: GmeetError | null = null;

  constructor(private readonly fixtures: RecordFixture[]) {}

  private find(name: string): RecordFixture | undefined {
    return this.fixtures.find((f) => f.record.name === name);
  }

  async pace(): Promise<void> {
    this.calls.push("pace");
  }

  async listConferenceRecords(
    windowStartIso: string,
  ): Promise<GmeetResult<GmeetConferenceRecord[]>> {
    this.calls.push("listConferenceRecords");
    this.windowStarts.push(windowStartIso);
    if (this.listError) return { ok: false, error: this.listError };
    // Google's own order: newest-first. The engine is responsible for reversing.
    return { ok: true, data: this.fixtures.map((f) => f.record) };
  }

  async listParticipants(recordName: string): Promise<GmeetResult<GmeetParticipant[]>> {
    this.calls.push(`listParticipants:${recordName}`);
    const fixture = this.find(recordName);
    if (fixture?.fail?.on === "participants") return { ok: false, error: fixture.fail.error };
    return { ok: true, data: fixture?.participants ?? [] };
  }

  async listTranscripts(recordName: string): Promise<GmeetResult<GmeetTranscript[]>> {
    this.calls.push(`listTranscripts:${recordName}`);
    const fixture = this.find(recordName);
    if (fixture?.fail?.on === "transcripts") return { ok: false, error: fixture.fail.error };
    return { ok: true, data: fixture?.transcripts ?? [] };
  }

  async listTranscriptEntries(
    transcriptName: string,
  ): Promise<GmeetResult<GmeetTranscriptEntry[]>> {
    this.calls.push(`listTranscriptEntries:${transcriptName}`);
    const fixture = this.fixtures.find((f) =>
      transcriptName.startsWith(`${f.record.name}/transcripts/`),
    );
    if (fixture?.fail?.on === "entries") return { ok: false, error: fixture.fail.error };
    return { ok: true, data: fixture?.entries?.[transcriptName] ?? [] };
  }
}

// ── Fixture builders ────────────────────────────────────────────────────

function participant(id: string, displayName: string): GmeetParticipant {
  return { name: `${id}`, signedinUser: { user: "people/1", displayName } };
}

function entry(
  transcriptName: string,
  index: number,
  participantName: string,
  text: string,
  startIso: string,
): GmeetTranscriptEntry {
  return {
    name: `${transcriptName}/entries/${index}`,
    participant: participantName,
    text,
    languageCode: "en-US",
    startTime: startIso,
    endTime: startIso,
  };
}

/** One conference record with one transcript in `state`, and `entryTexts` entries. */
function fixture(
  id: string,
  opts: {
    state?: string;
    entryTexts?: string[];
    startTime?: string;
    fail?: RecordFixture["fail"];
  } = {},
): RecordFixture {
  const recordName = `conferenceRecords/${id}`;
  const transcriptName = `${recordName}/transcripts/t1`;
  const startTime = opts.startTime ?? "2026-08-16T09:00:00.000Z";
  const speaker = `${recordName}/participants/p1`;
  const texts = opts.entryTexts ?? [];
  return {
    record: {
      name: recordName,
      startTime,
      endTime: "2026-08-16T09:30:00.000Z",
      space: "spaces/standing-room",
    },
    participants: [participant(speaker, "Alice")],
    transcripts: [{ name: transcriptName, state: opts.state ?? "ENDED" }],
    entries: {
      [transcriptName]: texts.map((text, i) =>
        entry(transcriptName, i, speaker, text, `2026-08-16T09:0${i}:00.000Z`),
      ),
    },
    fail: opts.fail,
  };
}

function run(client: GmeetSyncClient, store: GmeetSyncStore, extra: Partial<{
  signal: AbortSignal;
  onProgress: (p: GmeetSyncProgress) => void;
}> = {}) {
  return syncGoogleMeet({ client, store, tcw: TCW, now, ...extra });
}

beforeEach(() => {
  _resetGmeetSyncSingleFlightForTests();
});

// ── Watermark math ──────────────────────────────────────────────────────

describe("watermark window", () => {
  test("first connect (no watermark) backfills the full 30 days", () => {
    expect(gmeetSyncWindowStartMs(null, NOW_MS)).toBe(NOW_MS - GMEET_MAX_BACKFILL_MS);
    expect(gmeetSyncWindowStartMs(undefined, NOW_MS)).toBe(NOW_MS - GMEET_MAX_BACKFILL_MS);
    expect(gmeetSyncWindowStartIso(null, NOW_MS)).toBe(
      new Date(NOW_MS - GMEET_MAX_BACKFILL_MS).toISOString(),
    );
  });

  test("a subsequent run re-sweeps LAG_BUFFER behind the watermark", () => {
    const watermarkMs = NOW_MS - 6 * 60 * 60 * 1000;
    expect(GMEET_LAG_BUFFER_MS).toBe(72 * 60 * 60 * 1000);
    expect(gmeetSyncWindowStartMs(new Date(watermarkMs).toISOString(), NOW_MS)).toBe(
      watermarkMs - GMEET_LAG_BUFFER_MS,
    );
  });

  test("the window never reaches past the 30-day horizon", () => {
    const stale = new Date(NOW_MS - 90 * 24 * 60 * 60 * 1000).toISOString();
    expect(gmeetSyncWindowStartMs(stale, NOW_MS)).toBe(NOW_MS - GMEET_MAX_BACKFILL_MS);
  });

  test("a future watermark (clock skew) never pushes the start past now", () => {
    const future = new Date(NOW_MS + 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(gmeetSyncWindowStartMs(future, NOW_MS)).toBe(NOW_MS);
  });

  test("an unparseable watermark degrades to the full backfill", () => {
    expect(gmeetSyncWindowStartMs("not-a-date", NOW_MS)).toBe(NOW_MS - GMEET_MAX_BACKFILL_MS);
  });

  test("the engine asks the API for exactly the computed window", async () => {
    const store = new FakeStore();
    store.connection = {
      connectorId: "google-meet",
      status: "connected",
      lastSyncedAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 3,
    };
    const client = new FakeClient([]);
    const res = await run(client, store);

    expect(res.ok).toBe(true);
    expect(client.windowStarts).toEqual([
      new Date(NOW_MS - 60 * 60 * 1000 - GMEET_LAG_BUFFER_MS).toISOString(),
    ]);
  });
});

// ── Transcript state gate ───────────────────────────────────────────────

describe("transcript state gate", () => {
  test("only ENDED and FILE_GENERATED are persistable", () => {
    expect(isPersistableTranscriptState("ENDED")).toBe(true);
    expect(isPersistableTranscriptState("FILE_GENERATED")).toBe(true);
    expect(isPersistableTranscriptState("STARTED")).toBe(false);
    expect(isPersistableTranscriptState("STATE_UNSPECIFIED")).toBe(false);
    expect(isPersistableTranscriptState(null)).toBe(false);
  });

  test("a STARTED transcript is skipped and NOTHING is persisted", async () => {
    const store = new FakeStore();
    const client = new FakeClient([fixture("rec-live", { state: "STARTED", entryTexts: ["hi"] })]);

    const res = await run(client, store);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(0);
    expect(res.data.items[0]?.outcome).toBe("skipped");
    expect(store.rows).toHaveLength(0);
    expect(store.bodies.size).toBe(0);
    // The entries of a live transcript are never even read.
    expect(client.calls.some((c) => c.startsWith("listTranscriptEntries"))).toBe(false);
  });

  test("a FILE_GENERATED transcript is persisted without waiting for anything else", async () => {
    const store = new FakeStore();
    const client = new FakeClient([
      fixture("rec-done", { state: "FILE_GENERATED", entryTexts: ["all done"] }),
    ]);

    const res = await run(client, store);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.created).toBe(1);
  });

  test("a record with no transcript at all is skipped, not failed", async () => {
    const store = new FakeStore();
    const client = new FakeClient([
      { record: { name: "conferenceRecords/rec-silent", startTime: "2026-08-16T09:00:00.000Z" } },
    ]);

    const res = await run(client, store);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.skipped).toBe(1);
    expect(res.data.failed).toBe(0);
    expect(store.rows).toHaveLength(0);
  });
});

// ── Late artifact: skip without persisting, then the re-sweep ───────────

describe("late artifact", () => {
  test("empty entries skip WITHOUT persisting, and the re-sweep creates the row", async () => {
    const store = new FakeStore();

    // Sync 1 — transcript ENDED but the entries have not landed yet.
    const first = await run(new FakeClient([fixture("rec-late", { entryTexts: [] })]), store);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.skipped).toBe(1);
    expect(first.data.items[0]).toMatchObject({
      sourceId: "rec-late",
      outcome: "skipped",
    });
    expect(store.rows).toHaveLength(0);
    expect(store.bodies.size).toBe(0);
    expect(store.calls.filter((c) => c.startsWith("putTranscriptBody"))).toHaveLength(0);

    // The completed run advanced the watermark, so the re-sweep only finds the
    // record again because of the LAG_BUFFER overlap.
    expect(store.state?.lastSyncedAt).toBe(new Date(NOW_MS).toISOString());
    store.connection = {
      connectorId: "google-meet",
      status: "connected",
      lastSyncedAt: store.state!.lastSyncedAt,
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 0,
    };
    _resetGmeetSyncSingleFlightForTests();

    // Sync 2 — the artifact arrived.
    const client2 = new FakeClient([fixture("rec-late", { entryTexts: ["hello", "there"] })]);
    const second = await run(client2, store);

    expect(client2.windowStarts[0]).toBe(new Date(NOW_MS - GMEET_LAG_BUFFER_MS).toISOString());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.created).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(store.bodies.get("google-meet/rec-late")).toHaveLength(2);
  });

  test("entries that carry no text are skipped rather than persisted empty", async () => {
    const store = new FakeStore();
    const client = new FakeClient([fixture("rec-blank", { entryTexts: ["", "   "] })]);

    const res = await run(client, store);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.skipped).toBe(1);
    expect(store.rows).toHaveLength(0);
    expect(store.bodies.size).toBe(0);
  });
});

// ── Re-sweep overlap: upsert dedups and repairs ─────────────────────────

describe("re-sweep overlap", () => {
  test("a record seen twice updates one row instead of duplicating it", async () => {
    const store = new FakeStore();

    const first = await run(new FakeClient([fixture("rec-dup", { entryTexts: ["one"] })]), store);
    expect(first.ok).toBe(true);
    const rowId = store.rows[0]!.id;
    expect(store.rows[0]!.meeting.metadata.entry_count).toBe(1);

    store.connection = {
      connectorId: "google-meet",
      status: "connected",
      lastSyncedAt: store.state!.lastSyncedAt,
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 1,
    };
    _resetGmeetSyncSingleFlightForTests();

    // The same record, now with the full transcript.
    const second = await run(
      new FakeClient([fixture("rec-dup", { entryTexts: ["one", "two", "three"] })]),
      store,
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.updated).toBe(1);
    expect(second.data.created).toBe(0);
    expect(store.rows).toHaveLength(1);
    // Repaired in place: same row identity, merged metadata, fuller blob.
    expect(store.rows[0]!.id).toBe(rowId);
    expect(store.rows[0]!.createdAt).toBe("created-at");
    expect(store.rows[0]!.meeting.metadata.entry_count).toBe(3);
    expect(store.rows[0]!.meeting.metadata.space).toBe("spaces/standing-room");
    expect(store.bodies.get("google-meet/rec-dup")).toHaveLength(3);
  });
});

// ── Persist ordering + abort ────────────────────────────────────────────

describe("persist ordering and abort", () => {
  test("the KV blob is written BEFORE the row, per record", async () => {
    const store = new FakeStore();
    const client = new FakeClient([
      fixture("rec-b", { entryTexts: ["b"] }),
      fixture("rec-a", { entryTexts: ["a"] }),
    ]);

    await run(client, store);

    // Oldest-first (the client hands them back newest-first), and for each
    // record the blob precedes the row — the row is the commit point.
    expect(store.calls.filter((c) => c.includes(":rec-"))).toEqual([
      "putTranscriptBody:rec-a",
      "upsertMeeting:rec-a",
      "putTranscriptBody:rec-b",
      "upsertMeeting:rec-b",
    ]);
  });

  test("an abort mid-batch stops between items and leaves no row without its blob", async () => {
    const store = new FakeStore();
    const controller = new AbortController();
    // Abort as soon as the first record's row lands.
    store.afterUpsert = () => controller.abort();

    const client = new FakeClient([
      fixture("rec-second", { entryTexts: ["later"] }),
      fixture("rec-first", { entryTexts: ["earlier"] }),
    ]);

    const res = await run(client, store, { signal: controller.signal });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.aborted).toBe(true);
    expect(res.data.created).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.meeting.sourceId).toBe("rec-first");
    // Every stored row has its transcript blob; the second record was never touched.
    for (const row of store.rows) {
      expect(store.bodies.has(`google-meet/${row.meeting.sourceId}`)).toBe(true);
    }
    expect(store.calls).not.toContain("putTranscriptBody:rec-second");
    expect(store.calls).not.toContain("upsertMeeting:rec-second");
    // An aborted run leaves the previous watermark alone — the next window must
    // still cover the record it never reached.
    expect(store.state?.lastSyncedAt).toBeNull();
  });

  test("a completed run anchors the watermark at the sync START time", async () => {
    const store = new FakeStore();
    const res = await run(new FakeClient([fixture("rec-ok", { entryTexts: ["hi"] })]), store);

    expect(res.ok).toBe(true);
    expect(store.state).toMatchObject({
      connectorId: "google-meet",
      status: "connected",
      lastSyncedAt: new Date(NOW_MS).toISOString(),
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 1,
    });
  });
});

// ── Error handling ──────────────────────────────────────────────────────

describe("error handling", () => {
  test("one bad record never kills the batch, and the run still completes", async () => {
    const store = new FakeStore();
    const client = new FakeClient([
      fixture("rec-good", { entryTexts: ["fine"] }),
      fixture("rec-bad", {
        entryTexts: ["never read"],
        fail: {
          on: "transcripts",
          error: { kind: "not-found", status: 404, message: "record expired" },
        },
      }),
    ]);

    const res = await run(client, store);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.failed).toBe(1);
    expect(res.data.created).toBe(1);
    expect(res.data.items).toEqual([
      { sourceId: "rec-bad", outcome: "error", reason: "record expired" },
      { sourceId: "rec-good", outcome: "created" },
    ]);
    // A completed-with-failures run still records state (partial-failure path).
    expect(store.state?.lastSyncStatus).toBe("ok");
    expect(store.state?.lastSyncedAt).toBe(new Date(NOW_MS).toISOString());
  });

  test("a per-record storage failure is contained too", async () => {
    const store = new FakeStore();
    store.failBodyFor.add("rec-kv");
    const client = new FakeClient([
      fixture("rec-kv", { entryTexts: ["blocked"] }),
      fixture("rec-fine", { entryTexts: ["stored"] }),
    ]);

    const res = await run(client, store);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.failed).toBe(1);
    expect(res.data.created).toBe(1);
    // The failed record never reached the row write — no row without a blob.
    expect(store.calls).not.toContain("upsertMeeting:rec-kv");
    expect(store.rows.map((r) => r.meeting.sourceId)).toEqual(["rec-fine"]);
  });

  test("terminal vs per-item split", () => {
    expect(isTerminalGmeetError({ kind: "auth-expired", status: 401, message: "x" })).toBe(true);
    expect(isTerminalGmeetError({ kind: "forbidden", status: 403, message: "x" })).toBe(true);
    expect(isTerminalGmeetError({ kind: "rate-limited", status: 429, message: "x" })).toBe(true);
    expect(isTerminalGmeetError({ kind: "not-found", status: 404, message: "x" })).toBe(false);
    expect(isTerminalGmeetError({ kind: "network-error", status: null, message: "x" })).toBe(false);
    expect(isTerminalGmeetError({ kind: "api-error", status: 500, message: "x" })).toBe(false);
  });

  test("an auth failure aborts the run as terminal and preserves the watermark", async () => {
    const store = new FakeStore();
    const previous = new Date(NOW_MS - 3 * 60 * 60 * 1000).toISOString();
    store.connection = {
      connectorId: "google-meet",
      status: "connected",
      lastSyncedAt: previous,
      lastSyncStatus: "ok",
      lastSyncError: null,
      itemCount: 1,
    };
    const client = new FakeClient([
      fixture("rec-after", { entryTexts: ["unreached"] }),
      fixture("rec-auth", {
        entryTexts: ["nope"],
        fail: {
          on: "participants",
          error: {
            kind: "auth-expired",
            status: 401,
            message: "Request had invalid authentication credentials.",
            googleStatus: "UNAUTHENTICATED",
          },
        },
      }),
    ]);

    const res = await run(client, store);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("auth");
    expect(res.error.googleStatus).toBe("UNAUTHENTICATED");
    // The batch stopped at the first record — the later one was never fetched.
    expect(client.calls).not.toContain("listParticipants:conferenceRecords/rec-after");
    expect(store.rows).toHaveLength(0);
    expect(store.state?.lastSyncStatus).toBe("error");
    expect(store.state?.lastSyncError).toBe("Request had invalid authentication credentials.");
    expect(store.state?.lastSyncedAt).toBe(previous);
    // The summary rides out with the error, so it must NAME the record the run
    // died on — dropping it under-reports the failure count by exactly one.
    expect(res.data?.failed).toBe(1);
    expect(res.data?.items).toEqual([
      {
        sourceId: "rec-auth",
        outcome: "error",
        reason: "Request had invalid authentication credentials.",
      },
    ]);
  });

  test("a revoked grant (403) is terminal as well", async () => {
    const store = new FakeStore();
    const client = new FakeClient([
      fixture("rec-revoked", {
        fail: {
          on: "participants",
          error: {
            kind: "forbidden",
            status: 403,
            message: "insufficient authentication scopes",
            googleStatus: "PERMISSION_DENIED",
          },
        },
      }),
    ]);

    const res = await run(client, store);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("forbidden");
  });

  test("a failed listing is terminal and never advances the watermark", async () => {
    const store = new FakeStore();
    const client = new FakeClient([]);
    client.listError = { kind: "rate-limited", status: 429, message: "quota", retryAfterMs: 5000 };

    const res = await run(client, store);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("rate-limited");
    expect(res.error.retryAfterMs).toBe(5000);
    expect(store.state?.lastSyncedAt).toBeNull();
  });

  test("an unreadable connector_state returns before any state write", async () => {
    const store = new FakeStore();
    store.getConnectionError = true;

    const res = await run(new FakeClient([]), store);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe("storage");
    expect(store.stateWrites).toBe(0);
  });
});

// ── Progress vocabulary ─────────────────────────────────────────────────

describe("progress events", () => {
  test("emits the §4.2 vocabulary with cumulative counters", async () => {
    const store = new FakeStore();
    const events: GmeetSyncProgress[] = [];
    const client = new FakeClient([
      fixture("rec-2", { entryTexts: ["two"] }),
      fixture("rec-1", { state: "STARTED" }),
    ]);

    await run(client, store, { onProgress: (p) => events.push(p) });

    expect(events[0]!.type).toBe("status");
    expect(events.at(-1)!.type).toBe("complete");
    expect(events.at(-1)).toMatchObject({ current: 2, total: 2, synced: 1, failed: 0, skipped: 1 });
    for (const e of events) {
      expect(["status", "progress", "complete", "error"]).toContain(e.type);
    }
  });

  test("emits an error event on the terminal path", async () => {
    const store = new FakeStore();
    const events: GmeetSyncProgress[] = [];
    const client = new FakeClient([]);
    client.listError = { kind: "auth-expired", status: 401, message: "token dead" };

    await run(client, store, { onProgress: (p) => events.push(p) });

    expect(events.at(-1)).toMatchObject({ type: "error", message: "token dead" });
  });
});

// ── Single flight ───────────────────────────────────────────────────────

describe("single-flight guard", () => {
  test("a second concurrent call joins the run in flight instead of starting one", async () => {
    const store = new FakeStore();
    const client = new FakeClient([fixture("rec-one", { entryTexts: ["hi"] })]);

    const a = syncGoogleMeet({ client, store, tcw: TCW, now });
    const b = syncGoogleMeet({ client, store, tcw: TCW, now });
    expect(isGmeetSyncInFlight()).toBe(true);

    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe(rb);
    expect(client.calls.filter((c) => c === "listConferenceRecords")).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
    expect(store.stateWrites).toBe(1);
    expect(isGmeetSyncInFlight()).toBe(false);
  });

  test("the slot is released so a later run can start", async () => {
    const store = new FakeStore();
    await run(new FakeClient([]), store);
    expect(isGmeetSyncInFlight()).toBe(false);

    const client = new FakeClient([fixture("rec-next", { entryTexts: ["hi"] })]);
    const res = await run(client, store);
    expect(res.ok).toBe(true);
    expect(client.calls).toContain("listConferenceRecords");
  });

  test("the slot is released even when the run fails terminally", async () => {
    const store = new FakeStore();
    store.getConnectionError = true;
    await run(new FakeClient([]), store);
    expect(isGmeetSyncInFlight()).toBe(false);
  });
});
