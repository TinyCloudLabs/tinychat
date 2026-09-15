// Google Meet sync engine — time-window cursor (plan §4.2, refinement R1).
//
// Sibling of firefliesSync.ts (same injected-seams shape, same terminal-vs-item
// error split at :119-121) but a DIFFERENT design: Fireflies lists newest-first
// and stops at the first known id; Meet cannot do that. A conference record's
// transcript artifact materializes MINUTES after the meeting ends, so a
// stop-at-first-known-id scan would walk straight past a record it already has a
// row for and never come back for the transcript that showed up afterwards.
// Instead the engine re-sweeps a time window on every run and lets the publisher
// dedup and repair.
//
// Window = [max(watermark − LAG_BUFFER, now − 30d), now], watermark =
// connector_state.last_synced_at (read via getConnection — connector_state has no
// free-form cursor column and there is no migration machinery, so the existing
// column IS the cursor).
//
// Persist order per record is load-bearing: KV transcript blob FIRST, the row
// LAST. The row is the commit point. A crash between the two leaves an ORPHAN
// BLOB — invisible, harmless, and repaired by the next re-sweep — never a row
// pointing at a transcript that does not exist (Listen's ghost-meeting trap,
// inverted).
//
// This module never touches tcw.secrets: the caller (connect dialog / session
// hook) obtains the access token through the backend refresh proxy and hands the
// engine a ready GmeetClient. Transcript text, titles and participant names are
// private user data — nothing here logs them, and per-item failure reasons carry
// API messages only.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { FirefliesSentence } from "./firefliesClient";
import type {
  NormalizedMeeting,
  GmeetNotesAssociation,
  GmeetNotesRemovalOutcome,
  MeetingDatetimeStats,
  StoreError,
  StoreResult,
  UpdateSyncStateInput,
  UpsertMeetingOutcome,
} from "./connectorStore";
import type {
  GmeetCallOptions,
  GmeetConferenceRecord,
  GmeetError,
  GmeetParticipant,
  GmeetResult,
  GmeetTranscript,
  GmeetTranscriptEntry,
  GoogleDriveChange,
  GoogleDriveChangesPage,
  GoogleDriveFile,
  GoogleDocsDocument,
} from "./gmeetClient";
import {
  GMEET_MEETING_SOURCE,
  normalizeGoogleMeetTranscript,
  type GmeetTranscriptBundle,
} from "./gmeetNormalize";
import { GMEET_DATETIME_RESOLUTION_VERSION, diagnoseGmeetNotesDocument } from "./gmeetNotes";
import { listMeetings } from "./meetingExplorer";
import type { ConnectorConnection, ConnectorId } from "./types";

/** SQL `source` column value and connector id — one string, one meaning. */
const SOURCE = GMEET_MEETING_SOURCE;

/**
 * Re-sweep overlap subtracted from the watermark (G1-ratified 72h).
 *
 * Sized for the ARTIFACT LAG, not the median: a transcript's entries appear some
 * time after the conference ends, and anything the previous run skipped as
 * "no entries yet" has to fall inside the next run's window or it is lost
 * forever. The spike measured one ≤165s datapoint — a single sample from one
 * account on one day does not shrink a safety window, and the cost of the wide
 * window is a few re-listed records that the publisher handles by identity.
 */
export const GMEET_LAG_BUFFER_MS = 72 * 60 * 60 * 1000;

/**
 * Hard backfill horizon. Google deletes conference records ~30 days after the
 * conference ends, so a window that reaches further back can only return
 * nothing — this is the API's limit, not a policy choice.
 */
export const GMEET_MAX_BACKFILL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Transcript states whose entries may be persisted.
 *
 * ENDED is included deliberately: entries are listable at ENDED, BEFORE the Docs
 * artifact generates (spike-confirmed). Waiting for FILE_GENERATED would add
 * avoidable staleness. STARTED is never persisted — the transcript is still
 * being written and a partial blob would be committed as if it were whole.
 */
export const GMEET_PERSISTABLE_TRANSCRIPT_STATES: readonly string[] = ["ENDED", "FILE_GENERATED"];

/** Structural surface of GmeetClient used by the engine — narrow enough that a
 *  unit test can hand-roll a mock without constructing the real class. */
export interface GmeetSyncClient {
  readonly delayMs: number;
  /** Pacing between conference records; abort-aware. */
  pace(opts?: GmeetCallOptions): Promise<void>;
  listConferenceRecords(
    windowStartIso: string,
    opts?: GmeetCallOptions,
  ): Promise<GmeetResult<GmeetConferenceRecord[]>>;
  listParticipants(
    recordName: string,
    opts?: GmeetCallOptions,
  ): Promise<GmeetResult<GmeetParticipant[]>>;
  listTranscripts(
    recordName: string,
    opts?: GmeetCallOptions,
  ): Promise<GmeetResult<GmeetTranscript[]>>;
  listTranscriptEntries(
    transcriptName: string,
    opts?: GmeetCallOptions,
  ): Promise<GmeetResult<GmeetTranscriptEntry[]>>;
  listDriveFiles?(opts?: GmeetCallOptions): Promise<GmeetResult<GoogleDriveFile[]>>;
  getDriveStartPageToken?(opts?: GmeetCallOptions): Promise<GmeetResult<string>>;
  listDriveChangesPage?(pageToken: string, opts?: GmeetCallOptions): Promise<GmeetResult<GoogleDriveChangesPage>>;
  getDriveDocument?(fileId: string, opts?: GmeetCallOptions): Promise<GmeetResult<GoogleDocsDocument>>;
}

