// Fireflies sync engine. See docs/connectors-spec.md §8.
//
// The engine is a plain async function — no React, no globals, everything
// injected (client, store, tcw). Real callers pass `import * as store from
// "./connectorStore"` and a real FirefliesClient; unit tests pass a fake
// store and a mock client. E2E drivers under test/connectors/ reuse the same
// entry point against the mock upstream + fake-tinycloud.
//
// Ordering (spec §8 step 3): the client returns new ids NEWEST-first from
// the paginator; the engine reverses to OLDEST-first before fetching so a
// mid-run abort leaves a contiguous history tail behind.
//
// listen bug we defend against: listen only slept between LIST pages, not
// between per-transcript detail fetches, and could burst-hit the rate limit
// on backfill. We sleep between detail fetches too.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type {
  FirefliesError,
  FirefliesListing,
  FirefliesResult,
  FirefliesSentence,
  FirefliesTranscript,
  ListNewTranscriptIdsOptions,
} from "./firefliesClient";
import { FIREFLIES_MAX_DETAIL_CAP, FIREFLIES_MAX_RETRY_AFTER_MS } from "./firefliesClient";
import {
  FIREFLIES_MAX_PENDING_IDS,
  normalizeFirefliesTranscript,
  type NormalizedMeeting,
  type StoreError,
  type StoreResult,
  type UpdateSyncStateInput,
} from "./connectorStore";
import { isStorageFullError } from "../storageStatus";
import { runOnSpaceLane } from "../spaceWriteLane";
import type { SyncProgress, SyncResult } from "./types";
const SOURCE = "fireflies" as const;

/** Structural surface of FirefliesClient used by the engine — narrow enough
 *  that unit tests can hand-roll a mock without pulling in the real class. */
export interface SyncClient {
  readonly delayMs: number;
  listNewTranscriptIds(opts: ListNewTranscriptIdsOptions): Promise<FirefliesResult<FirefliesListing>>;
  getTranscript(id: string, signal?: AbortSignal): Promise<FirefliesResult<FirefliesTranscript>>;
}

/** Structural surface of connectorStore used by the engine. `import * as store
 *  from "./connectorStore"` satisfies this shape; tests pass a fake object.
 *  Every method returns a StoreResult — the engine branches on `.ok` and
 *  never expects a throw across the boundary (spec §4). */
