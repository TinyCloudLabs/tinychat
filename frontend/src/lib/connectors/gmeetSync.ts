// Google Meet sync engine — time-window cursor (plan §4.2, refinement R1).
//
// Sibling of firefliesSync.ts (same injected-seams shape, same terminal-vs-item
// error split at :119-121) but a DIFFERENT design: Fireflies lists newest-first
// and stops at the first known id; Meet cannot do that. A conference record's
// transcript artifact materializes MINUTES after the meeting ends, so a
// stop-at-first-known-id scan would walk straight past a record it already has a
// row for and never come back for the transcript that showed up afterwards.
// Instead the engine re-sweeps a time window on every run and lets upsertMeeting
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
  GmeetNotesIndex,
  GmeetDriveProgress,
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
import { listMeetingsRead } from "./meetingExplorer";
import {
  createGmeetSyncLogRecorder,
  summarizeGmeetSyncResult,
  type GmeetSyncLog,
  type GmeetSyncLogRecorder,
} from "./gmeetSyncLog";
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
 * window is a few re-listed records that upsertMeeting dedups anyway.
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
  putTranscriptBody(
    tcw: TinyCloudWeb,
    source: string,
    sourceId: string,
    sentences: FirefliesSentence[],
  ): Promise<StoreResult<void>>;
  upsertMeeting(
    tcw: TinyCloudWeb,
    meeting: NormalizedMeeting,
    sentences: FirefliesSentence[],
  ): Promise<StoreResult<UpsertMeetingOutcome>>;
  updateSyncState(tcw: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>>;
  countMeetings(tcw: TinyCloudWeb, source: string): Promise<StoreResult<number>>;
  getMeetingDatetimeStats?(tcw: TinyCloudWeb, source: string): Promise<StoreResult<MeetingDatetimeStats>>;
  getDriveCursor?(tcw: TinyCloudWeb, source: string): Promise<StoreResult<string | null>>;
  putDriveCursor?(tcw: TinyCloudWeb, source: string, cursor: string): Promise<StoreResult<void>>;
  findGmeetNotesAssociation?(tcw: TinyCloudWeb, source: string, fileId: string, title: string | null, startedAt: string | null, excludeSourceId?: string): Promise<StoreResult<GmeetNotesAssociation | null>>;
  attachGmeetNotes?(tcw: TinyCloudWeb, row: Pick<GmeetNotesAssociation, "id" | "sourceId" | "title" | "startedAt" | "metadata">, notes: Pick<NormalizedMeeting, "startedAt" | "summaryOverview" | "summaryActionItems" | "metadata">): Promise<StoreResult<void>>;
  /** One read of every row for in-memory association matching (replaces a LIKE scan per Doc). */
  loadGmeetNotesIndex?(tcw: TinyCloudWeb, source: string): Promise<StoreResult<GmeetNotesIndex>>;
  /** Resumable snapshot checkpoint; `null` clears it. */
  getDriveProgress?(tcw: TinyCloudWeb, source: string): Promise<StoreResult<GmeetDriveProgress | null>>;
  putDriveProgress?(tcw: TinyCloudWeb, source: string, progress: GmeetDriveProgress | null): Promise<StoreResult<void>>;
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
  /** True when Notes by Gemini are still reconciling in the background (`deferNotes`). */
  notesDeferred?: boolean;
  items: GmeetSyncItem[];
}

export type GmeetSyncResult =
  | { ok: true; data: GmeetSyncSummary }
  | {
    ok: false;
    error: GmeetSyncError;
    data: GmeetSyncSummary | null;
    /** False when Finishing ended without a connector_state row marking the connection saved. */
    connectionSaved?: boolean;
  };

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
  /**
   * Finishing sub-step: `meetings` = Meet records checked, `notes-listing` =
   * reading the Drive listing, `notes` = reconciling Notes, `saving` = count +
   * sync-state write.
   */
  stage?: "meetings" | "notes-listing" | "notes" | "saving";
  /** Notes candidates reconciled so far / in total (known after the Drive listing). */
  notesDone?: number;
  notesTotal?: number;
  /** Google Docs seen in the Drive listing, and how many are Notes candidates. */
  docsListed?: number;
  docsMatched?: number;
  /** The Notes reconcile is continuing a checkpoint an earlier run (often an earlier page load) left. */
  resumed?: boolean;
}

/** Notes saved out of the Notes the run had to reconcile; the rest stay for the next run. Counts only. */
export interface GmeetNotesPartial {
  saved: number;
  total: number;
}

export function gmeetNotesPartialMessage(partial: GmeetNotesPartial): string {
  return `${partial.saved} of ${partial.total} Notes saved. Sync now or Full rescan finishes the rest.`;
}

/** Final outcome of a deferred Notes reconcile. Counts and error kinds only. */
export interface GmeetNotesSettled {
  ok: boolean;
  /** Error kind only: messages can carry store text, so they stay in the row. */
  errorKind: GmeetSyncErrorKind | null;
  /** Set when some Notes could not be saved: the run finished and the rest are stored. */
  partial?: GmeetNotesPartial | null;
  diagnostics: GmeetSyncDiagnostics;
}

export interface GmeetSyncOptions {
  client: GmeetSyncClient;
  store: GmeetSyncStore;
  tcw: TinyCloudWeb;
  /** Drive defaults to cursor-based auto mode; snapshot forces one full listing. */
  driveMode?: "auto" | "snapshot";
  /**
   * Save the connection as soon as the Meet records are checked, return, and
   * reconcile Notes by Gemini in the background (bounded, parallel Docs reads,
   * checkpointed). The result's `data.notesDeferred` is then true; the outcome
   * arrives through `onGmeetNotesSettled`. Not abortable by `signal` after return.
   */
  deferNotes?: boolean;
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
  /** Wall time per Finishing phase (Drive vs node SQL), in ms. Count-only. */
  phase_drive_ms: number;
  phase_count_ms: number;
  phase_diagnostics_ms: number;
  phase_state_write_ms: number;
  finishing_timed_out: 0 | 1;
  /** Phase that was running when a Finishing deadline fired. */
  finishing_stalled_phase: "none" | "drive" | "count" | "diagnostics" | "state_write";
  finishing_recovery_write: "none" | "written" | "failed" | "skipped_pending_storage" | "timed_out";
  /** Drive Notes reconcile cost split: node storage calls vs Google HTTP calls. Counts and ms only. */
  drive_sql_calls: number;
  drive_sql_ms: number;
  drive_http_calls: number;
  drive_http_ms: number;
  /** Rows read once for in-memory association matching, and files skipped without any storage call. */
  drive_assoc_preloaded_rows: number;
  drive_prefilter_skipped: number;
  /** Docs that needed reconcile work (Notes candidates, associated docs, trashed). */
  drive_candidates: number;
  /** Candidates skipped because a checkpoint already covered them; checkpoints written. */
  drive_resumed_skipped: number;
  drive_checkpoint_writes: number;
  /** Individual Drive/Docs/storage calls abandoned by their per-call timeout. */
  drive_call_timeouts: number;
  /** Retries of one Note's storage call after a transient node error; Notes left unsaved this run. */
  drive_storage_retries: number;
  drive_items_failed: number;
}

