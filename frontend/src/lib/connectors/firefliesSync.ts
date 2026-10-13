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
  FirefliesResult,
  FirefliesSentence,
  FirefliesTranscript,
  ListNewTranscriptIdsOptions,
} from "./firefliesClient";
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
  listNewTranscriptIds(opts: ListNewTranscriptIdsOptions): Promise<FirefliesResult<string[]>>;
  getTranscript(id: string, signal?: AbortSignal): Promise<FirefliesResult<FirefliesTranscript>>;
}

/** Structural surface of connectorStore used by the engine. `import * as store
 *  from "./connectorStore"` satisfies this shape; tests pass a fake object.
 *  Every method returns a StoreResult — the engine branches on `.ok` and
 *  never expects a throw across the boundary (spec §4). */
export interface SyncStore {
  ensureSchema(tcw: TinyCloudWeb): Promise<StoreResult<void>>;
  listKnownSourceIds(tcw: TinyCloudWeb, source: string): Promise<StoreResult<string[]>>;
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
  /** Maximum number of unseen transcript IDs for bounded background catch-up. */
  maxNewTranscripts?: number;
  /** A full-listing reconciliation catch-up; targeted webhook ingest is not one. */
  catchUpWatermark?: string | null;
  /** False after account/session generation changes. */
  isCurrent?: () => boolean;
  /** Connect may create connector_state for the first time in this engine run. */
  allowMissingConnection?: boolean;
  /** Override the between-detail-fetch sleep. Defaults to setTimeout;
   *  tests pass `() => Promise.resolve()` to keep runs synchronous. */
  sleepImpl?: (ms: number) => Promise<void>;
}

