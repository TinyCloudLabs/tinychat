import type { TinyCloudNode } from "@tinycloud/node-sdk";
import * as serverPackage from "@tinyboilerplate/server";
import { BackendStorageLane } from "./backend-storage-lane.js";
import {
  isValidMeetingId,
  isValidSource,
  keyedLogHash,
  normalizeWebhookAddress,
} from "./webhook-tokens.js";

const { assertKvResult, withSessionRefresh } = serverPackage;
const { isKvMissingKeyResult } = serverPackage as typeof serverPackage & {
  isKvMissingKeyResult: (result: unknown, key: string) => boolean;
};

/**
 * Per-user pending queue over the backend's OWN KV (§5.1/§5.2/§5.3/§5.5).
 *
 * Shape, per W0's recorded verdict (`docs/connector-webhooks-kv-write-budget.md` §0/§6.4):
 * ONE JSON array per address, NOT per-item keys. Per-item keys make the burst strictly worse
 * (50 deliveries = 50 uncoalescable writes) and turn a 200-item drain from 1 write into 200.
 *
 * MULTI-INSTANCE WARNING — read this before adding a second backend instance.
 * The read-modify-write below is made safe by an IN-PROCESS per-address mutex, which is a
 * real mutex only because the backend is a single Bun process on a single CVM (the same
 * assumption `DelegationCache`, the usage counters and the nonce store already bake in).
 * **If the backend is ever scaled to more than one instance, this queue silently loses
 * events** — last write wins, exactly as listen's unlocked queue does today. The mitigation
 * then is a per-item KV key (`webhooks/pending/{source}/{address}/{meetingId}`) + `list`,
 * which is naturally concurrent-safe at the cost of a `list` call per drain, and W0's write
 * budget is void that same day.
 *
 * Keys are backend-own and auto-prefixed under `ops.tinychat.backend` — they do NOT carry the
 * full `xyz.tinycloud.tinychat/…` path. (User-space calls, e.g. the writer's, DO. Getting
 * these two conventions backwards is the classic tinychat mistake in both directions.)
 *
 * ERROR CONVENTION — a DELIBERATE deviation from `docs/connectors-spec.md` §4's "return
 * `Result`-style objects, never throw across module boundaries", which is scoped there to the
 * FRONTEND connector modules. This service rejects. Its only callers are Express handlers under
 * §4.3's "nothing may leave the request unanswered or throw out of the handler", so every call
 * site is already inside a `try`/`catch` that maps the failure to a status code; a second
 * `{ok:false}` channel beside it is a second thing to forget to check. The `{ok, …}` shape is
 * reserved for verdicts that are INSPECTED rather than propagated
 * (`validateConnectorWebhookSecrets`, `createStoredDelegationGate.validate`). Same rule in
 * `webhook-tokens.ts` and `connector-drain.ts`; the spec records it too.
 */

const PENDING_KEY_PREFIX = "webhooks/pending";
const DEAD_KEY_PREFIX = "webhooks/dead";
const CORRUPT_KEY_PREFIX = "webhooks/corrupt";

/** §5.3: cap 200 items/user, drop-oldest, and log the drop. */
export const PENDING_CAP = 200;
/** §5.3: dead-letter cap 50, drop-oldest. */
export const DEAD_CAP = 50;
/** §5.3: 14 days. An item older than this is PROMOTED to dead-letter, never silently dropped. */
export const QUEUE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** §5.5: `attempts >= 5` → dead-letter. */
export const MAX_ATTEMPTS = 5;
/** §5.5: `nextAttemptAt = now + min(2^attempts × 60s, 6h)`. */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
/** Jitter is additive and bounded at 10% of the delay, so the schedule stays predictable. */
export const BACKOFF_JITTER_RATIO = 0.1;
/**
 * W0 §6.1 (a CONDITION of the "keep the queue on the node" verdict): coalesce deliveries
 * arriving inside this window into ONE queue write. 50 deliveries in <1s cost 1–4 writes
 * instead of 50 — ~2–8s of the node's shared write budget instead of ~100s. The `202` is
 * sent AFTER the flush, so an acked delivery is still a durably enqueued delivery.
 */
export const ENQUEUE_FLUSH_WINDOW_MS = 250;

export type PendingKind = "transcript" | "summary";

export interface PendingItem {
  /** Fireflies id — the (source, source_id) identity. */
  meetingId: string;
  kind: PendingKind;
  /** ISO. Also what the 14-day TTL is measured from. */
  receivedAt: string;
  /**
   * ISO, the PROVIDER's `timestamp` on the delivery (§4.5) when it carried one — absent for the
   * legacy shape. `receivedAt` is refreshed by a duplicate delivery, so a captured delivery
   * replayed after a purge arrives with `receivedAt = now` and slips past §6.2's tombstone
   * watermark. This field does not move on a replay, so it is what the tombstone compares.
   */
  sourceTimestamp?: string;
  /** 0 on enqueue. Only ITEM-state failures increment this (§5.5). */
  attempts: number;
  /** ISO; === receivedAt on enqueue. */
  nextAttemptAt: string;
  /** Short code, never a payload fragment. */
  lastError?: string;
  /**
   * Backoff counter for the non-burning classes (§5.5). `awaiting_transcript` must re-queue
   * "with backoff" without burning attempts, so the backoff needs a counter that is not
   * `attempts` — otherwise every hold retries at a flat 60s forever.
   */
  requeues?: number;
}

export interface DeadItem extends PendingItem {
  deadAt: string;
}

// ── Error classes (§5.5) ─────────────────────────────────────────────
//
// Non-item-state failures must NOT burn attempts, or one expired delegation dead-letters a
// user's whole queue in five minutes.

