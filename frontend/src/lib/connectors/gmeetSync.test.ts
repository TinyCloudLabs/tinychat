import type { SessionStore } from "@tinyboilerplate/client";
import { sourceRowDisplay } from "@/capture/meetingSources/meetingSourceState";
import { runGmeetSyncNow } from "@/chat/ConnectorsCard";
import { getGmeetLastRun, resetGmeetLastRunsForTests } from "./gmeetLastRun";
import { getGmeetMeetingCount, onGmeetMeetingCount, resetGmeetMeetingCountsForTests } from "./gmeetLiveCount";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesSentence } from "./firefliesClient";
import type {
  NormalizedMeeting,
  MeetingDatetimeStats,
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
import { GmeetClient } from "./gmeetClient";
import {
  GMEET_LAG_BUFFER_MS,
  getGmeetLiveStatus,
  getGmeetRunLog,
  onGmeetLiveStatus,
  onGmeetRunLog,
  GMEET_MAX_BACKFILL_MS,
  _resetGmeetSyncSingleFlightForTests,
  gmeetSyncWindowStartIso,
  gmeetSyncWindowStartMs,
  isGmeetNotesSyncInFlight,
  isGmeetSyncInFlight,
  onGmeetNotesProgress,
  onGmeetNotesSettled,
  isLikelyGmeetNotesFile,
  isPersistableTranscriptState,
  isTerminalGmeetError,
  stopGmeetNotesSync,
  stopGmeetSyncForAccount,
  syncGoogleMeet,
  type GmeetNotesSettled,
  type GmeetSyncClient,
  type GmeetSyncDiagnostics,
  type GmeetSyncProgress,
  type GmeetSyncStore,
} from "./gmeetSync";
import type { ConnectorConnection, ConnectorId } from "./types";
import { runDisconnect, type DisconnectDeps } from "./connectorLifecycle";

const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });

const TCW = {
  did: "did:pkh:eip155:1:0xaaaa",
  sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [] } }) }) },
} as unknown as TinyCloudWeb;

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

  async getMeetingDatetimeStats(_: TinyCloudWeb, source: string): Promise<StoreResult<MeetingDatetimeStats>> {
    const rows = this.rows.filter((row) => row.meeting.source === source);
    const stats: MeetingDatetimeStats = {
      rows: rows.length, dated: 0, sourceMeet: 0, sourceDocs: 0,
      sourceDriveCreatedApprox: 0, sourceUnavailable: 0,
      invalidAmbiguous: 0, duplicates: 0,
    };
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.meeting.sourceId)) stats.duplicates++;
      else seen.add(row.meeting.sourceId);
      if (row.meeting.startedAt !== null) {
        if (Number.isFinite(Date.parse(row.meeting.startedAt))) stats.dated++;
        else stats.invalidAmbiguous++;
      }
      switch (row.meeting.metadata.datetime_source) {
        case "meet_conference_start": stats.sourceMeet++; break;
        case "docs_content": stats.sourceDocs++; break;
        case "drive_created_time": stats.sourceDriveCreatedApprox++; break;
        default: stats.sourceUnavailable++; break;
      }
    }
    return ok(stats);
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
  deferNotes: boolean;
  driveMode: "auto" | "snapshot";
  onProgress: (p: GmeetSyncProgress) => void;
  onDiagnostics: (diagnostics: Record<string, number | string>) => void;
}> = {}) {
  return syncGoogleMeet({ client, store, tcw: TCW, now, ...extra } as Parameters<typeof syncGoogleMeet>[0]);
}

beforeEach(() => {
  _resetGmeetSyncSingleFlightForTests();
});

const DIAGNOSTIC_KEYS = [
  "drive_mode", "drive_diagnostics_complete", "drive_input_items", "drive_terminal_items",
  "drive_unprocessed_due_run_stop", "drive_missing_id", "drive_removed_or_trashed",
  "drive_non_google_doc", "drive_google_docs_discovered", "drive_metadata_non_candidate",
  "drive_metadata_candidate", "drive_association_bypass", "drive_unchanged_associated",
  "drive_docs_get_attempted", "drive_docs_get_succeeded", "drive_docs_get_failed_retryable",
  "drive_docs_get_failed_terminal", "drive_docs_get_aborted", "drive_parser_rejected_no_marker",
  "drive_parser_rejected_no_supported_section", "drive_parser_accepted",
  "drive_accepted_standalone_created", "drive_accepted_standalone_updated",
  "drive_accepted_attached", "drive_accepted_migrated", "drive_storage_failed",
  "drive_post_parse_storage_failed", "drive_cursor_committed", "meet_records_discovered",
  "meet_records_processed", "meet_rows_inserted", "drive_rows_inserted", "drive_rows_deleted",
  "drive_attached_fields_cleared", "persisted_item_count_before", "persisted_item_count_after",
  "meetings_page_rows_all_sources", "explorer_google_meet_rows",
  "datetime_dated_rows_before", "datetime_dated_rows_after", "datetime_source_meet",
  "datetime_source_docs", "datetime_source_drive_created_approx", "datetime_source_unavailable",
  "datetime_rows_backfilled", "datetime_rows_unchanged", "datetime_invalid_ambiguous",
  "datetime_duplicates", "phase_drive_ms", "phase_count_ms", "phase_diagnostics_ms",
  "phase_state_write_ms", "finishing_timed_out", "finishing_stalled_phase", "finishing_recovery_write",
  "drive_sql_calls", "drive_sql_ms", "drive_http_calls", "drive_http_ms", "drive_assoc_preloaded_rows",
  "drive_prefilter_skipped", "drive_candidates", "drive_resumed_skipped", "drive_checkpoint_writes",
  "drive_call_timeouts", "drive_storage_retries", "drive_items_failed",
].sort();

