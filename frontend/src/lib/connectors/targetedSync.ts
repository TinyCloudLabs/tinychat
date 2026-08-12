// Targeted queued-id ingest — the browser half of the Option-C webhook path.
// See docs/connectors-spec.md §8 for the v1 sync this deliberately does NOT
// reuse, and the webhook handoff's "targeted queued-id ingest and durable
// acknowledgement" section for the contract implemented here.
//
// WHY A SECOND ENGINE. `syncFireflies()` lists newest-first and stops at the
// first id it already has. That is right for a manual catch-up and wrong for a
// queue: a webhook hands us EXACT ids, and a `meeting.summarized` event is an
// event about a meeting we usually already stored — the v1 engine would skip it
// forever. So this engine never lists; it fetches the ids it was given.
//
// OPTION C, RESTATED IN CODE. The backend queues `(meetingId, kind)` pairs and
// nothing else. The Fireflies key is read HERE, in the browser, through the
// existing `connectorSecrets` path, and is handed only to the Fireflies client.
// It is never put in a request to our backend, never logged, never persisted by
// this module. The backend holds no delegation and never writes to the user's
// space — this function is the only writer.
//
// STORAGE BEFORE ACK. An identity is acknowledged only after the user's own
// space write for it has SUCCEEDED. Acknowledging first would let a failed
// write silently drop a meeting: the queue entry would be gone and nothing
// would ever retry it. The inverse failure — write succeeded, ack response
// lost — is safe and is the case this design accepts, because a retry re-fetches
// the same id and `upsertMeeting` lands it on the SAME row (no duplicate), then
// re-acknowledges; the backend answers `alreadySettled`.
//
// NO SURPRISE PROMPTS. A locked vault or a missing key is a reported no-op, not
// an error and not a reason to pop an unlock/permission dialog. Unlocking is a
// user-initiated action on the surface, never a side effect of processing.
//
// Sequential everywhere — TinyCloud drops concurrent responses on one space,
// and Fireflies rate-limits bursts, so detail fetches are paced exactly as the
// v1 engine paces its own.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  FirefliesClient,
  type FirefliesResult,
  type FirefliesSentence,
  type FirefliesTranscript,
} from "./firefliesClient";
import {
  normalizeFirefliesTranscript,
  updateSyncState as storeUpdateSyncState,
  countMeetings as storeCountMeetings,
  upsertMeeting as storeUpsertMeeting,
  type NormalizedMeeting,
  type StoreError,
  type StoreResult,
  type UpdateSyncStateInput,
  type UpsertMeetingOutcome,
} from "./connectorStore";
import { fromFireflies, isTerminal, type SyncError } from "./firefliesSync";
import { getConnectorKey, isSecretsUnlocked } from "./connectorSecrets";
import type {
  ConnectorAckItem,
  ConnectorAckRequest,
  ConnectorAckResult,
  ConnectorPendingKind,
  ConnectorWebhooksResult,
} from "./webhooksApi";
import type { ConnectorDescriptor, SyncProgress } from "./types";

/** The backend rejects an `/ack` batch larger than this, so we chunk. */
export const TARGETED_ACK_BATCH_LIMIT = 200;

/** One surfaced queue identity. Extra fields from `GET /pending` are ignored. */
export interface TargetedQueueItem {
  meetingId: string;
  kind: ConnectorPendingKind;
}

/** Structural surface of `FirefliesClient` this engine uses. No listing call —
 *  the ids come from the queue, which is the whole point of this module. */
export interface TargetedSyncClient {
  readonly delayMs: number;
  getTranscript(id: string): Promise<FirefliesResult<FirefliesTranscript>>;
}

/** Structural surface of `connectorStore`. `upsertMeeting` writes SQL and the
 *  KV body together and preserves the row id / creation time on an update. */
export interface TargetedIngestStore {
  upsertMeeting(
    tcw: TinyCloudWeb,
    meeting: NormalizedMeeting,
    sentences: FirefliesSentence[],
  ): Promise<StoreResult<UpsertMeetingOutcome>>;
  updateSyncState(tcw: TinyCloudWeb, input: UpdateSyncStateInput): Promise<StoreResult<void>>;
  countMeetings(tcw: TinyCloudWeb, source: string): Promise<StoreResult<number>>;
}

/** Structural surface of `connectorSecrets`. Deliberately has NO `unlock`:
 *  this engine cannot prompt even by accident. */
