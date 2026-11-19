// Granola sync engine (granola plan S2). The Fireflies file is the model, cut
// down to what a cursor-paged upstream needs:
//
//  - INCREMENTAL, not offset-paged: `updated_after = lastSyncedAt - overlap`
//    means a note's own clock decides whether it is listed; there is no
//    resumable listing offset to persist. A mid-run abort simply re-lists a
//    slightly overlapping window next time, and upserts are idempotent.
//  - SKIP-UNCHANGED: `metadata.granola_updated_at` on the stored row is
//    compared to the summary's `updated_at`; a note the overlap re-lists but
//    that did not change costs zero detail or transcript calls.
//  - TRANSCRIPTS are always paged through `/transcript` at 100 — the detail
//    endpoint's `include=transcript` can 413, this one cannot. A missing or
//    admin-disabled transcript is not an error: the meeting keeps its summary.
//  - NOT STORED, per the plan's §3 ruling: `private_notes_*` and attachment
//    URLs (they are unauthenticated). `has_private_notes` and a COUNT ride in
//    metadata instead.
//
// Ordering: detail fetches run OLDEST-first so a mid-run abort leaves a
// contiguous history tail. Client calls pace at the client's delayMs.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { connectorMeetingId, type TranscriptSentence } from "@tinyboilerplate/core";

import type {
  GranolaError,
  GranolaNote,
  GranolaResult,
  GranolaTranscriptItem,
  GranolaNotePage,
} from "./granolaClient";
import { GRANOLA_SECRET_NAME } from "./granolaFeature";
import {
  GRANOLA_KEY_EXPIRED,
  GRANOLA_PLAN_INACTIVE,
  GRANOLA_SAVED_KEY_WARNING,
  GRANOLA_SUMMARIES_ONLY,
  GRANOLA_SYNC_ERROR,
  GRANOLA_SYNC_PARTIAL,
} from "./granolaStatus";
import { deleteConnectorKey, saveConnectorKey, type SecretsErr } from "./connectorSecrets";
import * as connectorStore from "./connectorStore";
import {
  type NormalizedMeeting,
  type StoreError,
  type StoreResult,
  type UpdateSyncStateInput,
  type UpsertMeetingOutcome,
} from "./connectorStore";
import { isStorageFullError } from "../storageStatus";
import { runOnSpaceLane } from "../spaceWriteLane";
import type { SyncProgress, SyncResult } from "./types";

export const GRANOLA_SOURCE = "granola" as const;
/** Re-list a little behind the watermark: an in-flight edit can clock-skew past it. */
export const GRANOLA_INCREMENTAL_OVERLAP_MS = 60_000;
/** Detail fetches a single run will make — the page budget's own bound. */
export const GRANOLA_MAX_DETAILS_PER_RUN = 250;
const GRANOLA_SECRET = { secretName: GRANOLA_SECRET_NAME };

/** Serialize credential and connection writes with Granola's sync writes. */
export function saveGranolaConnection(
  tcw: TinyCloudWeb, key: string, current: () => boolean,
): Promise<boolean> {
  return runOnSpaceLane(async () => {
    if (!current() || !(await connectorStore.ensureSchema(tcw)).ok || !current()) return false;
    const previous = await connectorStore.getConnection(tcw, GRANOLA_SOURCE);
    if (!previous.ok || !current()) return false;
    const stored = await saveConnectorKey(tcw, GRANOLA_SECRET, key);
    if (!stored.ok || !current()) return false;
    if (previous.data?.status === "connected") return true;
    return (await connectorStore.updateSyncState(tcw, {
      connectorId: GRANOLA_SOURCE, status: "connected", lastSyncedAt: null,
      lastSyncStatus: null, lastSyncError: null, itemCount: 0,
    })).ok;
  });
}

export function clearGranolaKey(tcw: TinyCloudWeb, current: () => boolean): Promise<boolean> {
  return runOnSpaceLane(async () => {
    if (!current()) return false;
    const cleared = await deleteConnectorKey<SecretsErr>(tcw, GRANOLA_SECRET);
    return cleared.ok || cleared.error.code === "NOT_FOUND";
  });
}