export const DELEGATION_UNUSABLE = "delegation_unusable";
export const SCHEMA_MISSING = "schema_missing";
export const SPACE_NOT_HOSTED = "space_not_hosted";
export const AWAITING_TRANSCRIPT = "awaiting_transcript";
export const LEDGER_UNAVAILABLE = "ledger_unavailable";
/** The server-side content sink was unreachable — infrastructure-state, not item-state. */
export const CONTENT_STORE_UNAVAILABLE = "content_store_failed";

/** User-state, ordering-state and infrastructure-state — none of them is item-state. */
export const NON_BURNING_ERRORS: readonly string[] = [
  DELEGATION_UNUSABLE,
  SCHEMA_MISSING,
  SPACE_NOT_HOSTED,
  AWAITING_TRANSCRIPT,
  LEDGER_UNAVAILABLE,
  CONTENT_STORE_UNAVAILABLE,
];

const NON_BURNING = new Set(NON_BURNING_ERRORS);

/** §5.6: a summary that outran its transcript is dead-lettered at the TTL, never at attempt 5. */
export const AWAITING_TRANSCRIPT_TIMEOUT = "awaiting_transcript_timeout";
/** Every other item promoted to dead-letter by the 14-day TTL. */
export const TTL_EXPIRED = "ttl_expired";

export function burnsAttempt(lastError: string | undefined): boolean {
  return !(typeof lastError === "string" && NON_BURNING.has(lastError));
}

/** `min(2^n × 60s, 6h)` — the exact §5.5 schedule, before jitter. */
export function backoffDelayMs(count: number): number {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n >= 32) return BACKOFF_CAP_MS;
  return Math.min(2 ** n * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
}

// ── Key builders ─────────────────────────────────────────────────────

function normalizeQueueSource(source: unknown): string {
  if (!isValidSource(source)) throw new Error("Invalid webhook source");
  return source;
}

export function pendingQueueKey(source: string, address: string): string {
  return `${PENDING_KEY_PREFIX}/${normalizeQueueSource(source)}/${normalizeWebhookAddress(address)}`;
}

export function deadLetterKey(source: string, address: string): string {
  return `${DEAD_KEY_PREFIX}/${normalizeQueueSource(source)}/${normalizeWebhookAddress(address)}`;
}

export function corruptQueueKey(source: string, address: string): string {
  return `${CORRUPT_KEY_PREFIX}/${normalizeQueueSource(source)}/${normalizeWebhookAddress(address)}`;
}

// ── Validation (§5.3 container-level recovery) ───────────────────────

const KINDS = new Set<PendingKind>(["transcript", "summary"]);
const MAX_ERROR_CODE_LENGTH = 64;

function isIsoish(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * §6.3/T13. Exported because the DRAIN's log lines interpolate the same release-hook-supplied
 * strings (`outcome.reason` from a `skipped` result, `classifyDrainError`'s verbatim
 * `DrainError.code`) into a `public_logs=true` stream, and a newline in one of those forges lines
 * into the forensic record. Nothing attacker-controlled reaches them under the shipped
 * surface-only release; an Option-A hook is where it becomes live.
 */
export function sanitizeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, MAX_ERROR_CODE_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored >= 0 ? floored : null;
}

function parsePendingItem(raw: unknown): PendingItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const value = raw as Record<string, unknown>;
  if (!isValidMeetingId(value.meetingId)) return null;
  if (typeof value.kind !== "string" || !KINDS.has(value.kind as PendingKind))
    return null;
  if (!isIsoish(value.receivedAt) || !isIsoish(value.nextAttemptAt))
    return null;
  const attempts = nonNegativeInt(value.attempts);
  if (attempts === null) return null;

  const item: PendingItem = {
    meetingId: value.meetingId,
    kind: value.kind as PendingKind,
    receivedAt: value.receivedAt,
    attempts,
    nextAttemptAt: value.nextAttemptAt,
  };
  if (isIsoish(value.sourceTimestamp))
    item.sourceTimestamp = value.sourceTimestamp;
  const lastError = sanitizeErrorCode(value.lastError);
  if (lastError !== undefined) item.lastError = lastError;
  const requeues = nonNegativeInt(value.requeues);
  if (requeues !== null && requeues > 0) item.requeues = requeues;
  return item;
}

function parseDeadItem(raw: unknown): DeadItem | null {
  const item = parsePendingItem(raw);
  if (item === null) return null;
  const deadAt = (raw as Record<string, unknown>).deadAt;
  return { ...item, deadAt: isIsoish(deadAt) ? deadAt : item.receivedAt };
}

function itemKey(item: { meetingId: string; kind: PendingKind }): string {
  return `${item.kind}:${item.meetingId}`;
}

// ── Logging (§6.3 — ids only, keyed hashes, never a raw address or meeting id) ─

function hashed(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    // LOG_HASH_SALT unset (flag-off / test contexts): drop the field rather than fake it.
    return "unavailable";
  }
}

/**
 * How many keyed hashes one `mids=` field may carry.
 *
 * `POST /ack` accepts 200 identities per request and every cap/drop path here can move a whole
 * queue at once, so an unbounded list let ONE call choose the size of a record on a stream the
 * deploy publishes with `--public-logs` (~3 KB from a single ack). No raw identifier leaks either
 * way — every entry is keyed-hashed — so this bounds record shape, not disclosure. The overflow
 * is REPORTED as `mids_omitted=`, matching the no-silent-caps rule the purge overflow follows.
 */
const LOGGED_MIDS_CAP = 20;

/** `mids=<=20 hashes>[ mids_omitted=N]` — the one way an id list reaches a log line. */
function midsField(hashes: readonly string[]): string {
  if (hashes.length <= LOGGED_MIDS_CAP) return `mids=${hashes.join(",")}`;
  return (
    `mids=${hashes.slice(0, LOGGED_MIDS_CAP).join(",")} ` +
    `mids_omitted=${hashes.length - LOGGED_MIDS_CAP}`
  );
}

function logQueue(fields: string): void {
  console.log(`[connector-queue] ${fields} t=${new Date().toISOString()}`);
}