export interface TargetedIngestSecrets {
  isUnlocked(tcw: TinyCloudWeb): boolean;
  getKey(
    tcw: TinyCloudWeb,
    descriptor: ConnectorDescriptor,
  ): Promise<{ ok: true; data: string } | { ok: false; error: unknown }>;
}

/** The only backend call this engine makes. */
export interface TargetedAckClient {
  acknowledge(
    request: ConnectorAckRequest,
  ): Promise<ConnectorWebhooksResult<ConnectorAckResult>>;
}

/**
 * Why nothing was processed. Both values are DEFINED product states the card
 * renders as an actionable "Sync queued meetings" affordance — neither is an
 * error, and neither triggers a prompt from here.
 */
export type TargetedIngestBlockedReason = "secrets-locked" | "key-missing";

export interface TargetedIngestFailure {
  meetingId: string;
  kind: ConnectorPendingKind;
  /** Where it broke: the provider fetch, or the write to the user's space. */
  stage: "fetch" | "storage";
  message: string;
}

export interface TargetedIngestOutcome {
  /** Meetings written to the user's space this run (unique meeting ids). */
  stored: number;
  inserted: number;
  updated: number;
  /** Queue identities the backend removed because of THIS run. */
  acknowledged: number;
  /** Already gone when we acknowledged — the lost-response retry, a success. */
  alreadySettled: number;
  /** Covered by the purge ledger: not settled here, and not ingested. */
  tombstoned: number;
  /** Per-identity failures. Each stays queued for a later retry. */
  failures: TargetedIngestFailure[];
  /**
   * Stored, but the acknowledgement did not land. The meeting is safe; the
   * identity is still queued and the next run settles it idempotently.
   */
  unacknowledged: TargetedQueueItem[];
  /** The failing `ConnectorWebhooksResult.status`, or null when every ack landed. */
  ackError: ConnectorWebhooksResult<never>["status"] | null;
  blocked: TargetedIngestBlockedReason | null;
  /** Meetings stored for this source after the run — what the card shows. */
  itemCount: number;
}

export type TargetedIngestResult =
  | { ok: true; data: TargetedIngestOutcome }
  | { ok: false; error: SyncError };

export interface IngestQueuedMeetingsOptions {
  tcw: TinyCloudWeb;
  /** Supplies the secret name/scope AND the SQL `source` — never a body field. */
  descriptor: ConnectorDescriptor;
  /** The surfaced queue, in the order the backend handed it over. */
  items: readonly TargetedQueueItem[];
  webhooks: TargetedAckClient;
  store?: TargetedIngestStore;
  secrets?: TargetedIngestSecrets;
  /** Built per run from the browser-held key; injectable for tests. */
  createClient?: (apiKey: string) => TargetedSyncClient;
  onProgress?: (progress: SyncProgress) => void;
  signal?: AbortSignal;
  /** Defaults to setTimeout; tests pass a recorder to keep runs synchronous. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultStore: TargetedIngestStore = {
  upsertMeeting: storeUpsertMeeting,
  updateSyncState: storeUpdateSyncState,
  countMeetings: storeCountMeetings,
};

const defaultSecrets: TargetedIngestSecrets = {
  isUnlocked: isSecretsUnlocked,
  getKey: (tcw, descriptor) => getConnectorKey<unknown>(tcw, descriptor),
};

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

/**
 * Classify a `tcw.secrets.get` failure.
 *
 * Only two shapes are a no-op: the vault is locked, or this connector has no
 * stored key (disconnected on another device, or never connected). Anything
 * else is a real failure and must surface — a secrets-service outage read as
 * "no key" would quietly stop ingesting forever.
 */
function classifySecretsError(err: unknown): TargetedIngestBlockedReason | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if (/VAULT_LOCKED/i.test(code)) return "secrets-locked";
  if (/NOT_FOUND/i.test(code)) return "key-missing";
  if (/not found|404/i.test(message)) return "key-missing";
  return null;
}

/** Group queue identities by meeting id, preserving first-seen order.
 *  `meeting.transcribed` and `meeting.summarized` for the same meeting are two
 *  queue identities but ONE provider fetch and ONE write. */
