import { beforeEach, describe, expect, test } from "bun:test";
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
import {
  GMEET_LAG_BUFFER_MS,
  GMEET_MAX_BACKFILL_MS,
  _resetGmeetSyncSingleFlightForTests,
  gmeetSyncWindowStartIso,
  gmeetSyncWindowStartMs,
  isGmeetSyncInFlight,
  isLikelyGmeetNotesFile,
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
  "datetime_duplicates",
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

    expect(result.ok).toBe(true);
    expect(result.data.aborted).toBe(true);
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

    expect(result.ok).toBe(true);
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

    expect(result.ok).toBe(true);
    expect(result.data.items).toEqual([{ sourceId: "notes", outcome: "error", reason: "offline" }]);
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