function logQueueWarn(fields: string): void {
  console.warn(`[connector-queue] ${fields} t=${new Date().toISOString()}`);
}

// ── Public result shapes ─────────────────────────────────────────────

export type EnqueueStatus = "queued" | "deduped" | "dropped";

export interface EnqueueResult {
  status: EnqueueStatus;
  /** Queue depth after the flush this enqueue rode in on. */
  depth: number;
}

export interface EnqueueInput {
  meetingId: string;
  kind: PendingKind;
  /** ISO; defaults to now. */
  receivedAt?: string;
  /** ISO; the provider's own timestamp when the delivery carried one. See {@link PendingItem}. */
  sourceTimestamp?: string;
}

/** An `EnqueueInput` with the defaultable fields resolved. `sourceTimestamp` has no default. */
type QueuedEntry = Required<Omit<EnqueueInput, "sourceTimestamp">> &
  Pick<EnqueueInput, "sourceTimestamp">;

export interface SettleOutcome {
  meetingId: string;
  kind: PendingKind;
  /** `done` removes the item; `failed` applies §5.5's classes. */
  status: "done" | "failed";
  /** Short code. Required for `failed`. */
  lastError?: string;
  /**
   * §5.4/T5: a Fireflies 404 for an id we have NEVER written is a fabrication until proven
   * otherwise — terminal on the FIRST attempt, not after five.
   */
  terminal?: boolean;
}

export type SettleDisposition =
  | "removed"
  | "requeued"
  | "dead-lettered"
  | "unknown";

export interface SettleResult {
  meetingId: string;
  kind: PendingKind;
  disposition: SettleDisposition;
  attempts: number;
  nextAttemptAt: string | null;
}

/**
 * One browser-asserted settlement: "I fetched this exact id with the user's own Fireflies key
 * and the write to the user's own space succeeded" (§4.7 under ingest shape C). It carries an
 * IDENTITY and nothing else — no status, no error string, no attempt count. The first version of
 * the ack route accepts successes only, so a failure has no shape to arrive in, and a
 * browser-supplied error string has nowhere to land.
 */
export interface AcknowledgeInput {
  meetingId: string;
  kind: PendingKind;
}

/**
 * `not-queued` is a SUCCESS, not a miss: the browser stored the meeting and then lost the ack
 * response, so the retry finds the identity already gone. Distinguishing it from `removed` is
 * what lets the route report "already settled" instead of inventing an ingest.
 */
export type AcknowledgeDisposition = "removed" | "not-queued";

export interface AcknowledgeResult {
  meetingId: string;
  kind: PendingKind;
  disposition: AcknowledgeDisposition;
}

export interface ConnectorQueueOptions {
  maxItems?: number;
  maxDeadItems?: number;
  ttlMs?: number;
  maxAttempts?: number;
  flushWindowMs?: number;
  /** Injectable clock — the 14-day TTL is not testable against the wall clock. */
  now?: () => number;
  /** Injectable jitter in [0,1). Tests pin it to 0 so the schedule is asserted exactly. */
  jitter?: () => number;
  /**
   * The shared backend-storage lane (§9.3). Wired by index.ts so the queue, the KV content store
   * and the KV credential store all funnel through ONE lane against the shared backend node.
   * Absent = a private per-instance lane (the shipped default for tests and standalone use).
   */
  storageLane?: BackendStorageLane;
}

interface QueueState {
  items: PendingItem[];
  dead: DeadItem[];
  /** True when the read itself mutated the value (invalid entries dropped, or a reset). */
  repaired: boolean;
}

interface DeadSweep {
  items: PendingItem[];
  dead: DeadItem[];
  promoted: PendingItem[];
  dropped: DeadItem[][];
}

interface DeadAppend {
  dead: DeadItem[];
  dropped: DeadItem[];
}

interface PendingBatch {
  entries: QueuedEntry[];
  promise: Promise<EnqueueResult[]>;
  /**
   * F005: set by `clear()`. The batch was ACCEPTED before the clear and flushes AFTER it, so
   * without this the flush writes the very items the clear was meant to drop and re-enable
   * hands back a queue it promised was empty. A superseded batch never touches storage.
   */
  superseded: boolean;
}

/**
 * What a `clear()` actually removed. F010: the teardown used to `list()` then `clear()` and
 * report the list's length — anything enqueued between the two calls was dropped but not
 * counted. Counting inside the clear's own lock makes `queueDropped` exact.
 */
export interface ClearResult {
  /** Durably-stored pending items this call deleted. */
  cleared: number;
  /** Accepted-but-unflushed deliveries this call superseded (F005). */
  superseded: number;
}

export class ConnectorQueue {
  private readonly maxItems: number;
  private readonly maxDeadItems: number;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly flushWindowMs: number;
  private readonly now: () => number;
  private readonly jitter: () => number;

  /** §5.2 defense 1: one mutex per address, around every read-modify-write. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** W0 §6.1: in-memory coalescing window per address, INSIDE the mutex. */
  private readonly batches = new Map<string, PendingBatch>();
  /**
   * §9.3: TinyCloud drops concurrent responses on one space, and every key here lives in the
   * ONE backend space — so the per-address mutexes are not enough on their own. Node calls
   * additionally funnel through the shared BackendStorageLane (or a private per-instance lane
   * when no shared lane is injected, e.g. tests / standalone use).
   */
  private readonly storageLane: BackendStorageLane;

  constructor(
    private readonly node: TinyCloudNode,
    options: ConnectorQueueOptions = {},
  ) {
    this.maxItems = options.maxItems ?? PENDING_CAP;
    this.maxDeadItems = options.maxDeadItems ?? DEAD_CAP;
    this.ttlMs = options.ttlMs ?? QUEUE_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.flushWindowMs = options.flushWindowMs ?? ENQUEUE_FLUSH_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.jitter = options.jitter ?? (() => Math.random());
    this.storageLane = options.storageLane ?? new BackendStorageLane();
  }