function groupByMeeting(
  items: readonly TargetedQueueItem[],
): { meetingId: string; kinds: ConnectorPendingKind[] }[] {
  const groups: { meetingId: string; kinds: ConnectorPendingKind[] }[] = [];
  const byId = new Map<string, { meetingId: string; kinds: ConnectorPendingKind[] }>();
  for (const item of items) {
    let group = byId.get(item.meetingId);
    if (!group) {
      group = { meetingId: item.meetingId, kinds: [] };
      byId.set(item.meetingId, group);
      groups.push(group);
    }
    if (!group.kinds.includes(item.kind)) group.kinds.push(item.kind);
  }
  return groups;
}

function emptyOutcome(
  overrides: Partial<TargetedIngestOutcome> = {},
): TargetedIngestOutcome {
  return {
    stored: 0,
    inserted: 0,
    updated: 0,
    acknowledged: 0,
    alreadySettled: 0,
    tombstoned: 0,
    failures: [],
    unacknowledged: [],
    ackError: null,
    blocked: null,
    itemCount: 0,
    ...overrides,
  };
}

/**
 * Process a surfaced webhook queue: fetch each exact id, write it to the user's
 * space, then acknowledge what was written.
 *
 * Ordering is the contract (handoff steps 1–8): fetch → normalize → upsert →
 * connector state/count → acknowledge. Nothing is acknowledged that was not
 * stored, and the whole batch is never failed because one item failed —
 * successes settle, failures stay queued.
 */
export async function ingestQueuedMeetings(
  opts: IngestQueuedMeetingsOptions,
): Promise<TargetedIngestResult> {
  const { tcw, descriptor, items, webhooks, onProgress, signal } = opts;
  const store = opts.store ?? defaultStore;
  const secrets = opts.secrets ?? defaultSecrets;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const source = descriptor.source;

  const groups = groupByMeeting(items);
  // Nothing queued: touch NOTHING. Not the vault, not the space, not the
  // backend — an empty visit must be free and must not look like activity.
  if (groups.length === 0) return { ok: true, data: emptyOutcome() };

  // ── 2. The key, browser-side only ────────────────────────────────────
  // `isUnlocked` is a read, never a prompt. If it is false we stop here: the
  // surface offers a user-initiated unlock, this engine never asks for one.
  if (!secrets.isUnlocked(tcw)) {
    return { ok: true, data: emptyOutcome({ blocked: "secrets-locked" }) };
  }
  const keyRes = await secrets.getKey(tcw, descriptor);
  if (!keyRes.ok) {
    const blocked = classifySecretsError(keyRes.error);
    if (blocked) return { ok: true, data: emptyOutcome({ blocked }) };
    return {
      ok: false,
      error: { kind: "storage", message: `secrets.get: ${errorMessage(keyRes.error)}` },
    };
  }
  const apiKey = keyRes.data;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return { ok: true, data: emptyOutcome({ blocked: "key-missing" }) };
  }

  const createClient =
    opts.createClient ?? ((key: string) => new FirefliesClient({ apiKey: key }));
  const client = createClient(apiKey);
  const delayMs = client.delayMs ?? 0;

  const failures: TargetedIngestFailure[] = [];
  /** Identities whose space write SUCCEEDED — the only ack candidates. */
  const settled: ConnectorAckItem[] = [];
  let stored = 0;
  let inserted = 0;
  let updated = 0;
  let terminal: SyncError | null = null;

  const recordFailure = (
    kinds: ConnectorPendingKind[],
    meetingId: string,
    stage: "fetch" | "storage",
    message: string,
  ) => {
    for (const kind of kinds) failures.push({ meetingId, kind, stage, message });
  };

  onProgress?.({ phase: "fetching", done: 0, total: groups.length });

  // ── 3–6. Fetch each exact id, sequentially and paced ─────────────────
  for (let i = 0; i < groups.length; i++) {
    if (signal?.aborted) break;
    const { meetingId, kinds } = groups[i];

    const txRes = await client.getTranscript(meetingId);
    if (!txRes.ok) {
      if (isTerminal(txRes.error)) {
        // A bad key stays bad and a rate limit needs a wait — stop fetching.
        // What was already stored is still settled below.
        terminal = fromFireflies(txRes.error);
        break;
      }
      recordFailure(kinds, meetingId, "fetch", txRes.error.message);
    } else {
      try {
        const { meeting, sentences } = normalizeFirefliesTranscript(txRes.data);
        const upsertRes = await store.upsertMeeting(tcw, meeting, sentences);
        if (!upsertRes.ok) {
          // The write did not happen, so this identity is NOT acknowledged and
          // stays queued. This is the storage-before-ack rule doing its job.
          recordFailure(kinds, meetingId, "storage", upsertRes.error.message);
        } else {
          stored += 1;
          if (upsertRes.data.inserted) inserted += 1;
          else updated += 1;
          for (const kind of kinds) settled.push({ meetingId, kind, status: "done" });
          onProgress?.({ phase: "storing", done: i + 1, total: groups.length });
        }
      } catch (err) {
        // normalize() runs synchronously and can throw on a malformed payload —
        // per item, never fatal to the batch.
        recordFailure(kinds, meetingId, "storage", errorMessage(err));
      }
    }

    // Pace BETWEEN detail fetches, exactly as the v1 engine does. The targeted
    // path burst-fetching would trip the same rate limit the v1 path avoids.
    if (i < groups.length - 1 && !signal?.aborted && !terminal) {
      await sleep(delayMs);
    }
  }

  // ── 7. Connector state / count (also a write to the user's space) ─────
  const countRes = await store.countMeetings(tcw, source);
  const itemCount = countRes.ok ? countRes.data : 0;
  const failed = terminal !== null || failures.length > 0;
  const updateRes = await store.updateSyncState(tcw, {
    connectorId: descriptor.id,
    status: "connected",
    lastSyncedAt: new Date().toISOString(),
    lastSyncStatus: failed ? "error" : "ok",
    // Counts only — a meeting id has no business in a persisted status string.
    lastSyncError: terminal
      ? terminal.message
      : failures.length > 0
        ? `${failures.length} queued item(s) failed`
        : null,
    itemCount,
  });
  if (!updateRes.ok && !terminal) {
    terminal = fromStore(updateRes.error, "updateSyncState");
  }

  // ── 8. Acknowledge — successes only, and only now ────────────────────
  // Runs even when a terminal error stopped the loop: those meetings ARE in the
  // user's space, and leaving them queued would re-fetch them for nothing.
  const ack = await acknowledgeSettled(webhooks, source, settled);

  const outcome: TargetedIngestOutcome = {
    stored,
    inserted,
    updated,
    acknowledged: ack.acknowledged,
    alreadySettled: ack.alreadySettled,
    tombstoned: ack.tombstoned,
    failures,
    unacknowledged: ack.unacknowledged,
    ackError: ack.ackError,
    blocked: null,
    itemCount,
  };

  if (terminal) return { ok: false, error: terminal };
  return { ok: true, data: outcome };
}