function emptyDiagnostics(): GmeetSyncDiagnostics {
  return {
    drive_mode: "unavailable", drive_diagnostics_complete: 0,
    drive_input_items: 0, drive_terminal_items: 0, drive_unprocessed_due_run_stop: 0,
    drive_missing_id: 0, drive_removed_or_trashed: 0, drive_non_google_doc: 0,
    drive_google_docs_discovered: 0, drive_metadata_non_candidate: 0,
    drive_metadata_candidate: 0, drive_association_bypass: 0, drive_unchanged_associated: 0,
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
    phase_drive_ms: 0, phase_count_ms: 0, phase_diagnostics_ms: 0, phase_state_write_ms: 0,
    finishing_timed_out: 0, finishing_stalled_phase: "none", finishing_recovery_write: "none",
    drive_sql_calls: 0, drive_sql_ms: 0, drive_http_calls: 0, drive_http_ms: 0,
    drive_assoc_preloaded_rows: 0, drive_prefilter_skipped: 0, drive_candidates: 0,
    drive_resumed_skipped: 0, drive_checkpoint_writes: 0, drive_call_timeouts: 0,
    drive_storage_retries: 0, drive_items_failed: 0,
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
// same (source, source_id) upserts — and there is no DB uniqueness constraint to
// save us (the TinyCloud authorizer forbids UNIQUE). A second call JOINS the run
// already in flight instead of starting one; it observes the same result, but
// only the first caller's onProgress is driven.

let inFlight: Promise<GmeetSyncResult> | null = null;

// A deferred Notes reconcile runs after syncGoogleMeet has returned. It is the
// only storage writer for its space until it settles, so a new run waits for it.
let notesInFlight: Promise<void> | null = null;
const notesSettledListeners = new Set<(settled: GmeetNotesSettled) => void>();

/** True while a deferred Notes reconcile is still running. */
export function isGmeetNotesSyncInFlight(): boolean {
  return notesInFlight !== null;
}

let notesStop: AbortController | null = null;
// True while the foreground run of a `deferNotes` sync has not yet handed off to the background.
let foregroundDeferred = false;

/**
 * Stop a running deferred Notes reconcile and wait until it has written nothing
 * more. A disconnect calls this first: the reconcile's final write would
 * otherwise recreate the connection row it just removed.
 */
export async function stopGmeetNotesSync(): Promise<void> {
  // A deferred foreground run hands off to the background as it returns: wait for that
  // hand-off, or the reconcile would start after the caller's teardown.
  const foreground = inFlight;
  if (foreground !== null && foregroundDeferred) await foreground.catch(() => {});
  const running = notesInFlight;
  if (running === null) return;
  notesStop?.abort();
  await running;
}

/**
 * Sign-out or an account change: stop the run in flight if it belongs to this account. The Notes
 * reconcile outlives a closed dialog or an unmounted card, but never its account's session.
 */
export async function stopGmeetSyncForAccount(tcw: TinyCloudWeb): Promise<void> {
  const did = tcw.did;
  if (!did || activeDid !== did) return;
  await stopGmeetNotesSync();
}

/** Subscribe to deferred-Notes outcomes (the card re-reads its row on each). */
export function onGmeetNotesSettled(listener: (settled: GmeetNotesSettled) => void): () => void {
  notesSettledListeners.add(listener);
  return () => { notesSettledListeners.delete(listener); };
}

/** Refusal text while a deferred Notes reconcile still holds the storage writer. */
export const GMEET_NOTES_BUSY_MESSAGE = "Google Meet notes are still syncing in the background. Saved meetings are kept. Retry shortly.";

// ── Live status and last-run log ───────────────────────────────────────
//
// The card did not start a session-start or dialog run, yet has to show it. Both
// views carry counters, step names and error kinds only.

/** What the engine is doing right now, for a surface that did not start the run. */
export interface GmeetLiveStatus {
  running: boolean;
  /** Latest progress of the run in flight (Meet records in the foreground, Notes in the background). */
  progress: GmeetSyncProgress | null;
  /** The Notes reconcile continues a checkpoint written by an earlier run. */
  resumed: boolean;
}

const IDLE_LIVE: GmeetLiveStatus = { running: false, progress: null, resumed: false };
let liveStatus: GmeetLiveStatus = IDLE_LIVE;
/** DID of the account whose run is in flight; null when idle. */
let activeDid: string | null = null;
const liveListeners = new Set<() => void>();

/**
 * Snapshot for `useSyncExternalStore`: the same object until something changes. Keyed by account:
 * a run belongs to the DID of the `tcw` that started it, and any other account sees nothing of it.
 */
export function getGmeetLiveStatus(tcw: TinyCloudWeb | null): GmeetLiveStatus {
  const did = tcw?.did;
  return did && did === activeDid ? liveStatus : IDLE_LIVE;
}

export function onGmeetLiveStatus(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => { liveListeners.delete(listener); };
}

function publishLive(next: { progress?: GmeetSyncProgress | null; resumed?: boolean } = {}): void {
  if (inFlight === null && notesInFlight === null) {
    livePending = null;
    clearTimeout(liveTimer);
    liveTimer = undefined;
    liveStage = "none";
    activeDid = null;
    if (liveStatus === IDLE_LIVE) return;
    liveStatus = IDLE_LIVE;
  } else {
    liveStatus = {
      running: true,
      progress: next.progress === undefined ? liveStatus.progress : next.progress,
      resumed: next.resumed ?? liveStatus.resumed,
    };
  }
  for (const listener of liveListeners) guarded(listener);
}

/** A run's log, offered to a persister: `final` once nothing more will be recorded for it. */
export interface GmeetRunLogEvent {
  tcw: TinyCloudWeb;
  recorder: GmeetSyncLogRecorder;
  final: boolean;
}

let lastRun: { tcw: TinyCloudWeb; recorder: GmeetSyncLogRecorder } | null = null;
const runLogListeners = new Set<(event: GmeetRunLogEvent) => void>();

export function onGmeetRunLog(listener: (event: GmeetRunLogEvent) => void): () => void {
  runLogListeners.add(listener);
  return () => { runLogListeners.delete(listener); };
}

/** The most recent run's log in this page load, for the account whose `tcw` ran it. */
export function getGmeetRunLog(tcw: TinyCloudWeb, build?: string | null): GmeetSyncLog | null {
  if (lastRun === null || lastRun.tcw !== tcw) return null;
  return lastRun.recorder.build({ generatedAt: new Date(), build });
}

function publishRunLog(tcw: TinyCloudWeb, recorder: GmeetSyncLogRecorder, final: boolean): void {
  for (const listener of runLogListeners) guarded(() => listener({ tcw, recorder, final }));
}

function beginRunLog(tcw: TinyCloudWeb): GmeetSyncLogRecorder {
  const recorder = createGmeetSyncLogRecorder();
  lastRun = { tcw, recorder };
  publishRunLog(tcw, recorder, false);
  return recorder;
}

/** Per-Note progress reaches observers at most this often; a stage change always goes through at once. */
const LIVE_THROTTLE_MS = 250;
let liveStage: GmeetSyncProgress["stage"] | "none" = "none";
let liveLastAt = 0;
let livePending: { tcw: TinyCloudWeb; recorder: GmeetSyncLogRecorder; progress: GmeetSyncProgress } | null = null;
let liveTimer: ReturnType<typeof setTimeout> | undefined;

function deliverProgress(tcw: TinyCloudWeb, recorder: GmeetSyncLogRecorder, progress: GmeetSyncProgress): void {
  livePending = null;
  liveStage = progress.stage ?? "none";
  liveLastAt = Date.now();
  publishLive({ progress, resumed: progress.resumed });
  publishRunLog(tcw, recorder, false);
}

function trackProgress(tcw: TinyCloudWeb, recorder: GmeetSyncLogRecorder, progress: GmeetSyncProgress): void {
  recorder.record(progress);
  const elapsed = Date.now() - liveLastAt;
  if (progress.type !== "progress" || (progress.stage ?? "none") !== liveStage || elapsed >= LIVE_THROTTLE_MS) {
    clearTimeout(liveTimer);
    liveTimer = undefined;
    deliverProgress(tcw, recorder, progress);
    return;
  }
  livePending = { tcw, recorder, progress };
  liveTimer ??= setTimeout(() => {
    liveTimer = undefined;
    if (livePending !== null) deliverProgress(livePending.tcw, livePending.recorder, livePending.progress);
  }, LIVE_THROTTLE_MS - elapsed);
}

// Storage has no AbortSignal contract. A timed-out transport may still commit;
// do not start another writer on that space until the outstanding call settles.
const pendingFinishingStorage = new WeakMap<TinyCloudWeb, Set<Promise<unknown>>>();
const FINISHING_TIMEOUT_MS = 120_000;
const FINISHING_TIMEOUT_MESSAGE = "Finishing Google Meet sync timed out. Saved meetings are kept. Retry to finish syncing.";
// Drive Notes get a budget of their own, so the count and state write keep time.
const DRIVE_NOTES_TIMEOUT_MS = 60_000;
const DRIVE_NOTES_TIMEOUT_MESSAGE = "Syncing Google Meet notes from Drive timed out. Saved meetings are kept. Retry to finish syncing.";
// Wait-and-write budget for the connection row after a Finishing timeout.
const STATE_RECOVERY_TIMEOUT_MS = 10_000;

function trackFinishingStorage(tcw: TinyCloudWeb, pending: Promise<unknown>): void {
  const calls = pendingFinishingStorage.get(tcw) ?? new Set<Promise<unknown>>();
  pendingFinishingStorage.set(tcw, calls);
  calls.add(pending);
  const settled = () => {
    calls.delete(pending);
    if (calls.size === 0 && pendingFinishingStorage.get(tcw) === calls) pendingFinishingStorage.delete(tcw);
  };
  void pending.then(settled, settled);
}

async function settlePendingStorage(tcw: TinyCloudWeb): Promise<void> {
  for (let calls = pendingFinishingStorage.get(tcw); calls?.size; calls = pendingFinishingStorage.get(tcw)) {
    await Promise.allSettled([...calls]);
  }
}
type FinishingStep = <T>(work: () => Promise<T>, storage?: boolean) => Promise<T>;
type FinishingOptions = GmeetSyncOptions & { step: FinishingStep; ctx?: DriveCtx };

/** True while a run is in flight — lets the UI disable "Sync now" honestly. */
export function isGmeetSyncInFlight(): boolean {
  return inFlight !== null || notesInFlight !== null;
}

/** Test-only reset, mirroring `_resetConnectorSchemaMemoForTests`. */
export function _resetGmeetSyncSingleFlightForTests(): void {
  inFlight = null;
  notesInFlight = null;
  notesStop = null;
  foregroundDeferred = false;
  liveStatus = IDLE_LIVE;
  activeDid = null;
  livePending = null;
  clearTimeout(liveTimer);
  liveTimer = undefined;
  lastRun = null;
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
  if (notesInFlight) {
    return Promise.resolve({
      ok: false,
      error: { kind: "storage", message: GMEET_NOTES_BUSY_MESSAGE },
      data: null,
    });
  }
  if (pendingFinishingStorage.get(opts.tcw)?.size) {
    return Promise.resolve({
      ok: false,
      error: { kind: "storage", message: "The previous Google Meet save is still settling. Saved meetings are kept. Retry shortly." },
      data: null,
    });
  }
  foregroundDeferred = opts.deferNotes === true;
  const recorder = beginRunLog(opts.tcw);
  activeDid = opts.tcw.did ?? null;
  const run = runGoogleMeetSync(opts, recorder)
    .then((result) => {
      recorder.setResult(summarizeGmeetSyncResult(result));
      // A deferred hand-off keeps recording: the background reconcile finishes the log.
      publishRunLog(opts.tcw, recorder, !(result.ok && result.data.notesDeferred === true));
      return result;
    }, (error: unknown) => {
      recorder.setResult({ kind: "unknown", connectionSaved: null, notesDeferred: false });
      publishRunLog(opts.tcw, recorder, true);
      throw error;
    })
    .finally(() => {
      inFlight = null;
      foregroundDeferred = false;
      publishLive();
    });
  inFlight = run;
  // The run's first progress event fires before the slot is taken and reads as idle: re-assert the owner.
  activeDid = opts.tcw.did ?? null;
  publishLive({ progress: null, resumed: false });
  return run;
}

async function runGoogleMeetSync(opts: GmeetSyncOptions, recorder: GmeetSyncLogRecorder): Promise<GmeetSyncResult> {
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
  let partialNotes: GmeetNotesPartial | null = null;
  const diagnostics = emptyDiagnostics();
  let step: FinishingStep = (work) => work();
  let finishing = false;
  const readDiagnosticMeetings = async (sources?: readonly string[]) => {
    const result = await step(() => listMeetingsRead(tcw, sources), true);
    if (result.status === "ok") return result.meetings;
    if (finishing) throw new Error("Could not read Google Meet sync diagnostics from storage.");
    return [];
  };

  const readDatetimeStats = async (): Promise<MeetingDatetimeStats> => {
    if (store.getMeetingDatetimeStats) {
      const result = await step(() => store.getMeetingDatetimeStats!(tcw, SOURCE), true);
      if (result.ok) return result.data;
      if (finishing) throw new Error(fromStore(result.error, "getMeetingDatetimeStats").message);
    }
    const rows = await readDiagnosticMeetings([SOURCE]);
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
    const allRows = await readDiagnosticMeetings();
    const googleRows = await readDiagnosticMeetings([SOURCE]);
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
    await step(async () => { await onDiagnostics({ ...diagnostics }); });
  };

  const emit = (type: GmeetSyncProgress["type"], message?: string, extra?: Partial<GmeetSyncProgress>) => {
    const progress: GmeetSyncProgress = { type, current, total, synced: created + updated, failed, skipped, message, ...extra };
    trackProgress(tcw, recorder, progress);
    return onProgress?.(progress);
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
  // The deferred path keeps the dialog's critical path free of whole-table diagnostic reads.
  if (onDiagnostics && !opts.deferNotes) {
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
      const records = [...listRes.data].reverse();
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
  } catch (err) {
    // Nothing in the loop is expected to throw (every seam is Result-shaped);
    // an unexpected one is surfaced rather than swallowed.
    terminal = { kind: "storage", message: errorMessage(err) };
  }

  // One deadline covers the whole post-record phase, not a fresh allowance per
  // page/call. Every await in Drive reconciliation uses step: timing out cannot
  // leave an abandoned continuation writing a cursor or publishing success.
  // Drive Notes fetching has its own, shorter budget inside that deadline so the
  // count and the connector_state write always keep time of their own.
  finishing = true;
  type Phase = "drive" | "count" | "diagnostics" | "state_write";
  let phaseName: Phase | null = null;
  let phaseStartedAt = 0;
  const leavePhase = () => {
    if (phaseName === null) return;
    diagnostics[`phase_${phaseName}_ms`] += Math.max(0, Date.now() - phaseStartedAt);
    phaseName = null;
  };
  const enterPhase = (next: Phase) => {
    leavePhase();
    phaseName = next;
    phaseStartedAt = Date.now();
  };
  const controller = new AbortController();
  let stopped: GmeetSyncError | null = null;
  let timedOut = false;
  let stateWritten = false;
  let rejectStop!: (reason: Error) => void;
  const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
  // A synchronous progress consumer can fail before the first raced await.
  void stopPromise.catch(() => {});
  const stop = (message: string, byTimeout = false) => {
    if (stopped !== null) return;
    stopped = { kind: "network", message };
    if (byTimeout) {
      timedOut = true;
      diagnostics.finishing_timed_out = 1;
      diagnostics.finishing_stalled_phase = phaseName ?? "none";
    }
    leavePhase();
    const error = new Error(message);
    controller.abort(error);
    rejectStop(error);
  };
  const onAbort = () => stop("Google Meet sync was stopped. Saved meetings are kept. Retry to finish syncing.");
  const timer = setTimeout(() => stop(FINISHING_TIMEOUT_MESSAGE, true), FINISHING_TIMEOUT_MS);
  // Preserve the pre-record cancellation result; cancellation during Finishing
  // is an error, never a completed import.
  if (!aborted) {
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  }
  step = async <T>(work: () => Promise<T>, storage = false): Promise<T> => {
    if (stopped) throw new Error(stopped.message);
    const pending = work();
    if (storage) trackFinishingStorage(tcw, pending);
    const result = await Promise.race([pending, stopPromise]);
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  };
  let itemCount = connRes.data?.itemCount ?? 0;
  const writeState = async () => {
    const completed = terminal === null && !aborted;
    enterPhase("state_write");
    let update;
    try {
      update = await step(() => store.updateSyncState(tcw, {
        connectorId: SOURCE,
        status: "connected",
        lastSyncedAt: completed ? startedAtIso : watermarkIso,
        lastSyncStatus: terminal ? "error" : reconnectRequired || partialNotes ? "partial" : "ok",
        lastSyncError: terminal?.message ?? (partialNotes ? gmeetNotesPartialMessage(partialNotes) : reconnectRequired ? "Reconnect Google Meet to sync Notes by Gemini" : null),
        itemCount,
      }), true);
    } finally {
      leavePhase();
    }
    if (update.ok) stateWritten = true;
    else terminal ??= fromStore(update.error, "updateSyncState");
  };
  // After a Finishing timeout `step` is closed, so the connection row gets its own
  // short deadline. The secret already exists; without this row the card never
  // shows Google Meet as connected. Outstanding storage calls settle first (the
  // single-writer guard), and a late continuation can never write after we give up.
  const persistConnectionAfterTimeout = async (message: string) => {
    enterPhase("state_write");
    let abandoned = false;
    let started = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      deadlineTimer = setTimeout(() => { abandoned = true; resolve("timeout"); }, STATE_RECOVERY_TIMEOUT_MS);
    });
    const attempt = (async (): Promise<"written" | "failed"> => {
      await settlePendingStorage(tcw);
      if (abandoned) return "failed";
      started = true;
      const pending = store.updateSyncState(tcw, {
        connectorId: SOURCE,
        status: "connected",
        lastSyncedAt: watermarkIso,
        lastSyncStatus: "error",
        lastSyncError: message,
        itemCount,
      });
      trackFinishingStorage(tcw, pending);
      return (await pending).ok ? "written" : "failed";
    })();
    void attempt.catch(() => {});
    let outcome: "written" | "failed" | "timeout";
    try {
      outcome = await Promise.race([attempt, deadline]);
    } catch {
      outcome = "failed";
    } finally {
      clearTimeout(deadlineTimer);
      leavePhase();
    }
    if (outcome === "written") stateWritten = true;
    diagnostics.finishing_recovery_write = outcome === "written" ? "written"
      : outcome === "timeout" ? (started ? "timed_out" : "skipped_pending_storage") : "failed";
  };
  try {
    await step(async () => { await emit("status", "finishing", opts.deferNotes ? { stage: "meetings" } : undefined); });
    if (terminal === null && !aborted && !opts.deferNotes) {
      const failuresBeforeNotes = failed;
      enterPhase("drive");
      const run = await runBudgetedDrive({
        opts, parentStep: step, parentSignal: controller.signal, record, diagnostics,
        budgetMs: DRIVE_NOTES_TIMEOUT_MS, parallel: false,
      });
      leavePhase();
      if (run.timeoutMessage !== null) {
        terminal = { kind: "network", message: run.timeoutMessage };
        if (pendingFinishingStorage.get(tcw)?.size) {
          // A storage call is stuck: waiting for it inside Finishing would hold the
          // single-flight slot (and Disconnect) until the whole deadline. Give up now;
          // the connection row is written once it settles, within its own short deadline.
          timedOut = true;
          throw new Error(run.timeoutMessage);
        }
        // An abandoned Notes write must settle before the next writer starts.
        await step(() => settlePendingStorage(tcw));
      } else {
        const verdict = interpretDrive(run.drive, items, failed > failuresBeforeNotes, diagnostics);
        terminal = verdict.terminal;
        if (verdict.aborted) aborted = true;
        if (verdict.reconnectRequired) reconnectRequired = true;
        if (verdict.partial) partialNotes = verdict.partial;
      }
    }
    if (opts.deferNotes) await step(async () => { await emit("progress", "finishing", { stage: "saving" }); });
    enterPhase("count");
    const count = await step(() => store.countMeetings(tcw, SOURCE), true);
    leavePhase();
    if (count.ok) itemCount = count.data;
    else terminal ??= fromStore(count.error, "countMeetings");
    diagnostics.persisted_item_count_after = itemCount;
    enterPhase("diagnostics");
    // The deferred path keeps the dialog's critical path free of whole-table diagnostic reads.
    if (opts.deferNotes) await step(async () => { await onDiagnostics?.({ ...diagnostics }); });
    else await emitDiagnostics();
    leavePhase();
    await writeState();
    if (terminal === null) {
      await step(async () => { await emit("complete"); });
      // A stopped run (Stop between Meet records) keeps its old watermark and starts no background work.
      if (!opts.deferNotes || aborted) return { ok: true, data: summary() };
      const meetings = { current, total, synced: created + updated, failed, skipped };
      const stop = new AbortController();
      const background: Promise<void> = runNotesInBackground({ opts, startedAtIso, itemCount, diagnostics, meetings, stop, recorder })
        .catch(() => {
          // An unexpected rejection must not leave the log unfinished.
          recorder.setNotesOutcome({ ok: false, errorKind: "storage" });
          publishRunLog(tcw, recorder, true);
        })
        .finally(() => { if (notesInFlight === background) notesInFlight = null; publishLive(); });
      notesInFlight = background;
      notesStop = stop;
      return { ok: true, data: { ...summary(), notesDeferred: true } };
    }
  } catch (error) {
    terminal ??= stopped ?? { kind: "storage", message: errorMessage(error) };
    // Report a failure when storage is usable, under the SAME deadline. Once
    // stopped, no new store operation or diagnostic continuation is started; a
    // stuck storage call (timedOut) is never overlapped by another writer.
    if (stopped === null && !timedOut) {
      try { await writeState(); } catch { /* The error result remains authoritative when state cannot be written. */ }
    }
    if (timedOut && !stateWritten) {
      await persistConnectionAfterTimeout(terminal.message);
      // Count-only phase timings; step is closed, so no storage is read here.
      try { onDiagnostics?.({ ...diagnostics }); } catch { /* Diagnostics are best effort. */ }
    }
  } finally {
    recorder.setDiagnostics({ ...diagnostics });
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  const error = terminal ?? { kind: "network" as const, message: "Google Meet sync did not finish. Retry to finish syncing." };
  try {
    void Promise.resolve(emit("error", error.message)).catch(() => {});
  } catch { /* A broken progress consumer must not turn the terminal result into a rejection. */ }
  return {
    ok: false,
    error,
    data: summary(),
    // False only when no connector_state row marks the card connected.
    connectionSaved: stateWritten || connRes.data?.status === "connected",
  };
}

const DRIVE_DOC_MIME = "application/vnd.google-apps.document";
const STOPPED_MESSAGE = "Google Meet sync was stopped. Saved meetings are kept. Retry to finish syncing.";
const STORAGE_CALL_TIMEOUT_MESSAGE = "A storage call while syncing Google Meet notes timed out. Saved meetings are kept. Retry to finish syncing.";
// The background reconcile outlives the dialog, so it gets a larger budget than the
// foreground Drive phase. Each Docs read and each storage call is bounded on top.
const NOTES_BACKGROUND_BUDGET_MS = 10 * 60_000;
const STORAGE_CALL_TIMEOUT_MS = 30_000;
const DOC_CALL_TIMEOUT_MS = 30_000;
const DOCS_CONCURRENCY = 5;
const DOCS_READ_AHEAD = DOCS_CONCURRENCY * 2;
const CHECKPOINT_EVERY = 10;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60_000;

/** Per-run state the Drive reconcile shares with `syncDriveFile`. */
interface DriveCtx {
  /** Bounded parallel Docs reads (background reconcile only). */
  parallel: boolean;
  emitNotes?: (extra: Partial<GmeetSyncProgress>) => void;
  /** Id-only association lookup over rows read once; null when the store cannot preload. */
  lookup: ((fileId: string) => GmeetNotesAssociation | null) | null;
  /** A Docs read already started ahead for this file, if any. */
  takeDoc: ((fileId: string) => Promise<GmeetResult<GoogleDocsDocument>> | null) | null;
}

interface DriveRunInput {
  opts: GmeetSyncOptions;
  parentStep: FinishingStep;
  parentSignal: AbortSignal;
  record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void;
  diagnostics: GmeetSyncDiagnostics;
  budgetMs: number;
  parallel: boolean;
  emitNotes?: (extra: Partial<GmeetSyncProgress>) => void;
}

/**
 * Run the Drive Notes reconcile under its own budget. A stalled phase, or a single
 * storage call stuck past its own limit, abandons the reconcile (`timeoutMessage`)
 * without touching the caller's deadline, so the caller can still save its state.
 * Every call is accounted as node storage or Google HTTP time in `diagnostics`.
 */
async function runBudgetedDrive(input: DriveRunInput): Promise<{ drive: DriveOutcome; timeoutMessage: string | null }> {
  const { diagnostics, parentStep } = input;
  const driveController = new AbortController();
  const forwardAbort = () => driveController.abort(input.parentSignal.reason);
  input.parentSignal.addEventListener("abort", forwardAbort, { once: true });
  let timeoutMessage: string | null = null;
  let rejectDrive!: (reason: Error) => void;
  const drivePromise = new Promise<never>((_, reject) => { rejectDrive = reject; });
  void drivePromise.catch(() => {});
  const failDrive = (message: string) => {
    if (timeoutMessage !== null) return;
    timeoutMessage = message;
    diagnostics.finishing_timed_out = 1;
    diagnostics.finishing_stalled_phase = "drive";
    const error = new Error(message);
    driveController.abort(error);
    rejectDrive(error);
  };
  const budgetTimer = setTimeout(() => failDrive(DRIVE_NOTES_TIMEOUT_MESSAGE), input.budgetMs);
  const timedStep: FinishingStep = (work, storage = false) => {
    if (timeoutMessage !== null) return Promise.reject(new Error(timeoutMessage));
    if (input.parentSignal.aborted) return Promise.reject(new Error(STOPPED_MESSAGE));
    const began = Date.now();
    const inner = parentStep(work, storage);
    void inner.catch(() => {});
    let callTimer: ReturnType<typeof setTimeout> | undefined;
    const racers: Promise<unknown>[] = [inner, drivePromise];
    if (storage) {
      // Storage has no AbortSignal contract: abandon a stuck call, never overlap a next writer.
      racers.push(new Promise<never>((_, reject) => {
        callTimer = setTimeout(() => {
          diagnostics.drive_call_timeouts++;
          failDrive(STORAGE_CALL_TIMEOUT_MESSAGE);
          reject(new Error(STORAGE_CALL_TIMEOUT_MESSAGE));
        }, STORAGE_CALL_TIMEOUT_MS);
      }));
    }
    return (Promise.race(racers) as Promise<Awaited<ReturnType<typeof work>>>).finally(() => {
      clearTimeout(callTimer);
      if (storage) { diagnostics.drive_sql_calls++; diagnostics.drive_sql_ms += Date.now() - began; }
      else { diagnostics.drive_http_calls++; diagnostics.drive_http_ms += Date.now() - began; }
    });
  };
  const ctx: DriveCtx = { parallel: input.parallel, emitNotes: input.emitNotes, lookup: null, takeDoc: null };
  try {
    const drive = await syncDriveNotes(
      { ...input.opts, signal: driveController.signal, step: timedStep, ctx }, input.record, diagnostics,
    );
    return { drive, timeoutMessage };
  } catch (error) {
    if (timeoutMessage === null) throw error;
    return { drive: {}, timeoutMessage };
  } finally {
    clearTimeout(budgetTimer);
    input.parentSignal.removeEventListener("abort", forwardAbort);
  }
}

/** Map a finished Drive reconcile onto the sync's terminal/abort/reconnect/partial state. */
function interpretDrive(
  drive: DriveOutcome,
  items: readonly GmeetSyncItem[],
  failedDuringDrive: boolean,
  diagnostics: GmeetSyncDiagnostics,
): { terminal: GmeetSyncError | null; aborted: boolean; reconnectRequired: boolean; partial: GmeetNotesPartial | null } {
  let terminal: GmeetSyncError | null = drive.terminal ?? null;
  const aborted = drive.aborted === true;
  if (aborted) terminal ??= { kind: "network", message: STOPPED_MESSAGE };
  let partial: GmeetNotesPartial | null = null;
  if (terminal === null && (drive.failed || failedDuringDrive)) {
    if (drive.partial) {
      // The Notes that failed stay out of the checkpoint; the run itself completed.
      partial = drive.partial;
    } else {
      let reason = "Google Meet Notes could not finish syncing. Retry to finish syncing.";
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]!.outcome !== "error") continue;
        reason = items[i]!.reason ?? reason;
        break;
      }
      terminal = { kind: diagnostics.drive_storage_failed > 0 ? "storage" : "network", message: reason };
    }
  }
  return { terminal, aborted, reconnectRequired: drive.reconnectRequired === true, partial };
}

