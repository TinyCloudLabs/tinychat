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
} from "./gmeetClient";
import {
  GMEET_MEETING_SOURCE,
  normalizeGoogleMeetTranscript,
  type GmeetTranscriptBundle,
} from "./gmeetNormalize";
import { parseGmeetNotesDocument } from "./gmeetNotes";
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
  getDriveDocument?(fileId: string, opts?: GmeetCallOptions): Promise<GmeetResult<Record<string, unknown>>>;
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
  getDriveCursor?(tcw: TinyCloudWeb, source: string): Promise<StoreResult<string | null>>;
  putDriveCursor?(tcw: TinyCloudWeb, source: string, cursor: string): Promise<StoreResult<void>>;
  findGmeetNotesAssociation?(tcw: TinyCloudWeb, source: string, fileId: string, title: string | null, startedAt: string | null): Promise<StoreResult<{
    id: string; sourceId: string; title: string | null; startedAt: string | null; metadata: Record<string, unknown>;
  } | null>>;
  attachGmeetNotes?(tcw: TinyCloudWeb, row: { id: string; sourceId: string; title: string | null; startedAt: string | null; metadata: Record<string, unknown> }, notes: Pick<NormalizedMeeting, "summaryOverview" | "summaryActionItems" | "metadata">): Promise<StoreResult<void>>;
  removeGmeetNotes?(tcw: TinyCloudWeb, source: string, fileId: string): Promise<StoreResult<void>>;
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
  onProgress?: (progress: GmeetSyncProgress) => void;
  signal?: AbortSignal;
  /** Clock seam — tests pin the window arithmetic. Defaults to Date.now. */
  now?: () => number;
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