interface AckTally {
  acknowledged: number;
  alreadySettled: number;
  tombstoned: number;
  unacknowledged: TargetedQueueItem[];
  ackError: ConnectorWebhooksResult<never>["status"] | null;
}

/**
 * Settle stored identities in backend-sized batches.
 *
 * A resolved non-`ok` result is a FAILURE, not an empty success: the batch that
 * failed and every batch after it are reported as `unacknowledged` so the caller
 * can surface "stored, not yet settled" instead of silently claiming the queue
 * is clear. Those identities are still queued backend-side, and the retry is
 * idempotent by construction.
 */
async function acknowledgeSettled(
  webhooks: TargetedAckClient,
  source: string,
  settled: ConnectorAckItem[],
): Promise<AckTally> {
  const tally: AckTally = {
    acknowledged: 0,
    alreadySettled: 0,
    tombstoned: 0,
    unacknowledged: [],
    ackError: null,
  };
  if (settled.length === 0) return tally;

  for (let start = 0; start < settled.length; start += TARGETED_ACK_BATCH_LIMIT) {
    const batch = settled.slice(start, start + TARGETED_ACK_BATCH_LIMIT);
    if (tally.ackError !== null) {
      // The transport is already failing; do not hammer it with the rest.
      pushUnacknowledged(tally, batch);
      continue;
    }
    // `source` only CONFIRMS what the backend already derived from the session.
    // No key, no token, no payload — just the identities we wrote.
    const res = await webhooks.acknowledge({ source, items: batch });
    if (res.status !== "ok") {
      tally.ackError = res.status;
      pushUnacknowledged(tally, batch);
      continue;
    }
    tally.acknowledged += res.value.acknowledged;
    tally.alreadySettled += res.value.alreadySettled;
    tally.tombstoned += res.value.tombstoned;
  }

  return tally;
}

function pushUnacknowledged(tally: AckTally, batch: ConnectorAckItem[]): void {
  for (const item of batch) {
    tally.unacknowledged.push({ meetingId: item.meetingId, kind: item.kind });
  }
}