function syncStateInput(
  startedAtIso: string,
  itemCount: number,
  terminal: GmeetSyncError | null,
  reconnectRequired: boolean,
  partial: GmeetNotesPartial | null,
): UpdateSyncStateInput {
  return {
    connectorId: SOURCE,
    status: "connected",
    lastSyncedAt: startedAtIso,
    lastSyncStatus: terminal ? "error" : reconnectRequired || partial ? "partial" : "ok",
    lastSyncError: terminal?.message ?? (partial ? gmeetNotesPartialMessage(partial) : reconnectRequired ? "Reconnect Google Meet to sync Notes by Gemini" : null),
    itemCount,
  };
}

const notesProgressListeners = new Set<(progress: GmeetSyncProgress) => void>();

/** Live progress of the deferred Notes reconcile (stage, docs listed/matched, notes done/total). */
export function onGmeetNotesProgress(listener: (progress: GmeetSyncProgress) => void): () => void {
  notesProgressListeners.add(listener);
  return () => { notesProgressListeners.delete(listener); };
}

function guarded(call: () => unknown): void {
  try { void Promise.resolve(call()).catch(() => {}); } catch { /* A broken observer must not fail the sync. */ }
}

interface NotesBackgroundInput {
  opts: GmeetSyncOptions;
  startedAtIso: string;
  itemCount: number;
  diagnostics: GmeetSyncDiagnostics;
  meetings: Pick<GmeetSyncProgress, "current" | "total" | "synced" | "failed" | "skipped">;
  /** Aborted by `stopGmeetNotesSync`; the reconcile then writes nothing further. */
  stop: AbortController;
  recorder: GmeetSyncLogRecorder;
}