const TERMINAL_KEYS = [
  "drive_missing_id", "drive_removed_or_trashed", "drive_non_google_doc",
  "drive_metadata_non_candidate", "drive_unchanged_associated", "drive_docs_get_failed_retryable",
  "drive_docs_get_failed_terminal", "drive_docs_get_aborted", "drive_parser_rejected_no_marker",
  "drive_parser_rejected_no_supported_section", "drive_accepted_standalone_created",
  "drive_accepted_standalone_updated", "drive_accepted_attached", "drive_accepted_migrated",
  "drive_storage_failed", "drive_unprocessed_due_run_stop",
] as const;

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

  test("persists conference start time as authoritative exact datetime provenance", async () => {
    const store = new FakeStore();
    const client = new FakeClient([
      fixture("rec-exact", { entryTexts: ["all done"], startTime: "2026-08-16T09:00:00-04:00" }),
    ]);

    const res = await run(client, store);

    expect(res.ok).toBe(true);
    expect(store.rows[0]?.meeting.startedAt).toBe("2026-08-16T13:00:00.000Z");
    expect(store.rows[0]?.meeting.metadata).toMatchObject({
      datetime_source: "meet_conference_start",
      datetime_exact: true,
      datetime_resolution_version: 1,
    });
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

describe("Drive Notes by Gemini sync", () => {
  function snapshotDocument() {
    return {
      title: "Notes by Gemini — Sanitized meeting",
      tabs: [
        { tabProperties: { title: "Meeting notes" }, documentTab: { body: { content: [
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_3" }, elements: [{ textRun: { content: "Summary\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "A sanitized summary.\n" } }] } },
        ] } } },
        { tabProperties: { title: "Transcript" }, documentTab: { body: { content: [
          { paragraph: { elements: [{ textRun: { content: "Synthetic transcript content.\n" } }] } },
        ] } } },
      ],
    };
  }

  function forcedSnapshotStore(cursor = "old-cursor") {
    return Object.assign(new FakeStore(), {
      cursor,
      writes: [] as string[],
      async getDriveCursor() { return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, nextCursor: string) {
        this.writes.push(nextCursor);
        this.cursor = nextCursor;
        return ok(undefined);
      },
      async findGmeetNotesAssociation() { return ok(null); },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok("unchanged" as const); },
    });
  }

  test("a forced snapshot with an existing cursor uses snapshot APIs and never Drive Changes", async () => {
    const calls: string[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { calls.push("getDriveStartPageToken"); return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { calls.push("listDriveFiles"); return { ok: true as const, data: [] }; },
      async listDriveChangesPage() { calls.push("listDriveChangesPage"); throw new Error("forced snapshot must not read changes"); },
      async getDriveDocument() { throw new Error("empty snapshot must not read Docs"); },
    });
    const store = forcedSnapshotStore();

    const result = await run(client, store, { driveMode: "snapshot" });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["getDriveStartPageToken", "listDriveFiles"]);
    expect(store.writes).toEqual(["snapshot-token"]);
  });

  test("a successful forced snapshot captures before listing and commits only after all item work", async () => {
    const order: string[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { order.push("capture"); return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { order.push("list"); return { ok: true as const, data: [
        { id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" },
      ] }; },
      async listDriveChangesPage() { throw new Error("forced snapshot must not read changes"); },
      async getDriveDocument() { order.push("read-item"); return { ok: true as const, data: snapshotDocument() }; },
    });
    const store = forcedSnapshotStore();
    store.afterUpsert = () => order.push("persist-item");
    const putDriveCursor = store.putDriveCursor.bind(store);
    store.putDriveCursor = async (...args) => {
      order.push("commit");
      return putDriveCursor(...args);
    };

    const result = await run(client, store, { driveMode: "snapshot" });

    expect(result.ok).toBe(true);
    expect(order).toEqual(["capture", "list", "read-item", "persist-item", "commit"]);
    expect(store.writes).toEqual(["snapshot-token"]);
  });

  test("threads Drive creation time as approximate provenance for a standalone Notes row", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { return { ok: true as const, data: [{
        id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document",
        createdTime: "2026-08-17T08:55:04.123Z", modifiedTime: "2026-08-19T11:12:13.000Z",
      }] }; },
      async listDriveChangesPage() { throw new Error("snapshot only"); },
      async getDriveDocument() { return { ok: true as const, data: snapshotDocument() }; },
    });
    const store = forcedSnapshotStore();

    const result = await run(client, store, {
      driveMode: "snapshot",
      onDiagnostics: (value) => diagnostics.push(value),
    });

    expect(result.ok).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.meeting.startedAt).toBe("2026-08-17T08:55:04.123Z");
    expect(store.rows[0]?.meeting.metadata).toMatchObject({
      datetime_source: "drive_created_time",
      datetime_exact: false,
      datetime_resolution_version: 1,
    });
    expect(diagnostics[0]).toMatchObject({
      datetime_dated_rows_before: 0,
      datetime_dated_rows_after: 1,
      datetime_source_meet: 0,
      datetime_source_docs: 0,
      datetime_source_drive_created_approx: 1,
      datetime_source_unavailable: 0,
      datetime_rows_backfilled: 0,
      datetime_rows_unchanged: 0,
      datetime_invalid_ambiguous: 0,
      datetime_duplicates: 0,
    });
  });

  test("never offers approximate Drive time to exact title and time association", async () => {
    const identityCalls: Array<{ title: string | null; startedAt: string | null }> = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { return { ok: true as const, data: [{
        id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document",
        createdTime: "2026-08-17T08:55:04.123Z",
      }] }; },
      async listDriveChangesPage() { throw new Error("snapshot only"); },
      async getDriveDocument() { return { ok: true as const, data: snapshotDocument() }; },
    });
    const store = forcedSnapshotStore();
    store.findGmeetNotesAssociation = async (_tcw, _source, _fileId, title, startedAt) => {
      identityCalls.push({ title, startedAt });
      return ok(null);
    };

    const result = await run(client, store, { driveMode: "snapshot" });

    expect(result.ok).toBe(true);
    expect(identityCalls).toHaveLength(2);
    expect(identityCalls).toEqual([
      { title: null, startedAt: null },
      { title: null, startedAt: null },
    ]);
  });

  test("an aborted forced snapshot preserves the old cursor", async () => {
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { return { ok: true as const, data: [
        { id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" },
      ] }; },
      async listDriveChangesPage() { throw new Error("forced snapshot must not read changes"); },
      async getDriveDocument() { return { ok: false as const, error: { kind: "aborted" as const, status: null, message: "aborted" } }; },
    });
    const store = forcedSnapshotStore();

    const result = await run(client, store, { driveMode: "snapshot" });

    expect(result.ok).toBe(false);
    expect(result.data?.aborted).toBe(true);
    expect(store.cursor).toBe("old-cursor");
    expect(store.writes).toEqual([]);
  });

  test("a terminal forced snapshot failure preserves the old cursor", async () => {
    const calls: string[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { calls.push("getDriveStartPageToken"); return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { calls.push("listDriveFiles"); return { ok: true as const, data: [
        { id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" },
      ] }; },
      async listDriveChangesPage() { calls.push("listDriveChangesPage"); throw new Error("forced snapshot must not read changes"); },
      async getDriveDocument() { calls.push("getDriveDocument"); return { ok: false as const, error: { kind: "rate-limited" as const, status: 429, message: "quota", retryAfterMs: 1_000 } }; },
    });
    const store = forcedSnapshotStore();

    const result = await run(client, store, { driveMode: "snapshot" });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["getDriveStartPageToken", "listDriveFiles", "getDriveDocument"]);
    expect(store.cursor).toBe("old-cursor");
    expect(store.writes).toEqual([]);
  });

  test("a per-item forced snapshot failure preserves the old cursor", async () => {
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { return { ok: true as const, data: [
        { id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" },
      ] }; },
      async listDriveChangesPage() { throw new Error("forced snapshot must not read changes"); },
      async getDriveDocument() { return { ok: false as const, error: { kind: "network-error" as const, status: null, message: "offline" } }; },
    });
    const store = forcedSnapshotStore();

    const result = await run(client, store, { driveMode: "snapshot" });

    expect(result.ok).toBe(false);
    expect(store.cursor).toBe("old-cursor");
    expect(store.writes).toEqual([]);
  });

  test("a forced snapshot cursor-write failure preserves the old cursor", async () => {
    const calls: string[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { calls.push("getDriveStartPageToken"); return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { calls.push("listDriveFiles"); return { ok: true as const, data: [] }; },
      async listDriveChangesPage() { calls.push("listDriveChangesPage"); throw new Error("forced snapshot must not read changes"); },
      async getDriveDocument() { throw new Error("empty snapshot must not read Docs"); },
    });
    const store = forcedSnapshotStore();
    store.putDriveCursor = async () => {
      calls.push("putDriveCursor");
      return { ok: false, error: { code: "STORE", message: "cursor write refused" } };
    };

    const result = await run(client, store, { driveMode: "snapshot" });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["getDriveStartPageToken", "listDriveFiles", "putDriveCursor"]);
    expect(store.cursor).toBe("old-cursor");
    expect(store.writes).toEqual([]);
  });

  test("default mode with an existing cursor stays incremental and commits the changes token", async () => {
    const calls: string[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { calls.push("getDriveStartPageToken"); throw new Error("incremental sync must not snapshot"); },
      async listDriveFiles() { calls.push("listDriveFiles"); throw new Error("incremental sync must not snapshot"); },
      async listDriveChangesPage() { calls.push("listDriveChangesPage"); return { ok: true as const, data: {
        changes: [], nextPageToken: null, newStartPageToken: "next-cursor",
      } }; },
      async getDriveDocument() { throw new Error("empty changes must not read Docs"); },
    });
    const store = forcedSnapshotStore();

    const result = await run(client, store);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["listDriveChangesPage"]);
    expect(store.writes).toEqual(["next-cursor"]);
  });

  test("two successful forced rescans over the same fixtures remain idempotent", async () => {
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { return { ok: true as const, data: [
        { id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" },
      ] }; },
      async listDriveChangesPage() { throw new Error("forced snapshot must not read changes"); },
      async getDriveDocument() { return { ok: true as const, data: snapshotDocument() }; },
    });
    const store = forcedSnapshotStore();

    const first = await run(client, store, { driveMode: "snapshot" });
    const countAfterFirst = store.rows.length;
    const second = await run(client, store, { driveMode: "snapshot" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(countAfterFirst).toBe(1);
    expect(store.rows).toHaveLength(countAfterFirst);
    expect(store.rows.map((row) => row.meeting.sourceId)).toEqual(["notes"]);
  });

  test("reconsiders one unchanged legacy null date then backfills the same row idempotently", async () => {
    let documentReads = 0;
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { return { ok: true as const, data: [{
        id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document",
        createdTime: "2026-08-17T08:55:04.123Z", modifiedTime: "unchanged",
      }] }; },
      async listDriveChangesPage() { throw new Error("snapshot only"); },
      async getDriveDocument() { documentReads++; return { ok: true as const, data: snapshotDocument() }; },
    });
    const store = forcedSnapshotStore();
    const legacy: NormalizedMeeting = {
      id: "stable-row", source: "google-meet", sourceId: "notes", title: "Notes by Gemini — Sanitized meeting",
      startedAt: null, durationSecs: null, organizerEmail: null, participants: [],
      summaryOverview: "A sanitized summary.", summaryActionItems: null, keywords: null, meetingType: null,
      metadata: { drive_file_id: "notes", drive_modified_time: "unchanged", notes_association: "standalone" },
    };
    store.rows.push({ id: legacy.id, createdAt: "stable-created-at", meeting: legacy });
    const originalBody = [{ index: 0, speaker_name: "Notes by Gemini", text: "A sanitized summary.", start_time: 0, end_time: 0 }];
    store.bodies.set("google-meet/notes", originalBody);
    store.findGmeetNotesAssociation = async (_tcw, _source, _fileId, _title, _startedAt, excludeSourceId) => {
      if (excludeSourceId === "notes") return ok(null);
      const row = store.rows[0]!;
      return ok({
        id: row.id, sourceId: row.meeting.sourceId, title: row.meeting.title,
        startedAt: row.meeting.startedAt, summaryOverview: row.meeting.summaryOverview,
        summaryActionItems: row.meeting.summaryActionItems, metadata: row.meeting.metadata,
      });
    };

    const first = await run(client, store, { driveMode: "snapshot", onDiagnostics: (value) => diagnostics.push(value) });
    const second = await run(client, store, { driveMode: "snapshot", onDiagnostics: (value) => diagnostics.push(value) });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(documentReads).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      id: "stable-row", createdAt: "stable-created-at",
      meeting: { sourceId: "notes", startedAt: "2026-08-17T08:55:04.123Z" },
    });
    expect(store.bodies.get("google-meet/notes")).toEqual(originalBody);
    expect(diagnostics[0]).toMatchObject({ datetime_rows_backfilled: 1, datetime_rows_unchanged: 0 });
    expect(diagnostics[1]).toMatchObject({ datetime_rows_backfilled: 0, datetime_rows_unchanged: 1 });
  });

  test("reconciles preliminary snapshot gates without changing missing-id cursor behavior", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "private-cursor" }; },
      async listDriveFiles() { return { ok: true as const, data: [
        {},
        { id: "trashed", trashed: true, mimeType: "application/vnd.google-apps.document" },
        { id: "binary", name: "Notes by Gemini", mimeType: "application/pdf" },
      ] }; },
      async listDriveChangesPage() { throw new Error("snapshot only"); },
      async getDriveDocument() { throw new Error("preliminary gates must not read Docs"); },
    });
    const store = Object.assign(new FakeStore(), {
      cursor: null as string | null,
      async getDriveCursor() { return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, cursor: string) { this.cursor = cursor; return ok(undefined); },
      async findGmeetNotesAssociation() { return ok(null); },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok("unchanged" as const); },
    });

    await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      drive_mode: "snapshot", drive_diagnostics_complete: 1,
      drive_input_items: 3, drive_terminal_items: 3,
      drive_missing_id: 1, drive_removed_or_trashed: 1, drive_non_google_doc: 1,
      drive_google_docs_discovered: 0, drive_cursor_committed: 0,
    });
    expect(store.cursor).toBeNull();
  });

  test("keeps a legacy Meet-only grant syncing when Drive rejects its new scopes", async () => {
    const client = Object.assign(new FakeClient([fixture("meet-still-syncs", { entryTexts: ["present"] })]), {
      async getDriveStartPageToken() {
        return { ok: false as const, error: {
          kind: "forbidden" as const, status: 403, message: "insufficient authentication scopes",
        } };
      },
      async listDriveFiles() { throw new Error("Drive snapshot must stop after its denied token request"); },
      async listDriveChangesPage() { throw new Error("legacy grant has no cursor"); },
      async getDriveDocument() { throw new Error("legacy grant must not read documents"); },
    });
    const store = Object.assign(new FakeStore(), {
      async getDriveCursor() { return ok(null); },
      async putDriveCursor() { return ok(undefined); },
      async findGmeetNotesAssociation() { return ok(null); },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok(undefined); },
    });

    const result = await run(client, store);

    expect(result.ok).toBe(true);
    expect(store.rows.map((row) => row.meeting.sourceId)).toContain("meet-still-syncs");
    expect(store.state).toMatchObject({
      lastSyncStatus: "partial",
      lastSyncError: "Reconnect Google Meet to sync Notes by Gemini",
    });
  });

  test("metadata gate prevents unrelated Docs from being read and commits the snapshot cursor", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { return { ok: true as const, data: [
        { id: "draft", name: "Planning draft", mimeType: "application/vnd.google-apps.document" },
        { id: "notes", name: "Notes by Gemini — Atlas", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-08-17T10:00:00.000Z" },
      ] }; },
      async listDriveChangesPage() { throw new Error("snapshot must not read changes"); },
      async getDriveDocument(id: string) {
        if (id !== "notes") throw new Error(`unexpected document read: ${id}`);
        return { ok: true as const, data: { documentId: id, title: "Atlas", body: { content: [
          { paragraph: { elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Atlas\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "Decision recorded.\n" } }] } },
        ] } } };
      },
    });
    const store = Object.assign(new FakeStore(), {
      cursor: null as string | null,
      async getDriveCursor() { return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, cursor: string) { this.cursor = cursor; return ok(undefined); },
      async findGmeetNotesAssociation() { return ok(null); },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok(undefined); },
    });

    const result = await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(result.ok).toBe(true);
    expect(store.cursor).toBe("snapshot-token");
    expect(client.calls).toContain("listConferenceRecords");
    expect(store.rows.some((row) => row.meeting.sourceId === "notes")).toBe(true);
    expect(store.rows.some((row) => row.meeting.sourceId === "draft")).toBe(false);
    expect(result.data.skipped).toBe(0);
    expect(result.data.items).not.toContainEqual(expect.objectContaining({ sourceId: "draft" }));
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0]!;
    expect(Object.keys(diagnostic).sort()).toEqual(DIAGNOSTIC_KEYS);
    expect(diagnostic).toMatchObject({
      drive_mode: "snapshot",
      drive_diagnostics_complete: 1,
      drive_input_items: 2,
      drive_terminal_items: 2,
      drive_missing_id: 0,
      drive_removed_or_trashed: 0,
      drive_non_google_doc: 0,
      drive_google_docs_discovered: 2,
      drive_metadata_non_candidate: 1,
      drive_metadata_candidate: 1,
      drive_docs_get_attempted: 1,
      drive_docs_get_succeeded: 1,
      drive_parser_accepted: 1,
      drive_accepted_standalone_created: 1,
      drive_cursor_committed: 1,
    });
    expect(TERMINAL_KEYS.reduce((sum, key) => sum + Number(diagnostic[key]), 0)).toBe(diagnostic.drive_terminal_items);
    expect(diagnostic.drive_docs_get_attempted).toBe(
      Number(diagnostic.drive_docs_get_succeeded)
      + Number(diagnostic.drive_docs_get_failed_retryable)
      + Number(diagnostic.drive_docs_get_failed_terminal)
      + Number(diagnostic.drive_docs_get_aborted),
    );
    expect(diagnostic.persisted_item_count_after).toBe(
      Number(diagnostic.persisted_item_count_before)
      + Number(diagnostic.meet_rows_inserted)
      + Number(diagnostic.drive_rows_inserted)
      - Number(diagnostic.drive_rows_deleted),
    );
    const serialized = JSON.stringify(diagnostic);
    for (const privateFixtureValue of ["snapshot-token", "draft", "notes", "Atlas", "Decision recorded"]) {
      expect(serialized).not.toContain(privateFixtureValue);
    }
  });

  test("migrates a Notes-first standalone row onto a later uniquely matching conference", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const store = new FakeStore();
    const standalone: NormalizedMeeting = {
      id: "notes-row", source: "google-meet", sourceId: "notes-1", title: "Project Atlas",
      startedAt: "2026-08-17T09:00:00.000Z", durationSecs: null, organizerEmail: null,
      participants: [], summaryOverview: "old summary", summaryActionItems: "old actions",
      keywords: null, meetingType: null,
      metadata: {
        drive_file_id: "notes-1", notes_association: "standalone",
        datetime_source: "docs_content", datetime_exact: true, datetime_resolution_version: 1,
      },
    };
    const conference: NormalizedMeeting = {
      ...standalone, id: "conference-row", sourceId: "conference-1",
      summaryOverview: null, summaryActionItems: null, metadata: {},
    };
    store.rows.push(
      { id: standalone.id, createdAt: "created-at", meeting: standalone },
      { id: conference.id, createdAt: "created-at", meeting: conference },
    );
    store.bodies.set("google-meet/notes-1", [{ index: 0, speaker_name: "Gemini", text: "old notes", start_time: 0, end_time: 1 }]);
    store.bodies.set("google-meet/conference-1", [{ index: 0, speaker_name: "Alice", text: "Meet transcript", start_time: 0, end_time: 1 }]);
    const attachCalls: string[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { throw new Error("incremental sync must not snapshot"); },
      async listDriveFiles() { throw new Error("incremental sync must not snapshot"); },
      async listDriveChangesPage() { return { ok: true as const, data: {
        changes: [{ fileId: "notes-1", file: { id: "notes-1", name: "Notes by Gemini — Project Atlas", mimeType: "application/vnd.google-apps.document" } }],
        nextPageToken: null, newStartPageToken: "cursor-2",
      } }; },
      async getDriveDocument() { return { ok: true as const, data: { body: { content: [
        { paragraph: { paragraphStyle: { namedStyleType: "TITLE" }, elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
        { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Project Atlas\n" } }] } },
        { paragraph: { elements: [{ textRun: { content: "August 17, 2026, 9:00 AM UTC – 9:30 AM\n" } }] } },
        { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
        { paragraph: { elements: [{ textRun: { content: "The pilot is approved.\n" } }] } },
      ] } } }; },
    });
    Object.assign(store, {
      cursor: "cursor-1",
      async getDriveCursor() { return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, cursor: string) { this.cursor = cursor; return ok(undefined); },
      async findGmeetNotesAssociation(_: TinyCloudWeb, _source: string, _fileId: string, title: string | null) {
        const found = title === null
          ? this.rows.find((row: StoredRow) => row.meeting.sourceId === "notes-1")
          : this.rows.find((row: StoredRow) => row.meeting.sourceId === "conference-1");
        return ok(found === undefined ? null : {
          id: found.id,
          sourceId: found.meeting.sourceId,
          title: found.meeting.title,
          startedAt: found.meeting.startedAt,
          metadata: found.meeting.metadata,
        });
      },
      async attachGmeetNotes(_: TinyCloudWeb, row: { sourceId: string }, notes: Pick<NormalizedMeeting, "startedAt" | "summaryOverview" | "summaryActionItems" | "metadata">) {
        attachCalls.push(row.sourceId);
        const target = this.rows.find((stored: StoredRow) => stored.meeting.sourceId === row.sourceId)!;
        target.meeting = { ...target.meeting, summaryOverview: notes.summaryOverview, summaryActionItems: notes.summaryActionItems, metadata: { ...target.meeting.metadata, ...notes.metadata } };
        return ok(undefined);
      },
      async removeGmeetNotes(_: TinyCloudWeb, _source: string, fileId: string) {
        const index = this.rows.findIndex((row: StoredRow) => row.meeting.sourceId === fileId);
        if (index >= 0) this.rows.splice(index, 1);
        this.bodies.delete(`google-meet/${fileId}`);
        return ok("deleted" as const);
      },
    });

    const result = await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(result.ok).toBe(true);
    expect(attachCalls).toEqual(["conference-1"]);
    expect(store.rows.map((row) => row.meeting.sourceId)).toEqual(["conference-1"]);
    expect(store.bodies.has("google-meet/notes-1")).toBe(false);
    expect(store.bodies.get("google-meet/conference-1")?.[0]?.text).toBe("Meet transcript");
    expect(diagnostics[0]).toMatchObject({
      drive_mode: "incremental", drive_parser_accepted: 1,
      drive_accepted_migrated: 1, drive_rows_deleted: 1,
      persisted_item_count_before: 2, persisted_item_count_after: 1,
    });
  });

  test("recognizes only a non-trashed Google Doc with the narrow Notes by Gemini metadata marker", () => {
    expect(isLikelyGmeetNotesFile({ id: "a", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" })).toBe(true);
    expect(isLikelyGmeetNotesFile({ id: "b", name: "Notes by Gemini", mimeType: "application/pdf" })).toBe(false);
    expect(isLikelyGmeetNotesFile({ id: "c", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document", trashed: true })).toBe(false);
    expect(isLikelyGmeetNotesFile({ id: "d", name: "Meeting notes", mimeType: "application/vnd.google-apps.document" })).toBe(false);
  });

  test("removes an associated trashed snapshot file without reading its document", async () => {
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-token" }; },
      async listDriveFiles() { return { ok: true as const, data: [
        { id: "notes-1", name: "Notes by Gemini — old", mimeType: "application/vnd.google-apps.document", trashed: true },
      ] }; },
      async listDriveChangesPage() { throw new Error("snapshot must not read changes"); },
      async getDriveDocument() { throw new Error("trashed Docs must not be read"); },
    });
    const removals: string[] = [];
    const store = Object.assign(new FakeStore(), {
      async getDriveCursor() { return ok(null); },
      async putDriveCursor() { return ok(undefined); },
      async findGmeetNotesAssociation() { return ok({
        id: "conference-row", sourceId: "conference-1", title: "Old", startedAt: null,
        metadata: { drive_file_id: "notes-1" },
      }); },
      async attachGmeetNotes() { throw new Error("trashed Docs must not attach"); },
      async removeGmeetNotes(_: TinyCloudWeb, _source: string, fileId: string) { removals.push(fileId); return ok(undefined); },
    });

    const result = await run(client, store);

    expect(result.ok).toBe(true);
    expect(removals).toEqual(["notes-1"]);
  });

  test("rebuilds an expired Drive cursor from a guarded metadata snapshot", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async listDriveChangesPage() {
        return { ok: false as const, error: {
          kind: "api-error" as const, status: 410, message: "page token is expired",
        } };
      },
      async getDriveStartPageToken() { return { ok: true as const, data: "snapshot-after-410" }; },
      async listDriveFiles() { return { ok: true as const, data: [] }; },
      async getDriveDocument() { throw new Error("empty snapshot must not read Docs"); },
    });
    const store = Object.assign(new FakeStore(), {
      cursor: "expired-cursor",
      writes: [] as string[],
      async getDriveCursor() { return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, cursor: string) { this.writes.push(cursor); this.cursor = cursor; return ok(undefined); },
      async findGmeetNotesAssociation() { return ok(null); },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok(undefined); },
    });

    const result = await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(result.ok).toBe(true);
    expect(store.cursor).toBe("snapshot-after-410");
    expect(store.writes).toEqual(["snapshot-after-410"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ drive_mode: "stale_cursor_snapshot", drive_diagnostics_complete: 1, drive_cursor_committed: 1 });
  });

  test("retains the prior change cursor when a candidate document read fails", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { throw new Error("not a snapshot"); },
      async listDriveFiles() { throw new Error("not a snapshot"); },
      async listDriveChangesPage() { return { ok: true as const, data: {
        changes: [{ fileId: "notes", file: { id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" } }],
        nextPageToken: null,
        newStartPageToken: "new-cursor",
      } }; },
      async getDriveDocument() { return { ok: false as const, error: { kind: "network-error" as const, status: null, message: "offline" } }; },
    });
    const store = Object.assign(new FakeStore(), {
      cursor: "old-cursor",
      writes: [] as string[],
      async getDriveCursor() { return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, cursor: string) { this.writes.push(cursor); this.cursor = cursor; return ok(undefined); },
      async findGmeetNotesAssociation() { return ok(null); },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok(undefined); },
    });

    const result = await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(result.ok).toBe(false);
    expect(result.data?.items).toEqual([{ sourceId: "notes", outcome: "error", reason: "offline" }]);
    expect(store.cursor).toBe("old-cursor");
    expect(store.writes).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      drive_mode: "incremental",
      drive_input_items: 1,
      drive_terminal_items: 1,
      drive_docs_get_attempted: 1,
      drive_docs_get_failed_retryable: 1,
      drive_cursor_committed: 0,
    });
  });

  test("buckets every successful Docs read as no-marker, no-section, or accepted", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { return { ok: true as const, data: "cursor" }; },
      async listDriveFiles() { return { ok: true as const, data: [
        { id: "a", name: "Renamed associated document", mimeType: "application/vnd.google-apps.document" },
        { id: "b", name: "Notes by Gemini B", mimeType: "application/vnd.google-apps.document" },
        { id: "c", name: "Notes by Gemini C", mimeType: "application/vnd.google-apps.document" },
      ] }; },
      async listDriveChangesPage() { throw new Error("snapshot only"); },
      async getDriveDocument(id: string) {
        if (id === "a") return { ok: true as const, data: { body: { content: [] } } };
        if (id === "b") return { ok: true as const, data: { body: { content: [
          { paragraph: { elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
        ] } } };
        return { ok: true as const, data: { body: { content: [
          { paragraph: { elements: [{ textRun: { content: "Notes by Gemini\n" } }] } },
          { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Summary\n" } }] } },
          { paragraph: { elements: [{ textRun: { content: "Accepted fixture body.\n" } }] } },
        ] } } };
      },
    });
    const store = Object.assign(new FakeStore(), {
      async getDriveCursor() { return ok(null); }, async putDriveCursor() { return ok(undefined); },
      async findGmeetNotesAssociation(_: TinyCloudWeb, _source: string, fileId: string) {
        return ok(fileId === "a" ? {
          id: "row-a", sourceId: "a", title: null, startedAt: null,
          summaryOverview: null, summaryActionItems: null, metadata: {},
        } : null);
      },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok("unchanged" as const); },
    });

    await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(diagnostics[0]).toMatchObject({
      drive_docs_get_succeeded: 3, drive_parser_rejected_no_marker: 1,
      drive_parser_rejected_no_supported_section: 1, drive_parser_accepted: 1,
      drive_accepted_standalone_created: 1, drive_terminal_items: 3,
    });
  });

  test("reports unchanged incremental associations and commits only the count, never the cursor value", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { throw new Error("incremental only"); },
      async listDriveFiles() { throw new Error("incremental only"); },
      async listDriveChangesPage() { return { ok: true as const, data: {
        changes: [{ fileId: "unchanged", file: { id: "unchanged", name: "renamed", mimeType: "application/vnd.google-apps.document", modifiedTime: "same" } }],
        nextPageToken: null, newStartPageToken: "new-private-cursor",
      } }; },
      async getDriveDocument() { throw new Error("unchanged association must not read Docs"); },
    });
    const store = Object.assign(new FakeStore(), {
      async getDriveCursor() { return ok("old-private-cursor"); }, async putDriveCursor() { return ok(undefined); },
      async findGmeetNotesAssociation() { return ok({
        id: "row", sourceId: "unchanged", title: null, startedAt: null,
        summaryOverview: null, summaryActionItems: null,
        metadata: {
          drive_modified_time: "same", datetime_source: "unavailable",
          datetime_exact: false, datetime_resolution_version: 1,
        },
      }); },
      async attachGmeetNotes() { return ok(undefined); }, async removeGmeetNotes() { return ok("unchanged" as const); },
    });

    await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(diagnostics[0]).toMatchObject({
      drive_mode: "incremental", drive_input_items: 1, drive_terminal_items: 1,
      drive_association_bypass: 1, drive_unchanged_associated: 1, drive_cursor_committed: 1,
    });
    expect(JSON.stringify(diagnostics[0])).not.toContain("private-cursor");
  });

  test("separates aborted Docs reads and reconciles the enumerated remainder", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { throw new Error("incremental only"); },
      async listDriveFiles() { throw new Error("incremental only"); },
      async listDriveChangesPage() { return { ok: true as const, data: {
        changes: [
          { fileId: "first", file: { id: "first", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" } },
          { fileId: "second", file: { id: "second", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" } },
        ], nextPageToken: null, newStartPageToken: "next",
      } }; },
      async getDriveDocument() { return { ok: false as const, error: { kind: "aborted" as const, status: null, message: "aborted" } }; },
    });
    const store = Object.assign(new FakeStore(), {
      async getDriveCursor() { return ok("current"); }, async putDriveCursor() { return ok(undefined); },
      async findGmeetNotesAssociation() { return ok(null); }, async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok("unchanged" as const); },
    });

    await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(diagnostics[0]).toMatchObject({
      drive_mode: "incremental", drive_diagnostics_complete: 1,
      drive_input_items: 2, drive_terminal_items: 2, drive_docs_get_attempted: 1,
      drive_docs_get_aborted: 1, drive_unprocessed_due_run_stop: 1, drive_cursor_committed: 0,
    });
  });

  test("reports all-source and Google-only explorer row counts separately", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const tcw = { sql: { db: () => ({ query: async (_sql: string, sources: string[]) => ({ ok: true, data: { rows:
      sources.length === 1
        ? [["g1", "google-meet", "s1", null, null], ["g2", "google-meet", "s2", null, null]]
        : [["g1", "google-meet", "s1", null, null], ["g2", "google-meet", "s2", null, null], ["f1", "fireflies", "s3", null, null]],
    } }) }) } } as unknown as TinyCloudWeb;

    await syncGoogleMeet({ client: new FakeClient([]), store: new FakeStore(), tcw, now, onDiagnostics: (value) => diagnostics.push(value as unknown as Record<string, number | string>) });

    expect(diagnostics[0]).toMatchObject({ meetings_page_rows_all_sources: 3, explorer_google_meet_rows: 2 });
  });

  test("stops on an exhausted Docs rate limit and leaves the Drive cursor retryable", async () => {
    const diagnostics: Record<string, number | string>[] = [];
    const documentReads: string[] = [];
    const client = Object.assign(new FakeClient([]), {
      async getDriveStartPageToken() { throw new Error("not a snapshot"); },
      async listDriveFiles() { throw new Error("not a snapshot"); },
      async listDriveChangesPage() { return { ok: true as const, data: {
        changes: [
          { fileId: "first", file: { id: "first", name: "Notes by Gemini — first", mimeType: "application/vnd.google-apps.document" } },
          { fileId: "second", file: { id: "second", name: "Notes by Gemini — second", mimeType: "application/vnd.google-apps.document" } },
        ],
        nextPageToken: null,
        newStartPageToken: "new-cursor",
      } }; },
      async getDriveDocument(id: string) {
        documentReads.push(id);
        return { ok: false as const, error: {
          kind: "rate-limited" as const, status: 429, message: "Docs quota exhausted", retryAfterMs: 1_000,
        } };
      },
    });
    const store = Object.assign(new FakeStore(), {
      cursor: "old-cursor",
      writes: [] as string[],
      async getDriveCursor() { return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, cursor: string) { this.writes.push(cursor); this.cursor = cursor; return ok(undefined); },
      async findGmeetNotesAssociation() { return ok(null); },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok(undefined); },
    });

    const result = await run(client, store, { onDiagnostics: (value) => diagnostics.push(value) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "rate-limited", message: "Docs quota exhausted" });
    expect(result.data?.items).toEqual([{ sourceId: "first", outcome: "error", reason: "Docs quota exhausted" }]);
    expect(result.data?.failed).toBe(1);
    expect(documentReads).toEqual(["first"]);
    expect(store.cursor).toBe("old-cursor");
    expect(store.writes).toEqual([]);
    expect(store.state?.lastSyncStatus).toBe("error");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      drive_mode: "incremental",
      drive_diagnostics_complete: 1,
      drive_input_items: 2,
      drive_terminal_items: 2,
      drive_docs_get_attempted: 1,
      drive_docs_get_failed_terminal: 1,
      drive_unprocessed_due_run_stop: 1,
      drive_cursor_committed: 0,
    });
  });
});

