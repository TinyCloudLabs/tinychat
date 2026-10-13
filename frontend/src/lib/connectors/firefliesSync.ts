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
import { FIREFLIES_MAX_RETRY_AFTER_MS } from "./firefliesClient";
import {
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
  hasTranscriptBody(tcw: TinyCloudWeb, source: string, sourceId: string): Promise<StoreResult<boolean>>;
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
  recordFirefliesAttempt?(
    tcw: TinyCloudWeb,
    attempt: {
      v: 1;
      lastAttemptAt: string;
      lastAttemptStatus: "running" | "ok" | "partial" | "error";
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

export interface SyncFirefliesOptions {
  client: SyncClient;
  store: SyncStore;
  tcw: TinyCloudWeb;
  onProgress?: (progress: SyncProgress) => void;
  signal?: AbortSignal;
  detailCap?: number;
  pageBudget?: number;
  /** False after account/session generation changes. */
  isCurrent?: () => boolean;
  /** Connect explicitly authorizes reactivating a retained disconnected row. */
  allowMissingConnection?: boolean;
  /** Manual requests follow an incomplete flight with their own reconcile. */
  manualRequest?: boolean;
  onJoined?: () => void;
  onJoinSettled?: () => void;
  /** Override the between-detail-fetch sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
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

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
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

async function recordAttemptBestEffort(
  store: SyncStore,
  tcw: TinyCloudWeb,
  attempt: { v: 1; lastAttemptAt: string; lastAttemptStatus: "running" | "ok" | "partial" | "error" },
  current: () => boolean,
): Promise<void> {
  const record = store.recordFirefliesAttempt;
  if (!record || !current()) return;
  try {
    await inSpace("Fireflies attempt metadata", async () => {
      if (!current()) return;
      await record.call(store, tcw, attempt);
    });
  } catch {
    // Attempt metadata is advisory; it never changes sync, ingest, or disconnect outcomes.
  }
}

function inSpace<T>(operation: string, run: () => Promise<T>): Promise<T> {
  return runOnSpaceLane(run, { operation });
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
  const attemptAt = new Date().toISOString();
  let terminal: SyncError | null = null;
  let listingComplete = false;
  if (!current()) return { ok: true, data: result };
  await recordAttemptBestEffort(store, tcw, {
    v: 1,
    lastAttemptAt: attemptAt,
    lastAttemptStatus: "running",
  }, current);

  try {
    const schemaRes = await inSpace("Fireflies ensure schema", async () =>
      current() ? store.ensureSchema(tcw) : null);
    if (!current() || !schemaRes) return { ok: true, data: result };
    if (!schemaRes.ok) {
      terminal = fromStore(schemaRes.error, "ensureSchema");
    } else {
      const connectionRes = await inSpace("Fireflies read success watermark", async () =>
        current() ? store.getConnection(tcw, SOURCE) : null);
      if (!current() || !connectionRes) return { ok: true, data: result };
      if (!connectionRes.ok) {
        terminal = fromStore(connectionRes.error, "getConnection");
      } else {
        const knownRes = await inSpace("Fireflies read known meetings", async () =>
          current() ? store.listKnownSourceIds(tcw, SOURCE) : null);
        if (!current() || !knownRes) return { ok: true, data: result };
        if (!knownRes.ok) {
          terminal = fromStore(knownRes.error, "listKnownSourceIds");
        } else {
          const watermarkMs = connectionRes.data?.lastSyncedAt
            ? Date.parse(connectionRes.data.lastSyncedAt)
            : Number.NaN;
          const stopBeforeDate = Number.isFinite(watermarkMs)
            ? new Date(watermarkMs - FIREFLIES_CATCH_UP_LAG_BUFFER_MS).toISOString()
            : null;
          const knownIds = new Set(knownRes.data);
          const listRes = await client.listNewTranscriptIds({
            knownIds,
            detailCap: opts.detailCap,
            pageBudget: opts.pageBudget,
            stopBeforeDate,
            signal,
            onProgress,
            isKnownComplete: async (id) => {
              const bodyRes = await store.hasTranscriptBody(tcw, SOURCE, id);
              if (!bodyRes.ok) throw new Error(bodyRes.error.message);
              return bodyRes.data;
            },
          });
          if (!current()) return { ok: true, data: result };
          if (!listRes.ok) {
            if (listRes.error.kind === "rate-limited"
              && (listRes.error.retryAfterMs ?? 0) > FIREFLIES_MAX_RETRY_AFTER_MS) {
              result.errors.push(listRes.error.message);
            } else if (!signal.aborted) {
              terminal = fromFireflies(listRes.error);
            }
          } else {
            listingComplete = listRes.data.complete;
            const idsOldestFirst = [...listRes.data.ids].reverse();
            const total = idsOldestFirst.length;
            onProgress?.({ phase: "fetching", done: 0, total });

            for (let i = 0; i < idsOldestFirst.length; i++) {
              if (!current() || signal.aborted) break;
              const id = idsOldestFirst[i];
              const txRes = await client.getTranscript(id, signal);
              if (!current()) break;
              if (!txRes.ok) {
                if (signal.aborted) break;
                if (txRes.error.kind === "rate-limited"
                  && (txRes.error.retryAfterMs ?? 0) > FIREFLIES_MAX_RETRY_AFTER_MS) {
                  result.errors.push(`${id}: ${txRes.error.message}`);
                } else if (isTerminal(txRes.error)) {
                  terminal = fromFireflies(txRes.error);
                  break;
                } else {
                  result.errors.push(`${id}: ${txRes.error.message}`);
                }
                continue;
              }

              try {
                const { meeting, sentences } = normalizeFirefliesTranscript(txRes.data);
                const itemWrite = await inSpace("Fireflies store meeting and transcript", async () => {
                  if (!current()) return null;
                  const insert = await store.insertMeeting(tcw, meeting);
                  if (!insert.ok) return { insert, body: null };
                  const body = await store.putTranscriptBody(tcw, SOURCE, meeting.sourceId, sentences);
                  return { insert, body };
                });
                if (!itemWrite) break;
                if (!itemWrite.insert.ok) {
                  result.errors.push(`${id}: ${itemWrite.insert.error.message}`);
                  if (isStorageFullError(itemWrite.insert.error)) {
                    terminal = fromStore(itemWrite.insert.error, "insertMeeting");
                    break;
                  }
                  continue;
                }
                if (!itemWrite.body?.ok) {
                  const bodyError = itemWrite.body?.error;
                  result.errors.push(`${id}: ${bodyError?.message ?? "Transcript body write failed"}`);
                  if (bodyError && isStorageFullError(bodyError)) {
                    terminal = fromStore(bodyError, "putTranscriptBody");
                    break;
                  }
                  continue;
                }
                if (itemWrite.insert.data) result.added += 1;
                else result.skipped += 1;
                onProgress?.({ phase: "storing", done: i + 1, total });
              } catch (err) {
                result.errors.push(`${id}: ${errorMessage(err)}`);
              }

              if (i < idsOldestFirst.length - 1 && current() && !signal.aborted) await sleep(delayMs);
            }
          }
        }
      }
    }
  } catch (err) {
    if (current()) terminal = { kind: "storage", message: errorMessage(err) };
  }
  if (!current()) return { ok: true, data: result };

  const reconciled = listingComplete && !signal.aborted && !terminal && result.errors.length === 0;
  const finalStatus: "ok" | "partial" | "error" =
    terminal ? "error" : reconciled ? "ok" : "partial";
  const countRes = await inSpace("Fireflies count meetings", async () =>
    current() ? store.countMeetings(tcw, SOURCE) : null);
  if (!current() || !countRes) return { ok: true, data: result };
  const itemCount = countRes.ok ? countRes.data : 0;
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
      lastSyncedAt: finalStatus === "ok" ? new Date().toISOString() : null,
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
  await recordAttemptBestEffort(store, tcw, {
    v: 1,
    lastAttemptAt: attemptAt,
    lastAttemptStatus: terminal ? "error" : finalStatus,
  }, current);
  if (terminal) return { ok: false, error: terminal };
  setComplete(finalStatus === "ok");
  return { ok: true, data: result };
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
    if (!opts.manualRequest || joined.reconciliationComplete || disconnectCount > 0 || opts.signal?.aborted) {
      return joinedResult;
    }
    await joined.settled;
    opts.onJoinSettled?.();
    if (disconnectCount > 0 || opts.signal?.aborted) return joinedResult;
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