/** Structural surface of connectorStore used by the engine. `import * as store
 *  from "./connectorStore"` satisfies this shape; tests pass a fake. Every method
 *  returns a StoreResult — the engine branches on `.ok` and never expects a throw
 *  across the boundary. */
export interface GmeetSyncStore {
  getConnection(
    tcw: TinyCloudWeb,
    connectorId: ConnectorId,
  ): Promise<StoreResult<ConnectorConnection | null>>;
  publishConnectorMeeting: typeof import("./connectorStore").publishConnectorMeeting;
  updateSyncState(tcw: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>>;
  countMeetings(tcw: TinyCloudWeb, source: string): Promise<StoreResult<number>>;
  getMeetingDatetimeStats?(tcw: TinyCloudWeb, source: string): Promise<StoreResult<MeetingDatetimeStats>>;
  getDriveCursor?(tcw: TinyCloudWeb, source: string): Promise<StoreResult<string | null>>;
  putDriveCursor?(tcw: TinyCloudWeb, source: string, cursor: string): Promise<StoreResult<void>>;
  findGmeetNotesAssociation?(tcw: TinyCloudWeb, source: string, fileId: string, title: string | null, startedAt: string | null, excludeSourceId?: string): Promise<StoreResult<GmeetNotesAssociation | null>>;
  removeGmeetNotes?(tcw: TinyCloudWeb, source: string, fileId: string): Promise<StoreResult<GmeetNotesRemovalOutcome | void>>;
}

export type GmeetSyncErrorKind = "auth" | "forbidden" | "rate-limited" | "network" | "storage";

export interface GmeetSyncError {
  kind: GmeetSyncErrorKind;
  message: string;
  /** Google's `error.status` when the failure came from the API. */
  googleStatus?: string | null;
  /** Only present when kind === "rate-limited". */
  retryAfterMs?: number;
}

/** Per-record outcome. `skipped` is a normal, expected state — a record whose
 *  transcript has not finished (or whose entries have not landed yet) is left
 *  alone for the next re-sweep, not recorded as a failure. */
export type GmeetItemOutcome = "created" | "updated" | "skipped" | "error";

export interface GmeetSyncItem {
  /** BARE conference record id (the `conferenceRecords/` prefix stripped). */
  sourceId: string;
  outcome: GmeetItemOutcome;
  /** Why it was skipped or how it failed. Never contains transcript text,
   *  meeting titles, participant names or token material. */
  reason?: string;
}

export interface GmeetSyncSummary {
  windowStartIso: string;
  /** Sync START time — also the watermark written on a completed run. */
  windowEndIso: string;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** True when the caller's signal aborted the run between items. */
  aborted: boolean;
  items: GmeetSyncItem[];
}

export type GmeetSyncResult =
  | { ok: true; data: GmeetSyncSummary }
  | { ok: false; error: GmeetSyncError; data: GmeetSyncSummary | null };

/** §4.2 progress vocabulary. Counters are cumulative and always present so a UI
 *  can render one row from any event. */
export interface GmeetSyncProgress {
  type: "status" | "progress" | "complete" | "error";
  current: number;
  total: number | null;
  synced: number;
  failed: number;
  skipped: number;
  /** Short, non-sensitive label ("listing", "syncing", an error message). */
  message?: string;
}

export interface GmeetSyncOptions {
  client: GmeetSyncClient;
  store: GmeetSyncStore;
  tcw: TinyCloudWeb;
  /** Drive defaults to cursor-based auto mode; snapshot forces one full listing. */
  driveMode?: "auto" | "snapshot";
  onProgress?: (progress: GmeetSyncProgress) => void;
  /** Local-development-only, count-only diagnostic seam. */
  onDiagnostics?: (diagnostics: GmeetSyncDiagnostics) => void;
  signal?: AbortSignal;
  /** Clock seam — tests pin the window arithmetic. Defaults to Date.now. */
  now?: () => number;
}

export interface GmeetSyncDiagnostics {
  drive_mode: "snapshot" | "incremental" | "stale_cursor_snapshot" | "unavailable";
  drive_diagnostics_complete: 0 | 1;
  drive_input_items: number;
  drive_terminal_items: number;
  drive_unprocessed_due_run_stop: number;
  drive_missing_id: number;
  drive_removed_or_trashed: number;
  drive_non_google_doc: number;
  drive_google_docs_discovered: number;
  drive_metadata_non_candidate: number;
  drive_metadata_candidate: number;
  drive_association_bypass: number;
  drive_unchanged_associated: number;
  drive_duplicate_identity: number;
  drive_docs_get_attempted: number;
  drive_docs_get_succeeded: number;
  drive_docs_get_failed_retryable: number;
  drive_docs_get_failed_terminal: number;
  drive_docs_get_aborted: number;
  drive_parser_rejected_no_marker: number;
  drive_parser_rejected_no_supported_section: number;
  drive_parser_accepted: number;
  drive_accepted_standalone_created: number;
  drive_accepted_standalone_updated: number;
  drive_accepted_attached: number;
  drive_accepted_migrated: number;
  drive_storage_failed: number;
  drive_post_parse_storage_failed: number;
  drive_cursor_committed: 0 | 1;
  meet_records_discovered: number;
  meet_records_processed: number;
  meet_rows_inserted: number;
  drive_rows_inserted: number;
  drive_rows_deleted: number;
  drive_attached_fields_cleared: number;
  persisted_item_count_before: number;
  persisted_item_count_after: number;
  meetings_page_rows_all_sources: number;
  explorer_google_meet_rows: number;
  datetime_dated_rows_before: number;
  datetime_dated_rows_after: number;
  datetime_source_meet: number;
  datetime_source_docs: number;
  datetime_source_drive_created_approx: number;
  datetime_source_unavailable: number;
  datetime_rows_backfilled: number;
  datetime_rows_unchanged: number;
  datetime_invalid_ambiguous: number;
  datetime_duplicates: number;
}

function emptyDiagnostics(): GmeetSyncDiagnostics {
  return {
    drive_mode: "unavailable", drive_diagnostics_complete: 0,
    drive_input_items: 0, drive_terminal_items: 0, drive_unprocessed_due_run_stop: 0,
    drive_missing_id: 0, drive_removed_or_trashed: 0, drive_non_google_doc: 0,
    drive_google_docs_discovered: 0, drive_metadata_non_candidate: 0,
    drive_metadata_candidate: 0, drive_association_bypass: 0, drive_unchanged_associated: 0, drive_duplicate_identity: 0,
    drive_docs_get_attempted: 0, drive_docs_get_succeeded: 0,
    drive_docs_get_failed_retryable: 0, drive_docs_get_failed_terminal: 0, drive_docs_get_aborted: 0,
    drive_parser_rejected_no_marker: 0, drive_parser_rejected_no_supported_section: 0,
    drive_parser_accepted: 0, drive_accepted_standalone_created: 0,
    drive_accepted_standalone_updated: 0, drive_accepted_attached: 0, drive_accepted_migrated: 0,
    drive_storage_failed: 0, drive_post_parse_storage_failed: 0, drive_cursor_committed: 0,
    meet_records_discovered: 0, meet_records_processed: 0, meet_rows_inserted: 0,
    drive_rows_inserted: 0, drive_rows_deleted: 0, drive_attached_fields_cleared: 0,
    persisted_item_count_before: 0, persisted_item_count_after: 0,
    meetings_page_rows_all_sources: 0, explorer_google_meet_rows: 0,
    datetime_dated_rows_before: 0, datetime_dated_rows_after: 0,
    datetime_source_meet: 0, datetime_source_docs: 0,
    datetime_source_drive_created_approx: 0, datetime_source_unavailable: 0,
    datetime_rows_backfilled: 0, datetime_rows_unchanged: 0,
    datetime_invalid_ambiguous: 0, datetime_duplicates: 0,
  };
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Window start (ms) for a run at `nowMs`, given the stored watermark.
 *
 *  - no watermark (first connect) ⇒ the full ≤30d backfill;
 *  - otherwise watermark − LAG_BUFFER, floored at the 30d horizon so the window
 *    can never exceed what the API still holds;
 *  - a watermark in the future (clock skew) can never push the start past now.
 */
export function gmeetSyncWindowStartMs(
  watermarkIso: string | null | undefined,
  nowMs: number,
): number {
  const horizonMs = nowMs - GMEET_MAX_BACKFILL_MS;
  const watermarkMs = parseIsoMs(watermarkIso);
  if (watermarkMs === null) return horizonMs;
  return Math.min(Math.max(watermarkMs - GMEET_LAG_BUFFER_MS, horizonMs), nowMs);
}

/** ISO form of {@link gmeetSyncWindowStartMs} — what the list filter is built from. */
export function gmeetSyncWindowStartIso(
  watermarkIso: string | null | undefined,
  nowMs: number,
): string {
  return isoAt(gmeetSyncWindowStartMs(watermarkIso, nowMs));
}

/** True when a transcript's entries may be persisted (ENDED or FILE_GENERATED). */
export function isPersistableTranscriptState(state: string | null | undefined): boolean {
  return typeof state === "string" && GMEET_PERSISTABLE_TRANSCRIPT_STATES.includes(state.trim());
}

/**
 * Terminal errors abort the whole run; everything else is contained to one
 * record. Same split as firefliesSync (:119-121): a dead or revoked grant will
 * not become good on the next record, and continuing after a rate-limit just
 * burns the remaining budget.
 */
export function isTerminalGmeetError(err: GmeetError): boolean {
  return err.kind === "auth-expired" || err.kind === "forbidden" || err.kind === "rate-limited";
}

/** Map a client error onto the engine's typed error. Google's message is
 *  preserved verbatim — it never carries token material. */
export function fromGmeetError(err: GmeetError): GmeetSyncError {
  switch (err.kind) {
    case "auth-expired":
      return { kind: "auth", message: err.message, googleStatus: err.googleStatus ?? null };
    case "forbidden":
      return { kind: "forbidden", message: err.message, googleStatus: err.googleStatus ?? null };
    case "rate-limited":
      return {
        kind: "rate-limited",
        message: err.message,
        googleStatus: err.googleStatus ?? null,
        retryAfterMs: err.retryAfterMs,
      };
    default:
      return { kind: "network", message: err.message, googleStatus: err.googleStatus ?? null };
  }
}

function fromStore(err: StoreError, context: string): GmeetSyncError {
  return { kind: "storage", message: `${context}: ${err.message}` };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Single-flight guard ─────────────────────────────────────────────────
//
// One module-level slot shared by the session-start hook and the manual
// "Sync now" button. Two concurrent runs over the same window would race on the
// same (source, source_id) publications. Native fencing protects cross-client
// concurrency. A second local call JOINS the run
// already in flight instead of starting one; it observes the same result, but
// only the first caller's onProgress is driven.

let inFlight: Promise<GmeetSyncResult> | null = null;

/** True while a run is in flight — lets the UI disable "Sync now" honestly. */
export function isGmeetSyncInFlight(): boolean {
  return inFlight !== null;
}

/** Test-only reset, mirroring `_resetConnectorSchemaMemoForTests`. */
export function _resetGmeetSyncSingleFlightForTests(): void {
  inFlight = null;
}

/**
 * Run one Google Meet sync. Single-flight: concurrent callers share one run.
 *
 * Flow (plan §4.2):
 *  1. read the watermark (getConnection) → window [max(wm − 72h, now − 30d), now];
 *  2. list conference records in the window (client paginates fully);
 *  3. per record, OLDEST-first: participants + transcripts → state gate →
 *     entries → normalize → KV blob → row;
 *  4. updateSyncState on the way out. The watermark advances to the run's START
 *     time only when the run COMPLETED (with or without per-item failures); a
 *     terminal error or an abort leaves the previous watermark alone so the next
 *     window still covers the records this run never reached.
 */
export function syncGoogleMeet(opts: GmeetSyncOptions): Promise<GmeetSyncResult> {
  if (inFlight) return inFlight;
  const run = runGoogleMeetSync(opts).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

type GmeetRunOptions = GmeetSyncOptions & { publicationAttempts: Set<string> };

async function runGoogleMeetSync(input: GmeetSyncOptions): Promise<GmeetSyncResult> {
  const opts: GmeetRunOptions = { ...input, publicationAttempts: new Set() };
  const { client, store, tcw, onProgress, onDiagnostics, signal } = opts;
  const nowMs = (opts.now ?? Date.now)();
  const startedAtIso = isoAt(nowMs);

  const items: GmeetSyncItem[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let current = 0;
  let total: number | null = null;
  let aborted = false;
  let terminal: GmeetSyncError | null = null;
  let reconnectRequired = false;
  const diagnostics = emptyDiagnostics();

  const readDatetimeStats = async (): Promise<MeetingDatetimeStats> => {
    if (store.getMeetingDatetimeStats) {
      const result = await store.getMeetingDatetimeStats(tcw, SOURCE);
      if (result.ok) return result.data;
    }
    const rows = await listMeetings(tcw, [SOURCE]);
    const dated = rows.filter((row) => row.startedAt !== null && Number.isFinite(Date.parse(row.startedAt))).length;
    const seen = new Set<string>();
    let duplicates = 0;
    for (const row of rows) {
      if (seen.has(row.sourceId)) duplicates++;
      else seen.add(row.sourceId);
    }
    return {
      rows: rows.length, dated, sourceMeet: 0, sourceDocs: 0,
      sourceDriveCreatedApprox: 0, sourceUnavailable: rows.length,
      invalidAmbiguous: rows.filter((row) => row.startedAt !== null && !Number.isFinite(Date.parse(row.startedAt))).length,
      duplicates,
    };
  };

  const emitDiagnostics = async () => {
    if (!onDiagnostics) return;
    const allRows = await listMeetings(tcw);
    const googleRows = await listMeetings(tcw, [SOURCE]);
    diagnostics.meetings_page_rows_all_sources = allRows.length;
    diagnostics.explorer_google_meet_rows = googleRows.length;
    const datetime = await readDatetimeStats();
    diagnostics.datetime_dated_rows_after = datetime.dated;
    diagnostics.datetime_source_meet = datetime.sourceMeet;
    diagnostics.datetime_source_docs = datetime.sourceDocs;
    diagnostics.datetime_source_drive_created_approx = datetime.sourceDriveCreatedApprox;
    diagnostics.datetime_source_unavailable = datetime.sourceUnavailable;
    diagnostics.datetime_invalid_ambiguous = datetime.invalidAmbiguous;
    diagnostics.datetime_duplicates = datetime.duplicates;
    onDiagnostics({ ...diagnostics });
  };

  const emit = (type: GmeetSyncProgress["type"], message?: string) => {
    onProgress?.({ type, current, total, synced: created + updated, failed, skipped, message });
  };

  const record = (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => {
    items.push(reason === undefined ? { sourceId, outcome } : { sourceId, outcome, reason });
    if (outcome === "created") created++;
    else if (outcome === "updated") updated++;
    else if (outcome === "skipped") skipped++;
    else failed++;
  };

  emit("status", "listing");

  // Watermark. A store that cannot even be read has nothing to write back to —
  // return before touching updateSyncState (same call as firefliesSync's
  // ensureSchema bail).
  const connRes = await store.getConnection(tcw, SOURCE);
  if (!connRes.ok) {
    const error = fromStore(connRes.error, "getConnection");
    onProgress?.({ type: "error", current: 0, total: null, synced: 0, failed: 0, skipped: 0, message: error.message });
    await emitDiagnostics();
    return { ok: false, error, data: null };
  }
  const watermarkIso = connRes.data?.lastSyncedAt ?? null;
  const windowStartIso = gmeetSyncWindowStartIso(watermarkIso, nowMs);
  if (onDiagnostics) {
    const before = await store.countMeetings(tcw, SOURCE);
    diagnostics.persisted_item_count_before = before.ok ? before.data : (connRes.data?.itemCount ?? 0);
    diagnostics.datetime_dated_rows_before = (await readDatetimeStats()).dated;
  }

  const summary = (): GmeetSyncSummary => ({
    windowStartIso,
    windowEndIso: startedAtIso,
    total: total ?? 0,
    created,
    updated,
    skipped,
    failed,
    aborted,
    items,
  });

  try {
    const listRes = await client.listConferenceRecords(windowStartIso, { signal });
    if (!listRes.ok) {
      if (listRes.error.kind === "aborted") aborted = true;
      else terminal = fromGmeetError(listRes.error);
    } else {
      // Google returns records NEWEST-first; walk them oldest-first so an abort
      // leaves a contiguous synced tail rather than a hole in the middle.
      const discovered = new Map(listRes.data.map((item) => [item.name, item]));
      const records = [...discovered.values()].reverse();
      total = records.length;
      diagnostics.meet_records_discovered = records.length;
      emit("progress", "syncing");

      for (let i = 0; i < records.length; i++) {
        // Abort BETWEEN items only — never between the blob and the row.
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        if (i > 0) {
          await client.pace({ signal });
          if (signal?.aborted) {
            aborted = true;
            break;
          }
        }

        const outcome = await syncOneRecord(records[i]!, opts);
        if (!outcome.aborted) diagnostics.meet_records_processed++;
        if (outcome.rowInserted) diagnostics.meet_rows_inserted++;
        if (outcome.driveRowDeleted) diagnostics.drive_rows_deleted++;
        if (outcome.terminal) {
          // Recorded BEFORE the break: the summary rides out alongside the
          // error, and a summary whose `items` omits the record the run died on
          // under-reports the failure count by exactly one.
          record(outcome.sourceId, "error", outcome.reason ?? outcome.terminal.message);
          terminal = outcome.terminal;
          break;
        }
        if (outcome.aborted) {
          aborted = true;
          break;
        }
        current++;
        record(outcome.sourceId, outcome.outcome, outcome.reason);
        emit("progress");
      }
    }
    if (terminal === null && !aborted) {
      const drive = await syncDriveNotes(opts, record, diagnostics);
      if (drive.terminal) terminal = drive.terminal;
      if (drive.aborted) aborted = true;
      if (drive.reconnectRequired) reconnectRequired = true;
    }
  } catch (err) {
    // Nothing in the loop is expected to throw (every seam is Result-shaped);
    // an unexpected one is surfaced rather than swallowed.
    terminal = { kind: "storage", message: errorMessage(err) };
  }

  // Final state write — reached by every path that got past getConnection.
  // countMeetings is best-effort so a broken read cannot mask the real error.
  const countRes = await store.countMeetings(tcw, SOURCE);
  const itemCount = countRes.ok ? countRes.data : (connRes.data?.itemCount ?? 0);
  diagnostics.persisted_item_count_after = itemCount;

  // The watermark advances ONLY on a completed run. Advancing it after a
  // terminal error or an abort would silently narrow the next window past
  // records this run never looked at.
  const completed = terminal === null && !aborted;
  const updateRes = await store.updateSyncState(tcw, {
    connectorId: SOURCE,
    status: "connected",
    lastSyncedAt: completed ? startedAtIso : watermarkIso,
    lastSyncStatus: terminal ? "error" : reconnectRequired ? "partial" : "ok",
    lastSyncError: terminal?.message ?? (reconnectRequired ? "Reconnect Google Meet to sync Notes by Gemini" : null),
    itemCount,
  });
  if (!updateRes.ok && !terminal) {
    terminal = fromStore(updateRes.error, "updateSyncState");
  }

  if (terminal) {
    onProgress?.({
      type: "error",
      current,
      total,
      synced: created + updated,
      failed,
      skipped,
      message: terminal.message,
    });
    await emitDiagnostics();
    return { ok: false, error: terminal, data: summary() };
  }
  emit("complete");
  await emitDiagnostics();
  return { ok: true, data: summary() };
}

/** A narrow metadata gate. Non-candidates must never reach Docs documents.get. */
export function isLikelyGmeetNotesFile(file: GoogleDriveFile): boolean {
  if (file.mimeType !== "application/vnd.google-apps.document" || file.trashed || !file.id?.trim()) return false;
  const marker = [file.name, file.description, ...Object.values(file.appProperties ?? {})]
    .filter((value): value is string => typeof value === "string")
    .join(" ").toLocaleLowerCase();
  return /\bnotes by gemini\b/.test(marker);
}

interface DriveOutcome { terminal?: GmeetSyncError; aborted?: boolean; reconnectRequired?: boolean }

type DriveTerminalCounter =
  | "drive_unprocessed_due_run_stop" | "drive_missing_id" | "drive_removed_or_trashed"
  | "drive_non_google_doc" | "drive_metadata_non_candidate" | "drive_unchanged_associated" | "drive_duplicate_identity"
  | "drive_docs_get_failed_retryable" | "drive_docs_get_failed_terminal" | "drive_docs_get_aborted"
  | "drive_parser_rejected_no_marker" | "drive_parser_rejected_no_supported_section"
  | "drive_accepted_standalone_created" | "drive_accepted_standalone_updated"
  | "drive_accepted_attached" | "drive_accepted_migrated" | "drive_storage_failed";

function terminalDriveItem(diagnostics: GmeetSyncDiagnostics, counter: DriveTerminalCounter, amount = 1): void {
  diagnostics[counter] += amount;
  diagnostics.drive_terminal_items += amount;
}

function recordRemovalMutation(diagnostics: GmeetSyncDiagnostics, outcome: GmeetNotesRemovalOutcome | void): void {
  if (outcome === "deleted") diagnostics.drive_rows_deleted++;
  if (outcome === "cleared") diagnostics.drive_attached_fields_cleared++;
}

async function syncDriveNotes(
  opts: GmeetRunOptions,
  record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void,
  diagnostics: GmeetSyncDiagnostics,
): Promise<DriveOutcome> {
  const { client, store, tcw, signal } = opts;
  // Optional methods preserve compatibility with deliberately narrow external test clients.
  if (!client.listDriveFiles || !client.getDriveStartPageToken || !client.listDriveChangesPage || !client.getDriveDocument
    || !store.getDriveCursor || !store.putDriveCursor || !store.findGmeetNotesAssociation || !store.removeGmeetNotes) return {};

  const cursor = await store.getDriveCursor(tcw, SOURCE);
  if (!cursor.ok) return { terminal: fromStore(cursor.error, "getDriveCursor") };
  if (signal?.aborted) return { aborted: true };
  if (opts.driveMode === "snapshot") return snapshotDriveNotes(opts, record, diagnostics, "snapshot");
  if (cursor.data === null) return snapshotDriveNotes(opts, record, diagnostics, "snapshot");

  diagnostics.drive_mode = "incremental";
  let pageToken = cursor.data;
  let finalCursor: string | null;
  let anyFailure = false;
  while (true) {
    const page = await client.listDriveChangesPage(pageToken, { signal });
    if (!page.ok) {
      if (page.error.kind === "aborted") return { aborted: true };
      // A stale Drive token is explicitly recovered with a fresh guarded snapshot.
      if (page.error.kind === "not-found" || page.error.status === 410) {
        return snapshotDriveNotes(opts, record, diagnostics, "stale_cursor_snapshot");
      }
      if (page.error.kind === "forbidden") return { reconnectRequired: true };
      return { terminal: fromGmeetError(page.error) };
    }
    let pageFailed = false;
    diagnostics.drive_input_items += page.data.changes.length;
    for (let index = 0; index < page.data.changes.length; index++) {
      const outcome = await syncDriveChange(page.data.changes[index]!, opts, record, diagnostics);
      if (outcome.aborted || outcome.terminal) {
        terminalDriveItem(diagnostics, "drive_unprocessed_due_run_stop", page.data.changes.length - index - 1);
        diagnostics.drive_diagnostics_complete = page.data.nextPageToken ? 0 : 1;
        return outcome;
      }
      if (outcome.failed) pageFailed = true;
    }
    // Never advance beyond a page that contained a failed candidate: replay is
    // intentional and id+modifiedTime provenance makes it safe.
    anyFailure ||= pageFailed;
    if (page.data.nextPageToken) {
      pageToken = page.data.nextPageToken;
      continue;
    }
    finalCursor = page.data.newStartPageToken;
    diagnostics.drive_diagnostics_complete = 1;
    break;
  }
  if (anyFailure) return {};
  if (!finalCursor) return { terminal: { kind: "network", message: "Google Drive changes page had no new start token" } };
  const write = await store.putDriveCursor(tcw, SOURCE, finalCursor);
  if (write.ok) diagnostics.drive_cursor_committed = 1;
  return write.ok ? {} : { terminal: fromStore(write.error, "putDriveCursor") };
}

async function snapshotDriveNotes(
  opts: GmeetRunOptions,
  record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void,
  diagnostics: GmeetSyncDiagnostics,
  mode: "snapshot" | "stale_cursor_snapshot",
): Promise<DriveOutcome> {
  const { client, store, tcw, signal } = opts;
  diagnostics.drive_mode = mode;
  if (!client.getDriveStartPageToken || !client.listDriveFiles || !store.putDriveCursor) return {};
  const start = await client.getDriveStartPageToken({ signal });
  if (!start.ok) {
    if (start.error.kind === "aborted") return { aborted: true };
    // Refresh tokens granted before Notes support have only the Meet scopes.
    // Keep their established Meet sync working; reconnecting renews the grant
    // with the Docs scopes and lets a later run take this first snapshot.
    if (start.error.kind === "forbidden") {
      return { reconnectRequired: true };
    }
    return { terminal: fromGmeetError(start.error) };
  }
  const files = await client.listDriveFiles({ signal });
  if (!files.ok) {
    if (files.error.kind === "aborted") return { aborted: true };
    if (files.error.kind === "forbidden") return { reconnectRequired: true };
    return { terminal: fromGmeetError(files.error) };
  }
  diagnostics.drive_diagnostics_complete = 1;
  diagnostics.drive_input_items += files.data.length;
  let failed = false;
  for (let index = 0; index < files.data.length; index++) {
    const outcome = await syncDriveFile(files.data[index]!, opts, record, diagnostics);
    if (outcome.aborted || outcome.terminal) {
      terminalDriveItem(diagnostics, "drive_unprocessed_due_run_stop", files.data.length - index - 1);
      return outcome;
    }
    if (outcome.failed) failed = true;
  }
  if (failed) return {};
  const write = await store.putDriveCursor(tcw, SOURCE, start.data);
  if (write.ok) diagnostics.drive_cursor_committed = 1;
  return write.ok ? {} : { terminal: fromStore(write.error, "putDriveCursor") };
}

async function syncDriveChange(change: GoogleDriveChange, opts: GmeetRunOptions, record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void, diagnostics: GmeetSyncDiagnostics): Promise<DriveOutcome & { failed?: boolean }> {
  const fileId = change.fileId ?? change.file?.id;
  if (!fileId) { terminalDriveItem(diagnostics, "drive_missing_id"); return { failed: true }; }
  if (change.removed || change.file?.trashed) {
    const removed = await opts.store.removeGmeetNotes!(opts.tcw, SOURCE, fileId);
    if (!removed.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); record(fileId, "error", fromStore(removed.error, "removeGmeetNotes").message); return { failed: true }; }
    recordRemovalMutation(diagnostics, removed.data);
    terminalDriveItem(diagnostics, "drive_removed_or_trashed");
    record(fileId, "updated");
    return {};
  }
  return syncDriveFile(change.file ?? { id: fileId }, opts, record, diagnostics);
}

async function syncDriveFile(file: GoogleDriveFile, opts: GmeetRunOptions, record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void, diagnostics: GmeetSyncDiagnostics): Promise<DriveOutcome & { failed?: boolean }> {
  const fileId = file.id?.trim();
  if (!fileId) { terminalDriveItem(diagnostics, "drive_missing_id"); return { failed: true }; }
  if (file.trashed) return syncDriveChange({ fileId, removed: true }, opts, record, diagnostics);
  if (file.mimeType !== "application/vnd.google-apps.document") { terminalDriveItem(diagnostics, "drive_non_google_doc"); return {}; }
  diagnostics.drive_google_docs_discovered++;
  const likelyNotes = isLikelyGmeetNotesFile(file);
  if (likelyNotes) diagnostics.drive_metadata_candidate++;
  const association = await opts.store.findGmeetNotesAssociation!(opts.tcw, SOURCE, fileId, null, null);
  if (!association.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); record(fileId, "error", association.error.message); return { failed: true }; }
  if (!likelyNotes && association.data === null) { terminalDriveItem(diagnostics, "drive_metadata_non_candidate"); return {}; }
  if (!likelyNotes) diagnostics.drive_association_bypass++;
  if (opts.publicationAttempts.has(fileId)) {
    terminalDriveItem(diagnostics, "drive_duplicate_identity");
    record(fileId, "skipped", "publication already attempted in this sync");
    return {};
  }
  opts.publicationAttempts.add(fileId);
  let providerError: GmeetError | undefined;
  let rejected: "no-marker" | "no-supported-section" | undefined;
  let dateBackfilled = false;
  let dateUnchanged = false;
  const published = await opts.store.publishConnectorMeeting(opts.tcw, { source: SOURCE, sourceId: fileId }, async () => {
    diagnostics.drive_docs_get_attempted++;
    const doc = await opts.client.getDriveDocument!(fileId, { signal: opts.signal });
    if (!doc.ok) { providerError = doc.error; throw new Error(doc.error.message); }
    diagnostics.drive_docs_get_succeeded++;
    const parsed = diagnoseGmeetNotesDocument(doc.data, { fileId, createdTime: file.createdTime ?? null,
      modifiedTime: file.modifiedTime ?? null, verifiedCandidate: likelyNotes });
    if (!parsed.ok) { rejected = parsed.reason; throw new Error(`Notes document ${parsed.reason}`); }
    diagnostics.drive_parser_accepted++;
    dateBackfilled = association.data?.sourceId === fileId && association.data.startedAt === null && parsed.data.meeting.startedAt !== null;
    dateUnchanged = association.data?.sourceId === fileId && association.data.startedAt === parsed.data.meeting.startedAt;
    const linkedSourceId = association.data?.linkedMeetingSourceId;
    const meeting = { ...parsed.data.meeting, metadata: { ...parsed.data.meeting.metadata,
      notes_association: "standalone", verified_meeting_link: linkedSourceId
        ? { source: SOURCE, sourceId: linkedSourceId, via: "docs_export_uri" } : null } };
    return { meeting, sentences: parsed.data.sentences, body: { basis: "notes", schema: "google-docs",
      raw: JSON.stringify(doc.data), originalExtent: "known" } };
  }, opts.signal);
  if (!published.ok) {
    if (providerError?.kind === "aborted") { terminalDriveItem(diagnostics, "drive_docs_get_aborted"); return { aborted: true }; }
    if (providerError && isTerminalGmeetError(providerError)) {
      terminalDriveItem(diagnostics, "drive_docs_get_failed_terminal");
      record(fileId, "error", providerError.message); return { terminal: fromGmeetError(providerError) };
    }
    if (rejected) {
      if (association.data?.sourceId === fileId) {
        const removed = await opts.store.removeGmeetNotes!(opts.tcw, SOURCE, fileId);
        if (!removed.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); record(fileId, "error", removed.error.message); return { failed: true }; }
        recordRemovalMutation(diagnostics, removed.data);
      }
      terminalDriveItem(diagnostics, rejected === "no-marker" ? "drive_parser_rejected_no_marker" : "drive_parser_rejected_no_supported_section");
      record(fileId, "skipped", "document is not a supported Notes artifact"); return {};
    }
    terminalDriveItem(diagnostics, providerError ? "drive_docs_get_failed_retryable" : "drive_storage_failed");
    record(fileId, "error", providerError?.message ?? published.error.message); return { failed: true };
  }
  terminalDriveItem(diagnostics, published.data.inserted ? "drive_accepted_standalone_created" : "drive_accepted_standalone_updated");
  if (published.data.inserted) diagnostics.drive_rows_inserted++;
  if (dateBackfilled) diagnostics.datetime_rows_backfilled++;
  else if (dateUnchanged) diagnostics.datetime_rows_unchanged++;
  record(fileId, published.data.inserted ? "created" : "updated");
  return {};
}

interface RecordOutcome {
  sourceId: string;
  outcome: GmeetItemOutcome;
  reason?: string;
  /** Set when the whole run must stop. */
  terminal?: GmeetSyncError;
  aborted?: boolean;
  rowInserted?: boolean;
  driveRowDeleted?: boolean;
}

/**
 * Sync ONE conference record — the unit of this engine.
 *
 * Keyed on the conference record, never on the space: a space maps 1:many to
 * records (8 of 13 records in the spike shared a single standing room), so a
 * space-keyed store would collapse a month of standups into one row.
 */
async function syncOneRecord(
  conferenceRecord: GmeetConferenceRecord,
  opts: GmeetRunOptions,
): Promise<RecordOutcome> {
  const { client, store, tcw, signal } = opts;
  const recordName = conferenceRecord.name;
  const sourceId = recordName.replace(/^\/*conferenceRecords\//, "");
  if (opts.publicationAttempts.has(sourceId)) return { sourceId, outcome: "skipped", reason: "publication already attempted in this sync" };
  opts.publicationAttempts.add(sourceId);
  let failure: RecordOutcome | undefined;
  const published = await store.publishConnectorMeeting(tcw, { source: SOURCE, sourceId }, async () => {
    const participants = await client.listParticipants(recordName, { signal });
    if (!participants.ok) { failure = classifyRecordFailure(sourceId, participants.error); throw new Error(participants.error.message); }
    const transcripts = await client.listTranscripts(recordName, { signal });
    if (!transcripts.ok) { failure = classifyRecordFailure(sourceId, transcripts.error); throw new Error(transcripts.error.message); }
    const persistable = transcripts.data.filter((t) => isPersistableTranscriptState(t.state));
    if (persistable.length === 0) {
      failure = { sourceId, outcome: "skipped", reason: "transcript not finished or unavailable" };
      throw new Error(failure.reason);
    }
    const bundles: GmeetTranscriptBundle[] = [];
    for (const transcript of persistable) {
      const entries = await client.listTranscriptEntries(transcript.name, { signal });
      if (!entries.ok) { failure = classifyRecordFailure(sourceId, entries.error); throw new Error(entries.error.message); }
      bundles.push({ transcript, entries: entries.data });
    }
    const entries = bundles.flatMap((bundle) => bundle.entries ?? []);
    if (entries.length === 0) {
      failure = { sourceId, outcome: "skipped", reason: "transcript entries not available yet" };
      throw new Error(failure.reason);
    }
    const normalized = normalizeGoogleMeetTranscript({ record: conferenceRecord, participants: participants.data, transcripts: bundles });
    if (normalized.sentences.length === 0) {
      failure = { sourceId, outcome: "skipped", reason: "transcript entries have no text" };
      throw new Error(failure.reason);
    }
    normalized.meeting.metadata = { ...normalized.meeting.metadata,
      datetime_source: normalized.meeting.startedAt === null ? "unavailable" : "meet_conference_start",
      datetime_exact: normalized.meeting.startedAt !== null,
      datetime_resolution_version: GMEET_DATETIME_RESOLUTION_VERSION,
      participantNamesByResource: Object.fromEntries(participants.data.map((participant) => [participant.name,
        participant.signedinUser?.displayName ?? participant.anonymousUser?.displayName ?? participant.phoneUser?.displayName ?? "Unknown"])),
    };
    return { ...normalized, body: { basis: "transcript", schema: "json-records", raw: JSON.stringify(entries), originalExtent: "known" } };
  }, signal);
  if (!published.ok) return failure ?? { sourceId, outcome: "error", reason: published.error.message };
  return { sourceId, outcome: published.data.inserted ? "created" : "updated", rowInserted: published.data.inserted, driveRowDeleted: false };
}

function classifyRecordFailure(sourceId: string, err: GmeetError): RecordOutcome {
  if (err.kind === "aborted") return { sourceId, outcome: "skipped", aborted: true };
  if (isTerminalGmeetError(err)) {
    return { sourceId, outcome: "error", terminal: fromGmeetError(err) };
  }
  // Everything else — a 404 for a record that expired mid-run, a transport
  // blip, a malformed page — is contained to this record. One bad meeting never
  // kills the batch.
  return { sourceId, outcome: "error", reason: err.message };
}