async function runGoogleMeetSync(opts: GmeetSyncOptions): Promise<GmeetSyncResult> {
  const { client, store, tcw, onProgress, signal } = opts;
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
    return { ok: false, error, data: null };
  }
  const watermarkIso = connRes.data?.lastSyncedAt ?? null;
  const windowStartIso = gmeetSyncWindowStartIso(watermarkIso, nowMs);

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
      const drive = await syncDriveNotes(opts, record);
      if (drive.terminal) terminal = drive.terminal;
      if (drive.aborted) aborted = true;
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

  // The watermark advances ONLY on a completed run. Advancing it after a
  // terminal error or an abort would silently narrow the next window past
  // records this run never looked at.
  const completed = terminal === null && !aborted;
  const updateRes = await store.updateSyncState(tcw, {
    connectorId: SOURCE,
    status: "connected",
    lastSyncedAt: completed ? startedAtIso : watermarkIso,
    lastSyncStatus: terminal ? "error" : "ok",
    lastSyncError: terminal?.message ?? null,
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
    return { ok: false, error: terminal, data: summary() };
  }
  emit("complete");
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

interface DriveOutcome { terminal?: GmeetSyncError; aborted?: boolean }

async function syncDriveNotes(
  opts: GmeetSyncOptions,
  record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void,
): Promise<DriveOutcome> {
  const { client, store, tcw, signal } = opts;
  // Optional methods preserve compatibility with deliberately narrow external test clients.
  if (!client.listDriveFiles || !client.getDriveStartPageToken || !client.listDriveChangesPage || !client.getDriveDocument
    || !store.getDriveCursor || !store.putDriveCursor || !store.findGmeetNotesAssociation || !store.attachGmeetNotes || !store.removeGmeetNotes) return {};

  const cursor = await store.getDriveCursor(tcw, SOURCE);
  if (!cursor.ok) return { terminal: fromStore(cursor.error, "getDriveCursor") };
  if (signal?.aborted) return { aborted: true };
  if (cursor.data === null) return snapshotDriveNotes(opts, record);

  let pageToken = cursor.data;
  let finalCursor: string | null = null;
  let anyFailure = false;
  while (true) {
    const page = await client.listDriveChangesPage(pageToken, { signal });
    if (!page.ok) {
      if (page.error.kind === "aborted") return { aborted: true };
      // A stale Drive token is explicitly recovered with a fresh guarded snapshot.
      if (page.error.kind === "not-found" || page.error.status === 410) return snapshotDriveNotes(opts, record);
      return { terminal: fromGmeetError(page.error) };
    }
    let pageFailed = false;
    for (const change of page.data.changes) {
      const outcome = await syncDriveChange(change, opts, record);
      if (outcome.aborted) return outcome;
      if (outcome.terminal) return outcome;
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
    break;
  }
  if (anyFailure) return {};
  if (!finalCursor) return { terminal: { kind: "network", message: "Google Drive changes page had no new start token" } };
  const write = await store.putDriveCursor(tcw, SOURCE, finalCursor);
  return write.ok ? {} : { terminal: fromStore(write.error, "putDriveCursor") };
}

async function snapshotDriveNotes(opts: GmeetSyncOptions, record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void): Promise<DriveOutcome> {
  const { client, store, tcw, signal } = opts;
  if (!client.getDriveStartPageToken || !client.listDriveFiles || !store.putDriveCursor) return {};
  const start = await client.getDriveStartPageToken({ signal });
  if (!start.ok) {
    if (start.error.kind === "aborted") return { aborted: true };
    // Refresh tokens granted before Notes support have only the Meet scopes.
    // Keep their established Meet sync working; reconnecting renews the grant
    // with the Docs scopes and lets a later run take this first snapshot.
    if (start.error.kind === "forbidden") {
      record("drive-notes", "skipped", "Reconnect Google Meet to sync Notes by Gemini");
      return {};
    }
    return { terminal: fromGmeetError(start.error) };
  }
  const files = await client.listDriveFiles({ signal });
  if (!files.ok) return files.error.kind === "aborted" ? { aborted: true } : { terminal: fromGmeetError(files.error) };
  let failed = false;
  for (const file of files.data) {
    const outcome = await syncDriveFile(file, opts, record);
    if (outcome.aborted || outcome.terminal) return outcome;
    if (outcome.failed) failed = true;
  }
  if (failed) return {};
  const write = await store.putDriveCursor(tcw, SOURCE, start.data);
  return write.ok ? {} : { terminal: fromStore(write.error, "putDriveCursor") };
}

async function syncDriveChange(change: GoogleDriveChange, opts: GmeetSyncOptions, record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void): Promise<DriveOutcome & { failed?: boolean }> {
  const fileId = change.fileId ?? change.file?.id;
  if (!fileId) return { failed: true };
  if (change.removed || change.file?.trashed) {
    const removed = await opts.store.removeGmeetNotes!(opts.tcw, SOURCE, fileId);
    if (!removed.ok) { record(fileId, "error", fromStore(removed.error, "removeGmeetNotes").message); return { failed: true }; }
    record(fileId, "updated");
    return {};
  }
  return syncDriveFile(change.file ?? { id: fileId }, opts, record);
}

async function syncDriveFile(file: GoogleDriveFile, opts: GmeetSyncOptions, record: (sourceId: string, outcome: GmeetItemOutcome, reason?: string) => void): Promise<DriveOutcome & { failed?: boolean }> {
  const fileId = file.id?.trim();
  if (!fileId) return { failed: true };
  // An already-associated exported transcript is eligible even if its Drive
  // name no longer carries the marker; all other files must pass metadata gate.
  const association = await opts.store.findGmeetNotesAssociation!(opts.tcw, SOURCE, fileId, null, null);
  if (!association.ok) { record(fileId, "error", fromStore(association.error, "findGmeetNotesAssociation").message); return { failed: true }; }
  if (!isLikelyGmeetNotesFile(file) && association.data === null) { record(fileId, "skipped", "not a Notes by Gemini document"); return {}; }
  if (typeof file.modifiedTime === "string" && file.modifiedTime.length > 0
    && association.data?.metadata.drive_modified_time === file.modifiedTime) {
    record(fileId, "skipped", "Drive file unchanged");
    return {};
  }
  const doc = await opts.client.getDriveDocument!(fileId, { signal: opts.signal });
  if (!doc.ok) {
    if (doc.error.kind === "aborted") return { aborted: true };
    if (isTerminalGmeetError(doc.error)) {
      record(fileId, "error", doc.error.message);
      return { terminal: fromGmeetError(doc.error) };
    }
    record(fileId, "error", doc.error.message); return { failed: true };
  }
  const parsed = parseGmeetNotesDocument(doc.data, { fileId, modifiedTime: file.modifiedTime ?? null });
  if (!parsed) { record(fileId, "skipped", "document is not a valid Notes by Gemini record"); return {}; }
  const target = association.data === null
    ? await opts.store.findGmeetNotesAssociation!(opts.tcw, SOURCE, fileId, parsed.meeting.title, parsed.meeting.startedAt)
    : association;
  if (!target.ok) { record(fileId, "error", fromStore(target.error, "findGmeetNotesAssociation").message); return { failed: true }; }
  if (target.data && target.data.sourceId !== fileId) {
    const attached = await opts.store.attachGmeetNotes!(opts.tcw, target.data, parsed.meeting);
    if (!attached.ok) { record(fileId, "error", fromStore(attached.error, "attachGmeetNotes").message); return { failed: true }; }
    record(fileId, "updated"); return {};
  }
  const standalone = { ...parsed.meeting, metadata: { ...parsed.meeting.metadata, notes_association: "standalone" } };
  // As with Meet transcripts, the body reaches KV before its visible row.
  const body = await opts.store.putTranscriptBody(opts.tcw, SOURCE, fileId, parsed.sentences);
  if (!body.ok) { record(fileId, "error", fromStore(body.error, "putTranscriptBody(notes)").message); return { failed: true }; }
  const write = await opts.store.upsertMeeting(opts.tcw, standalone, parsed.sentences);
  if (!write.ok) { record(fileId, "error", fromStore(write.error, "upsertMeeting(notes)").message); return { failed: true }; }
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

  return { sourceId, outcome: upsertRes.data.inserted ? "created" : "updated" };
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