  /**
   * Enqueue one delivery. Resolves only once the queue value is durably written (W0 §6.1) —
   * the caller's `202` rides on this promise, so an acked delivery is an enqueued delivery.
   */
  enqueue(
    source: string,
    address: string,
    input: EnqueueInput,
  ): Promise<EnqueueResult> {
    const key = pendingQueueKey(source, address);
    if (!isValidMeetingId(input.meetingId)) {
      return Promise.reject(new Error("Invalid meeting id"));
    }
    if (!KINDS.has(input.kind)) {
      return Promise.reject(new Error("Invalid pending item kind"));
    }
    const entry: QueuedEntry = {
      meetingId: input.meetingId,
      kind: input.kind,
      receivedAt: isIsoish(input.receivedAt)
        ? input.receivedAt
        : new Date(this.now()).toISOString(),
      ...(isIsoish(input.sourceTimestamp)
        ? { sourceTimestamp: input.sourceTimestamp }
        : {}),
    };

    let batch = this.batches.get(key);
    if (batch === undefined) {
      const created: Omit<PendingBatch, "promise"> = {
        entries: [],
        superseded: false,
      };
      const promise = new Promise<EnqueueResult[]>((resolve, reject) => {
        // Deliberately NOT unref'd: the ack waits on this flush.
        setTimeout(() => {
          // The batch is retired when its flush ACQUIRES THE LOCK, not when this timer fires —
          // see `flushBatch`. That is W1's burst-ack amendment.
          this.withLock(key, () => this.flushBatch(source, address, batch!)).then(
            resolve,
            reject,
          );
        }, this.flushWindowMs);
      });
      batch = Object.assign(created, { promise });
      this.batches.set(key, batch);
    }

    const index = batch.entries.push(entry) - 1;
    return batch.promise.then((results) => results[index]!);
  }

  /** The pending items, oldest-`receivedAt` first (§5.6 ordering). */
  async list(source: string, address: string): Promise<PendingItem[]> {
    return this.withLock(pendingQueueKey(source, address), async () => {
      const state = await this.readState(source, address);
      const swept = this.sweepExpired(state.items, state.dead);
      await this.persist(
        source,
        address,
        state,
        swept.items,
        swept.dead,
        state.repaired,
        swept.dropped,
      );
      this.logDeadChanges(source, address, swept.promoted);
      return sortByReceivedAt(swept.items);
    });
  }

  async depth(source: string, address: string): Promise<number> {
    return (await this.list(source, address)).length;
  }

  /** Items whose `nextAttemptAt` has arrived, oldest first. Future ones are skipped, not retried hot. */
  async due(source: string, address: string): Promise<PendingItem[]> {
    const now = this.now();
    const items = await this.list(source, address);
    return items.filter((item) => Date.parse(item.nextAttemptAt) <= now);
  }

  /** The dead-letter, surfaced in `GET …/webhooks/pending` so the operator can see it (§5.3). */
  async dead(source: string, address: string): Promise<DeadItem[]> {
    // Locked on the PENDING key, not its own: a dead-letter read must never observe a
    // half-applied promotion from a concurrent settle, and it runs the TTL sweep itself so
    // "did this expire?" does not depend on which accessor the caller happened to call first.
    return this.withLock(pendingQueueKey(source, address), async () => {
      const state = await this.readState(source, address);
      const swept = this.sweepExpired(state.items, state.dead);
      await this.persist(
        source,
        address,
        state,
        swept.items,
        swept.dead,
        state.repaired,
        swept.dropped,
      );
      this.logDeadChanges(source, address, swept.promoted);
      return swept.dead;
    });
  }

  /**
   * MAINTENANCE ONLY (§5.4 trigger 2 under §10.1 = C). Applies the TTL / dead-letter sweep and
   * persists it, in one locked read-modify-write, and reports COUNTS — never ids.
   *
   * The count/id distinction is the whole safety argument for running this in the background:
   * a sweep performs no purge-ledger read, so any id it returned would be an UNGATED surface,
   * and under C an id reaching a caller is what resurrects a purged meeting. Counts carry no
   * such authority, and the timer discards them anyway.
   *
   * Why it exists at all when `list`/`dead`/`settle`/`flush` already sweep: those run only when
   * a delivery arrives or the user visits. An abandoned connector — key revoked in Fireflies,
   * user gone — would otherwise hold its queued ids past the 14-day TTL indefinitely, and that
   * TTL is a retention promise rather than a best-effort one.
   */
  async sweep(
    source: string,
    address: string,
  ): Promise<{ pending: number; dead: number }> {
    return this.withLock(pendingQueueKey(source, address), async () => {
      const state = await this.readState(source, address);
      const swept = this.sweepExpired(state.items, state.dead);
      await this.persist(
        source,
        address,
        state,
        swept.items,
        swept.dead,
        state.repaired,
        swept.dropped,
      );
      this.logDeadChanges(source, address, swept.promoted);
      return { pending: swept.items.length, dead: swept.dead.length };
    });
  }