/**
 * Reconcile Notes by Gemini after syncGoogleMeet has returned, then rewrite the
 * connector_state row with the real outcome (so an error shows on the card). It is
 * the only storage writer for the space until it settles; every await is bounded.
 */
async function runNotesInBackground(input: NotesBackgroundInput): Promise<void> {
  const { opts, diagnostics, recorder } = input;
  const { store, tcw } = opts;
  const publish = (extra: Partial<GmeetSyncProgress>) => {
    const progress: GmeetSyncProgress = { type: "progress", ...input.meetings, message: "notes", ...extra };
    trackProgress(tcw, recorder, progress);
    for (const listener of notesProgressListeners) guarded(() => listener(progress));
  };
  const items: GmeetSyncItem[] = [];
  let failedInDrive = false;
  const record = (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => {
    items.push(reason === undefined ? { sourceId, outcome } : { sourceId, outcome, reason });
    if (outcome === "error") failedInDrive = true;
  };
  let terminal: GmeetSyncError | null = null;
  let reconnectRequired = false;
  let partial: GmeetNotesPartial | null = null;
  let itemCount = input.itemCount;
  const trackedStep: FinishingStep = (work, storage = false) => {
    const pending = work();
    if (storage) trackFinishingStorage(tcw, pending);
    return pending;
  };
  const began = Date.now();
  try {
    const run = await runBudgetedDrive({
      opts: { ...opts, signal: undefined }, parentStep: trackedStep, parentSignal: input.stop.signal,
      record, diagnostics, budgetMs: NOTES_BACKGROUND_BUDGET_MS, parallel: true, emitNotes: publish,
    });
    diagnostics.phase_drive_ms += Date.now() - began;
    if (run.timeoutMessage !== null) terminal = { kind: "network", message: run.timeoutMessage };
    else {
      const verdict = interpretDrive(run.drive, items, failedInDrive, diagnostics);
      terminal = verdict.terminal;
      reconnectRequired = verdict.reconnectRequired;
      partial = verdict.partial;
    }
  } catch (error) {
    terminal = { kind: "storage", message: errorMessage(error) };
  }
  publish({ stage: "saving" });
  // An abandoned call may still commit: wait for it (bounded) before the next write.
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    settlePendingStorage(tcw).then(() => true),
    new Promise<boolean>((resolve) => { settleTimer = setTimeout(() => resolve(false), STATE_RECOVERY_TIMEOUT_MS); }),
  ]);
  clearTimeout(settleTimer);
  if (input.stop.signal.aborted) {
    // Stopped (a disconnect): the data is being removed, so nothing more may be written.
    terminal ??= { kind: "network", message: STOPPED_MESSAGE };
  } else if (settled) {
    const boundedStorage = async <T>(work: () => Promise<T>): Promise<T | null> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = work();
      trackFinishingStorage(tcw, pending);
      void pending.catch(() => {});
      try {
        return await Promise.race([
          pending,
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), STORAGE_CALL_TIMEOUT_MS); }),
        ]);
      } catch { return null; } finally { clearTimeout(timer); }
    };
    const stateBegan = Date.now();
    // Recounted on every outcome (success, partial, error): the row written below is what the
    // card shows. A count that cannot be read must not leave the pre-reconcile figure standing,
    // so it falls back to that figure plus the rows this run is known to have added or removed.
    const count = await boundedStorage(() => store.countMeetings(tcw, SOURCE));
    if (count?.ok) itemCount = count.data;
    else itemCount = Math.max(0, input.itemCount + diagnostics.drive_rows_inserted - diagnostics.drive_rows_deleted);
    diagnostics.persisted_item_count_after = itemCount;
    const write = await boundedStorage(() => store.updateSyncState(tcw, syncStateInput(input.startedAtIso, itemCount, terminal, reconnectRequired, partial)));
    diagnostics.phase_state_write_ms += Date.now() - stateBegan;
    if (!write?.ok) {
      terminal ??= { kind: "storage", message: "Google Meet notes finished but the sync state could not be saved." };
      diagnostics.finishing_recovery_write = "failed";
    }
  } else {
    terminal ??= { kind: "storage", message: STORAGE_CALL_TIMEOUT_MESSAGE };
    diagnostics.finishing_recovery_write = "skipped_pending_storage";
  }
  // Released before observers run: they re-read the row and expect "Sync now" to be usable again.
  if (notesStop === input.stop) notesInFlight = null;
  const settledOutcome: GmeetNotesSettled = {
    ok: terminal === null && partial === null, errorKind: terminal?.kind ?? null, partial, diagnostics: { ...diagnostics },
  };
  recorder.setDiagnostics(settledOutcome.diagnostics);
  recorder.setNotesOutcome(settledOutcome);
  publishLive();
  publishRunLog(tcw, recorder, true);
  guarded(() => opts.onDiagnostics?.({ ...diagnostics }));
  for (const listener of notesSettledListeners) guarded(() => listener(settledOutcome));
}