/** Structural surface of GranolaClient used by the engine; tests hand-roll a mock. */
export interface GranolaSyncClient {
  readonly delayMs: number;
  listNotes(opts: {
    pageSize?: number;
    cursor?: string | null;
    updatedAfter?: string | null;
    signal?: AbortSignal;
  }): Promise<GranolaResult<GranolaNotePage>>;
  getNote(id: string, signal?: AbortSignal): Promise<GranolaResult<GranolaNote>>;
  getTranscript(
    id: string,
    opts?: { signal?: AbortSignal },
  ): Promise<GranolaResult<{ items: GranolaTranscriptItem[]; truncated: boolean; access?: "allowed" | "disabled" }>>;
}

/** Structural surface of connectorStore used by the engine. */
export interface GranolaSyncStore {
  ensureSchema(tcw: TinyCloudWeb): Promise<StoreResult<void>>;
  listMeetingMetadataValues(
    tcw: TinyCloudWeb,
    source: string,
    metadataKey: string,
  ): Promise<StoreResult<Record<string, string | null>>>;
  upsertMeeting(
    tcw: TinyCloudWeb,
    meeting: NormalizedMeeting,
    sentences: TranscriptSentence[],
  ): Promise<StoreResult<UpsertMeetingOutcome>>;
  updateSyncState(tcw: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>>;
  getConnection(tcw: TinyCloudWeb, connectorId: "granola"): Promise<StoreResult<{
    status: "connected" | "disconnected";
    lastSyncedAt: string | null;
    lastSyncError?: string | null;
  } | null>>;
  countMeetings(tcw: TinyCloudWeb, source: string): Promise<StoreResult<number>>;
}

export type SyncErrorKind = "auth" | "rate-limited" | "network" | "storage";

export interface SyncError {
  kind: SyncErrorKind;
  message: string;
  reconnect?: true;
  /** Only present when kind === "rate-limited". */
  retryAfterMs?: number;
}

export type SyncGranolaResult =
  | { ok: true; data: SyncResult }
  | { ok: false; error: SyncError };

export interface SyncGranolaOptions {
  client: GranolaSyncClient;
  store: GranolaSyncStore;
  tcw: TinyCloudWeb;
  checkPurge: (meetingId: string, sourceTimestamp: string | null) => Promise<boolean>;
  onProgress?: (progress: SyncProgress) => void;
  signal?: AbortSignal;
  detailCap?: number;
  pageBudget?: number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  /** False after account/session generation changes. */
  isCurrent?: () => boolean;
  onJoined?: () => void;
  onJoinSettled?: () => void;
  /** Stable timestamp injection for deterministic tests. */
  now?: () => string;
}

let flightSequence = 0;
interface GranolaFlight {
  sequence: number;
  controller: AbortController;
  promise: Promise<SyncGranolaResult>;
}
let activeFlight: GranolaFlight | null = null;

export function isGranolaSyncInFlight(): boolean {
  return activeFlight !== null;
}

export async function abortGranolaSync(): Promise<void> {
  activeFlight?.controller.abort();
  const flight = activeFlight;
  if (flight) await flight.promise.catch(() => undefined);
}

function granolaSyncIsCurrent(opts: SyncGranolaOptions, sequence: number): boolean {
  if (flightSequence !== sequence) return false;
  try {
    return opts.isCurrent?.() !== false;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fromStore(err: StoreError, context: string): SyncError {
  return { kind: "storage", message: `${context}: ${err.message}` };
}

/** Map a GranolaError from client calls into a SyncError. */
export function fromGranola(err: GranolaError): SyncError {
  switch (err.kind) {
    case "invalid-key":
      return { kind: "auth", message: GRANOLA_SAVED_KEY_WARNING, reconnect: true };
    case "forbidden":
      return { kind: "auth", message: err.code === "SUBSCRIPTION_INACTIVE" ? GRANOLA_PLAN_INACTIVE : err.message };
    case "rate-limited":
      return { kind: "rate-limited", message: err.message, retryAfterMs: err.retryAfterMs };
    default:
      return { kind: "network", message: err.message };
  }
}

/** Auth and an exhausted 429 end the run; other per-item errors are collected. */
export function isTerminal(err: GranolaError): boolean {
  return err.kind === "invalid-key"
    || (err.kind === "forbidden" && err.code !== "FORBIDDEN")
    || err.kind === "rate-limited";
}

function inSpace<T>(_operation: string, run: () => Promise<T>): Promise<T> {
  return runOnSpaceLane(run);
}

/** One Granola write on the shared space lane; the CSV import queues its writes here too. */
export function runGranolaSpaceWrite<T>(run: () => Promise<T>): Promise<T> {
  return runOnSpaceLane(run);
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Mapping ─────────────────────────────────────────────────────────────

function parseTime(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** One invitee/attendee pair deduped by email-then-name, cheapest wins kept. */
function participantsOf(note: GranolaNote): { name: string; email: string | null }[] {
  const out: { name: string; email: string | null }[] = [];
  const seenEmails = new Set<string>();
  const seenNames = new Set<string>();
  const push = (name: string | null, email: string | null) => {
    const trimmedName = name?.trim() ?? "";
    const trimmedEmail = email?.trim() ?? "";
    if (trimmedName.length === 0 && trimmedEmail.length === 0) return;
    const finalName = trimmedName.length > 0 ? trimmedName : trimmedEmail;
    if (trimmedEmail.length > 0) {
      const key = trimmedEmail.toLowerCase();
      if (seenEmails.has(key)) return;
      seenEmails.add(key);
    }
    if (seenNames.has(finalName)) return;
    seenNames.add(finalName);
    out.push({ name: finalName, email: trimmedEmail.length > 0 ? trimmedEmail : null });
  };
  for (const attendee of note.attendees) push(attendee.name, attendee.email);
  for (const invitee of note.calendar_event?.invitees ?? []) push(null, invitee.email);
  return out;
}

/** Folder/space memberships pass through as opaque lists of names we can read. */
function membershipNames(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.length > 0) names.push(entry);
    else if (typeof entry === "object" && entry !== null) {
      const name = (entry as Record<string, unknown>).name ?? (entry as Record<string, unknown>).title;
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return names;
}

/**
 * Note + transcript items → NormalizedMeeting + TranscriptSentence[].
 *
 * Speaker name: `name` → diarization label → the note owner when Granola says
 * the line came from the microphone ("me") → null. Utterance times arrive as
 * ISO datetimes; the body uses seconds from the first timed utterance.
 * Keep that instant as meeting metadata to recover the original clock times.
 */
export async function normalizeGranolaNote(
  note: GranolaNote,
  items: GranolaTranscriptItem[],
  transcriptTruncated: boolean,
): Promise<{ meeting: NormalizedMeeting; sentences: TranscriptSentence[] }> {
  const ownerName = note.owner?.name ?? null;

  const sentences: TranscriptSentence[] = [];
  let firstMs: number | null = null;
  let index = 0;
  for (const item of items) {
    const text = typeof item.text === "string" ? item.text : "";
    if (text.length === 0) continue;
    const startMs = parseTime(item.start_time);
    firstMs ??= startMs;
    const endMs = parseTime(item.end_time);
    // Timestamps are ISO instants; offset them against the first utterance.
    // Phone/watch items can share one timestamp — that becomes a zero span.
    const startSec = firstMs !== null && startMs !== null
      ? Math.max(0, (startMs - firstMs) / 1000)
      : index;
    const endSec = firstMs !== null && endMs !== null
      ? Math.max(startSec, (endMs - firstMs) / 1000)
      : startSec;
    const speaker = item.speaker;
    const speakerName = speaker?.name
      ?? speaker?.diarization_label
      ?? (speaker?.attribution === "me" ? ownerName : null)
      ?? (speaker?.attribution === "them" ? "Other" : null);
    sentences.push({
      index,
      speaker_name: speakerName,
      text,
      start_time: startSec,
      end_time: endSec,
    });
    index++;
  }

  const event = note.calendar_event;
  const startMs = parseTime(event?.scheduled_start_time) ?? parseTime(note.created_at);
  const endMs = parseTime(event?.scheduled_end_time);
  const lastEnd = sentences.length > 0 ? sentences[sentences.length - 1]!.end_time : 0;
  let durationSecs: number | null = null;
  if (startMs !== null && endMs !== null && endMs > startMs) {
    durationSecs = Math.round((endMs - startMs) / 1000);
  } else if (lastEnd > 0) {
    durationSecs = Math.round(lastEnd);
  }

  const metadata: Record<string, unknown> = {
    web_url: note.web_url,
    folders: membershipNames(note.folder_membership),
    spaces: membershipNames(note.space_membership),
    granola_updated_at: note.updated_at,
    granola_created_at: note.created_at,
    transcript_state: transcriptTruncated
      ? "truncated"
      : sentences.length > 0 ? "stored" : "absent",
    owner_name: ownerName,
    owner_email: note.owner?.email ?? null,
  };
  if (firstMs !== null) metadata.granola_transcript_started_at = new Date(firstMs).toISOString();
  if (note.attachment_count > 0) metadata.attachment_count = note.attachment_count;
  if (durationSecs !== null) metadata.duration_source = "calendar_event";

  const meeting: NormalizedMeeting = {
    // Deterministic, so a reconnect's upsert lands on the same row id.
    id: await connectorMeetingId(GRANOLA_SOURCE, note.id),
    source: GRANOLA_SOURCE,
    sourceId: note.id,
    title: note.title ?? event?.event_title ?? null,
    startedAt: startMs !== null ? new Date(startMs).toISOString() : null,
    durationSecs,
    organizerEmail: event?.organiser ?? null,
    participants: participantsOf(note),
    summaryOverview: note.summary_markdown ?? note.summary_text ?? null,
    summaryActionItems: null, // Granola has no separate action-items field.
    keywords: null,
    meetingType: null,
    metadata,
  };
  return { meeting, sentences };
}

// ── Engine ──────────────────────────────────────────────────────────────

export async function syncGranola(
  opts: SyncGranolaOptions,
): Promise<SyncGranolaResult> {
  if (activeFlight) {
    const joined = activeFlight;
    opts.onJoined?.();
    const joinedResult = await joined.promise;
    opts.onJoinSettled?.();
    return joinedResult;
  }

  const sequence = ++flightSequence;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const flight: GranolaFlight = {
    sequence,
    controller,
    promise: Promise.resolve({ ok: true, data: { added: 0, skipped: 0, errors: [] } }),
  };
  activeFlight = flight;
  flight.promise = runGranolaSync(opts, controller.signal, sequence);
  try {
    return await flight.promise;
  } finally {
    opts.signal?.removeEventListener("abort", abortFromCaller);
    if (activeFlight === flight) activeFlight = null;
  }
}

async function runGranolaSync(
  opts: SyncGranolaOptions,
  signal: AbortSignal,
  sequence: number,
): Promise<SyncGranolaResult> {
  const { client, store, tcw, onProgress } = opts;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const delayMs = client.delayMs ?? 0;
  const current = () => granolaSyncIsCurrent(opts, sequence);
  const result: SyncResult = { added: 0, skipped: 0, errors: [] };
  const attemptAt = opts.now?.() ?? new Date().toISOString();
  let terminal: SyncError | null = null;
  let listingComplete = false;
  let summariesOnly = false;
  let transcriptAllowed = false;
  let transcriptDisabled = false;
  /** The watermark this run started from — preserved verbatim on any non-ok outcome. */
  let previousWatermark: string | null = null;
  if (!current()) return { ok: true, data: result };

  try {
    const schemaRes = await inSpace("Granola ensure schema", async () =>
      current() ? store.ensureSchema(tcw) : null);
    if (!current() || !schemaRes) return { ok: true, data: result };
    if (!schemaRes.ok) {
      terminal = fromStore(schemaRes.error, "ensureSchema");
    } else {
      const connectionRes = await inSpace("Granola read connection", async () =>
        current() ? store.getConnection(tcw, GRANOLA_SOURCE) : null);
      if (!current() || !connectionRes) return { ok: true, data: result };
      if (!connectionRes.ok) {
        terminal = fromStore(connectionRes.error, "getConnection");
      } else {
        const connection = connectionRes.data;
        if (connection?.status !== "connected") {
          return { ok: false, error: { kind: "network", message: "Granola is not connected" } };
        }
        previousWatermark = connection.lastSyncedAt;
        summariesOnly = connection.lastSyncError === GRANOLA_SUMMARIES_ONLY;

        const storedRes = await inSpace("Granola read stored update times", async () =>
          current() ? store.listMeetingMetadataValues(tcw, GRANOLA_SOURCE, "granola_updated_at") : null);
        if (!current() || !storedRes) return { ok: true, data: result };
        if (!storedRes.ok) {
          terminal = fromStore(storedRes.error, "listMeetingMetadataValues");
        } else {
          const storedUpdatedAt = storedRes.data;
          const updatedAfter = previousWatermark
            ? new Date(Date.parse(previousWatermark) - GRANOLA_INCREMENTAL_OVERLAP_MS).toISOString()
            : null;
          const pageBudget = opts.pageBudget ?? 40;
          const maxDetails = Number.isFinite(opts.detailCap)
            ? Math.max(0, Math.floor(opts.detailCap!))
            : GRANOLA_MAX_DETAILS_PER_RUN;

          // ── Listing: cursor-paged, `updated_after` filtered upstream. ──
          const summaries: { id: string; updated_at: string | null }[] = [];
          const seenIds = new Set<string>();
          let cursor: string | null = null;
          let pages = 0;
          let listingError: GranolaError | null = null;
          while (pages < pageBudget && current() && !signal.aborted && !listingError) {
            if (pages > 0 && !await sleep(delayMs, signal)) break;
            const page = await client.listNotes({
              cursor, updatedAfter, signal,
            });
            if (!page.ok) {
              listingError = page.error;
              break;
            }
            pages++;
            onProgress?.({ phase: "listing", done: summaries.length, total: null });
            for (const note of page.data.notes) {
              if (!note.id || note.deleted_at !== null || seenIds.has(note.id)) continue;
              seenIds.add(note.id);
              summaries.push({ id: note.id, updated_at: note.updated_at });
            }
            if (!page.data.hasMore || !page.data.cursor) { listingComplete = true; break; }
            cursor = page.data.cursor;
          }
          if (!current()) return { ok: true, data: result };
          if (listingError) {
            terminal = fromGranola(listingError);
          } else if (pages >= pageBudget && !listingComplete) {
            result.errors.push("Granola listing did not finish inside the page budget");
          }

          // ── Detail + transcript, oldest-first. ──
          if (!terminal) {
            const changed = summaries.filter((s) =>
              s.updated_at === null || storedUpdatedAt[s.id] !== s.updated_at);
            const skippedUnchanged = summaries.length - changed.length;
            result.skipped += skippedUnchanged;
            const queue = [...changed].reverse(); // oldest first
            const total = queue.length;
            onProgress?.({ phase: "fetching", done: 0, total });
            let detailsUsed = 0;
            for (let i = 0; i < queue.length; i++) {
              if (detailsUsed >= maxDetails) {
                result.errors.push(`Granola detail budget reached with ${queue.length - i} note(s) left`);
                break;
              }
              if (!current() || signal.aborted) break;
              if (detailsUsed > 0 && !await sleep(delayMs, signal)) break;
              detailsUsed++;
              const summary = queue[i]!;
              const noteRes = await client.getNote(summary.id, signal);
              if (!current()) return { ok: true, data: result };
              if (!noteRes.ok) {
                if (signal.aborted) break;
                if (noteRes.error.notFound) {
                  // Deleted or never summarized between list and read — skip.
                  result.skipped++;
                  continue;
                }
                result.errors.push(`${summary.id}: ${noteRes.error.message}`);
                if (isTerminal(noteRes.error)) { terminal = fromGranola(noteRes.error); break; }
                continue;
              }
              const txRes = await client.getTranscript(summary.id, { signal });
              if (!current()) return { ok: true, data: result };
              if (!txRes.ok) {
                if (signal.aborted) break;
                result.errors.push(`${summary.id}: ${txRes.error.message}`);
                if (isTerminal(txRes.error)) { terminal = fromGranola(txRes.error); break; }
                continue;
              }
              transcriptAllowed ||= txRes.data.access === "allowed";
              transcriptDisabled ||= txRes.data.access === "disabled";
              try {
                const { meeting, sentences } = await normalizeGranolaNote(
                  noteRes.data, txRes.data.items, txRes.data.truncated,
                );
                const write = await inSpace("Granola store meeting and transcript", async () => {
                  if (!current()) return null;
                  const before = await store.getConnection(tcw, GRANOLA_SOURCE);
                  if (!before.ok) return { error: before.error };
                  if (before.data?.status !== "connected") return { disconnected: true };
                  if (!current()) return null;
                  if (await opts.checkPurge(meeting.sourceId, meeting.startedAt)) return { purged: true };
                  if (!current() || signal.aborted) return null;
                  return { upsert: await store.upsertMeeting(tcw, meeting, sentences) };
                });
                if (!write) return { ok: true, data: result };
                if ("disconnected" in write) break;
                if ("purged" in write) { result.skipped++; continue; }
                if ("error" in write) {
                  terminal = fromStore(
                    write.error ?? { code: "STORE_ERROR", message: "Connection read failed" },
                    "getConnection before item write",
                  );
                  break;
                }
                if (!write.upsert.ok) {
                  result.errors.push(`${summary.id}: ${write.upsert.error.message}`);
                  if (isStorageFullError(write.upsert.error)) {
                    terminal = fromStore(write.upsert.error, "upsertMeeting");
                    break;
                  }
                  continue;
                }
                if (write.upsert.data.inserted) result.added++;
                else result.skipped++; // a changed note's upsert refreshes a stored row
                onProgress?.({ phase: "storing", done: i + 1, total });
              } catch (err) {
                result.errors.push(`${summary.id}: ${errorMessage(err)}`);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    if (current()) terminal = { kind: "storage", message: errorMessage(err) };
  }
  if (!current()) return { ok: true, data: result };

  // ── Sync state. Failure or partial never moves lastSyncedAt — we pass the
  // previous value back verbatim (updateSyncState's preserve flag is
  // fireflies-only, and a failed run must not wipe the watermark). ──
  let itemCount = 0;
  try {
    const countRes = await inSpace("Granola count meetings", async () =>
      current() ? store.countMeetings(tcw, GRANOLA_SOURCE) : null);
    if (!current() || !countRes) return { ok: true, data: result };
    if (!countRes.ok) terminal ??= fromStore(countRes.error, "countMeetings");
    else itemCount = countRes.data;

    const reconciled = listingComplete && !terminal && result.errors.length === 0 && !signal.aborted;
    const finalStatus: "ok" | "partial" | "error" =
      terminal ? "error" : reconciled ? "ok" : "partial";
    const stateRes = await inSpace("Granola update sync state", async () => {
      if (!current()) return null;
      const connectionRes = await store.getConnection(tcw, GRANOLA_SOURCE);
      if (!connectionRes.ok || !current()) return connectionRes;
      if (connectionRes.data?.status !== "connected") return { ok: true as const, data: undefined };
      return store.updateSyncState(tcw, {
        connectorId: GRANOLA_SOURCE,
        status: "connected",
        lastSyncedAt: finalStatus === "ok" ? attemptAt : previousWatermark,
        lastSyncStatus: finalStatus,
        lastSyncError: terminal
          ? terminal.reconnect ? GRANOLA_KEY_EXPIRED : GRANOLA_SYNC_ERROR
          : result.errors.length > 0
            ? GRANOLA_SYNC_PARTIAL
            : finalStatus === "ok" && (transcriptDisabled || (summariesOnly && !transcriptAllowed))
              ? GRANOLA_SUMMARIES_ONLY
              : null,
        itemCount,
      });
    });
    if (!current() || !stateRes) return { ok: true, data: result };
    if (!stateRes.ok) terminal ??= fromStore(stateRes.error, "updateSyncState");
    return terminal ? { ok: false, error: terminal } : { ok: true, data: result };
  } catch (err) {
    terminal = { kind: "storage", message: errorMessage(err) };
    if (!current()) return { ok: true, data: result };
    return { ok: false, error: terminal };
  }
}