  /** Apply drain outcomes to the queue in ONE read-modify-write (§5.5). */
  async settle(
    source: string,
    address: string,
    outcomes: SettleOutcome[],
  ): Promise<SettleResult[]> {
    return this.withLock(pendingQueueKey(source, address), async () => {
      const state = await this.readState(source, address);
      const swept = this.sweepExpired(state.items, state.dead);
      let items = swept.items;
      let dead = swept.dead;
      const promoted = [...swept.promoted];
      const dropped = [...swept.dropped];
      const results: SettleResult[] = [];

      for (const outcome of outcomes) {
        const key = itemKey(outcome);
        const index = items.findIndex((item) => itemKey(item) === key);
        if (index === -1) {
          results.push({
            meetingId: outcome.meetingId,
            kind: outcome.kind,
            disposition: "unknown",
            attempts: 0,
            nextAttemptAt: null,
          });
          continue;
        }
        const item = items[index]!;

        if (outcome.status === "done") {
          items = items.filter((_, i) => i !== index);
          results.push({
            meetingId: item.meetingId,
            kind: item.kind,
            disposition: "removed",
            attempts: item.attempts,
            nextAttemptAt: null,
          });
          continue;
        }

        const lastError =
          sanitizeErrorCode(outcome.lastError) ?? "unknown_error";
        const burns = burnsAttempt(lastError);
        const attempts = burns ? item.attempts + 1 : item.attempts;
        const requeues = burns
          ? (item.requeues ?? 0)
          : (item.requeues ?? 0) + 1;

        if (
          outcome.terminal === true ||
          (burns && attempts >= this.maxAttempts)
        ) {
          items = items.filter((_, i) => i !== index);
          const deadItem = { ...item, attempts, lastError };
          const appended = this.appendDead(dead, deadItem);
          dead = appended.dead;
          promoted.push(deadItem);
          if (appended.dropped.length > 0) dropped.push(appended.dropped);
          results.push({
            meetingId: item.meetingId,
            kind: item.kind,
            disposition: "dead-lettered",
            attempts,
            nextAttemptAt: null,
          });
          continue;
        }

        const delayMs = this.jittered(
          backoffDelayMs(burns ? attempts : requeues),
        );
        const nextAttemptAt = new Date(this.now() + delayMs).toISOString();
        const updated: PendingItem = {
          ...item,
          attempts,
          nextAttemptAt,
          lastError,
        };
        if (requeues > 0) updated.requeues = requeues;
        else delete updated.requeues;
        items = items.map((existing, i) => (i === index ? updated : existing));
        results.push({
          meetingId: item.meetingId,
          kind: item.kind,
          disposition: "requeued",
          attempts,
          nextAttemptAt,
        });
      }

      await this.persist(
        source,
        address,
        state,
        items,
        dead,
        state.repaired,
        dropped,
      );
      this.logDeadChanges(source, address, promoted);
      return results;
    });
  }

  /**
   * BROWSER SETTLEMENT (§4.7 under ingest shape C) — the durable half of the acknowledgement
   * companion, in ONE locked read-modify-write.
   *
   * Deliberately NOT `settle(…, status:"done")`, even though the removal is the same:
   *
   *  - `settle` is the DRAIN's vocabulary. Its `SettleOutcome` carries `status`, `lastError` and
   *    `terminal`, every one of which mutates attempt counters or promotes to the dead-letter.
   *    Reusing it here would put a browser-supplied object one field away from dead-lettering a
   *    user's own queue, and the ack route's whole contract is that a browser may assert exactly
   *    one thing: "this identity is done".
   *  - `settle` reports a missing identity as `unknown`, which reads as an anomaly. For an ack it
   *    is the ordinary lost-response retry and must be a success — see {@link AcknowledgeResult}.
   *  - It VALIDATES before mutating. `settle` tolerates a junk id because the drain composed it
   *    from an item it had just read; here the ids arrive from the network, so an invalid one
   *    rejects the whole batch before the queue is read, let alone written.
   *
   * The dead-letter is untouched. A dead item is never surfaced for processing, so the browser
   * has no dead identity to acknowledge; letting an ack reach into the dead-letter would only add
   * a way to erase the forensic record §5.3 keeps deliberately.
   */
  async acknowledge(
    source: string,
    address: string,
    acks: AcknowledgeInput[],
  ): Promise<AcknowledgeResult[]> {
    // Validation runs OUTSIDE the lock and before any node call: nothing is read, nothing is
    // written, and a bad batch cannot cost the shared single-writer node a round trip.
    for (const ack of acks) {
      if (!isValidMeetingId(ack.meetingId)) {
        throw new Error("Invalid meeting id");
      }
      if (!KINDS.has(ack.kind)) throw new Error("Invalid pending item kind");
    }
    if (acks.length === 0) return [];

    return this.withLock(pendingQueueKey(source, address), async () => {
      const state = await this.readState(source, address);
      const swept = this.sweepExpired(state.items, state.dead);
      let items = swept.items;
      const results: AcknowledgeResult[] = [];
      const removed: string[] = [];

      for (const ack of acks) {
        const key = itemKey(ack);
        const index = items.findIndex((item) => itemKey(item) === key);
        if (index === -1) {
          results.push({
            meetingId: ack.meetingId,
            kind: ack.kind,
            disposition: "not-queued",
          });
          continue;
        }
        items = items.filter((_, i) => i !== index);
        removed.push(ack.meetingId);
        results.push({
          meetingId: ack.meetingId,
          kind: ack.kind,
          disposition: "removed",
        });
      }

      // `force:false` — W0 §6.2: an all-`not-queued` batch (the lost-response retry) mutates
      // nothing and must therefore cost zero node writes.
      await this.persist(
        source,
        address,
        state,
        items,
        swept.dead,
        state.repaired,
        swept.dropped,
      );
      this.logDeadChanges(source, address, swept.promoted);

      if (removed.length > 0) {
        logQueue(
          `op=ack source=${source} removed=${removed.length} ` +
            `missing=${acks.length - removed.length} ` +
            `${midsField(removed.map((id) => hashed(id)))} ` +
            `depth=${items.length} aid=${hashed(normalizeWebhookAddress(address))}`,
        );
      }
      return results;
    });
  }

  /** Convenience wrapper over `settle` for a single successful item. */
  async succeed(
    source: string,
    address: string,
    meetingId: string,
    kind: PendingKind,
  ) {
    const [result] = await this.settle(source, address, [
      { meetingId, kind, status: "done" },
    ]);
    return result!;
  }

