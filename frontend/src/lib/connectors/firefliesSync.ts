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
import type { SyncProgress, SyncResult } from "./types";

const SOURCE = "fireflies" as const;

/** Structural surface of FirefliesClient used by the engine — narrow enough
 *  that unit tests can hand-roll a mock without pulling in the real class. */
export interface SyncClient {
  readonly delayMs: number;
  listNewTranscriptIds(opts: ListNewTranscriptIdsOptions): Promise<FirefliesResult<string[]>>;
  getTranscript(id: string): Promise<FirefliesResult<FirefliesTranscript>>;
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

export interface SyncFirefliesOptions {
  client: SyncClient;
  store: SyncStore;
  tcw: TinyCloudWeb;
  onProgress?: (progress: SyncProgress) => void;
  signal?: AbortSignal;
  /** Override the between-detail-fetch sleep. Defaults to setTimeout;
   *  tests pass `() => Promise.resolve()` to keep runs synchronous. */
  sleepImpl?: (ms: number) => Promise<void>;
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

/** Map a FirefliesError from client calls into a SyncError. */
function fromFireflies(err: FirefliesError): SyncError {
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

/** True when the error should abort the whole run rather than being skipped
 *  and recorded. Auth and rate-limit errors are terminal — a bad key won't
 *  suddenly become good, and continuing after a rate-limit just burns budget. */
function isTerminal(err: FirefliesError): boolean {
  return err.kind === "invalid-key" || err.kind === "rate-limited";
}

/**
 * Drive one Fireflies sync run against an injected store and client.
 *
 * Flow (spec §8):
 *  1. ensureSchema, then read the ids already in the DB.
 *  2. Ask the client for new ids (newest-first, early-exit).
 *  3. Fetch OLDEST-first: getTranscript → normalize → insertMeeting +
 *     putTranscriptBody → sleep. Between-item abort check is graceful —
 *     everything stored so far stays; state records the partial sync.
 *  4. Both ok and error paths call updateSyncState at the end (unless
 *     ensureSchema itself failed, in which case there's no DB to write to).
 *  5. Per-item errors are recorded in `errors[]` and the loop continues.
 *     Auth and rate-limit errors from the client abort the whole run and
 *     surface as typed `SyncError`s so the UI can distinguish them.
 */
export async function syncFireflies(
  opts: SyncFirefliesOptions,
): Promise<SyncFirefliesResult> {
  const { client, store, tcw, onProgress, signal } = opts;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const delayMs = client.delayMs ?? 0;

  const result: SyncResult = { added: 0, skipped: 0, errors: [] };

  const schemaRes = await store.ensureSchema(tcw);
  if (!schemaRes.ok) {
    // Schema failure — nothing to write to, so we can't updateSyncState.
    return { ok: false, error: fromStore(schemaRes.error, "ensureSchema") };
  }

  let terminal: SyncError | null = null;

  try {
    const knownRes = await store.listKnownSourceIds(tcw, SOURCE);
    if (!knownRes.ok) {
      terminal = fromStore(knownRes.error, "listKnownSourceIds");
    } else {
      const knownIds = knownRes.data;

      const listRes = await client.listNewTranscriptIds({ knownIds, onProgress });
      if (!listRes.ok) {
        terminal = fromFireflies(listRes.error);
      } else {
        // Newest-first from the client → reverse to oldest-first so an abort
        // preserves a contiguous history tail.
        const idsOldestFirst = [...listRes.data].reverse();
        const total = idsOldestFirst.length;
        onProgress?.({ phase: "fetching", done: 0, total });

        for (let i = 0; i < idsOldestFirst.length; i++) {
          if (signal?.aborted) break;

          const id = idsOldestFirst[i];
          const txRes = await client.getTranscript(id);
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
            const insertRes = await store.insertMeeting(tcw, meeting);
            if (!insertRes.ok) {
              result.errors.push(`${id}: ${insertRes.error.message}`);
              continue;
            }
            const putRes = await store.putTranscriptBody(tcw, SOURCE, meeting.sourceId, sentences);
            if (!putRes.ok) {
              result.errors.push(`${id}: ${putRes.error.message}`);
              continue;
            }
            if (insertRes.data) result.added += 1;
            else result.skipped += 1;
            onProgress?.({ phase: "storing", done: i + 1, total });
          } catch (err) {
            // normalizeFirefliesTranscript still runs synchronously — a raw
            // throw from it (bad payload) is per-item, not terminal.
            result.errors.push(`${id}: ${errorMessage(err)}`);
            continue;
          }

          // Sleep BETWEEN detail fetches (listen bug we're defending against —
          // it only slept in the LIST loop). Skip after the last item and skip
          // if the caller has since aborted, so aborts return promptly.
          if (i < idsOldestFirst.length - 1 && !signal?.aborted) {
            await sleep(delayMs);
          }
        }
      }
    }
  } catch (err) {
    // Unexpected mid-loop throw (e.g. abort-signal listener) — surface as storage.
    terminal = { kind: "storage", message: errorMessage(err) };
  }

  // Final state update — both ok and error paths reach here. countMeetings is
  // best-effort so a broken read doesn't mask the real terminal error.
  const countRes = await store.countMeetings(tcw, SOURCE);
  const itemCount = countRes.ok ? countRes.data : 0;

  const finalStatus: "ok" | "error" = terminal ? "error" : "ok";
  const updateRes = await store.updateSyncState(tcw, {
    connectorId: SOURCE,
    status: "connected",
    lastSyncedAt: new Date().toISOString(),
    lastSyncStatus: finalStatus,
    lastSyncError: terminal?.message ?? null,
    itemCount,
  });
  if (!updateRes.ok && !terminal) {
    terminal = fromStore(updateRes.error, "updateSyncState");
  }

  if (terminal) return { ok: false, error: terminal };
  return { ok: true, data: result };
}