/** A narrow metadata gate. Non-candidates must never reach Docs documents.get. */
export function isLikelyGmeetNotesFile(file: GoogleDriveFile): boolean {
  if (file.mimeType !== "application/vnd.google-apps.document" || file.trashed || !file.id?.trim()) return false;
  const marker = [file.name, file.description, ...Object.values(file.appProperties ?? {})]
    .filter((value): value is string => typeof value === "string")
    .join(" ").toLocaleLowerCase();
  return /\bnotes by gemini\b/.test(marker);
}

interface DriveOutcome { terminal?: GmeetSyncError; aborted?: boolean; reconnectRequired?: boolean; failed?: boolean; partial?: GmeetNotesPartial }

type DriveTerminalCounter =
  | "drive_unprocessed_due_run_stop" | "drive_missing_id" | "drive_removed_or_trashed"
  | "drive_non_google_doc" | "drive_metadata_non_candidate" | "drive_unchanged_associated"
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
  opts: FinishingOptions,
  record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void,
  diagnostics: GmeetSyncDiagnostics,
): Promise<DriveOutcome> {
  const { client, store, tcw, signal } = opts;
  // Optional methods preserve compatibility with deliberately narrow external test clients.
  if (!client.listDriveFiles || !client.getDriveStartPageToken || !client.listDriveChangesPage || !client.getDriveDocument
    || !store.getDriveCursor || !store.putDriveCursor || !store.findGmeetNotesAssociation || !store.attachGmeetNotes || !store.removeGmeetNotes) return {};

  const cursor = await opts.step(() => store.getDriveCursor!(tcw, SOURCE), true);
  if (!cursor.ok) return { terminal: fromStore(cursor.error, "getDriveCursor") };
  if (signal?.aborted) return { aborted: true };
  if (opts.driveMode === "snapshot") return snapshotDriveNotes(opts, record, diagnostics, "snapshot");
  if (cursor.data === null) return snapshotDriveNotes(opts, record, diagnostics, "snapshot");

  diagnostics.drive_mode = "incremental";
  let pageToken = cursor.data;
  let finalCursor: string | null;
  let anyFailure = false;
  let changesSeen = 0;
  let changesFailed = 0;
  let changesFailedOther = 0;
  while (true) {
    const page = await opts.step(() => client.listDriveChangesPage!(pageToken, { signal }));
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
    changesSeen += page.data.changes.filter(isNotesRelevantChange).length;
    for (let index = 0; index < page.data.changes.length; index++) {
      const storageFailedBefore = diagnostics.drive_storage_failed;
      const outcome = await syncDriveChange(page.data.changes[index]!, opts, record, diagnostics);
      if (outcome.aborted || outcome.terminal) {
        terminalDriveItem(diagnostics, "drive_unprocessed_due_run_stop", page.data.changes.length - index - 1);
        diagnostics.drive_diagnostics_complete = page.data.nextPageToken ? 0 : 1;
        return outcome;
      }
      if (outcome.failed) {
        pageFailed = true;
        if (diagnostics.drive_storage_failed > storageFailedBefore) changesFailed++;
        else changesFailedOther++;
      }
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
  if (anyFailure) {
    diagnostics.drive_items_failed = changesFailed;
    // Only storage failures are a partial result; a failed Docs read keeps the run's error.
    return changesFailedOther === 0
      ? { failed: true, partial: { saved: Math.max(0, Math.max(changesSeen, changesFailed) - changesFailed), total: Math.max(changesSeen, changesFailed) } }
      : { failed: true };
  }
  if (!finalCursor) return { terminal: { kind: "network", message: "Google Drive changes page had no new start token" } };
  const write = await opts.step(() => store.putDriveCursor!(tcw, SOURCE, finalCursor!), true);
  if (write.ok) diagnostics.drive_cursor_committed = 1;
  return write.ok ? {} : { terminal: fromStore(write.error, "putDriveCursor") };
}

/** Bounded read-ahead of Docs documents: at most DOCS_CONCURRENCY reads in flight, each with its own timeout. */
function createDocPrefetcher(
  opts: FinishingOptions,
  diagnostics: GmeetSyncDiagnostics,
  files: readonly GoogleDriveFile[],
): (fileId: string) => Promise<GmeetResult<GoogleDocsDocument>> | null {
  const started = new Map<string, Promise<GmeetResult<GoogleDocsDocument>>>();
  let next = 0;
  let running = 0;
  const fetchDocument = async (fileId: string): Promise<GmeetResult<GoogleDocsDocument>> => {
    const began = Date.now();
    const controller = new AbortController();
    const forward = () => controller.abort();
    opts.signal?.addEventListener("abort", forward, { once: true });
    if (opts.signal?.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GmeetResult<GoogleDocsDocument>>((resolve) => {
      timer = setTimeout(() => {
        diagnostics.drive_call_timeouts++;
        controller.abort();
        resolve({ ok: false, error: { kind: "network-error", status: null, message: "Google Docs request timed out" } });
      }, DOC_CALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([opts.client.getDriveDocument!(fileId, { signal: controller.signal }), timeout]);
    } catch (error) {
      return { ok: false, error: { kind: "network-error", status: null, message: errorMessage(error) } };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", forward);
      diagnostics.drive_http_calls++;
      diagnostics.drive_http_ms += Date.now() - began;
    }
  };
  const pump = () => {
    while (running < DOCS_CONCURRENCY && started.size < DOCS_READ_AHEAD && next < files.length) {
      const fileId = files[next++]!.id!.trim();
      running++;
      started.set(fileId, fetchDocument(fileId).finally(() => { running--; pump(); }));
    }
  };
  pump();
  return (fileId) => {
    const read = started.get(fileId);
    if (!read) return null;
    started.delete(fileId);
    pump();
    return read;
  };
}

async function snapshotDriveNotes(
  opts: FinishingOptions,
  record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void,
  diagnostics: GmeetSyncDiagnostics,
  mode: "snapshot" | "stale_cursor_snapshot",
): Promise<DriveOutcome> {
  const { client, store, tcw, signal, ctx } = opts;
  diagnostics.drive_mode = mode;
  if (!client.getDriveStartPageToken || !client.listDriveFiles || !store.putDriveCursor) return {};
  ctx?.emitNotes?.({ stage: "notes-listing" });
  // A checkpoint from an interrupted snapshot resumes it: same start token (older is
  // always safe, later changes replay from it) and the files already reconciled.
  let resumed: { startToken: string; doneIds: Set<string> } | null = null;
  if (store.getDriveProgress && store.putDriveProgress) {
    const saved = await opts.step(() => store.getDriveProgress!(tcw, SOURCE), true);
    if (saved.ok && saved.data !== null && Date.parse(saved.data.savedAt) > (opts.now ?? Date.now)() - CHECKPOINT_MAX_AGE_MS) {
      resumed = { startToken: saved.data.startToken, doneIds: new Set(saved.data.doneIds) };
    }
  }
  let startToken: string;
  if (resumed) startToken = resumed.startToken;
  else {
    const start = await opts.step(() => client.getDriveStartPageToken!({ signal }));
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
    startToken = start.data;
  }
  const files = await opts.step(() => client.listDriveFiles!({ signal }));
  if (!files.ok) {
    if (files.error.kind === "aborted") return { aborted: true };
    if (files.error.kind === "forbidden") return { reconnectRequired: true };
    return { terminal: fromGmeetError(files.error) };
  }
  diagnostics.drive_diagnostics_complete = 1;
  diagnostics.drive_input_items += files.data.length;
  let lookup: ((fileId: string) => GmeetNotesAssociation | null) | null = null;
  if (store.loadGmeetNotesIndex) {
    const loaded = await opts.step(() => store.loadGmeetNotesIndex!(tcw, SOURCE), true);
    // Only an optimisation: if the preload cannot be read, keep the per-Doc lookups.
    if (loaded.ok) {
      lookup = loaded.data.find;
      diagnostics.drive_assoc_preloaded_rows = loaded.data.size;
      if (ctx) ctx.lookup = lookup;
    }
  }
  // Only files that can need storage or Docs work are candidates: trashed (removal),
  // Notes-by-Gemini by metadata, or already associated. Everything else is a
  // no-op in syncDriveFile and is answered from memory.
  const isCandidate = (file: GoogleDriveFile): boolean => {
    const id = file.id?.trim();
    if (lookup === null || file.trashed === true || !id) return true;
    return file.mimeType === DRIVE_DOC_MIME && (isLikelyGmeetNotesFile(file) || lookup(id) !== null);
  };
  const doneIds = resumed?.doneIds ?? new Set<string>();
  const candidates = files.data.filter(isCandidate);
  const docsListed = files.data.filter((file) => file.mimeType === DRIVE_DOC_MIME && file.trashed !== true).length;
  diagnostics.drive_candidates = candidates.length;
  diagnostics.drive_prefilter_skipped = lookup === null ? 0 : files.data.length - candidates.length;
  let reconciled = 0;
  const notes = () => ctx?.emitNotes?.({
    stage: "notes", notesDone: reconciled, notesTotal: candidates.length, docsListed, docsMatched: candidates.length,
    resumed: resumed !== null,
  });
  notes();
  if (ctx?.parallel && lookup !== null && client.getDriveDocument) {
    const needsRead = (file: GoogleDriveFile): boolean => {
      const id = file.id?.trim();
      if (!id || file.trashed === true || file.mimeType !== DRIVE_DOC_MIME || doneIds.has(id)) return false;
      const modified = file.modifiedTime;
      return !(typeof modified === "string" && modified.length > 0 && lookup(id)?.metadata.drive_modified_time === modified);
    };
    ctx.takeDoc = createDocPrefetcher(opts, diagnostics, candidates.filter(needsRead));
  }
  let failed = false;
  let failedCount = 0;
  let failedOther = 0;
  let sinceCheckpoint = 0;
  let checkpointUsable = store.putDriveProgress !== undefined;
  const checkpoint = async () => {
    if (!checkpointUsable || sinceCheckpoint === 0) return;
    sinceCheckpoint = 0;
    const written = await opts.step(() => store.putDriveProgress!(tcw, SOURCE, {
      startToken, doneIds: [...doneIds], savedAt: isoAt((opts.now ?? Date.now)()),
    }), true);
    if (written.ok) diagnostics.drive_checkpoint_writes++;
    else checkpointUsable = false; // Only an optimisation: keep reconciling without it.
  };
  for (let index = 0; index < files.data.length; index++) {
    const file = files.data[index]!;
    const id = file.id?.trim();
    const candidate = isCandidate(file);
    if (candidate && id && doneIds.has(id)) {
      terminalDriveItem(diagnostics, "drive_unchanged_associated");
      diagnostics.drive_resumed_skipped++;
      reconciled++;
      notes();
      continue;
    }
    const storageFailedBefore = diagnostics.drive_storage_failed;
    const outcome = await syncDriveFile(file, opts, record, diagnostics);
    if (outcome.aborted || outcome.terminal) {
      terminalDriveItem(diagnostics, "drive_unprocessed_due_run_stop", files.data.length - index - 1);
      if (outcome.terminal) await checkpoint();
      return outcome;
    }
    if (outcome.failed) {
      failed = true;
      if (diagnostics.drive_storage_failed > storageFailedBefore) failedCount++;
      else failedOther++;
    }
    if (!candidate) continue;
    reconciled++;
    if (!outcome.failed && id) {
      doneIds.add(id);
      sinceCheckpoint++;
    }
    notes();
    if (sinceCheckpoint >= CHECKPOINT_EVERY) await checkpoint();
  }
  // Without the preloaded index every Drive file is a candidate; count only those that can be Notes.
  const notesTotal = Math.max(
    failedCount,
    lookup === null ? candidates.filter((file) => file.trashed === true || isLikelyGmeetNotesFile(file)).length : candidates.length,
  );
  if (failed) {
    // The Notes that failed stay out of doneIds: the next run resumes this checkpoint and
    // reconciles only them. The cursor is not committed until every Note is saved.
    await checkpoint();
    diagnostics.drive_items_failed = failedCount;
    // Only storage failures are a partial result; a failed Docs read keeps the run's error.
    return failedOther === 0
      ? { failed: true, partial: { saved: Math.max(0, notesTotal - failedCount), total: notesTotal } }
      : { failed: true };
  }
  if (store.putDriveProgress && (resumed !== null || diagnostics.drive_checkpoint_writes > 0)) {
    // Cleared before the cursor so a leftover checkpoint can never outlive a committed snapshot.
    const cleared = await opts.step(() => store.putDriveProgress!(tcw, SOURCE, null), true);
    if (!cleared.ok) return { terminal: fromStore(cleared.error, "putDriveProgress") };
  }
  const write = await opts.step(() => store.putDriveCursor!(tcw, SOURCE, startToken), true);
  if (write.ok) diagnostics.drive_cursor_committed = 1;
  return write.ok ? {} : { terminal: fromStore(write.error, "putDriveCursor") };
}

/** Backoff before each retry of one Note's storage call: two retries, then the Note is left for the next run. */
const NOTE_STORAGE_RETRY_BACKOFF_MS: readonly number[] = [500, 1500];

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * One Note's storage calls retry a failed result (not a timeout, which abandons the call) up to
 * twice with backoff, so a transient node error does not cost the Note. Every such call is an
 * idempotent read or an upsert keyed on (source, source_id).
 */
/** Runs in which a Note already exhausted its retries: the node is down, so later Notes fail fast instead of each burning the backoff. */
const retriesExhausted = new WeakSet<GmeetSyncDiagnostics>();

function withStorageRetry(opts: FinishingOptions, diagnostics: GmeetSyncDiagnostics): FinishingOptions {
  const isFailed = (value: unknown) => typeof value === "object" && value !== null && "ok" in value && value.ok === false;
  const step: FinishingStep = async (work, storage = false) => {
    let result = await opts.step(work, storage);
    if (!storage) return result;
    for (const wait of NOTE_STORAGE_RETRY_BACKOFF_MS) {
      if (!isFailed(result) || opts.signal?.aborted || retriesExhausted.has(diagnostics)) return result;
      diagnostics.drive_storage_retries++;
      await abortableDelay(wait, opts.signal);
      if (opts.signal?.aborted) return result;
      result = await opts.step(work, true);
    }
    if (isFailed(result)) retriesExhausted.add(diagnostics);
    return result;
  };
  return { ...opts, step };
}

/** Drive changes that reach Notes handling: removals and Notes candidates (never every unrelated file change). */
const isNotesRelevantChange = (change: GoogleDriveChange): boolean =>
  change.removed === true || change.file?.trashed === true || (change.file !== undefined && isLikelyGmeetNotesFile(change.file));

async function syncDriveChange(change: GoogleDriveChange, opts: FinishingOptions, record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void, diagnostics: GmeetSyncDiagnostics): Promise<DriveOutcome & { failed?: boolean }> {
  const fileId = change.fileId ?? change.file?.id;
  if (!fileId) { terminalDriveItem(diagnostics, "drive_missing_id"); return { failed: true }; }
  if (change.removed || change.file?.trashed) {
    const removed = await withStorageRetry(opts, diagnostics).step(() => opts.store.removeGmeetNotes!(opts.tcw, SOURCE, fileId), true);
    if (!removed.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); record(fileId, "error", fromStore(removed.error, "removeGmeetNotes").message); return { failed: true }; }
    recordRemovalMutation(diagnostics, removed.data);
    terminalDriveItem(diagnostics, "drive_removed_or_trashed");
    record(fileId, "updated");
    return {};
  }
  return syncDriveFile(change.file ?? { id: fileId }, opts, record, diagnostics);
}

async function syncDriveFile(file: GoogleDriveFile, rawOpts: FinishingOptions, record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void, diagnostics: GmeetSyncDiagnostics): Promise<DriveOutcome & { failed?: boolean }> {
  const opts = withStorageRetry(rawOpts, diagnostics);
  const fileId = file.id?.trim();
  if (!fileId) { terminalDriveItem(diagnostics, "drive_missing_id"); return { failed: true }; }
  // A snapshot can surface a trashed file without a separate Changes removal.
  // Remove its prior attachment/body, but never ask Docs to read deleted data.
  if (file.trashed) return syncDriveChange({ fileId, removed: true }, rawOpts, record, diagnostics);
  if (file.mimeType !== "application/vnd.google-apps.document") { terminalDriveItem(diagnostics, "drive_non_google_doc"); return {}; }
  diagnostics.drive_google_docs_discovered++;
  const likelyNotes = isLikelyGmeetNotesFile(file);
  if (likelyNotes) diagnostics.drive_metadata_candidate++;
  // An already-associated exported transcript is eligible even if its Drive
  // name no longer carries the marker; all other files must pass metadata gate.
  // The preloaded index answers "no association" without a storage call; a hit is
  // re-read so every write below starts from the row's current contents.
  const indexed = opts.ctx?.lookup ? opts.ctx.lookup(fileId) : undefined;
  const association = indexed === null
    ? { ok: true as const, data: null }
    : await opts.step(() => opts.store.findGmeetNotesAssociation!(opts.tcw, SOURCE, fileId, null, null), true);
  if (!association.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); record(fileId, "error", fromStore(association.error, "findGmeetNotesAssociation").message); return { failed: true }; }
  if (!likelyNotes && association.data === null) { terminalDriveItem(diagnostics, "drive_metadata_non_candidate"); return {}; }
  if (!likelyNotes) diagnostics.drive_association_bypass++;
  let migrationTarget: { id: string; sourceId: string; title: string | null; startedAt: string | null; metadata: Record<string, unknown> } | null = null;
  if (association.data?.sourceId === fileId && association.data.title !== null && association.data.startedAt !== null
    && association.data.metadata.datetime_exact === true) {
    const migration = await opts.step(() => opts.store.findGmeetNotesAssociation!(
      opts.tcw, SOURCE, fileId, association.data!.title, association.data!.startedAt, fileId,
    ), true);
    if (!migration.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); record(fileId, "error", fromStore(migration.error, "findGmeetNotesAssociation").message); return { failed: true }; }
    migrationTarget = migration.data;
  }
  const needsDatetimeResolution = association.data?.startedAt === null
    && association.data.metadata.datetime_resolution_version !== GMEET_DATETIME_RESOLUTION_VERSION;
  if (typeof file.modifiedTime === "string" && file.modifiedTime.length > 0
    && association.data?.metadata.drive_modified_time === file.modifiedTime && migrationTarget === null
    && !needsDatetimeResolution) {
    terminalDriveItem(diagnostics, "drive_unchanged_associated");
    diagnostics.datetime_rows_unchanged++;
    record(fileId, "skipped", "Drive file unchanged");
    return {};
  }
  const doc = await opts.step(() => opts.ctx?.takeDoc?.(fileId) ?? opts.client.getDriveDocument!(fileId, { signal: opts.signal }));
  diagnostics.drive_docs_get_attempted++;
  if (!doc.ok) {
    if (doc.error.kind === "aborted") { terminalDriveItem(diagnostics, "drive_docs_get_aborted"); return { aborted: true }; }
    if (isTerminalGmeetError(doc.error)) {
      terminalDriveItem(diagnostics, "drive_docs_get_failed_terminal");
      record(fileId, "error", doc.error.message);
      return { terminal: fromGmeetError(doc.error) };
    }
    terminalDriveItem(diagnostics, "drive_docs_get_failed_retryable");
    record(fileId, "error", doc.error.message); return { failed: true };
  }
  diagnostics.drive_docs_get_succeeded++;
  const parsedOutcome = diagnoseGmeetNotesDocument(doc.data, {
    fileId,
    createdTime: file.createdTime ?? null,
    modifiedTime: file.modifiedTime ?? null,
    verifiedCandidate: likelyNotes,
  });
  if (!parsedOutcome.ok) {
    // A previously valid Notes document can lose its marker or every Notes
    // section. Its content was read successfully, so remove only this file's
    // owned fields/body before allowing the Changes cursor to advance.
    if (association.data !== null) {
      const removed = await opts.step(() => opts.store.removeGmeetNotes!(opts.tcw, SOURCE, fileId), true);
      if (!removed.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); record(fileId, "error", fromStore(removed.error, "removeGmeetNotes").message); return { failed: true }; }
      recordRemovalMutation(diagnostics, removed.data);
      terminalDriveItem(diagnostics, parsedOutcome.reason === "no-marker" ? "drive_parser_rejected_no_marker" : "drive_parser_rejected_no_supported_section");
      record(fileId, "updated");
      return {};
    }
    terminalDriveItem(diagnostics, parsedOutcome.reason === "no-marker" ? "drive_parser_rejected_no_marker" : "drive_parser_rejected_no_supported_section");
    record(fileId, "skipped", "document is not a valid Notes by Gemini record");
    return {};
  }
  diagnostics.drive_parser_accepted++;
  const parsed = parsedOutcome.data;
  const exactIdentity = parsed.meeting.metadata.datetime_exact === true;
  const identityTitle = exactIdentity ? parsed.meeting.title : null;
  const identityStartedAt = exactIdentity ? parsed.meeting.startedAt : null;
  const target = association.data?.sourceId === fileId
    ? (migrationTarget === null
      ? await opts.step(() => opts.store.findGmeetNotesAssociation!(opts.tcw, SOURCE, fileId, identityTitle, identityStartedAt, fileId), true)
      : { ok: true as const, data: migrationTarget })
    : association.data === null
      ? await opts.step(() => opts.store.findGmeetNotesAssociation!(opts.tcw, SOURCE, fileId, identityTitle, identityStartedAt), true)
      : association;
  if (!target.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); diagnostics.drive_post_parse_storage_failed++; record(fileId, "error", fromStore(target.error, "findGmeetNotesAssociation").message); return { failed: true }; }
  if (target.data && target.data.sourceId !== fileId) {
    const attached = await opts.step(() => opts.store.attachGmeetNotes!(opts.tcw, target.data!, parsed.meeting), true);
    if (!attached.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); diagnostics.drive_post_parse_storage_failed++; record(fileId, "error", fromStore(attached.error, "attachGmeetNotes").message); return { failed: true }; }
    if (target.data.startedAt === null && parsed.meeting.startedAt !== null) diagnostics.datetime_rows_backfilled++;
    if (association.data?.sourceId === fileId) {
      const removed = await opts.step(() => opts.store.removeGmeetNotes!(opts.tcw, SOURCE, fileId), true);
      if (!removed.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); diagnostics.drive_post_parse_storage_failed++; record(fileId, "error", fromStore(removed.error, "removeGmeetNotes").message); return { failed: true }; }
      recordRemovalMutation(diagnostics, removed.data);
      terminalDriveItem(diagnostics, "drive_accepted_migrated");
    } else {
      terminalDriveItem(diagnostics, "drive_accepted_attached");
    }
    record(fileId, "updated"); return {};
  }
  const standalone = { ...parsed.meeting, metadata: { ...parsed.meeting.metadata, notes_association: "standalone" } };
  // As with Meet transcripts, the body reaches KV before its visible row.
  const body = await opts.step(() => opts.store.putTranscriptBody(opts.tcw, SOURCE, fileId, parsed.sentences), true);
  if (!body.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); diagnostics.drive_post_parse_storage_failed++; record(fileId, "error", fromStore(body.error, "putTranscriptBody(notes)").message); return { failed: true }; }
  const write = await opts.step(() => opts.store.upsertMeeting(opts.tcw, standalone, parsed.sentences), true);
  if (!write.ok) { terminalDriveItem(diagnostics, "drive_storage_failed"); diagnostics.drive_post_parse_storage_failed++; record(fileId, "error", fromStore(write.error, "upsertMeeting(notes)").message); return { failed: true }; }
  terminalDriveItem(diagnostics, write.data.inserted ? "drive_accepted_standalone_created" : "drive_accepted_standalone_updated");
  if (!write.data.inserted && association.data?.startedAt === null && parsed.meeting.startedAt !== null) {
    diagnostics.datetime_rows_backfilled++;
  }
  if (write.data.inserted) diagnostics.drive_rows_inserted++;
  record(fileId, write.data.inserted ? "created" : "updated");
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
  opts: GmeetSyncOptions,
): Promise<RecordOutcome> {
  const { client, store, tcw, signal } = opts;
  const recordName = conferenceRecord.name;
  const sourceId = recordName.replace(/^\/*conferenceRecords\//, "");

  const participantsRes = await client.listParticipants(recordName, { signal });
  if (!participantsRes.ok) {
    return classifyRecordFailure(sourceId, participantsRes.error);
  }

  const transcriptsRes = await client.listTranscripts(recordName, { signal });
  if (!transcriptsRes.ok) {
    return classifyRecordFailure(sourceId, transcriptsRes.error);
  }

  // State gate. A STARTED transcript is still being written — persisting it
  // would commit a partial conversation as if it were the whole meeting.
  const persistable = transcriptsRes.data.filter((t) => isPersistableTranscriptState(t.state));
  if (persistable.length === 0) {
    const reason =
      transcriptsRes.data.length === 0
        ? "no transcript for this conference"
        : "transcript not finished yet";
    return { sourceId, outcome: "skipped", reason };
  }

  const bundles: GmeetTranscriptBundle[] = [];
  let entryCount = 0;
  for (const transcript of persistable) {
    const entriesRes = await client.listTranscriptEntries(transcript.name, { signal });
    if (!entriesRes.ok) {
      return classifyRecordFailure(sourceId, entriesRes.error);
    }
    entryCount += entriesRes.data.length;
    bundles.push({ transcript, entries: entriesRes.data });
  }

  // The deliberate late-artifact retry: entries are listable at ENDED, but they
  // do not all land at once. An empty read persists NOTHING — no blob, no row —
  // and the LAG_BUFFER re-sweep picks the record up on a later run once the
  // entries exist.
  if (entryCount === 0) {
    return { sourceId, outcome: "skipped", reason: "transcript entries not available yet" };
  }

  const { meeting, sentences } = normalizeGoogleMeetTranscript({
    record: conferenceRecord,
    participants: participantsRes.data,
    transcripts: bundles,
  });
  meeting.metadata = {
    ...meeting.metadata,
    datetime_source: meeting.startedAt === null ? "unavailable" : "meet_conference_start",
    datetime_exact: meeting.startedAt !== null,
    datetime_resolution_version: GMEET_DATETIME_RESOLUTION_VERSION,
  };

  if (sentences.length === 0) {
    // Entries existed but none carried text — same treatment as no entries.
    return { sourceId, outcome: "skipped", reason: "transcript entries carried no text" };
  }

  // ORDER MATTERS — blob first, row last. Storage calls are sequential:
  // TinyCloud drops concurrent responses on one space.
  const kvRes = await store.putTranscriptBody(tcw, SOURCE, meeting.sourceId, sentences);
  if (!kvRes.ok) {
    return { sourceId, outcome: "error", reason: fromStore(kvRes.error, "putTranscriptBody").message };
  }

  // upsertMeeting, never insertMeeting: the re-sweep overlap re-visits records
  // that are already stored, and the merge semantics (keep-existing-on-null +
  // metadata merge) make that a repair instead of a duplicate. `sentences` is
  // passed through even though the blob is already written — upsertMeeting
  // writes the identical body again on the insert path, and handing it an empty
  // array would clobber the blob we just wrote.
  const upsertRes = await store.upsertMeeting(tcw, meeting, sentences);
  if (!upsertRes.ok) {
    return { sourceId, outcome: "error", reason: fromStore(upsertRes.error, "upsertMeeting").message };
  }

  const reconciled = await reconcileNotesFirstConference(opts, meeting, upsertRes.data.id);
  if (!reconciled.ok) {
    return { sourceId, outcome: "error", reason: reconciled.reason };
  }

  return {
    sourceId,
    outcome: upsertRes.data.inserted ? "created" : "updated",
    rowInserted: upsertRes.data.inserted,
    driveRowDeleted: reconciled.driveRowDeleted,
  };
}

/**
 * A Gemini Notes Doc can appear before Meet exposes the conference transcript.
 * Once that transcript arrives, migrate a uniquely matching Notes-first row
 * even when Drive Changes is empty; Drive is not the source of that event.
 */
async function reconcileNotesFirstConference(
  opts: GmeetSyncOptions,
  conference: NormalizedMeeting,
  conferenceRowId: string,
): Promise<{ ok: true; driveRowDeleted: boolean } | { ok: false; reason: string }> {
  const { store, tcw } = opts;
  if (!store.findGmeetNotesAssociation || !store.attachGmeetNotes || !store.removeGmeetNotes
    || conference.title === null || conference.startedAt === null) return { ok: true, driveRowDeleted: false };

  const candidate = await store.findGmeetNotesAssociation(
    tcw, SOURCE, conference.sourceId, conference.title, conference.startedAt, conference.sourceId,
  );
  if (!candidate.ok) return { ok: false, reason: fromStore(candidate.error, "findGmeetNotesAssociation").message };
  const standalone = candidate.data;
  const owned = standalone?.metadata.notes_owned_fields;
  if (!standalone || standalone.metadata.notes_association !== "standalone" || standalone.metadata.notes_kind !== "gemini"
    || !Array.isArray(owned) || !owned.includes("summary_overview") || !owned.includes("summary_action_items")) {
    return { ok: true, driveRowDeleted: false };
  }

  const attached = await store.attachGmeetNotes(tcw, {
    id: conferenceRowId,
    sourceId: conference.sourceId,
    title: conference.title,
    startedAt: conference.startedAt,
    metadata: conference.metadata,
  }, {
    startedAt: standalone.startedAt,
    summaryOverview: standalone.summaryOverview ?? null,
    summaryActionItems: standalone.summaryActionItems ?? null,
    metadata: standalone.metadata,
  });
  if (!attached.ok) return { ok: false, reason: fromStore(attached.error, "attachGmeetNotes").message };
  const removed = await store.removeGmeetNotes(tcw, SOURCE, standalone.sourceId);
  if (!removed.ok) return { ok: false, reason: fromStore(removed.error, "removeGmeetNotes").message };
  return { ok: true, driveRowDeleted: removed.data === "deleted" };
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