  /** Convenience wrapper over `settle` for a single failure. */
  async fail(
    source: string,
    address: string,
    meetingId: string,
    kind: PendingKind,
    lastError: string,
    options: { terminal?: boolean } = {},
  ) {
    const [result] = await this.settle(source, address, [
      {
        meetingId,
        kind,
        status: "failed",
        lastError,
        terminal: options.terminal,
      },
    ]);
    return result!;
  }

  /**
   * §3.6 rule 6: enable's first durable action idempotently clears the pending queue and the
   * dead-letter for this `(source, address)`, so re-enabling never replays the off-window.
   * It does NOT touch the purge ledger — only §4.8's `DELETE` clears that.
   */
  async clear(source: string, address: string): Promise<ClearResult> {
    const pendingKey = pendingQueueKey(source, address);

    // F005: SYNCHRONOUSLY with the call, before any await — `enqueue` is synchronous up to the
    // point it joins a batch, so every delivery accepted before this clear is in `batch` and
    // every one accepted after it starts a fresh batch. Marking here (rather than inside the
    // lock) is what closes the window: the batch's flush takes the same lock and would
    // otherwise land after the deletes below.
    const batch = this.batches.get(pendingKey);
    let superseded = 0;
    if (batch !== undefined) {
      batch.superseded = true;
      superseded = batch.entries.length;
      this.batches.delete(pendingKey);
    }

    return this.withLock(pendingKey, async () => {
      // F010: counted INSIDE the lock so the number reported is what this clear deleted, not
      // what a separate `list()` happened to see a round trip earlier.
      const cleared = await this.countStored(pendingKey);
      await this.runStorage(() => this.deleteKey(pendingKey));
      await this.runStorage(() =>
        this.deleteKey(deadLetterKey(source, address)),
      );
      logQueue(
        `op=clear source=${source} cleared=${cleared} superseded=${superseded} ` +
          `aid=${hashed(normalizeWebhookAddress(address))}`,
      );
      return { cleared, superseded };
    });
  }

  // ── Internals ──────────────────────────────────────────────────────

  /**
   * The pending count as stored, without `readState`'s repair writes: a clear deletes the key
   * either way, so quarantining a corrupt container here would cost two writes to describe a
   * value about to disappear. Entries that do not parse are not counted — they are not items.
   */
  private async countStored(key: string): Promise<number> {
    const raw = await this.runStorage(() => this.readRaw(key));
    if (!Array.isArray(raw.value)) return 0;
    return raw.value.filter((entry) => parsePendingItem(entry) !== null).length;
  }

  /**
   * F005: the accepted batch flushes only if `clear()` has not superseded it in the meantime.
   *
   * W1 BURST-ACK AMENDMENT (backend-ingest plan §5.3 — the one named exception to "reuse the
   * shipped enqueue path verbatim"; findings §2.5 is the number to beat).
   *
   * The batch is retired from `batches` HERE — synchronously, at the moment its flush wins the
   * per-address lock — rather than when its 250 ms timer fired. Retiring at timer-fire is what
   * produced the ≈100 s same-address 50-burst tail: a flush costs a read + a write on a shared
   * single-writer node (~2 s at the measured ~0.5 writes/sec), and every 250 ms of that window
   * opened ANOTHER batch, each of which then queued behind its predecessor on this same lock.
   * Eight windows deep, the last delivery's 202 was ~18 s away — past the provider's 10 s
   * deadline, so it retried into the same queue and made the tail worse.
   *
   * Retiring at lock-acquisition makes the window ADAPTIVE with no new tunable: while a flush
   * is in flight, every arriving delivery joins the one batch already waiting behind it, and
   * that batch absorbs the whole remainder of the burst into a SINGLE read-modify-write. At most
   * two batches for one address exist at any instant, so a delivery's ack waits at most one
   * in-flight flush plus its own — ~1-2 RMWs for the whole burst instead of one per window.
   *
   * Nothing else moves: the 202 still resolves only after the durable write (capture-before-ack),
   * dedup/cap/TTL semantics are untouched, and under no contention the behaviour is exactly the
   * shipped 250 ms coalesce. `clear()` still supersedes synchronously — and now also catches a
   * batch whose timer fired but whose flush had not yet started, which is what F005 always meant.
   */
  private async flushBatch(
    source: string,
    address: string,
    batch: PendingBatch,
  ): Promise<EnqueueResult[]> {
    const key = pendingQueueKey(source, address);
    // Synchronous, before any await: no delivery can join this batch after the snapshot below.
    // Only retire the batch this flush owns — `clear()` may already have replaced it.
    if (this.batches.get(key) === batch) this.batches.delete(key);

    if (batch.superseded) {
      // No silent drops: the count is logged, and the caller's result says `dropped` — which
      // the ingest route already answers with the same 202 a queued delivery gets (§4.6).
      logQueueWarn(
        `op=flush-superseded source=${source} dropped=${batch.entries.length} ` +
          `aid=${hashed(normalizeWebhookAddress(address))}`,
      );
      return batch.entries.map(() => ({ status: "dropped", depth: 0 }));
    }
    return this.flush(source, address, batch.entries);
  }