describe("post-loop finishing (TC-1270 synthetic 64-record controls)", () => {
  const points = [
    "getDriveCursor", "drive-start", "drive-files", "drive-changes", "docs",
    "association", "notes-body", "notes-upsert", "putDriveCursor",
    "countMeetings", "updateSyncState",
  ] as const;
  type Point = typeof points[number];

  async function flush() {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }

  function finishingFixture(held: Point | null) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blocked = held;
    const checkpoint = async (point: Point) => {
      if (blocked !== point) return;
      entered.resolve();
      await release.promise;
    };
    const store = Object.assign(new FakeStore(), {
      cursor: "old-cursor",
      async getDriveCursor() { await checkpoint("getDriveCursor"); return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, cursor: string) {
        await checkpoint("putDriveCursor");
        this.cursor = cursor;
        return ok(undefined);
      },
      async findGmeetNotesAssociation(_: TinyCloudWeb, _source: string, fileId: string) {
        if (fileId === "notes") await checkpoint("association");
        return ok(null);
      },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok(undefined); },
      async putTranscriptBody(tcw: TinyCloudWeb, source: string, id: string, sentences: FirefliesSentence[]) {
        if (id === "notes") await checkpoint("notes-body");
        return FakeStore.prototype.putTranscriptBody.call(this, tcw, source, id, sentences);
      },
      async upsertMeeting(tcw: TinyCloudWeb, meeting: NormalizedMeeting, sentences: FirefliesSentence[]) {
        if (meeting.sourceId === "notes") await checkpoint("notes-upsert");
        return FakeStore.prototype.upsertMeeting.call(this, tcw, meeting, sentences);
      },
      async countMeetings(tcw: TinyCloudWeb, source: string) {
        await checkpoint("countMeetings");
        return FakeStore.prototype.countMeetings.call(this, tcw, source);
      },
      async updateSyncState(tcw: TinyCloudWeb, input: UpdateSyncStateInput) {
        await checkpoint("updateSyncState");
        return FakeStore.prototype.updateSyncState.call(this, tcw, input);
      },
    });
    store.connection = {
      connectorId: "google-meet", status: "connected",
      lastSyncedAt: "2026-08-16T12:00:00.000Z", lastSyncStatus: "ok",
      lastSyncError: null, itemCount: 0,
    };
    const file = { id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" };
    const client = Object.assign(new FakeClient(Array.from({ length: 64 }, (_, i) =>
      fixture(`rec-${i}`, { entryTexts: [`Saved synthetic transcript ${i}`] }))), {
      async getDriveStartPageToken() { await checkpoint("drive-start"); return { ok: true as const, data: "next-cursor" }; },
      async listDriveFiles() { await checkpoint("drive-files"); return { ok: true as const, data: [file] }; },
      async listDriveChangesPage() {
        await checkpoint("drive-changes");
        return { ok: true as const, data: { changes: [{ fileId: file.id, file }], nextPageToken: null, newStartPageToken: "next-cursor" } };
      },
      async getDriveDocument() {
        await checkpoint("docs");
        return { ok: true as const, data: { title: "Notes by Gemini", tabs: [
          { tabProperties: { title: "Meeting notes" }, documentTab: { body: { content: [
            { paragraph: { paragraphStyle: { namedStyleType: "HEADING_3" }, elements: [{ textRun: { content: "Summary\n" } }] } },
            { paragraph: { elements: [{ textRun: { content: "Saved synthetic Notes.\n" } }] } },
          ] } } },
        ] } };
      },
    });
    return {
      store, client, entered: entered.promise,
      resume() { blocked = null; release.resolve(); },
      driveMode: held === "drive-changes" ? "auto" as const : "snapshot" as const,
    };
  }

  test("64 checked outcomes enter Finishing before Docs and finish only after final state", async () => {
    const f = finishingFixture("docs");
    const events: GmeetSyncProgress[] = [];
    const pending = run(f.client, f.store, { driveMode: f.driveMode, onProgress: (p) => events.push(p) });
    try {
      await f.entered;
      expect(events.at(-1)).toMatchObject({ type: "status", message: "finishing", current: 64, total: 64 });
      expect(f.store.rows.map((r) => r.meeting.sourceId).sort()).toEqual(
        Array.from({ length: 64 }, (_, i) => `rec-${i}`).sort(),
      );
      expect(events.some((p) => p.type === "complete")).toBe(false);
      expect(f.store.state).toBeNull();
      f.resume();
      const result = await pending;
      expect(result.ok).toBe(true);
      expect(events.at(-1)?.type).toBe("complete");
      expect(f.store.state).toMatchObject({ itemCount: 65, lastSyncStatus: "ok", lastSyncedAt: new Date(NOW_MS).toISOString() });
      expect(f.store.cursor).toBe("next-cursor");
    } finally { f.resume(); await pending; }
  });

  test.each(points)("a held %s times out without late completion and permits same-store Retry", async (point) => {
    vi.useFakeTimers();
    const f = finishingFixture(point);
    const events: GmeetSyncProgress[] = [];
    const pending = run(f.client, f.store, { driveMode: f.driveMode, onProgress: (p) => events.push(p) });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await f.entered;
      vi.advanceTimersByTime(120_001);
      await flush();
      vi.advanceTimersByTime(10_001); // The row-recovery wait for an outstanding storage call.
      await flush();
      expect(settled).toBe(true);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(events.at(-1)?.type).toBe("error");
      expect(isGmeetSyncInFlight()).toBe(false);
      expect(f.store.rows.filter((r) => r.meeting.sourceId.startsWith("rec-"))).toHaveLength(64);
      f.resume();
      await flush();
      expect(events.some((p) => p.type === "complete")).toBe(false);
      const retry = await run(f.client, f.store, { driveMode: f.driveMode });
      expect(retry.ok).toBe(true);
      expect(f.store.rows.map((r) => r.meeting.sourceId).sort()).toEqual(
        ["notes", ...Array.from({ length: 64 }, (_, i) => `rec-${i}`)].sort(),
      );
      expect(f.store.bodies.get("google-meet/rec-63")?.[0]?.text).toBe("Saved synthetic transcript 63");
    } finally {
      f.resume();
      await pending.catch(() => {});
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("Retry does not overlap an unabortable Notes write that timed out", async () => {
    vi.useFakeTimers();
    const f = finishingFixture("notes-upsert");
    const pending = run(f.client, f.store, { driveMode: "snapshot" });
    let result: Awaited<typeof pending> | undefined;
    void pending.then((value) => { result = value; });
    try {
      await f.entered;
      vi.advanceTimersByTime(120_001);
      await flush();
      vi.advanceTimersByTime(10_001); // The row-recovery wait for the outstanding write.
      await flush();
      expect(result?.ok).toBe(false);
      const callsAtTimeout = [...f.store.calls];
      const retryWhileWriting = await run(f.client, f.store, { driveMode: "snapshot" });
      expect(retryWhileWriting.ok).toBe(false);
      expect(f.store.calls).toEqual(callsAtTimeout);
      f.resume();
      await flush();
      const retry = await run(f.client, f.store, { driveMode: "snapshot" });
      expect(retry.ok).toBe(true);
      expect(f.store.rows).toHaveLength(65);
    } finally {
      f.resume();
      await pending;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  describe("a Finishing timeout still persists the connection", () => {
    // A diagnostics consumer that never settles stalls Finishing without holding
    // any storage call, so the recovery write has nothing to wait for.
    const stalledDiagnostics = () => {
      const seen: GmeetSyncDiagnostics[] = [];
      const reached = Promise.withResolvers<void>();
      return {
        seen,
        reached: reached.promise,
        onDiagnostics: (d: GmeetSyncDiagnostics) => {
          seen.push(d);
          if (seen.length > 1) return;
          reached.resolve();
          return new Promise<void>(() => {});
        },
      };
    };

    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    test("leaves one connected row carrying the timeout error, and Retry finishes without reconnecting", async () => {
      vi.useFakeTimers();
      const f = finishingFixture(null);
      f.store.connection = null; // First connect: the secret exists, no connector_state row yet.
      const diag = stalledDiagnostics();
      const pending = run(f.client, f.store, { driveMode: "snapshot", onDiagnostics: diag.onDiagnostics as never });
      await diag.reached;
      vi.advanceTimersByTime(120_001);
      await flush();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.connectionSaved).toBe(true);
      expect(f.store.stateWrites).toBe(1);
      expect(f.store.state).toMatchObject({
        connectorId: "google-meet", status: "connected", lastSyncStatus: "error",
        lastSyncError: expect.stringContaining("timed out"),
      });
      const timing = diag.seen.at(-1)!;
      expect(timing).toMatchObject({ finishing_timed_out: 1, finishing_stalled_phase: "diagnostics", finishing_recovery_write: "written" });
      for (const key of ["phase_drive_ms", "phase_count_ms", "phase_diagnostics_ms", "phase_state_write_ms"] as const) {
        expect(typeof timing[key]).toBe("number");
      }
      f.store.connection = f.store.state as never; // What getConnection reads back.
      const retry = await run(f.client, f.store, { driveMode: "snapshot" });
      expect(retry.ok).toBe(true);
      expect(f.store.state).toMatchObject({ status: "connected", lastSyncStatus: "ok", lastSyncError: null });
    });

    test("reports the connection as not saved when that row write also fails", async () => {
      vi.useFakeTimers();
      const f = finishingFixture(null);
      f.store.connection = null;
      f.store.updateSyncState = async () => ({ ok: false as const, error: { code: "STORE", message: "synthetic row write refused" } });
      const diag = stalledDiagnostics();
      const pending = run(f.client, f.store, { driveMode: "snapshot", onDiagnostics: diag.onDiagnostics as never });
      await diag.reached;
      vi.advanceTimersByTime(120_001);
      await flush();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.connectionSaved).toBe(false);
      expect(diag.seen.at(-1)).toMatchObject({ finishing_recovery_write: "failed" });
    });

    test("Drive Notes have their own budget, so the state row lands before the Finishing deadline", async () => {
      vi.useFakeTimers();
      const f = finishingFixture("docs");
      f.store.connection = null;
      const pending = run(f.client, f.store, { driveMode: "snapshot" });
      await f.entered;
      vi.advanceTimersByTime(60_001); // Well inside the 120 s Finishing deadline.
      await flush();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.message).toContain("Drive timed out");
      expect(f.store.state).toMatchObject({ status: "connected", lastSyncStatus: "error" });
      expect(f.store.cursor).toBe("old-cursor");
      f.resume();
      await flush();
      f.store.connection = f.store.state as never;
      expect((await run(f.client, f.store, { driveMode: "snapshot" })).ok).toBe(true);
    });
  });

  test.each(["countMeetings", "updateSyncState"] as const)("a rejected final %s yields an error result and terminal progress", async (point) => {
    const f = finishingFixture(null);
    const events: GmeetSyncProgress[] = [];
    f.store[point] = async () => { throw new Error(`synthetic ${point} transport rejection`); };
    const result = await run(f.client, f.store, { driveMode: "snapshot", onProgress: (p) => events.push(p) });
    expect(result.ok).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", current: 64, total: 64 });
    expect(events.some((p) => p.type === "complete")).toBe(false);
    expect(isGmeetSyncInFlight()).toBe(false);
    expect(f.store.rows).toHaveLength(65);
  });

  test.each(["countMeetings", "updateSyncState"] as const)("a result-shaped final %s failure cannot report success", async (point) => {
    const f = finishingFixture(null);
    const events: GmeetSyncProgress[] = [];
    f.store[point] = async () => ({ ok: false as const, error: { code: "STORE", message: `synthetic ${point} failure` } });
    const result = await run(f.client, f.store, { driveMode: "snapshot", onProgress: (p) => events.push(p) });
    expect(result.ok).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
    expect(f.store.state?.lastSyncedAt).not.toBe(new Date(NOW_MS).toISOString());
  });

  test.each(["progress", "diagnostics"] as const)("a thrown %s completion consumer returns error rather than stranding the run", async (consumer) => {
    const f = finishingFixture(null);
    const events: GmeetSyncProgress[] = [];
    const result = await run(f.client, f.store, {
      driveMode: "snapshot",
      onProgress(p) {
        if (consumer === "progress" && p.type === "complete") throw new Error("synthetic completion failure");
        events.push(p);
      },
      ...(consumer === "diagnostics" ? { onDiagnostics() { throw new Error("synthetic diagnostics failure"); } } : {}),
    });
    expect(result.ok).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
    expect(isGmeetSyncInFlight()).toBe(false);
  });

  test("a rejected asynchronous Finishing progress consumer is terminal", async () => {
    const f = finishingFixture(null);
    const events: GmeetSyncProgress[] = [];
    const result = await run(f.client, f.store, {
      driveMode: "snapshot",
      onProgress(p) {
        events.push(p);
        if (p.type === "status" && p.message === "finishing") {
          return Promise.reject(new Error("Synthetic Finishing consumer rejection"));
        }
      },
    });
    expect(result.ok).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
    expect(f.store.state?.lastSyncedAt).toBe(f.store.connection?.lastSyncedAt);
  });

  test.each(["stats", "query"] as const)("a result-shaped %s diagnostic failure cannot publish success", async (boundary) => {
    const f = finishingFixture(null);
    let reads = 0;
    const stats = f.store.getMeetingDatetimeStats.bind(f.store);
    f.store.getMeetingDatetimeStats = async (tcw, source) => {
      if (boundary === "stats" && ++reads > 1) {
        return { ok: false, error: { code: "STORE", message: "Synthetic final diagnostic failure" } };
      }
      return stats(tcw, source);
    };
    const tcw = {
      sql: { db: () => ({ query: async () => boundary === "query"
        ? { ok: false, error: { code: "STORE", message: "Synthetic final diagnostic query failure" } }
        : { ok: true, data: { rows: [] } } }) },
    } as unknown as TinyCloudWeb;
    const events: GmeetSyncProgress[] = [];
    const result = await syncGoogleMeet({
      client: f.client, store: f.store, tcw, now, driveMode: "snapshot",
      onProgress: (p) => events.push(p), onDiagnostics() {},
    });
    expect(result.ok).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some((p) => p.type === "complete")).toBe(false);
    expect(f.store.state?.lastSyncedAt).toBe(f.store.connection?.lastSyncedAt);
  });

  test.each(["slow-pages", "drive-list-403", "docs-403"] as const)("the real Google client preserves the %s control after 64 outcomes", async (control) => {
    const f = finishingFixture(null);
    const document = await f.client.getDriveDocument();
    const secondPage = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: string[] = [];
    const drive = new GmeetClient({
      accessToken: "synthetic-control-token", delayMs: 0,
      fetchImpl: (async (input) => {
        const url = new URL(String(input));
        requests.push(`${url.pathname}?${url.searchParams.get("pageToken") ?? ""}`);
        if (url.pathname === "/drive/v3/changes/startPageToken") return Response.json({ startPageToken: "next-cursor" });
        if (url.pathname === "/drive/v3/files") {
          if (control === "drive-list-403") return Response.json({ error: { message: "Synthetic Drive denial", status: "PERMISSION_DENIED" } }, { status: 403 });
          const page = url.searchParams.get("pageToken");
          if (control === "slow-pages" && page === null) return Response.json({ files: [], nextPageToken: "second" });
          if (page === "second") {
            secondPage.resolve();
            await release.promise;
            return Response.json({ files: [], nextPageToken: "third" });
          }
          return Response.json({ files: [{ id: "notes", name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document" }] });
        }
        if (url.pathname === "/v1/documents/notes") {
          if (control === "docs-403") return Response.json({ error: { message: "Synthetic Docs denial", status: "PERMISSION_DENIED" } }, { status: 403 });
          return Response.json(document.data);
        }
        throw new Error(`Unexpected synthetic Google control request: ${url.pathname}`);
      }) as typeof fetch,
    });
    Object.assign(f.client, {
      getDriveStartPageToken: drive.getDriveStartPageToken.bind(drive),
      listDriveFiles: drive.listDriveFiles.bind(drive),
      listDriveChangesPage: drive.listDriveChangesPage.bind(drive),
      getDriveDocument: drive.getDriveDocument.bind(drive),
    });
    const events: GmeetSyncProgress[] = [];
    const pending = run(f.client, f.store, { driveMode: "snapshot", onProgress: (p) => events.push(p) });
    try {
      if (control === "slow-pages") {
        await secondPage.promise;
        expect(events.at(-1)).toMatchObject({ type: "status", message: "finishing", current: 64, total: 64 });
        expect(f.store.cursor).toBe("old-cursor");
        release.resolve();
      }
      const result = await pending;
      expect(result.ok).toBe(control !== "docs-403");
      expect(f.store.state).toMatchObject({
        lastSyncStatus: control === "docs-403" ? "error" : control === "drive-list-403" ? "partial" : "ok",
        itemCount: control === "slow-pages" ? 65 : 64,
      });
      expect(f.store.cursor).toBe(control === "slow-pages" ? "next-cursor" : "old-cursor");
      if (control === "slow-pages") expect(requests.filter((path) => path.startsWith("/drive/v3/files?")))
        .toEqual(["/drive/v3/files?", "/drive/v3/files?second", "/drive/v3/files?third"]);
    } finally { release.resolve(); await pending; }
  });

  test("cancelling held post-loop work cannot later publish Done or advance its cursor", async () => {
    const f = finishingFixture("docs");
    const stop = new AbortController();
    const events: GmeetSyncProgress[] = [];
    const pending = run(f.client, f.store, { driveMode: "snapshot", signal: stop.signal, onProgress: (p) => events.push(p) });
    try {
      await f.entered;
      stop.abort();
      await flush();
      expect(events.at(-1)?.type).toBe("error");
      f.resume();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(f.store.cursor).toBe("old-cursor");
      expect(events.some((p) => p.type === "complete")).toBe(false);
    } finally { f.resume(); await pending; }
  });
});

describe("Notes reconcile at scale", () => {
  const DOC_MIME = "application/vnd.google-apps.document";
  const MODIFIED = "2026-10-01T00:00:00.000Z";

  function notesDocument() {
    return { title: "Notes by Gemini", tabs: [
      { tabProperties: { title: "Meeting notes" }, documentTab: { body: { content: [
        { paragraph: { paragraphStyle: { namedStyleType: "HEADING_3" }, elements: [{ textRun: { content: "Summary\n" } }] } },
        { paragraph: { elements: [{ textRun: { content: "Saved synthetic Notes.\n" } }] } },
      ] } } },
    ] };
  }

  /** A Drive of `docs` unrelated Docs plus `notes` Notes by Gemini, counting every node and Docs call. */
  function scaleFixture(config: { docs: number; notes: number; preload: boolean; progress?: boolean; records?: number }) {
    const files = Array.from({ length: config.docs + config.notes }, (_, i) => i < config.notes
      ? { id: `notes-${i}`, name: "Notes by Gemini", mimeType: DOC_MIME, modifiedTime: MODIFIED }
      : { id: `doc-${i}`, name: `Quarterly budget ${i}`, mimeType: DOC_MIME, modifiedTime: MODIFIED });
    const counts = { associations: 0, indexLoads: 0, reads: [] as string[], concurrent: 0, maxConcurrent: 0 };
    const ctl = { failOn: null as string | null, hold: null as Promise<void> | null };
    let saved: { startToken: string; doneIds: string[]; savedAt: string } | null = null;
    const store = Object.assign(new FakeStore(), {
      cursor: "old-cursor",
      async getDriveCursor() { return ok(this.cursor); },
      async putDriveCursor(_: TinyCloudWeb, _source: string, cursor: string) { this.cursor = cursor; return ok(undefined); },
      async findGmeetNotesAssociation() { counts.associations++; return ok(null); },
      async attachGmeetNotes() { return ok(undefined); },
      async removeGmeetNotes() { return ok(undefined); },
      ...(config.preload ? {
        async loadGmeetNotesIndex() { counts.indexLoads++; return ok({ size: 0, find: () => null }); },
      } : {}),
      ...(config.progress ? {
        async getDriveProgress() { return ok(saved); },
        async putDriveProgress(_: TinyCloudWeb, _source: string, progress: typeof saved) { saved = progress; return ok(undefined); },
      } : {}),
    });
    const client = Object.assign(new FakeClient(Array.from({ length: config.records ?? 1 }, (_, i) =>
      fixture(`rec-${i}`, { entryTexts: ["Saved synthetic transcript"] }))), {
      async getDriveStartPageToken() { return { ok: true as const, data: "next-cursor" }; },
      async listDriveFiles() { return { ok: true as const, data: files }; },
      async listDriveChangesPage() {
        return { ok: true as const, data: { changes: [], nextPageToken: null, newStartPageToken: "next-cursor" } };
      },
      async getDriveDocument(id: string) {
        counts.reads.push(id);
        counts.concurrent++;
        counts.maxConcurrent = Math.max(counts.maxConcurrent, counts.concurrent);
        try {
          await ctl.hold;
          if (id === ctl.failOn) {
            return { ok: false as const, error: { kind: "rate-limited" as const, status: 429, message: "synthetic quota" } };
          }
          return { ok: true as const, data: notesDocument() };
        } finally { counts.concurrent--; }
      },
    });
    return { store, client, counts, ctl, progress: () => saved };
  }

  // Everything the fakes await is microtask-only, so draining microtasks reaches any settled state.
  async function drain(predicate: () => boolean = () => false) {
    for (let i = 0; i < 5000 && !predicate(); i++) await Promise.resolve();
    return predicate();
  }

  afterEach(() => { vi.useRealTimers(); });

  test("a Drive of 1,000 Docs and 50 Notes costs node calls in proportion to the Notes, not the Docs", async () => {
    const f = scaleFixture({ docs: 1000, notes: 50, preload: true });
    const diagnostics: GmeetSyncDiagnostics[] = [];
    const result = await run(f.client, f.store, { driveMode: "snapshot", onDiagnostics: (d) => diagnostics.push(d as never) });
    expect(result.ok).toBe(true);
    expect(f.counts.reads).toHaveLength(50);
    expect(f.counts.indexLoads).toBe(1);
    expect(f.counts.associations).toBeLessThanOrEqual(100); // O(Notes): the post-parse lookups, never one per Doc.
    expect(diagnostics.at(-1)).toMatchObject({
      drive_candidates: 50, drive_prefilter_skipped: 1000, drive_metadata_non_candidate: 1000, drive_cursor_committed: 1,
    });
  });

  test("an interrupted snapshot resumes from its checkpoint: Retry reads only the remainder", async () => {
    const f = scaleFixture({ docs: 0, notes: 25, preload: true, progress: true });
    f.ctl.failOn = "notes-20";
    const first = await run(f.client, f.store, { driveMode: "snapshot" });
    expect(first.ok).toBe(false);
    expect(f.progress()?.doneIds).toHaveLength(20);
    expect(f.store.cursor).toBe("old-cursor");
    f.counts.reads.length = 0;
    f.ctl.failOn = null;
    const retry = await run(f.client, f.store, { driveMode: "snapshot" });
    expect(retry.ok).toBe(true);
    expect(f.counts.reads).toEqual(["notes-20", "notes-21", "notes-22", "notes-23", "notes-24"]);
    expect(f.progress()).toBeNull();
    expect(f.store.cursor).toBe("next-cursor");
    expect(f.store.rows.filter((row) => row.meeting.sourceId.startsWith("notes-"))).toHaveLength(25);
  });

  test("a stale checkpoint is ignored rather than resumed", async () => {
    const f = scaleFixture({ docs: 0, notes: 12, preload: true, progress: true });
    f.ctl.failOn = "notes-11";
    await run(f.client, f.store, { driveMode: "snapshot" });
    expect(f.progress()?.doneIds).toHaveLength(11); // Checkpoint at 10, flushed at the terminal failure.
    const aged = { ...f.progress()!, savedAt: new Date(NOW_MS - 25 * 3_600_000).toISOString() };
    await f.store.putDriveProgress({} as TinyCloudWeb, "google-meet", aged);
    f.counts.reads.length = 0;
    f.ctl.failOn = null;
    expect((await run(f.client, f.store, { driveMode: "snapshot" })).ok).toBe(true);
    expect(f.counts.reads).toHaveLength(12);
  });

  test("deferNotes saves the connection first, finishes Notes in the background, and reports the outcome", async () => {
    const f = scaleFixture({ docs: 200, notes: 3, preload: true });
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    const settled: GmeetNotesSettled[] = [];
    const stages: Array<string | undefined> = [];
    const offSettled = onGmeetNotesSettled((s) => settled.push(s));
    const offProgress = onGmeetNotesProgress((p) => stages.push(p.stage));
    const events: GmeetSyncProgress[] = [];
    try {
      const result = await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true, onProgress: (p) => events.push(p) });
      expect(result.ok && result.data.notesDeferred).toBe(true);
      expect(events.at(-1)?.type).toBe("complete");
      expect(f.store.state).toMatchObject({ status: "connected", lastSyncStatus: "ok", itemCount: 1 });
      expect(isGmeetNotesSyncInFlight()).toBe(true);
      expect(isGmeetSyncInFlight()).toBe(true);
      const blocked = await run(f.client, f.store, { driveMode: "snapshot" });
      expect(blocked.ok).toBe(false);
      expect(blocked.ok === false && blocked.error.message).toContain("background");
      hold.resolve();
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(settled[0]).toMatchObject({ ok: true, errorKind: null });
      expect(f.store.state).toMatchObject({ status: "connected", lastSyncStatus: "ok", itemCount: 4 });
      expect(f.store.cursor).toBe("next-cursor");
      expect(isGmeetNotesSyncInFlight()).toBe(false);
      expect(stages).toEqual(expect.arrayContaining(["notes-listing", "notes", "saving"]));
    } finally { hold.resolve(); offSettled(); offProgress(); }
  });

  test("a background Notes failure is written to the connection row so the card shows it", async () => {
    const f = scaleFixture({ docs: 5, notes: 4, preload: true });
    f.ctl.failOn = "notes-1";
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      const result = await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
      expect(result.ok).toBe(true);
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(settled[0]).toMatchObject({ ok: false, errorKind: "rate-limited" });
      expect(f.store.state).toMatchObject({ status: "connected", lastSyncStatus: "error", lastSyncError: "synthetic quota" });
      expect(f.store.cursor).toBe("old-cursor");
    } finally { off(); }
  });

  test("background Docs reads run in parallel but never more than five at once", async () => {
    const f = scaleFixture({ docs: 0, notes: 12, preload: true });
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
      expect(await drain(() => f.counts.concurrent === 5)).toBe(true);
      await drain();
      expect(f.counts.maxConcurrent).toBe(5);
      hold.resolve();
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(f.counts.maxConcurrent).toBe(5);
      expect(settled[0]?.ok).toBe(true);
    } finally { hold.resolve(); off(); }
  });

  test("a storage call stuck past its own limit ends the background reconcile without wedging the app", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 3, preload: true });
    const never = Promise.withResolvers<StoreResult<UpsertMeetingOutcome>>();
    f.store.upsertMeeting = (tcw, meeting, sentences) => meeting.sourceId.startsWith("notes-")
      ? never.promise
      : FakeStore.prototype.upsertMeeting.call(f.store, tcw, meeting, sentences);
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      expect((await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true })).ok).toBe(true);
      await drain();
      vi.advanceTimersByTime(30_001);
      await drain();
      vi.advanceTimersByTime(10_001); // The wait for the abandoned write before the state row.
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(settled[0]).toMatchObject({ ok: false, errorKind: "network" });
      expect(settled[0]!.diagnostics).toMatchObject({ drive_call_timeouts: 1, finishing_recovery_write: "skipped_pending_storage" });
      expect(isGmeetNotesSyncInFlight()).toBe(false);
    } finally {
      off();
      never.resolve(ok({ id: "late", inserted: true, createdAt: new Date(NOW_MS).toISOString() }));
      await drain();
    }
  });

  test("a stuck storage call does not hold the single-flight slot (and so Disconnect) for the whole Finishing deadline", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 3, preload: true });
    const never = Promise.withResolvers<StoreResult<UpsertMeetingOutcome>>();
    f.store.upsertMeeting = (tcw, meeting, sentences) => meeting.sourceId.startsWith("notes-")
      ? never.promise
      : FakeStore.prototype.upsertMeeting.call(f.store, tcw, meeting, sentences);
    let result: Awaited<ReturnType<typeof run>> | undefined;
    void run(f.client, f.store, { driveMode: "snapshot" }).then((value) => { result = value; });
    await drain();
    vi.advanceTimersByTime(30_001); // The per-call storage limit, far inside the 120 s deadline.
    await drain();
    vi.advanceTimersByTime(10_001); // The bounded wait for the stuck write before the connection row.
    await drain(() => result !== undefined);
    expect(result?.ok).toBe(false);
    expect(isGmeetSyncInFlight()).toBe(false);
    never.resolve(ok({ id: "late", inserted: true, createdAt: new Date(NOW_MS).toISOString() }));
    await drain();
  });

  test("stopping the background reconcile (a disconnect) writes nothing more", async () => {
    const f = scaleFixture({ docs: 0, notes: 6, preload: true });
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      expect((await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true })).ok).toBe(true);
      await drain(() => f.counts.concurrent === 5);
      const stateWrites = f.store.stateWrites;
      const rows = f.store.rows.length;
      const stopped = stopGmeetNotesSync();
      hold.resolve();
      await stopped;
      expect(isGmeetNotesSyncInFlight()).toBe(false);
      expect(f.store.stateWrites).toBe(stateWrites);
      expect(f.store.rows).toHaveLength(rows);
      expect(f.store.cursor).toBe("old-cursor");
      expect(settled).toHaveLength(1);
      expect(settled[0]?.ok).toBe(false);
    } finally { hold.resolve(); off(); }
  });

  test("a Google Meet disconnect stops the running background reconcile before it tears anything down", async () => {
    const f = scaleFixture({ docs: 0, notes: 6, preload: true });
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    try {
      expect((await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true })).ok).toBe(true);
      await drain(() => f.counts.concurrent === 5);
      expect(isGmeetNotesSyncInFlight()).toBe(true);
      // Every teardown step records whether the reconcile was still running when it started.
      const steps: string[] = [];
      const step = <T>(name: string, value: T) => async () => { steps.push(`${name}:${isGmeetNotesSyncInFlight()}`); return value; };
      const deps = {
        connectorId: "google-meet", source: "google-meet", mode: "keep-data",
        webhooks: {
          disable: step("disable", { status: "ok", value: { status: "disabled", queueDropped: 0 } }),
          recordPurge: step("record-purge", { status: "ok", value: null }),
          clearPurgeLedger: step("clear-ledger", { status: "ok", value: null }),
        },
        secrets: { isUnlocked: () => true, unlock: step("unlock", { ok: true }), deleteKey: step("delete-key", { ok: true }) },
        store: {
          listKnownSourceIds: step("collect-ids", ok<string[]>([])),
          purgeConnector: step("purge-local", ok(undefined)),
          clearFirefliesAttempt: step("clear-attempt", ok(undefined)),
          getConnection: step("get-connection", ok(null)),
          countMeetings: step("count", ok(0)),
          updateSyncState: step("update-state", ok(undefined)),
        },
      } as unknown as DisconnectDeps; // Only the steps the keep-data plan reaches are exercised.
      const done = runDisconnect(deps, () => {});
      hold.resolve();
      expect((await done).done).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.filter((entry) => entry.endsWith(":true"))).toEqual([]);
    } finally { hold.resolve(); }
  });

  test("a stopped deferred run keeps its old watermark and starts no background reconcile", async () => {
    const f = scaleFixture({ docs: 0, notes: 4, preload: true, records: 2 });
    const watermark = "2026-10-10T00:00:00.000Z";
    f.store.connection = {
      connectorId: "google-meet", status: "connected", lastSyncedAt: watermark,
      lastSyncStatus: "ok", lastSyncError: null, itemCount: 0,
    };
    const stop = new AbortController();
    f.store.afterUpsert = () => stop.abort(); // Stop lands between the two Meet records.
    const dialogSees: GmeetSyncProgress[] = [];
    const result = await run(f.client, f.store, {
      driveMode: "snapshot", deferNotes: true, signal: stop.signal, onProgress: (p) => dialogSees.push(p),
    });
    expect(result.ok && result.data.aborted).toBe(true);
    expect(result.ok && result.data.notesDeferred).toBeUndefined();
    expect(f.store.state?.lastSyncedAt).toBe(watermark);
    expect(isGmeetNotesSyncInFlight()).toBe(false);
    await drain();
    expect(f.counts.reads).toEqual([]);
    expect(f.store.rows.some((row) => row.meeting.sourceId.startsWith("notes-"))).toBe(false);
  });

  test("a disconnect during the foreground part of a deferred run still stops the reconcile it is about to start", async () => {
    const f = scaleFixture({ docs: 0, notes: 4, preload: true });
    const countGate = Promise.withResolvers<void>();
    const count = f.store.countMeetings.bind(f.store);
    f.store.countMeetings = async (tcw, source) => { await countGate.promise; return count(tcw, source); };
    const pending = run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
    await drain();
    const stopped = stopGmeetNotesSync();
    countGate.resolve();
    await stopped;
    await pending;
    expect(isGmeetNotesSyncInFlight()).toBe(false);
    await drain();
    expect(f.store.rows.some((row) => row.meeting.sourceId.startsWith("notes-"))).toBe(false);
  });

  // ── TC-1481 stage 3: one Note's storage failure no longer costs the run ──

  /** Makes one Note's row write fail `failures` times (Infinity = until healed), counting every attempt. */
  function failNoteWrites(f: ReturnType<typeof scaleFixture>, sourceId: string, failures: number) {
    const attempts = { count: 0 };
    const upsert = f.store.upsertMeeting.bind(f.store);
    let left = failures;
    f.store.upsertMeeting = async (tcw, meeting, sentences) => {
      if (meeting.sourceId !== sourceId) return upsert(tcw, meeting, sentences);
      attempts.count++;
      if (left > 0) { left--; return { ok: false, error: { code: "STORE", message: "node busy" } }; }
      return upsert(tcw, meeting, sentences);
    };
    return { attempts, heal: () => { left = 0; } };
  }

  /** Drains microtasks and moves the fake clock until the condition holds (retry backoffs are timers). */
  async function untilWithTimers(predicate: () => boolean) {
    for (let i = 0; i < 200 && !predicate(); i++) { await drain(); vi.advanceTimersByTime(1000); }
    return predicate();
  }

  const notesRows = (f: ReturnType<typeof scaleFixture>) => f.store.rows.filter((row) => row.meeting.sourceId.startsWith("notes-")).map((row) => row.meeting.sourceId).sort();

  test("a Note write that fails once is retried: the run is ok, with no terminal error", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 3, preload: true });
    const flaky = failNoteWrites(f, "notes-1", 1);
    const diagnostics: GmeetSyncDiagnostics[] = [];
    let result: Awaited<ReturnType<typeof run>> | undefined;
    void run(f.client, f.store, { driveMode: "snapshot", onDiagnostics: (d) => diagnostics.push(d as never) }).then((value) => { result = value; });
    expect(await untilWithTimers(() => result !== undefined)).toBe(true);
    expect(result?.ok).toBe(true);
    expect(notesRows(f)).toEqual(["notes-0", "notes-1", "notes-2"]);
    expect(flaky.attempts.count).toBe(2);
    expect(f.store.state).toMatchObject({ lastSyncStatus: "ok", lastSyncError: null });
    expect(f.store.cursor).toBe("next-cursor");
    expect(diagnostics.at(-1)).toMatchObject({ drive_storage_retries: 1, drive_items_failed: 0, drive_cursor_committed: 1 });
  });

  test("a Note write that keeps failing leaves the other Notes saved, a correct count, and the next run retries only that Note", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 5, preload: true, progress: true });
    const broken = failNoteWrites(f, "notes-2", Infinity);
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      expect((await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true })).ok).toBe(true);
      expect(await untilWithTimers(() => settled.length === 1)).toBe(true);
      expect(broken.attempts.count).toBe(3); // The first try and two retries.
      expect(notesRows(f)).toEqual(["notes-0", "notes-1", "notes-3", "notes-4"]);
      expect(settled[0]).toMatchObject({ ok: false, errorKind: null, partial: { saved: 4, total: 5 } });
      expect(settled[0]!.diagnostics).toMatchObject({ drive_items_failed: 1, drive_storage_retries: 2 });
      // The row says what happened and counts every stored meeting (the Meet record and four Notes).
      expect(f.store.state).toMatchObject({
        status: "connected", lastSyncStatus: "partial", itemCount: f.store.rows.length,
        lastSyncError: "4 of 5 Notes saved. Sync now or Full rescan finishes the rest.",
      });
      expect(f.store.rows).toHaveLength(5);
      // The checkpoint keeps the saved Notes and leaves the failed one out; the cursor waits for it.
      expect(f.progress()?.doneIds.sort()).toEqual(["notes-0", "notes-1", "notes-3", "notes-4"]);
      expect(f.store.cursor).toBe("old-cursor");

      broken.heal();
      f.counts.reads.length = 0;
      expect((await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true })).ok).toBe(true);
      expect(await untilWithTimers(() => settled.length === 2)).toBe(true);
      expect(f.counts.reads).toEqual(["notes-2"]);
      expect(settled[1]).toMatchObject({ ok: true, errorKind: null, partial: null });
      expect(notesRows(f)).toHaveLength(5);
      expect(f.store.state).toMatchObject({ lastSyncStatus: "ok", lastSyncError: null, itemCount: 6 });
      expect(f.progress()).toBeNull();
      expect(f.store.cursor).toBe("next-cursor");
    } finally { off(); }
  });

  test("a foreground run with one Note that cannot be saved also completes as a partial result, not an error", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 3, preload: true, progress: true });
    failNoteWrites(f, "notes-0", Infinity);
    let result: Awaited<ReturnType<typeof run>> | undefined;
    void run(f.client, f.store, { driveMode: "snapshot" }).then((value) => { result = value; });
    expect(await untilWithTimers(() => result !== undefined)).toBe(true);
    expect(result?.ok).toBe(true);
    expect(f.store.state).toMatchObject({ lastSyncStatus: "partial", lastSyncError: "2 of 3 Notes saved. Sync now or Full rescan finishes the rest." });
    expect(f.store.cursor).toBe("old-cursor");
  });

  test("the row rewritten after a partial background run is recounted even when the recount itself fails", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 4, preload: true });
    failNoteWrites(f, "notes-1", Infinity);
    const count = f.store.countMeetings.bind(f.store);
    let counts = 0;
    // The foreground count (before any Note exists) succeeds; the background recount does not.
    f.store.countMeetings = async (tcw, source) => (++counts === 1 ? count(tcw, source) : { ok: false, error: { code: "STORE", message: "node busy" } });
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      expect((await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true })).ok).toBe(true);
      expect(f.store.state?.itemCount).toBe(1);
      expect(await untilWithTimers(() => settled.length === 1)).toBe(true);
      // One Meet record plus the three Notes that were saved: never the figure from before the reconcile.
      expect(f.store.state).toMatchObject({ lastSyncStatus: "partial", itemCount: 4 });
      expect(f.store.rows).toHaveLength(4);
    } finally { off(); }
  });

  test("a background run reports its live progress, and marks a resumed checkpoint, to a surface that did not start it", async () => {
    const f = scaleFixture({ docs: 0, notes: 4, preload: true, progress: true });
    await f.store.putDriveProgress({} as TinyCloudWeb, "google-meet", {
      startToken: "earlier-token", doneIds: ["notes-0", "notes-1"], savedAt: new Date(NOW_MS).toISOString(),
    });
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    const seen: boolean[] = [];
    const offLive = onGmeetLiveStatus(() => seen.push(getGmeetLiveStatus(TCW).running));
    try {
      expect(getGmeetLiveStatus(TCW)).toMatchObject({ running: false, progress: null, resumed: false });
      expect((await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true })).ok).toBe(true);
      expect(await drain(() => getGmeetLiveStatus(TCW).progress?.stage === "notes")).toBe(true);
      expect(getGmeetLiveStatus(TCW)).toMatchObject({
        running: true, resumed: true, progress: { stage: "notes", notesTotal: 4 },
      });
      hold.resolve();
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(getGmeetLiveStatus(TCW)).toMatchObject({ running: false, progress: null, resumed: false });
      expect(seen.at(-1)).toBe(false);
    } finally { hold.resolve(); off(); offLive(); }
  });

  test("a fresh run is not reported as resumed", async () => {
    const f = scaleFixture({ docs: 0, notes: 2, preload: true, progress: true });
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
      expect(await drain(() => getGmeetLiveStatus(TCW).progress?.stage === "notes")).toBe(true);
      expect(getGmeetLiveStatus(TCW).resumed).toBe(false);
    } finally { hold.resolve(); await drain(() => settled.length === 1); off(); }
  });

  test("every run keeps a counters-only log for its account, finished by the background reconcile", async () => {
    const f = scaleFixture({ docs: 0, notes: 3, preload: true });
    const events: Array<{ final: boolean }> = [];
    const offLog = onGmeetRunLog((event) => events.push({ final: event.final }));
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      expect(getGmeetRunLog(TCW)).toBeNull();
      await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
      // Handed off to the background: the log is not final yet.
      expect(events.some((event) => event.final)).toBe(false);
      expect(getGmeetRunLog(TCW)?.result).toMatchObject({ kind: "ok", notesDeferred: true });
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(events.at(-1)).toEqual({ final: true });
      const log = getGmeetRunLog(TCW, "test-build")!;
      expect(log.build).toBe("test-build");
      expect(log.notesOutcome).toEqual({ ok: true, errorKind: null });
      expect(log.timeline.some((entry) => entry.stage === "notes" && entry.notesTotal === 3)).toBe(true);
      expect(log.diagnostics).toMatchObject({ drive_items_failed: 0, drive_cursor_committed: 1 });
      // Another account's `tcw` never sees this run's log.
      expect(getGmeetRunLog({ sql: TCW.sql } as unknown as TinyCloudWeb)).toBeNull();
    } finally { off(); offLog(); }
  });

  test("an incremental run's partial total counts Notes changes, not every Drive change", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 0, preload: true });
    const changes = [
      ...Array.from({ length: 40 }, (_, i) => ({ fileId: `doc-${i}`, file: { id: `doc-${i}`, name: `Budget ${i}`, mimeType: "application/vnd.google-apps.document" } })),
      ...Array.from({ length: 3 }, (_, i) => ({ fileId: `notes-${i}`, file: { id: `notes-${i}`, name: "Notes by Gemini", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T00:00:00.000Z" } })),
    ];
    f.client.listDriveChangesPage = async () => ({ ok: true as const, data: { changes, nextPageToken: null, newStartPageToken: "next-cursor" } });
    failNoteWrites(f, "notes-1", Infinity);
    let result: Awaited<ReturnType<typeof run>> | undefined;
    void run(f.client, f.store, {}).then((value) => { result = value; });
    expect(await untilWithTimers(() => result !== undefined)).toBe(true);
    expect(f.store.state).toMatchObject({ lastSyncStatus: "partial", lastSyncError: "2 of 3 Notes saved. Sync now or Full rescan finishes the rest." });
    expect(f.store.cursor).toBe("old-cursor");
  });

  test("once one Note has exhausted its retries, later Notes fail fast instead of burning the backoff again", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 3, preload: true });
    const a = failNoteWrites(f, "notes-0", Infinity);
    const upsert = f.store.upsertMeeting.bind(f.store);
    let second = 0;
    f.store.upsertMeeting = async (tcw, meeting, sentences) => {
      if (meeting.sourceId !== "notes-1") return upsert(tcw, meeting, sentences);
      second++;
      return { ok: false, error: { code: "STORE", message: "node busy" } };
    };
    let result: Awaited<ReturnType<typeof run>> | undefined;
    void run(f.client, f.store, { driveMode: "snapshot" }).then((value) => { result = value; });
    expect(await untilWithTimers(() => result !== undefined)).toBe(true);
    expect(a.attempts.count).toBe(3);
    expect(second).toBe(1);
    expect(f.store.state).toMatchObject({ lastSyncStatus: "partial", lastSyncError: "1 of 3 Notes saved. Sync now or Full rescan finishes the rest." });
  });

  // ── Cross-account isolation (TC-1376) ──
  const ACCOUNT_B = { did: "did:pkh:eip155:1:0xbbbb", sql: TCW.sql } as unknown as TinyCloudWeb;

  test("account A's running sync, progress and log never show for account B in the same tab", async () => {
    const f = scaleFixture({ docs: 0, notes: 4, preload: true });
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
      expect(await drain(() => getGmeetLiveStatus(TCW).progress?.stage === "notes")).toBe(true);
      expect(getGmeetLiveStatus(TCW).running).toBe(true);
      // Signed in as B (a different DID): nothing of A's run is visible.
      expect(getGmeetLiveStatus(ACCOUNT_B)).toEqual({ running: false, progress: null, resumed: false });
      expect(getGmeetLiveStatus(null).running).toBe(false);
      expect(getGmeetRunLog(ACCOUNT_B)).toBeNull();
      hold.resolve();
      expect(await drain(() => settled.length === 1)).toBe(true);
    } finally { hold.resolve(); off(); }
  });

  test("sign-out of account A stops its background reconcile and its writes; account B's sign-in stops nothing of A's", async () => {
    const f = scaleFixture({ docs: 0, notes: 6, preload: true });
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
      await drain(() => f.counts.concurrent === 5);
      // Another account's teardown does not touch A's run.
      await stopGmeetSyncForAccount(ACCOUNT_B);
      expect(isGmeetNotesSyncInFlight()).toBe(true);
      const stateWrites = f.store.stateWrites;
      const rows = f.store.rows.length;
      const stopped = stopGmeetSyncForAccount(TCW); // A signs out.
      hold.resolve();
      await stopped;
      expect(isGmeetNotesSyncInFlight()).toBe(false);
      await drain();
      expect(f.store.stateWrites).toBe(stateWrites);
      expect(f.store.rows).toHaveLength(rows);
      expect(f.store.cursor).toBe("old-cursor");
      expect(getGmeetLiveStatus(TCW)).toEqual({ running: false, progress: null, resumed: false });
      // B can now sync: the slot is free and A's reconcile writes nothing under B's session.
      expect(isGmeetSyncInFlight()).toBe(false);
    } finally { hold.resolve(); off(); }
  });

  test("per-Note progress reaches observers throttled, and the stage change and the end still arrive", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 12, preload: true });
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    let notifications = 0;
    const offLive = onGmeetLiveStatus(() => { notifications++; });
    try {
      await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
      expect(await untilWithTimers(() => settled.length === 1)).toBe(true);
      // 12 Notes would otherwise be 12+ notifications on their own.
      expect(notifications).toBeLessThan(12);
      expect(getGmeetLiveStatus(TCW).running).toBe(false);
    } finally { off(); offLive(); }
  });

  // ── TC-1481 stage 5: a manual Sync now / Full rescan hands its Notes to the background ──
  const SESSION_STORE = { getToken: () => "session-token", isExpired: () => false, clear: () => {} } as unknown as SessionStore;
  const mintFetch = (async () => new Response(JSON.stringify({ access_token: "access" }), { status: 200 })) as unknown as typeof fetch;

  /** Every Note's two storage calls take `ms`: the node that answers a SQL call in ~2.7 s. */
  function slowNoteStorage(f: ReturnType<typeof scaleFixture>, ms: number) {
    const body = f.store.putTranscriptBody.bind(f.store);
    const upsert = f.store.upsertMeeting.bind(f.store);
    const wait = () => new Promise<void>((resolve) => setTimeout(resolve, ms));
    f.store.putTranscriptBody = async (tcw, source, sourceId, sentences) => {
      if (sourceId.startsWith("notes-")) await wait();
      return body(tcw, source, sourceId, sentences);
    };
    f.store.upsertMeeting = async (tcw, meeting, sentences) => {
      if (meeting.sourceId.startsWith("notes-")) await wait();
      return upsert(tcw, meeting, sentences);
    };
  }

  function press(f: ReturnType<typeof scaleFixture>, driveMode: "auto" | "snapshot") {
    return runGmeetSyncNow({
      tcw: TCW, backendUrl: "https://backend.test", sessionStore: SESSION_STORE, refreshToken: "refresh",
      driveMode, signal: new AbortController().signal, onProgress: () => {},
      deps: { store: f.store, fetchImpl: mintFetch, createClient: () => f.client, mintRetryDelayMs: 0 },
    });
  }

  /** The Drive's change feed reports every Note as new, so an incremental (auto) run has all of them to reconcile. */
  function allNotesChanged(f: ReturnType<typeof scaleFixture>, notes: number) {
    const changes = Array.from({ length: notes }, (_, i) => ({ fileId: `notes-${i}`, file: { id: `notes-${i}`, name: "Notes by Gemini", mimeType: DOC_MIME, modifiedTime: MODIFIED } }));
    f.client.listDriveChangesPage = async () => ({ ok: true as const, data: { changes, nextPageToken: null, newStartPageToken: "next-cursor" } });
  }

  test("Sync now returns after the Meet records and finishes 26 Notes in the background on a node slower than the 60 s Drive limit", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 26, preload: true, progress: true });
    allNotesChanged(f, 26);
    slowNoteStorage(f, 2_700);
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      const outcome = await press(f, "auto");
      expect(outcome).toEqual({ ok: true });
      // Back to the caller with the Meet record saved and the Notes still to do, not timed out in the foreground.
      expect(isGmeetNotesSyncInFlight()).toBe(true);
      expect(notesRows(f)).toEqual([]);
      expect(f.store.state).toMatchObject({ status: "connected", lastSyncStatus: "ok" });
      expect(await untilWithTimers(() => settled.length === 1)).toBe(true);
      expect(settled[0]).toMatchObject({ ok: true, errorKind: null, partial: null });
      expect(settled[0]!.diagnostics).toMatchObject({ finishing_timed_out: 0, drive_call_timeouts: 0 });
      expect(notesRows(f)).toHaveLength(26);
      expect(f.store.state).toMatchObject({ lastSyncStatus: "ok", lastSyncError: null, itemCount: 27 });
      expect(f.store.cursor).toBe("next-cursor");
      expect(f.progress()).toBeNull();
    } finally { off(); }
  });

  test("Full rescan hands its Notes to the background too, and keeps its snapshot listing", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 40, notes: 26, preload: true, progress: true });
    slowNoteStorage(f, 2_700);
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      const outcome = await press(f, "snapshot");
      expect(outcome).toEqual({ ok: true });
      expect(isGmeetNotesSyncInFlight()).toBe(true);
      expect(notesRows(f)).toEqual([]);
      // A second Full rescan cannot join the running one: it is refused, not started alongside it.
      expect(await press(f, "snapshot")).toEqual({ ok: false, busy: true });
      expect(await untilWithTimers(() => settled.length === 1)).toBe(true);
      expect(settled[0]).toMatchObject({ ok: true, errorKind: null });
      expect(settled[0]!.diagnostics).toMatchObject({ drive_mode: "snapshot", finishing_timed_out: 0, drive_cursor_committed: 1 });
      expect(notesRows(f)).toHaveLength(26);
      expect(f.store.state).toMatchObject({ lastSyncStatus: "ok", lastSyncError: null });
    } finally { off(); }
  });

  test("a press that finds the previous Notes run interrupted resumes from its checkpoint in the background", async () => {
    vi.useFakeTimers();
    const f = scaleFixture({ docs: 0, notes: 26, preload: true, progress: true });
    slowNoteStorage(f, 2_700);
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    try {
      await f.store.putDriveProgress({} as TinyCloudWeb, "google-meet", {
        startToken: "earlier-token", doneIds: Array.from({ length: 20 }, (_, i) => `notes-${i}`), savedAt: new Date().toISOString(),
      });
      expect(await press(f, "snapshot")).toEqual({ ok: true });
      expect(await untilWithTimers(() => settled.length === 1)).toBe(true);
      expect(f.counts.reads.sort()).toEqual(["notes-20", "notes-21", "notes-22", "notes-23", "notes-24", "notes-25"]);
      expect(settled[0]!.diagnostics).toMatchObject({ drive_resumed_skipped: 20 });
    } finally { off(); }
  });

  test("a finished run replaces an earlier run's failure and time on the status line, before the row is re-read", async () => {
    const f = scaleFixture({ docs: 0, notes: 3, preload: true });
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    resetGmeetLastRunsForTests();
    // What the window still holds from the earlier, timed-out runs: the watermark from connecting, 14 minutes ago.
    const staleRow = {
      status: "connected", lastSyncedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
      lastSyncStatus: "error", lastSyncError: "Syncing Google Meet notes from Drive timed out. Saved meetings are kept. Retry to finish syncing.", itemCount: 17,
    };
    const display = () => sourceRowDisplay({
      comingSoon: false, connection: staleRow, itemCount: 4, lastRun: getGmeetLastRun(TCW),
      syncing: false, connecting: false, syncError: null, rowNote: null,
    });
    try {
      expect(display().status?.text).toBe("Last sync failed · synced 14 minutes ago · 4 meetings");
      expect(await press(f, "snapshot")).toEqual({ ok: true });
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(display()).toMatchObject({ status: { text: "Connected · synced just now · 4 meetings" }, error: null });
    } finally { off(); }
  });

  test("a run that ends in a failure shows that failure, and keeps the end time of the last run that completed", async () => {
    const f = scaleFixture({ docs: 0, notes: 4, preload: true });
    resetGmeetLastRunsForTests();
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    let clock = NOW_MS;
    const sync = () => syncGoogleMeet({ client: f.client, store: f.store, tcw: TCW, driveMode: "snapshot", deferNotes: true, now: () => clock });
    try {
      expect((await sync()).ok).toBe(true);
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(getGmeetLastRun(TCW)).toEqual({ syncedAt: new Date(NOW_MS).toISOString(), status: "ok", error: null });
      clock += 10 * 60_000;
      f.ctl.failOn = "notes-1";
      expect((await sync()).ok).toBe(true);
      expect(await drain(() => settled.length === 2)).toBe(true);
      // The Meet records were saved at the start of the second run; the Notes failed. The run says so.
      expect(getGmeetLastRun(TCW)).toMatchObject({ status: "error", error: "synthetic quota" });
    } finally { off(); }
  });

  test("the last run's time is when it ended, while the stored watermark stays the run's start", async () => {
    const f = scaleFixture({ docs: 0, notes: 3, preload: true });
    resetGmeetLastRunsForTests();
    const hold = Promise.withResolvers<void>();
    f.ctl.hold = hold.promise;
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    let clock = NOW_MS;
    try {
      await syncGoogleMeet({ client: f.client, store: f.store, tcw: TCW, driveMode: "snapshot", deferNotes: true, now: () => clock });
      clock += 5 * 60_000; // The Notes take five minutes.
      hold.resolve();
      expect(await drain(() => settled.length === 1)).toBe(true);
      expect(getGmeetLastRun(TCW)?.syncedAt).toBe(new Date(NOW_MS + 5 * 60_000).toISOString());
      expect(f.store.state?.lastSyncedAt).toBe(new Date(NOW_MS).toISOString());
    } finally { hold.resolve(); off(); }
  });

  test("the live count follows every saved Note, not only the checkpoints", async () => {
    const f = scaleFixture({ docs: 0, notes: 6, preload: true });
    resetGmeetMeetingCountsForTests();
    const settled: GmeetNotesSettled[] = [];
    const off = onGmeetNotesSettled((s) => settled.push(s));
    const seen: Array<number | null> = [];
    const offCount = onGmeetMeetingCount(() => seen.push(getGmeetMeetingCount(TCW)));
    try {
      await run(f.client, f.store, { driveMode: "snapshot", deferNotes: true });
      expect(await drain(() => settled.length === 1)).toBe(true);
      // One Meet record plus six Notes, counted up as they were saved (no checkpoint store, so no checkpoints).
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally { off(); offCount(); }
  });
});