let flightSequence = 0;
let activeFlight: {
  sequence: number;
  controller: AbortController;
  promise: Promise<SyncFirefliesResult>;
} | null = null;

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
    await inSpace("Fireflies attempt metadata", () => record.call(store, tcw, attempt));
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
): Promise<SyncFirefliesResult> {
  const { client, store, tcw, onProgress } = opts;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const delayMs = client.delayMs ?? 0;
  const current = () => firefliesSyncIsCurrent(opts, sequence);
  const result: SyncResult = { added: 0, skipped: 0, errors: [] };
  const maxNewTranscripts = Number.isFinite(opts.maxNewTranscripts)
    ? Math.max(0, Math.floor(opts.maxNewTranscripts!))
    : undefined;
  const isCatchUp = opts.catchUpWatermark !== undefined;
  const watermarkMs = opts.catchUpWatermark ? Date.parse(opts.catchUpWatermark) : Number.NaN;
  const stopBeforeDate = Number.isFinite(watermarkMs)
    ? new Date(watermarkMs - FIREFLIES_CATCH_UP_LAG_BUFFER_MS).toISOString()
    : null;
  const attemptAt = new Date().toISOString();
  if (!current()) return { ok: true, data: result };
  await recordAttemptBestEffort(store, tcw, {
    v: 1,
    lastAttemptAt: attemptAt,
    lastAttemptStatus: "running",
  }, current);

  let terminal: SyncError | null = null;
  let truncated = false;
  try {
    if (!current()) return { ok: true, data: result };
    const schemaRes = await inSpace("Fireflies ensure schema", () => store.ensureSchema(tcw));
    if (!current()) return { ok: true, data: result };
    if (!schemaRes.ok) {
      terminal = fromStore(schemaRes.error, "ensureSchema");
    } else {
      const knownRes = await inSpace("Fireflies read known meetings", () =>
        store.listKnownSourceIds(tcw, SOURCE));
      if (!current()) return { ok: true, data: result };
      if (!knownRes.ok) {
        terminal = fromStore(knownRes.error, "listKnownSourceIds");
      } else {
        const listRes = await client.listNewTranscriptIds({
          knownIds: knownRes.data,
          maxResults: maxNewTranscripts === undefined ? undefined : maxNewTranscripts + 1,
          retainLast: maxNewTranscripts !== undefined && !isCatchUp,
          scanPastKnown: isCatchUp,
          stopBeforeDate,
          signal,
          onProgress,
        });
        if (!current()) return { ok: true, data: result };
        if (!listRes.ok) {
          terminal = fromFireflies(listRes.error);
        } else {
          const maxNewIds = maxNewTranscripts ?? Number.POSITIVE_INFINITY;
          truncated = listRes.data.length > maxNewIds;
          const limitedIds = truncated
            ? (isCatchUp
              ? listRes.data.slice(0, maxNewIds)
              : listRes.data.slice(Math.max(0, listRes.data.length - maxNewIds)))
            : listRes.data;
          const idsOldestFirst = [...limitedIds].reverse();
          const total = idsOldestFirst.length;
          onProgress?.({ phase: "fetching", done: 0, total });

          for (let i = 0; i < idsOldestFirst.length; i++) {
            if (!current() || signal.aborted) break;
            const id = idsOldestFirst[i];
            const txRes = await client.getTranscript(id, signal);
            if (!current()) break;
            if (!txRes.ok) {
              if (isTerminal(txRes.error)) {
                terminal = fromFireflies(txRes.error);
                break;
              }
              result.errors.push(`${id}: ${txRes.error.message}`);
              continue;
            }

            try {
              const { meeting, sentences } = normalizeFirefliesTranscript(txRes.data);
              if (!current()) break;
              const insertRes = await inSpace("Fireflies insert meeting", () =>
                store.insertMeeting(tcw, meeting));
              if (!current()) break;
              if (!insertRes.ok) {
                result.errors.push(`${id}: ${insertRes.error.message}`);
                if (isStorageFullError(insertRes.error)) {
                  terminal = fromStore(insertRes.error, "insertMeeting");
                  break;
                }
                continue;
              }
              const putRes = await inSpace("Fireflies store transcript", () =>
                store.putTranscriptBody(tcw, SOURCE, meeting.sourceId, sentences));
              if (!current()) break;
              if (!putRes.ok) {
                result.errors.push(`${id}: ${putRes.error.message}`);
                if (isStorageFullError(putRes.error)) {
                  terminal = fromStore(putRes.error, "putTranscriptBody");
                  break;
                }
                continue;
              }
              if (insertRes.data) result.added += 1;
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
  } catch (err) {
    if (current()) terminal = { kind: "storage", message: errorMessage(err) };
  }
  if (!current()) return { ok: true, data: result };
  if (terminal?.kind === "storage") {
    await recordAttemptBestEffort(store, tcw, {
      v: 1,
      lastAttemptAt: attemptAt,
      lastAttemptStatus: "error",
    }, current);
    return { ok: false, error: terminal };
  }

  if (!current()) return { ok: true, data: result };
  const aborted = signal.aborted;
  const finalStatus: "ok" | "partial" | "error" =
    terminal ? "error" : aborted || truncated || result.errors.length > 0 ? "partial" : "ok";
  const countRes = await inSpace("Fireflies count meetings", () =>
    store.countMeetings(tcw, SOURCE));
  if (!current()) return { ok: true, data: result };
  const itemCount = countRes.ok ? countRes.data : 0;
  const connectionRes = await inSpace("Fireflies re-read connection", () =>
    store.getConnection(tcw, SOURCE));
  if (!current()) return { ok: true, data: result };
  if (!connectionRes.ok) terminal ??= fromStore(connectionRes.error, "getConnection");
  const connection = connectionRes.ok ? connectionRes.data : null;
  const mayWriteConnected = connection?.status === "connected"
    || (connection === null && opts.allowMissingConnection === true);
  if (mayWriteConnected && current()) {
    const updateRes = await inSpace("Fireflies update sync state", () =>
      store.updateSyncState(tcw, {
        connectorId: SOURCE,
        status: "connected",
        lastSyncedAt: finalStatus === "ok" ? new Date().toISOString() : null,
        lastSyncStatus: finalStatus,
        lastSyncError: terminal?.message ?? (result.errors.length > 0
          ? `${result.errors.length} transcript(s) failed`
          : null),
        itemCount,
        preserveLastSyncedAt: finalStatus !== "ok",
      }));
    if (!current()) return { ok: true, data: result };
    if (!updateRes.ok) terminal ??= fromStore(updateRes.error, "updateSyncState");
  }
  await recordAttemptBestEffort(store, tcw, {
    v: 1,
    lastAttemptAt: attemptAt,
    lastAttemptStatus: terminal ? "error" : finalStatus,
  }, current);
  if (terminal) return { ok: false, error: terminal };
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
  if (activeFlight) return activeFlight.promise;
  const sequence = ++flightSequence;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  else opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const promise = runFirefliesSync(opts, controller.signal, sequence);
  const flight = { sequence, controller, promise };
  activeFlight = flight;
  try {
    return await promise;
  } finally {
    opts.signal?.removeEventListener("abort", abortFromCaller);
    if (activeFlight === flight) activeFlight = null;
  }
}