  private async flush(
    source: string,
    address: string,
    entries: QueuedEntry[],
  ): Promise<EnqueueResult[]> {
    const state = await this.readState(source, address);
    let items = state.items;
    let dead = state.dead;

    // TTL first: an expired item is promoted to dead-letter before the cap can drop it.
    const swept = this.sweepExpired(items, dead);
    items = swept.items;
    dead = swept.dead;

    const statuses: EnqueueStatus[] = [];
    for (const entry of entries) {
      const key = itemKey(entry);
      const index = items.findIndex((item) => itemKey(item) === key);
      if (index !== -1) {
        // §5.3: a duplicate delivery updates receivedAt and returns; it never appends.
        // `sourceTimestamp` is deliberately NOT refreshed — the tombstone leans on it precisely
        // because a re-delivery cannot move it.
        const existing = items[index]!;
        items = items.map((item, i) =>
          i === index ? { ...existing, receivedAt: entry.receivedAt } : item,
        );
        statuses.push("deduped");
        continue;
      }
      items = [
        ...items,
        {
          meetingId: entry.meetingId,
          kind: entry.kind,
          receivedAt: entry.receivedAt,
          ...(entry.sourceTimestamp !== undefined
            ? { sourceTimestamp: entry.sourceTimestamp }
            : {}),
          attempts: 0,
          nextAttemptAt: entry.receivedAt,
        },
      ];
      statuses.push("queued");
    }

    items = this.applyCap(items, source, address);

    await this.persist(
      source,
      address,
      state,
      items,
      dead,
      state.repaired || entries.length > 0,
      swept.dropped,
    );
    this.logDeadChanges(source, address, swept.promoted);

    const depth = items.length;
    return entries.map((entry, i) => {
      const survived = items.some((item) => itemKey(item) === itemKey(entry));
      const status: EnqueueStatus = survived ? statuses[i]! : "dropped";
      if (status !== "dropped") {
        logQueue(
          `op=enqueue source=${source} mid=${hashed(entry.meetingId)} kind=${entry.kind} ` +
            `result=${status} depth=${depth} aid=${hashed(normalizeWebhookAddress(address))}`,
        );
      }
      return { status, depth };
    });
  }

  /** §5.3: cap N, drop-OLDEST, and log the count AND the ids. Silent truncation is the bug. */
  private applyCap(
    items: PendingItem[],
    source: string,
    address: string,
  ): PendingItem[] {
    if (items.length <= this.maxItems) return items;
    const ordered = sortByReceivedAt(items);
    const dropped = ordered.slice(0, ordered.length - this.maxItems);
    const kept = ordered.slice(ordered.length - this.maxItems);
    logQueueWarn(
      `op=drop-oldest source=${source} dropped=${dropped.length} ` +
        `${midsField(dropped.map((item) => hashed(item.meetingId)))} ` +
        `depth=${kept.length} aid=${hashed(normalizeWebhookAddress(address))}`,
    );
    return kept;
  }

  /**
   * §5.3/§5.6: an item older than the TTL is PROMOTED to dead-letter, not dropped. A summary
   * still waiting on its transcript is dead-lettered here and ONLY here — never by the
   * 5-attempt rule — with `lastError=awaiting_transcript_timeout`.
   */
  private sweepExpired(items: PendingItem[], dead: DeadItem[]): DeadSweep {
    const cutoff = this.now() - this.ttlMs;
    const expired = items.filter(
      (item) => Date.parse(item.receivedAt) <= cutoff,
    );
    if (expired.length === 0) return { items, dead, promoted: [], dropped: [] };

    let nextDead = dead;
    const promoted: PendingItem[] = [];
    const dropped: DeadItem[][] = [];
    for (const item of expired) {
      const lastError =
        item.lastError === AWAITING_TRANSCRIPT
          ? AWAITING_TRANSCRIPT_TIMEOUT
          : TTL_EXPIRED;
      const deadItem = { ...item, lastError };
      const appended = this.appendDead(nextDead, deadItem);
      nextDead = appended.dead;
      promoted.push(deadItem);
      if (appended.dropped.length > 0) dropped.push(appended.dropped);
    }
    const expiredKeys = new Set(expired.map(itemKey));
    return {
      items: items.filter((item) => !expiredKeys.has(itemKey(item))),
      dead: nextDead,
      promoted,
      dropped,
    };
  }

  private appendDead(dead: DeadItem[], item: PendingItem): DeadAppend {
    // A failed pending-removal write leaves the same identity in both arrays. Preserve the
    // already-acknowledged dead entry on retry so deadAt and cap order remain deterministic.
    if (dead.some((entry) => itemKey(entry) === itemKey(item))) {
      return { dead, dropped: [] };
    }
    const next = [
      ...dead,
      { ...item, deadAt: new Date(this.now()).toISOString() },
    ];
    if (next.length <= this.maxDeadItems) return { dead: next, dropped: [] };
    const dropped = next.slice(0, next.length - this.maxDeadItems);
    return {
      dead: next.slice(next.length - this.maxDeadItems),
      dropped,
    };
  }

  /** Emit promotion success only after both dead-first writes have acknowledged. */
  private logDeadChanges(
    source: string,
    address: string,
    promoted: PendingItem[],
  ): void {
    const aid = hashed(normalizeWebhookAddress(address));
    for (const item of promoted) {
      logQueue(
        `op=dead-letter source=${source} mid=${hashed(item.meetingId)} kind=${item.kind} ` +
          `reason=${item.lastError ?? "unknown_error"} attempts=${item.attempts} aid=${aid}`,
      );
    }
  }

  /** A cap eviction is durable once the dead-first write acknowledges, even if removal fails. */
  private logDeadDrops(
    source: string,
    address: string,
    dropped: DeadItem[][],
  ): void {
    const aid = hashed(normalizeWebhookAddress(address));
    for (const entries of dropped) {
      logQueueWarn(
        `op=dead-drop-oldest source=${source} dropped=${entries.length} ` +
          `${midsField(entries.map((entry) => hashed(entry.meetingId)))} ` +
          `depth=${this.maxDeadItems} aid=${aid}`,
      );
    }
  }