export interface SyncStore {
  ensureSchema(tcw: TinyCloudWeb): Promise<StoreResult<void>>;
  listKnownSourceIds(tcw: TinyCloudWeb, source: string): Promise<StoreResult<string[]>>;
  listTranscriptBodyIds(tcw: TinyCloudWeb, source: string): Promise<StoreResult<Set<string>>>;
  clearFirefliesAttempt?(tcw: TinyCloudWeb): Promise<StoreResult<void>>;
  insertMeeting(tcw: TinyCloudWeb, meeting: NormalizedMeeting): Promise<StoreResult<boolean>>;
  putTranscriptBody(
    tcw: TinyCloudWeb,
    source: string,
    sourceId: string,
    sentences: FirefliesSentence[],
  ): Promise<StoreResult<void>>;
  updateSyncState(tcw: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>>;
  getConnection(tcw: TinyCloudWeb, connectorId: "fireflies"): Promise<StoreResult<{
    status: "connected" | "disconnected";
    lastSyncedAt: string | null;
  } | null>>;
  getFirefliesAttempt?(tcw: TinyCloudWeb): Promise<StoreResult<{
    v: 1;
    lastAttemptAt: string;
    lastAttemptStatus: "running" | "ok" | "partial" | "error";
    listingSkip?: number | null;
    listingStartedAt?: string | null;
    listingAnchor?: string | null;
    listingAnchorDate?: number | string | null;
    listingPreviousNeighbor?: string | null;
    pendingIds?: string[];
    suspectIds?: string[];
    suspectSeenIds?: string[];
    suspectProofIds?: string[];
    suspectProofAt?: string | null;
  } | null>>;
  recordFirefliesAttempt?(
    tcw: TinyCloudWeb,
    attempt: {
      v: 1;
      lastAttemptAt: string;
      lastAttemptStatus: "running" | "ok" | "partial" | "error";
      listingSkip?: number | null;
      listingStartedAt?: string | null;
      listingAnchor?: string | null;
      listingAnchorDate?: number | string | null;
      listingPreviousNeighbor?: string | null;
      pendingIds?: string[];
      suspectIds?: string[];
      suspectSeenIds?: string[];
      suspectProofIds?: string[];
      suspectProofAt?: string | null;
    },
  ): Promise<StoreResult<void>>;
  countMeetings(tcw: TinyCloudWeb, source: string): Promise<StoreResult<number>>;
}

export type SyncErrorKind = "auth" | "rate-limited" | "network" | "storage";

export interface SyncError {
  kind: SyncErrorKind;
  message: string;
  /** Only present when kind === "rate-limited". */
  retryAfterMs?: number;
}

export type SyncFirefliesResult =
  | { ok: true; data: SyncResult }
  | { ok: false; error: SyncError };

export const FIREFLIES_CATCH_UP_LAG_BUFFER_MS = 24 * 60 * 60 * 1000;
export const FIREFLIES_SUSPECT_PROOF_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SyncFirefliesOptions {
  client: SyncClient;
  store: SyncStore;
  tcw: TinyCloudWeb;
  onProgress?: (progress: SyncProgress) => void;
  signal?: AbortSignal;
  detailCap?: number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  pageBudget?: number;
  /** False after account/session generation changes. */
  isCurrent?: () => boolean;
  /** Connect explicitly authorizes reactivating a retained disconnected row. */
  allowMissingConnection?: boolean;
  /** Manual requests follow an incomplete flight with their own reconcile. */
  manualRequest?: boolean;
  onJoined?: () => void;
  onJoinSettled?: () => void;
  /** Stable timestamp injection for deterministic multi-run continuation tests. */
  now?: () => string;
}

let flightSequence = 0;
interface FirefliesFlight {
  sequence: number;
  controller: AbortController;
  promise: Promise<SyncFirefliesResult>;
  settled: Promise<void>;
  settle: () => void;
  reconciliationComplete: boolean;
}
let activeFlight: FirefliesFlight | null = null;

export function isFirefliesSyncInFlight(): boolean {
  return activeFlight !== null;
}

export async function abortFirefliesSync(): Promise<void> {
  const flight = activeFlight;
  if (!flight) return;
  flightSequence++;
  flight.controller.abort();
  try {
    await flight.promise;
  } catch {
    // The sync caller owns errors; disconnect only needs the write barrier.
  }
}
let disconnectCount = 0;

export async function beginFirefliesDisconnect(): Promise<() => void> {
  disconnectCount += 1;
  await abortFirefliesSync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    disconnectCount = Math.max(0, disconnectCount - 1);
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fromStore(err: StoreError, context: string): SyncError {
  return { kind: "storage", message: `${context}: ${err.message}` };
}

/** Map a FirefliesError from client calls into a SyncError. Exported so the
 * targeted queued-id ingest classifies client failures identically. */
export function fromFireflies(err: FirefliesError): SyncError {
  switch (err.kind) {
    case "invalid-key":
      return { kind: "auth", message: err.message };
    case "rate-limited":
      return { kind: "rate-limited", message: err.message, retryAfterMs: err.retryAfterMs };
    case "network-error":
      return { kind: "network", message: err.message };
    case "graphql-error":
      return { kind: "network", message: err.message };
  }
}

export function isTerminal(err: FirefliesError): boolean {
  return err.kind === "invalid-key" || err.kind === "rate-limited";
}


function firefliesSyncIsCurrent(opts: SyncFirefliesOptions, sequence: number): boolean {
  if (flightSequence !== sequence) return false;
  try {
    return opts.isCurrent?.() !== false;
  } catch {
    return false;
  }
}
function optionIsCurrent(opts: SyncFirefliesOptions): boolean {
  try {
    return opts.isCurrent?.() !== false;
  } catch {
    return false;
  }
}

async function recordAttemptBestEffort(
  store: SyncStore,
  tcw: TinyCloudWeb,
  attempt: {
    v: 1;
    lastAttemptAt: string;
    lastAttemptStatus: "running" | "ok" | "partial" | "error";
    listingSkip?: number | null;
    listingStartedAt?: string | null;
    listingAnchor?: string | null;
    listingAnchorDate?: number | string | null;
    listingPreviousNeighbor?: string | null;
    pendingIds?: string[];
    suspectIds?: string[];
    suspectSeenIds?: string[];
    suspectProofIds?: string[];
    suspectProofAt?: string | null;
  },
  current: () => boolean,
): Promise<boolean> {
  const record = store.recordFirefliesAttempt;
  if (!record || !current()) return false;
  try {
    const result = await inSpace("Fireflies attempt metadata", async () => {
      if (!current()) return null;
      return record.call(store, tcw, attempt);
    });
    return result?.ok === true;
  } catch {
    // Attempt metadata is advisory; it never changes sync, ingest, or disconnect outcomes.
    return false;
  }
}

function inSpace<T>(_operation: string, run: () => Promise<T>): Promise<T> {
  return runOnSpaceLane(run);
}

async function runFirefliesSync(
  opts: SyncFirefliesOptions,
  signal: AbortSignal,
  sequence: number,
  setComplete: (complete: boolean) => void,
): Promise<SyncFirefliesResult> {
  const { client, store, tcw, onProgress } = opts;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const delayMs = client.delayMs ?? 0;
  const current = () => firefliesSyncIsCurrent(opts, sequence);
  const result: SyncResult = { added: 0, skipped: 0, errors: [] };
  const attemptAt = opts.now?.() ?? new Date().toISOString();
  let resumeSkip = 0;
  let resumeStartedAt = attemptAt;
  let resumeAnchor: string | null = null;
  let resumeAnchorDate: number | string | null = null;
  let resumePreviousNeighbor: string | null = null;
  let terminal: SyncError | null = null;
  let pendingIds = new Set<string>();
  let suspectIds = new Set<string>();
  let suspectSeenIds = new Set<string>();
  let suspectProofIds = new Set<string>();
  let suspectProofAt: string | null = null;
  const pendingNotFoundRetries = new Set<string>();
  let cursorBlocked = false;
  let forceRestartAfterListing = false;
  const rememberPending = (id: string): boolean => {
    if (pendingIds.has(id)) return true;
    if (pendingIds.size >= FIREFLIES_MAX_PENDING_IDS) return false;
    pendingIds.add(id);
    return true;
  };
  let listingComplete = false;
  let listingSkip: number | null = 0;
  let listingStartedAt: string | null = attemptAt;
  let listingAnchor: string | null = null;
  let listingAnchorDate: number | string | null = null;
  let listingPreviousNeighbor: string | null = null;
  const restartListingAtTop = () => {
    resumeSkip = 0;
    resumeAnchor = null;
    resumeAnchorDate = null;
    resumePreviousNeighbor = null;
    listingSkip = 0;
    listingAnchor = null;
    listingAnchorDate = null;
    listingPreviousNeighbor = null;
  };
  if (!current()) return { ok: true, data: result };

  try {
    const schemaRes = await inSpace("Fireflies ensure schema", async () =>
      current() ? store.ensureSchema(tcw) : null);
    if (!current() || !schemaRes) return { ok: true, data: result };
    if (!schemaRes.ok) {
      terminal = fromStore(schemaRes.error, "ensureSchema");
    } else {
      const connectionRes = await inSpace("Fireflies read connection", async () =>
        current() ? store.getConnection(tcw, SOURCE) : null);
      if (!current() || !connectionRes) return { ok: true, data: result };
      if (!connectionRes.ok) {
        terminal = fromStore(connectionRes.error, "getConnection");
      } else {
        const connection = connectionRes.data;
        const connectAuthorizes = opts.allowMissingConnection === true
          && (connection === null || connection.status === "disconnected");
        if (!opts.allowMissingConnection && connection?.status !== "connected") {
          return { ok: false, error: { kind: "network", message: "Fireflies is not connected" } };
        }

        if (connectAuthorizes && store.clearFirefliesAttempt) {
          try {
            const cleared = await inSpace("Fireflies clear stale continuation", async () =>
              current() ? store.clearFirefliesAttempt!(tcw) : null);
            if (!current() || !cleared) return { ok: true, data: result };
            // Connect never reads the old record and its running write replaces it.
            // A stale clear failure must not prevent the authorized full reconcile.
          } catch {
            // Best effort: Connect starts from the listing top regardless.
          }
        }
        resumeSkip = 0;
        resumeStartedAt = attemptAt;
        resumeAnchor = null;
        resumeAnchorDate = null;
        resumePreviousNeighbor = null;
        if (!connectAuthorizes && store.getFirefliesAttempt) {
          try {
            const attemptRes = await inSpace("Fireflies read attempt metadata", async () =>
              current() ? store.getFirefliesAttempt!(tcw) : null);
            if (!current()) return { ok: true, data: result };
            const attempt = attemptRes?.ok ? attemptRes.data : null;
            const skip = attempt?.listingSkip;
            const startedAt = attempt?.listingStartedAt;
            const anchor = attempt?.listingAnchor;
            const anchorDate = attempt?.listingAnchorDate;
            const previousNeighbor = attempt?.listingPreviousNeighbor;
            const validDate = anchorDate === null
              || (typeof anchorDate === "number" && Number.isFinite(anchorDate))
              || (typeof anchorDate === "string" && Number.isFinite(Date.parse(anchorDate)));
            const validCursor = Number.isSafeInteger(skip)
              && (skip ?? -1) >= 0
              && typeof startedAt === "string"
              && Number.isFinite(Date.parse(startedAt))
              && ((skip ?? 0) === 0
                ? anchor == null && anchorDate == null && previousNeighbor == null
                : typeof anchor === "string" && anchor.length > 0
                  && anchorDate !== undefined && validDate
                  && ((skip ?? 0) === 1
                    ? previousNeighbor === null
                    : typeof previousNeighbor === "string" && previousNeighbor.length > 0));
            if (validCursor) {
              resumeSkip = skip!;
              resumeStartedAt = startedAt;
              resumeAnchor = typeof anchor === "string" ? anchor : null;
              resumeAnchorDate = anchorDate ?? null;
              resumePreviousNeighbor = typeof previousNeighbor === "string" ? previousNeighbor : null;
            }
            for (const id of attempt?.pendingIds ?? []) rememberPending(id);
            for (const id of attempt?.suspectIds ?? []) {
              if (pendingIds.has(id)) suspectIds.add(id);
            }
            for (const id of attempt?.suspectSeenIds ?? []) {
              if (suspectIds.has(id)) suspectSeenIds.add(id);
            }
            for (const id of attempt?.suspectProofIds ?? []) {
              if (pendingIds.has(id)) suspectProofIds.add(id);
            }
            suspectProofAt = typeof attempt?.suspectProofAt === "string"
              && Number.isFinite(Date.parse(attempt.suspectProofAt))
              ? attempt.suspectProofAt
              : null;
            if (suspectIds.size > 0 && (suspectProofIds.size === 0 || !suspectProofAt)) {
              suspectProofIds = new Set(suspectIds);
              suspectProofAt = attemptAt;
              restartListingAtTop();
            }
          } catch {
            // Lost or unreadable continuation restarts from the newest page.
          }
        }
        listingSkip = resumeSkip;
        listingStartedAt = resumeStartedAt;
        listingAnchor = resumeAnchor;
        listingAnchorDate = resumeAnchorDate;
        listingPreviousNeighbor = resumePreviousNeighbor;
        const runningAttemptWritten = await recordAttemptBestEffort(store, tcw, {
          v: 1,
          lastAttemptAt: attemptAt,
          lastAttemptStatus: "running",
          listingSkip,
          listingStartedAt,
          listingAnchor,
          listingAnchorDate,
          listingPreviousNeighbor,
          pendingIds: [...pendingIds],
          suspectIds: [...suspectIds],
          suspectSeenIds: [...suspectSeenIds],
          suspectProofIds: [...suspectProofIds],
          suspectProofAt,
        }, current);
        if (!runningAttemptWritten) {
          resumeSkip = 0;
          resumeStartedAt = attemptAt;
          resumeAnchor = null;
          resumeAnchorDate = null;
          resumePreviousNeighbor = null;
          listingSkip = 0;
          listingStartedAt = attemptAt;
          listingAnchor = null;
          listingAnchorDate = null;
          listingPreviousNeighbor = null;
        }

        const knownRes = await inSpace("Fireflies read known meetings", async () =>
          current() ? store.listKnownSourceIds(tcw, SOURCE) : null);
        if (!current() || !knownRes) return { ok: true, data: result };
        if (!knownRes.ok) {
          terminal = fromStore(knownRes.error, "listKnownSourceIds");
        } else {
          const bodyIdsRes = await inSpace("Fireflies list transcript bodies", async () =>
            current() ? store.listTranscriptBodyIds(tcw, SOURCE) : null);
          if (!current() || !bodyIdsRes) return { ok: true, data: result };
          if (!bodyIdsRes.ok) {
            terminal = fromStore(bodyIdsRes.error, "listTranscriptBodyIds");
          } else {
            const watermarkMs = connection?.lastSyncedAt
              ? Date.parse(connection.lastSyncedAt)
              : Number.NaN;
            const catchUpStopBeforeDate = Number.isFinite(watermarkMs)
              ? new Date(watermarkMs - FIREFLIES_CATCH_UP_LAG_BUFFER_MS).toISOString()
              : null;
            const bodyIds = bodyIdsRes.data;
            const maxDetails = Number.isFinite(opts.detailCap)
              ? Math.min(FIREFLIES_MAX_DETAIL_CAP, Math.max(0, Math.floor(opts.detailCap!)))
              : FIREFLIES_MAX_DETAIL_CAP;
            const pendingRetryCap = maxDetails > 0
              ? Math.max(1, Math.min(25, Math.floor(maxDetails / 2)))
              : 0;
            let detailsUsed = 0;
            let storedPrefix = true;
            let pendingRetryStopped = false;
            const processTranscript = async (
              id: string,
              done: number,
              total: number,
              fromPendingRetry = false,
            ): Promise<boolean> => {
              if (!current() || signal.aborted) {
                storedPrefix = false;
                cursorBlocked = true;
                return false;
              }
              if (detailsUsed > 0 && !await sleep(delayMs, signal)) {
                storedPrefix = false;
                cursorBlocked = true;
                return false;
              }
              if (!current() || signal.aborted) {
                storedPrefix = false;
                cursorBlocked = true;
                return false;
              }
              detailsUsed++;
              const txRes = await client.getTranscript(id, signal);
              if (!current()) {
                storedPrefix = false;
                cursorBlocked = true;
                return false;
              }
              if (!txRes.ok) {
                if (signal.aborted) {
                  storedPrefix = false;
                  cursorBlocked = true;
                  return false;
                }
                result.errors.push(`${id}: ${txRes.error.message}`);
                if (!rememberPending(id)) {
                  storedPrefix = false;
                  cursorBlocked = true;
                }
                if (fromPendingRetry && txRes.error.notFound === true) {
                  pendingNotFoundRetries.add(id);
                  return true;
                }
                if (txRes.error.kind === "rate-limited"
                  && (txRes.error.retryAfterMs ?? 0) > FIREFLIES_MAX_RETRY_AFTER_MS) {
                  storedPrefix = false;
                  cursorBlocked = true;
                  return false;
                }
                if (isTerminal(txRes.error)) {
                  terminal = fromFireflies(txRes.error);
                  storedPrefix = false;
                  return false;
                }
                return true;
              }

              try {
                const { meeting, sentences } = normalizeFirefliesTranscript(txRes.data);
                const itemWrite = await inSpace("Fireflies store meeting and transcript", async () => {
                  if (!current()) return null;
                  const connectionBeforeWrite = await store.getConnection(tcw, SOURCE);
                  if (!connectionBeforeWrite.ok) return { error: connectionBeforeWrite.error };
                  if (!current()) return null;
                  const mayWrite = connectionBeforeWrite.data?.status === "connected"
                    || (opts.allowMissingConnection === true
                      && (connectionBeforeWrite.data === null
                        || connectionBeforeWrite.data.status === "disconnected"));
                  if (!mayWrite) return { disconnected: true };
                  if (!current()) return null;
                  const insert = await store.insertMeeting(tcw, meeting);
                  if (!insert.ok) return { insert, body: null };
                  const body = await store.putTranscriptBody(tcw, SOURCE, meeting.sourceId, sentences);
                  return { insert, body };
                });
                if (!itemWrite) {
                  storedPrefix = false;
                  cursorBlocked = true;
                  return false;
                }
                if ("disconnected" in itemWrite) {
                  storedPrefix = false;
                  cursorBlocked = true;
                  return false;
                }
                if ("error" in itemWrite) {
                  storedPrefix = false;
                  cursorBlocked = true;
                  terminal = fromStore(
                    itemWrite.error ?? { code: "STORE_ERROR", message: "Connection read failed" },
                    "getConnection before item write",
                  );
                  return false;
                }
                if (!itemWrite.insert.ok) {
                  result.errors.push(`${id}: ${itemWrite.insert.error.message}`);
                  if (!rememberPending(id)) {
                    storedPrefix = false;
                    cursorBlocked = true;
                  }
                  if (isStorageFullError(itemWrite.insert.error)) {
                    terminal = fromStore(itemWrite.insert.error, "insertMeeting");
                    storedPrefix = false;
                    return false;
                  }
                  return true;
                }
                if (!itemWrite.body?.ok) {
                  const bodyError = itemWrite.body?.error;
                  result.errors.push(`${id}: ${bodyError?.message ?? "Transcript body write failed"}`);
                  if (!rememberPending(id)) {
                    storedPrefix = false;
                    cursorBlocked = true;
                  }
                  if (bodyError && isStorageFullError(bodyError)) {
                    terminal = fromStore(bodyError, "putTranscriptBody");
                    storedPrefix = false;
                    return false;
                  }
                  return true;
                }
                if (itemWrite.insert.data) result.added += 1;
                else result.skipped += 1;
                pendingIds.delete(id);
                suspectIds.delete(id);
                suspectSeenIds.delete(id);
                suspectProofIds.delete(id);
                bodyIds.add(id);
                onProgress?.({ phase: "storing", done, total });
                return true;
              } catch (err) {
                result.errors.push(`${id}: ${errorMessage(err)}`);
                if (!rememberPending(id)) {
                  storedPrefix = false;
                  cursorBlocked = true;
                }
                return true;
              }
            };

            const pendingToRetry = [...pendingIds].slice(0, pendingRetryCap);
            for (let i = 0; i < pendingToRetry.length && detailsUsed < maxDetails; i++) {
              const id = pendingToRetry[i]!;
              if (!await processTranscript(id, i + 1, pendingToRetry.length, true)) {
                pendingRetryStopped = true;
              }
              if (terminal || cursorBlocked || signal.aborted || !current()) {
                pendingRetryStopped = true;
              }
              if (pendingRetryStopped) break;
              if (pendingIds.has(id)) {
                pendingIds.delete(id);
                pendingIds.add(id);
              }
            }
            if (!pendingRetryStopped && pendingNotFoundRetries.size > 0) {
              const candidates = [...pendingNotFoundRetries];
              const proofAtMs = suspectProofAt ? Date.parse(suspectProofAt) : Number.NaN;
              const runAtMs = Date.parse(attemptAt);
              const sameSetCoolingDown = suspectIds.size === 0
                && Number.isFinite(proofAtMs)
                && Number.isFinite(runAtMs)
                && runAtMs - proofAtMs < FIREFLIES_SUSPECT_PROOF_INTERVAL_MS
                && candidates.every((id) => suspectProofIds.has(id));
              // Keep generation membership fixed from its skip-zero start.
              // A late not-found ID stays pending, then starts a fresh proof
              // on a later retry instead of inheriting an already-passed prefix.
              if (suspectIds.size === 0 && !sameSetCoolingDown) {
                suspectIds = new Set(candidates);
                suspectSeenIds.clear();
                suspectProofIds = new Set(candidates);
                suspectProofAt = attemptAt;
                restartListingAtTop();
              }
            }

            if (!pendingRetryStopped && !terminal && !cursorBlocked
              && detailsUsed < maxDetails && current() && !signal.aborted) {
              const knownIds = new Set([...knownRes.data, ...pendingIds]);
              const listStartSkip = resumeSkip;
              const listRes = await client.listNewTranscriptIds({
                knownIds,
                detailCap: maxDetails - detailsUsed,
                pageBudget: opts.pageBudget,
                startSkip: resumeSkip,
                startAnchor: resumeAnchor,
                startAnchorDate: resumeAnchorDate,
                startPreviousNeighbor: resumePreviousNeighbor,
                stopBeforeDate: suspectIds.size > 0 ? null : catchUpStopBeforeDate,
                signal,
                onProgress,
                onSummary: (summary) => {
                  if (suspectIds.has(summary.id)) suspectSeenIds.add(summary.id);
                },
                isKnownComplete: (id) => pendingIds.has(id) || bodyIds.has(id),
              });
              if (!current()) return { ok: true, data: result };
              if (!listRes.ok) {
                if (listRes.error.kind === "rate-limited"
                  && (listRes.error.retryAfterMs ?? 0) > FIREFLIES_MAX_RETRY_AFTER_MS) {
                  result.errors.push(listRes.error.message);
                  cursorBlocked = true;
                } else if (!signal.aborted) {
                  terminal = fromFireflies(listRes.error);
                }
              } else {
                listingComplete = listRes.data.complete;
                const idsOldestFirst = [...listRes.data.ids].reverse();
                onProgress?.({ phase: "fetching", done: 0, total: idsOldestFirst.length });
                for (let i = 0; i < idsOldestFirst.length; i++) {
                  if (!await processTranscript(idsOldestFirst[i]!, detailsUsed + 1, maxDetails)) break;
                }
                const cursorResetDuringListing = resumeSkip !== listStartSkip;
                if (cursorResetDuringListing) listingComplete = false;
                if (listingComplete && suspectIds.size > 0) {
                  const absentSuspects = [...suspectIds].filter((id) => !suspectSeenIds.has(id));
                  for (const id of absentSuspects) {
                    pendingIds.delete(id);
                    suspectIds.delete(id);
                    suspectSeenIds.delete(id);
                    suspectProofIds.delete(id);
                  }
                  if (absentSuspects.length > 0) {
                    // Absence is proof only after the full-history chain reaches EOF.
                    listingComplete = false;
                    forceRestartAfterListing = true;
                    restartListingAtTop();
                  }
                  // Seen evidence belongs only to this completed generation. Keep
                  // the bounded proof set/time to pace the next re-proof.
                  for (const id of suspectIds) {
                    suspectIds.delete(id);
                    suspectSeenIds.delete(id);
                  }
                  if (suspectProofIds.size === 0) suspectProofAt = null;
                }
                if (forceRestartAfterListing) listingComplete = false;
                const prefixCommitted = storedPrefix
                  && current()
                  && !signal.aborted
                  && !terminal
                  && !cursorBlocked;
                if (prefixCommitted) {
                  const clearCursor = listingComplete && pendingIds.size === 0;
                  listingSkip = clearCursor ? null
                    : forceRestartAfterListing ? 0
                      : cursorResetDuringListing ? 0 : listRes.data.nextSkip;
                  listingStartedAt = clearCursor ? null : resumeStartedAt;
                  listingAnchor = clearCursor ? null
                    : forceRestartAfterListing || cursorResetDuringListing ? null : listRes.data.nextAnchor;
                  listingAnchorDate = clearCursor ? null
                    : forceRestartAfterListing || cursorResetDuringListing
                      ? null : listRes.data.nextAnchorDate;
                  listingPreviousNeighbor = clearCursor ? null
                    : forceRestartAfterListing || cursorResetDuringListing
                      ? null : listRes.data.nextPreviousNeighbor;
                }
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

  let itemCount = 0;
  try {
    const countRes = await inSpace("Fireflies count meetings", async () =>
      current() ? store.countMeetings(tcw, SOURCE) : null);
    if (!current() || !countRes) return { ok: true, data: result };
    if (!countRes.ok) terminal ??= fromStore(countRes.error, "countMeetings");
    else itemCount = countRes.data;

    const reconciled = listingComplete && pendingIds.size === 0 && suspectIds.size === 0
      && !signal.aborted && !terminal && result.errors.length === 0;
    const finalStatus: "ok" | "partial" | "error" =
      terminal ? "error" : reconciled ? "ok" : "partial";
    const stateRes = await inSpace("Fireflies update sync state", async () => {
      if (!current()) return null;
      const connectionRes = await store.getConnection(tcw, SOURCE);
      if (!connectionRes.ok || !current()) return connectionRes;
      const connection = connectionRes.data;
      const mayWriteConnected = connection?.status === "connected"
        || (opts.allowMissingConnection === true
          && (connection === null || connection.status === "disconnected"));
      if (!mayWriteConnected) return { ok: true as const, data: undefined };
      if (!current()) return null;
      return store.updateSyncState(tcw, {
        connectorId: SOURCE,
        status: "connected",
        lastSyncedAt: finalStatus === "ok" ? resumeStartedAt : null,
        lastSyncStatus: finalStatus,
        lastSyncError: terminal?.message ?? (result.errors.length > 0
          ? `${result.errors.length} transcript(s) failed`
          : null),
        itemCount,
        preserveLastSyncedAt: finalStatus !== "ok",
      });
    });
    if (!current() || !stateRes) return { ok: true, data: result };
    if (!stateRes.ok) terminal ??= fromStore(stateRes.error, "updateSyncState");
    if (terminal || signal.aborted || cursorBlocked) {
      listingSkip = resumeSkip;
      listingStartedAt = resumeStartedAt;
      listingAnchor = resumeAnchor;
      listingAnchorDate = resumeAnchorDate;
      listingPreviousNeighbor = resumePreviousNeighbor;
    }
    const attemptStatus = terminal ? "error"
      : listingComplete && pendingIds.size === 0 && suspectIds.size === 0
        && !signal.aborted && result.errors.length === 0 ? "ok" : "partial";
    if (attemptStatus === "ok") {
      suspectProofIds.clear();
      suspectProofAt = null;
    }
    await recordAttemptBestEffort(store, tcw, {
      v: 1,
      lastAttemptAt: attemptAt,
      lastAttemptStatus: attemptStatus,
      listingSkip: attemptStatus === "ok" ? null : listingSkip,
      listingStartedAt: attemptStatus === "ok" ? null : listingStartedAt,
      listingAnchor: attemptStatus === "ok" ? null : listingAnchor,
      listingAnchorDate: attemptStatus === "ok" ? null : listingAnchorDate,
      listingPreviousNeighbor: attemptStatus === "ok" ? null : listingPreviousNeighbor,
      pendingIds: [...pendingIds],
      suspectIds: [...suspectIds],
      suspectSeenIds: [...suspectSeenIds],
      suspectProofIds: [...suspectProofIds],
      suspectProofAt,
    }, current);
    if (terminal) return { ok: false, error: terminal };
    setComplete(finalStatus === "ok");
    return { ok: true, data: result };
  } catch (err) {
    terminal = { kind: "storage", message: errorMessage(err) };
    if (!current()) return { ok: true, data: result };
    await recordAttemptBestEffort(store, tcw, {
      v: 1,
      lastAttemptAt: attemptAt,
      lastAttemptStatus: "error",
      listingSkip,
      listingStartedAt,
      listingAnchor,
      listingAnchorDate,
      listingPreviousNeighbor,
      pendingIds: [...pendingIds],
      suspectIds: [...suspectIds],
      suspectSeenIds: [...suspectSeenIds],
      suspectProofIds: [...suspectProofIds],
      suspectProofAt,
    }, current);
    return { ok: false, error: terminal };
  }
}

export async function syncFireflies(
  opts: SyncFirefliesOptions,
): Promise<SyncFirefliesResult> {
  if (disconnectCount > 0) {
    return {
      ok: false,
      error: { kind: "network", message: "Fireflies disconnect is in progress" },
    };
  }
  if (activeFlight) {
    const joined = activeFlight;
    opts.onJoined?.();
    const joinedResult = await joined.promise;
    if (!optionIsCurrent(opts)
      || !opts.manualRequest
      || joined.reconciliationComplete
      || disconnectCount > 0
      || opts.signal?.aborted) {
      return joinedResult;
    }
    await joined.settled;
    opts.onJoinSettled?.();
    if (!optionIsCurrent(opts) || disconnectCount > 0 || opts.signal?.aborted) return joinedResult;
    return syncFireflies({ ...opts, manualRequest: false });
  }

  const sequence = ++flightSequence;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const flight: FirefliesFlight = {
    sequence,
    controller,
    promise: Promise.resolve({ ok: true, data: { added: 0, skipped: 0, errors: [] } }),
    settled,
    settle,
    reconciliationComplete: false,
  };
  activeFlight = flight;
  flight.promise = runFirefliesSync(opts, controller.signal, sequence, (complete) => {
    flight.reconciliationComplete = complete;
  });
  try {
    return await flight.promise;
  } finally {
    opts.signal?.removeEventListener("abort", abortFromCaller);
    if (activeFlight === flight) activeFlight = null;
    flight.settle();
  }
}