  /**
   * Read + validate the queue value, with §5.3's CONTAINER-level recovery.
   *
   * §5.5's poison handling covers items; it cannot cover the container. If the single JSON
   * array is unparseable or type-invalid, every read AND every enqueue for this address
   * throws, no item ever reaches the attempt counter, nothing dead-letters, and the address
   * is wedged forever. So: entries failing validation are dropped with their ids and count
   * logged, and a TOTAL parse failure moves the raw value aside to
   * `webhooks/corrupt/{source}/{address}` (preserved for triage) and starts a fresh queue.
   */
  private async readState(
    source: string,
    address: string,
  ): Promise<QueueState> {
    const pendingKey = pendingQueueKey(source, address);
    const raw = await this.runStorage(() => this.readRaw(pendingKey));
    const deadRaw = await this.runStorage(() =>
      this.readRaw(deadLetterKey(source, address)),
    );

    const dead = Array.isArray(deadRaw.value)
      ? deadRaw.value
          .map(parseDeadItem)
          .filter((item): item is DeadItem => item !== null)
      : [];

    if (!raw.present || raw.value === null || raw.value === undefined) {
      return { items: [], dead, repaired: false };
    }

    if (raw.unparseable || !Array.isArray(raw.value)) {
      await this.runStorage(() =>
        this.writeJson(corruptQueueKey(source, address), raw.value),
      );
      await this.runStorage(() => this.writeJson(pendingKey, []));
      // `moved_to` names the PREFIX, never the full key: the key's last segment is the raw
      // address, and §6.3 forbids one in a world-readable line. `aid=` is the correlator.
      logQueueWarn(
        `op=queue-reset source=${source} reason=${raw.unparseable ? "unparseable" : "not-an-array"} ` +
          `moved_to=${CORRUPT_KEY_PREFIX}/${source} aid=${hashed(normalizeWebhookAddress(address))}`,
      );
      return { items: [], dead, repaired: false };
    }

    const items: PendingItem[] = [];
    const invalid: string[] = [];
    for (const entry of raw.value) {
      const parsed = parsePendingItem(entry);
      if (parsed === null) {
        const candidate = (entry as Record<string, unknown> | null)?.meetingId;
        invalid.push(
          isValidMeetingId(candidate) ? hashed(candidate) : "unreadable",
        );
        continue;
      }
      items.push(parsed);
    }

    if (invalid.length > 0) {
      logQueueWarn(
        `op=drop-invalid source=${source} dropped=${invalid.length} ${midsField(invalid)} ` +
          `depth=${items.length} aid=${hashed(normalizeWebhookAddress(address))}`,
      );
    }

    return { items, dead, repaired: invalid.length > 0 };
  }

  /**
   * Write back only what actually changed (W0 §6.2): a pass that mutates nothing must cost
   * zero node writes, or the 5-minute drain timer alone costs 288 writes/day/user.
   */
  private async persist(
    source: string,
    address: string,
    state: QueueState,
    items: PendingItem[],
    dead: DeadItem[],
    force: boolean,
    dropped: DeadItem[][] = [],
  ): Promise<void> {
    const itemsChanged = force || !sameJson(state.items, items);
    const deadChanged = !sameJson(state.dead, dead);
    // Promotion is at-least-once: acknowledge the dead copy before removing pending. If the
    // second write fails, the item is duplicated durably and a retry converges idempotently.
    if (deadChanged) {
      await this.runStorage(() =>
        this.writeJson(deadLetterKey(source, address), dead),
      );
      state.dead = dead;
      this.logDeadDrops(source, address, dropped);
    }
    if (itemsChanged) {
      await this.runStorage(() =>
        this.writeJson(pendingQueueKey(source, address), items),
      );
      state.items = items;
    }
  }

  private jittered(delayMs: number): number {
    const jitter = this.jitter();
    const factor = Number.isFinite(jitter)
      ? Math.min(Math.max(jitter, 0), 1)
      : 0;
    return Math.round(delayMs * (1 + factor * BACKOFF_JITTER_RATIO));
  }

  /** §5.2 defense 1 — one lane per address, around every read-modify-write. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return result;
  }

  /** §9.3 — storage calls are sequential across the shared backend lane, never concurrent. */
  private runStorage<T>(fn: () => Promise<T>): Promise<T> {
    return this.storageLane.run(fn);
  }

  private async readRaw(key: string): Promise<{
    present: boolean;
    unparseable: boolean;
    value: unknown;
  }> {
    // §9.3 read-side hardening: without `assertKvResult` here a durable read Result{ok:false}
    // is cast to `undefined`, `present:false` propagates through `readState`, and the very next
    // `enqueue` writes a one-item pending array over whatever was already durable — silently
    // wiping the queue and shipping 202 for the wipe. Mirror the write path (writeJson below)
    // and delegation-store.ts:61-64 so a session-class Result rides the single-refresh retry.
    const result = await withSessionRefresh(this.node, async () => {
      const r = await this.node.kv.get(key);
      if (isKvMissingKeyResult(r, key)) return null;
      return assertKvResult(r);
    });
    const response = (result as { data?: unknown } | null)?.data as
      | { data?: unknown }
      | null
      | undefined;
    if (response === null || response === undefined) {
      return { present: false, unparseable: false, value: null };
    }
    const raw = (response as { data?: unknown }).data ?? response;
    if (raw === null || raw === undefined) {
      return { present: false, unparseable: false, value: null };
    }
    if (typeof raw === "string") {
      try {
        return { present: true, unparseable: false, value: JSON.parse(raw) };
      } catch {
        // The RAW value is carried out so the caller can quarantine it verbatim (§5.3).
        return { present: true, unparseable: true, value: raw };
      }
    }
    return { present: true, unparseable: false, value: raw };
  }

  private async writeJson(key: string, value: unknown): Promise<void> {
    // §9.3 durable-Result contract: the SDK reports a durable KV failure as `{ok:false,error}`
    // and no longer rejects. Silently accepting that ships a 202 for a write that never landed,
    // so the shape is re-thrown as a redacted error INSIDE withSessionRefresh — a session-class
    // Result surfaces as a session-matching Error and the existing single-refresh retry still
    // applies, exactly as delegation-store.ts's writes do.
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.put(key, value);
      assertKvResult(result);
    });
  }

  private async deleteKey(key: string): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.delete(key);
      if (isKvMissingKeyResult(result, key)) return;
      assertKvResult(result);
    });
  }
}

function sortByReceivedAt(items: PendingItem[]): PendingItem[] {
  return [...items].sort(
    (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt),
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
