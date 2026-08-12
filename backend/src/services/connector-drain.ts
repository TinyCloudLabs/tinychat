import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { assertKvResult, withSessionRefresh } from "@tinyboilerplate/server";
import type {
  ConnectorControl,
  ConnectorDrainAbortFlags,
  PurgeLedger,
} from "../routes/connector-webhooks.js";
import {
  AWAITING_TRANSCRIPT,
  DELEGATION_UNUSABLE,
  LEDGER_UNAVAILABLE,
  NON_BURNING_ERRORS,
  sanitizeErrorCode,
  SCHEMA_MISSING,
  SPACE_NOT_HOSTED,
  type PendingItem,
  type SettleOutcome,
} from "./connector-queue.js";
import {
  isValidSource,
  keyedLogHash,
  normalizeWebhookAddress,
  redactedErrorMessage,
  type WebhookConfigRecord,
} from "./webhook-tokens.js";
import { runInWriteLane } from "./write-lane.js";

/**
 * The drain worker (§5.4/§5.5/§6.1 step -1/§3.6) — all four triggers, the per-address
 * singleton, the revocation checks and the Option-A ceilings.
 *
 * WHAT THIS DOES AT THE END IS DECISION-DEPENDENT (§4.7, binding). Under the selected ingest
 * shape (**B**) the drain **writes NOTHING to the user's space**: it surfaces the pending
 * meeting-id list and the client's v1 engine (F5) does the write with the user's own
 * authority. Wiring a server-side writer in here under B/C is the silent break §2.1 names —
 * the writer's `(source, source_id)` SKIP rule would turn the client's later full-row write
 * into a no-op and the meeting content would never land. The `release` hook below is the seam
 * Option A (task A3) fills; its DEFAULT surfaces and writes nothing.
 *
 * The tombstone / purge-ledger checks apply under EVERY option, and under B/C they gate
 * **surfacing** rather than writing: an id handed to the client resurrects the meeting just as
 * surely as a write would (§12a R3).
 */

// ── Constants (§5.4 — every one of these is normative; an unset bound in an
//    anti-amplification control ships as Infinity) ─────────────────────

/** §5.4 trigger 2: a single timer, default 5 min, env-tunable via `CONNECTOR_DRAIN_INTERVAL_MS`. */
export const DRAIN_INTERVAL_MS = 5 * 60_000;

/** §5.4: minimum inter-drain interval per address, so a slow trickle never becomes a tight loop. */
export const MIN_INTER_DRAIN_INTERVAL_MS = 2_000;

/**
 * The floor that replaces that interval on the FORCED path (§5.4 trigger 3, `POST …/drain`).
 *
 * `force` skips `MIN_INTER_DRAIN_INTERVAL_MS` deliberately, and the singleton coalesces only
 * CONCURRENT kicks — so sequential forced requests each ran a full pass (config read, marker
 * read, queue read, dead read, ledger read) against the shared single-writer node, at the
 * companion bucket's 600 requests/15 min/IP and exempt from the global limiter. An unset bound on
 * an anti-amplification control ships as Infinity. A forced kick inside this window returns the
 * PREVIOUS pass's result rather than deferring, so the user still gets an immediate answer.
 */
export const FORCED_DRAIN_FLOOR_MS = 2_000;

/** §5.4: global cap on concurrent drains. The write lane serializes anyway; this bounds fan-out. */
export const MAX_CONCURRENT_DRAINS = 4;

/**
 * §9.3: the per-write revocation re-check is HOISTED. The in-process abort flag is checked
 * between every item (free); the durable marker is re-read at most once per this many ms per
 * address, and at least once per {@link REVOCATION_RECHECK_ITEMS} items.
 *
 * Be precise about what survives the hoist: §3.6 rule 2's per-write guarantee is provided by
 * `connectorDrainAbort`, which is a module-level Set and therefore holds under the
 * SINGLE-INSTANCE assumption this backend already bakes in everywhere (see the MULTI-INSTANCE
 * WARNING in `connector-queue.ts`). A revocation that does not pass through this process —
 * a second instance, an operator or repair job writing the marker, a teardown that crashed
 * after step 1 and restarted the drain elsewhere — is caught only by the durable re-read
 * below, which is why that re-read is bounded by item count as well as by time: a
 * surfaceOnly drain of a full 200-item queue otherwise finishes inside a single 5s window
 * and checks the marker exactly once.
 */
export const REVOCATION_RECHECK_MS = 5_000;
/** …and at most this many items may pass between two durable marker reads. */
export const REVOCATION_RECHECK_ITEMS = 20;

/**
 * The item bound for a release whose effects leave this process — i.e. Option A, where
 * `removeOnRelease` is true, "released" means WRITTEN to the user's space, and a released item is
 * a node write plus a provider fetch rather than a surfaced id.
 *
 * 20 is defensible only while the exposure of a missed revocation is "20 ids were surfaced to a
 * client that then did nothing with them". Under Option A the same gap is up to 20 writes into
 * the space of a user who has already revoked, which is what §3.6 rule 2's per-write phrasing
 * exists to forbid — and the gap only opens for revocations that do NOT pass through this
 * process (a second instance, an operator or repair job writing the marker, a crashed teardown),
 * exactly the cases the in-process abort flag cannot see. So the bound follows the release shape
 * instead of waiting to be remembered when A3 lands.
 */
export const REVOCATION_RECHECK_ITEMS_SIDE_EFFECTING = 1;

/** §5.4 ceiling 1 — server-side Fireflies transcript fetches per address per rolling hour. */
export const CONNECTOR_A_FETCH_CEILING_PER_HOUR = 20;

/**
 * §5.4 ceiling 2 — delegated secret reads per address per rolling hour. NOT implied by ceiling
 * 1 and not optional: one-read-per-drain bounds in-memory exposure *duration*, not count, and
 * the 2 s minimum inter-drain interval permits up to 1800 drains/hour/address (corrected
 * 2026-08-04). Additionally gated behind "≥1 fetch permitted in this window".
 */
export const CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR = 20;

/** Both ceilings are rolling-hour. */
export const CEILING_WINDOW_MS = 60 * 60 * 1000;

/** Bounded so a hostile address stream cannot grow the counters without limit. */
const MAX_CEILING_ENTRIES = 10_000;

// ── Logging (§6.3 — ids only, keyed hashes, never a raw address or meeting id) ─

function hashed(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    // LOG_HASH_SALT unset (flag-off / test contexts): drop the field rather than fake it.
    return "unavailable";
  }
}

function logDrain(fields: string): void {
  console.log(`[connector-drain] ${fields} t=${new Date().toISOString()}`);
}

function logDrainWarn(fields: string): void {
  console.warn(`[connector-drain] ${fields} t=${new Date().toISOString()}`);
}

// ── Error classes (§5.5) ─────────────────────────────────────────────

/** Failure a `release` hook raises when it knows the class. Item-state failures burn attempts. */
export class DrainError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly terminal = false,
  ) {
    super(message ?? code);
    this.name = "DrainError";
  }
}

const NON_BURNING = new Set(NON_BURNING_ERRORS);

/**
 * Map a raw thrown value to a §5.5 class. An explicit `DrainError` wins; otherwise only the
 * three USER-STATE classes are recognised by message, because misclassifying an item-state
 * failure as user-state means it never burns an attempt and never dead-letters. Everything
 * else is item-state (`release_failed`) and burns — the safe direction.
 */
export function classifyDrainError(error: unknown): {
  lastError: string;
  terminal: boolean;
} {
  if (error instanceof DrainError) {
    return { lastError: error.code, terminal: error.terminal };
  }
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes("delegation") || lowered.includes("unauthorized")) {
    return { lastError: DELEGATION_UNUSABLE, terminal: false };
  }
  if (lowered.includes("no such table") || lowered.includes("schema")) {
    return { lastError: SCHEMA_MISSING, terminal: false };
  }
  if (lowered.includes("space not hosted") || lowered.includes("not hosted")) {
    return { lastError: SPACE_NOT_HOSTED, terminal: false };
  }
  return { lastError: "release_failed", terminal: false };
}

// ── §5.4's two per-address hourly ceilings ───────────────────────────

export interface CeilingState {
  fetches: number;
  secretReads: number;
  fetchCeilingReached: boolean;
  secretReadCeilingReached: boolean;
}

function positiveIntFromEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    // No silent fallback: a typo'd override on an anti-amplification control that quietly
    // reverts to a default (or to Infinity) is the failure §5.4 exists to prevent.
    throw new Error(
      `${name} must be a positive integer; got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

export interface ConnectorSideEffectCeilingOptions {
  fetchCeiling?: number;
  secretReadCeiling?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * §5.4's MANDATORY per-address, per-hour ceilings on Option-A side effects. They ship with the
 * drain **even while Option A is off** (both counters, both constants, both env overrides), so
 * A3 does not have to retrofit them — and so the numbers are asserted by a test today rather
 * than chosen under pressure later.
 *
 * Exhaustion is non-destructive: excess items stay QUEUED (they may be legitimate), never
 * dead-lettered, and the state is surfaced as a connector-card line (`state()` below), per the
 * `deliveriesRateLimited` precedent.
 */
export class ConnectorSideEffectCeilings {
  private readonly fetches = new Map<string, number[]>();
  private readonly secretReads = new Map<string, number[]>();
  readonly fetchCeiling: number;
  readonly secretReadCeiling: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: ConnectorSideEffectCeilingOptions = {}) {
    this.fetchCeiling =
      options.fetchCeiling ?? CONNECTOR_A_FETCH_CEILING_PER_HOUR;
    this.secretReadCeiling =
      options.secretReadCeiling ?? CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR;
    this.windowMs = options.windowMs ?? CEILING_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Both overrides, read from the environment, each failing LOUDLY on a bad value. */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: Omit<
      ConnectorSideEffectCeilingOptions,
      "fetchCeiling" | "secretReadCeiling"
    > = {},
  ): ConnectorSideEffectCeilings {
    return new ConnectorSideEffectCeilings({
      ...options,
      fetchCeiling: positiveIntFromEnv(
        "CONNECTOR_A_FETCH_CEILING_PER_HOUR",
        env.CONNECTOR_A_FETCH_CEILING_PER_HOUR,
        CONNECTOR_A_FETCH_CEILING_PER_HOUR,
      ),
      secretReadCeiling: positiveIntFromEnv(
        "CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR",
        env.CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR,
        CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR,
      ),
    });
  }

  remainingFetches(address: string): number {
    return Math.max(0, this.fetchCeiling - this.count(this.fetches, address));
  }

  remainingSecretReads(address: string): number {
    return Math.max(
      0,
      this.secretReadCeiling - this.count(this.secretReads, address),
    );
  }

  /** Consume one transcript fetch. `false` ⇒ the item stays queued; nothing is dead-lettered. */
  tryFetch(address: string): boolean {
    if (this.remainingFetches(address) < 1) return false;
    this.record(this.fetches, address);
    return true;
  }

  /**
   * Consume one delegated secret read. Gated behind "≥1 fetch permitted in this window": a
   * drain with no remaining fetch budget has nothing to fetch, so materializing the user's key
   * would be pure exposure.
   */
  trySecretRead(address: string): boolean {
    if (this.remainingFetches(address) < 1) return false;
    if (this.remainingSecretReads(address) < 1) return false;
    this.record(this.secretReads, address);
    return true;
  }

  /** The connector-card line: visible, never silent. */
  state(address: string): CeilingState {
    const fetches = this.count(this.fetches, address);
    const secretReads = this.count(this.secretReads, address);
    return {
      fetches,
      secretReads,
      fetchCeilingReached: fetches >= this.fetchCeiling,
      secretReadCeilingReached: secretReads >= this.secretReadCeiling,
    };
  }

  private count(store: Map<string, number[]>, address: string): number {
    const key = normalizeWebhookAddress(address);
    const cutoff = this.now() - this.windowMs;
    const stamps = (store.get(key) ?? []).filter((stamp) => stamp > cutoff);
    if (stamps.length === 0) store.delete(key);
    else store.set(key, stamps);
    return stamps.length;
  }

  private record(store: Map<string, number[]>, address: string): void {
    const key = normalizeWebhookAddress(address);
    this.count(store, address);
    if (store.size >= MAX_CEILING_ENTRIES && !store.has(key)) {
      const oldest = store.keys().next();
      if (!oldest.done) store.delete(oldest.value);
    }
    store.set(key, [...(store.get(key) ?? []), this.now()]);
  }
}

// ── §6.1 step -1: the tombstone check ────────────────────────────────

/**
 * `purgedThrough` is the authoritative tombstone; `recentIds` is forensics that also happens to
 * catch an id whose `receivedAt` postdates the purge. Protection is unbounded in id count — one
 * timestamp covers a 5,000-meeting purge — which is why a 500-id purge still drops the
 * 300th-oldest id (§6.2).
 */
export function isTombstoned(
  item: Pick<PendingItem, "meetingId" | "receivedAt" | "sourceTimestamp">,
  ledger: PurgeLedger | null,
): boolean {
  if (ledger === null) return false;
  if (ledger.recentIds.includes(item.meetingId)) return true;
  // The PROVIDER's timestamp, and ONLY it. `receivedAt` is set to `now` on every (re-)delivery
  // and a purge clears the queue, so every post-purge item — replayed capture or genuinely new —
  // carries a `receivedAt` on the safe side of the watermark. Comparing it does not merely weaken
  // the tombstone for the legacy `{meetingId, eventType}` shape (§4.5), it makes the watermark
  // INERT for it: the ±24 h freshness window is skipped for that shape by design, so `recentIds`
  // (200 ids, forensics per §6.2) was the only thing left, and a captured signed delivery
  // resurrected a purged meeting once it aged out. §9.1's T1 residual claims the tombstone closes
  // that; this is what makes the claim true.
  //
  // So an ABSENT provider stamp is treated exactly like an unparseable one: not evidence of
  // safety. The cost is disclosed and bounded — after a purge, timestamp-less deliveries for that
  // source are dropped (logged `reason=purged_no_timestamp`, never silent) until the user's
  // explicit re-sync fires §4.8's `DELETE`, which is the one verb §6.2 allows to clear a
  // tombstone. The alternative reading resurrects meetings the user deleted while they are
  // offline, which §6.2 calls the failure this ledger exists to prevent.
  const purgedThrough = Date.parse(ledger.purgedThrough);
  if (item.sourceTimestamp === undefined) return true;
  const sourceTimestamp = Date.parse(item.sourceTimestamp);
  if (!Number.isFinite(sourceTimestamp) || !Number.isFinite(purgedThrough)) {
    // An unreadable timestamp on either side is not evidence of safety.
    return true;
  }
  return sourceTimestamp < purgedThrough;
}

/**
 * Why an item was tombstoned, for the drop log only — the verdict itself is {@link isTombstoned}.
 * Separated so an operator can tell "this predates the purge" from "this shape carries no
 * provider timestamp and a ledger exists", which is the difference between a purge working and a
 * legacy-shape workspace needing an explicit re-sync (§4.8's `DELETE`).
 */
export function tombstoneReason(
  item: Pick<PendingItem, "meetingId" | "receivedAt" | "sourceTimestamp">,
  ledger: PurgeLedger | null,
): string {
  if (ledger !== null && ledger.recentIds.includes(item.meetingId))
    return "purged";
  if (item.sourceTimestamp === undefined) return "purged_no_timestamp";
  return "purged";
}

// ── Injected slices ──────────────────────────────────────────────────

/** The slice of `ConnectorQueue` the drain uses. */
export interface DrainQueue {
  due(source: string, address: string): Promise<PendingItem[]>;
  settle(
    source: string,
    address: string,
    outcomes: SettleOutcome[],
  ): Promise<unknown>;
}

/** The slice of `WebhookTokenService` the drain uses — `config` is the enabled-state probe. */
export interface DrainConfigLookup {
  config(address: string): Promise<WebhookConfigRecord | null>;
}

/** The slice of `ConnectorControlStore` the drain uses (§3.6 rule 3 + §6.2). */
export type DrainControl = Pick<
  ConnectorControl,
  "readDisabled" | "readLedger" | "quarantineLedger"
>;

/**
 * §3.6 rule 1: a cache hit is NOT evidence the grant still exists. A drain that ran under a
 * delegation would re-validate the stored record — existence, `expiresAt`, `policyHash` —
 * through this gate.
 *
 * UNWIRED UNDER OPTION C, and index.ts is pinned against filling it. There is no connector
 * delegation to validate, so the only record a gate could check is the app's unrelated CHAT
 * delegation: an expired chat grant would then stop the connector card, and `needsReauth` would
 * ask the user to re-grant something this feature never used. The seam stays for an Option-A
 * writer, which is the only shape where the backend holds a grant of its own.
 *
 * WHEN THIS CAN GO. Option C is the shipped decision, recorded in
 * `docs/connector-webhooks-delegation-gate.md`; Option A is not rejected, it is BLOCKED on the
 * SDK exposing a verified attestation or a genuinely resolved space id (V4). Delete this
 * interface and the `delegations` collaborator when that decision is recorded as final — until
 * then the "pinned against filling it" claim is enforced by `__tests__/connector-drain.test.ts`
 * ("no stored delegation gate is wired into the drain"), which reads index.ts's source and
 * fails if the collaborator ever appears — not by this comment.
 */
export interface DrainDelegationGate {
  validate(
    address: string,
  ): Promise<{ ok: true } | { ok: false; reason?: string }>;
}

export interface ReleaseContext {
  source: string;
  address: string;
  item: PendingItem;
  /** §5.4's two ceilings. Option A consults these BEFORE a fetch or a secret read. */
  ceilings: ConnectorSideEffectCeilings;
  /**
   * §5.4: read the secret ONCE per drain and hold it for that drain's lifetime, never per item.
   * Memoized per drain; returns null when ceiling 2 (or its fetch gate) refuses.
   */
  secret: () => Promise<string | null>;
}

export type ReleaseOutcome =
  | { status: "released" }
  | { status: "skipped"; reason: string }
  | { status: "held"; reason: string; terminal?: boolean };

export type ReleaseFn = (
  context: ReleaseContext,
) => Promise<ReleaseOutcome> | ReleaseOutcome;

/**
 * The DEFAULT release under §10.1 = B/C: surface the id and write nothing (§4.7, binding).
 * The item stays QUEUED — the client (F5) is the writer, so removing it here would hand the id
 * to exactly one browser tab and lose it if that tab never finished.
 */
const surfaceOnly: ReleaseFn = () => ({ status: "released" });

export interface ConnectorDrainOptions {
  queue: DrainQueue;
  tokens: DrainConfigLookup;
  control: DrainControl;
  /** §3.6 rule 3's in-process half. Shared with the teardown route — one instance per process. */
  abort: ConnectorDrainAbortFlags;
  delegations?: DrainDelegationGate;
  ceilings?: ConnectorSideEffectCeilings;
  /** Option A (task A3) fills this. Its default writes NOTHING to the user's space. */
  release?: ReleaseFn;
  /**
   * `true` only under Option A, where "released" means "written" and the item is done. Under
   * B/C the id must stay pending until the client has actually written it.
   */
  removeOnRelease?: boolean;
  /** Option A's per-drain secret read. Absent ⇒ `context.secret()` resolves null. */
  readSecret?: (address: string) => Promise<string>;
  minIntervalMs?: number;
  /** Per-address floor for FORCED kicks (trigger 3). See {@link FORCED_DRAIN_FLOOR_MS}. */
  forcedMinIntervalMs?: number;
  maxConcurrent?: number;
  revocationRecheckMs?: number;
  revocationRecheckItems?: number;
  now?: () => number;
  lane?: <T>(fn: () => Promise<T> | T) => Promise<T>;
}

export type DrainStatus = "ok" | "aborted";

export interface DrainResult {
  address: string;
  source: string | null;
  status: DrainStatus;
  /** `revoked` | `not_configured` | `ledger_unavailable` | `delegation_unusable`. */
  reason?: string;
  /** §4.7 under B/C: the pending ids handed to the client. Nothing was written. */
  surfaced: string[];
  /** §6.1 step -1 drops. */
  dropped: number;
  /** Items removed as done (Option A writes, or a release that reported `skipped`). */
  completed: number;
  /** Items left queued with a §5.5 class. */
  held: number;
  /** Drain passes actually executed — the `dirty`-flag loop makes this 1 or 2 for a burst. */
  passes: number;
  ceiling: CeilingState;
  needsReauth: boolean;
}

interface CardState {
  needsReauth: boolean;
  lastAbortReason: string | null;
  ceiling: CeilingState;
}

/**
 * Per-address drain singleton + dirty flag + minimum inter-drain interval + global cap.
 *
 * MANDATORY (§5.4): trigger 1 fires a drain after EVERY delivery, so a 50-event burst would
 * otherwise spawn 50 concurrent drains for one address — 50 delegation activations, 50 queue
 * RMWs and, under Option A, 50 server-side Fireflies fetches for the same meeting. The §5.2
 * queue mutex protects the queue VALUE, not the drain.
 */
export class ConnectorDrainWorker {
  private readonly running = new Map<string, Promise<DrainResult>>();
  private readonly dirty = new Set<string>();
  private readonly scheduled = new Map<string, Promise<DrainResult>>();
  private readonly lastFinishedAt = new Map<string, number>();
  /** The previous pass's result, returned to a forced kick inside {@link FORCED_DRAIN_FLOOR_MS}. */
  private readonly lastResult = new Map<string, DrainResult>();
  private readonly cards = new Map<string, CardState>();
  private readonly drains = new Map<string, number>();
  private waiting: Array<() => void> = [];
  private active = 0;
  private stopped = false;

  readonly ceilings: ConnectorSideEffectCeilings;
  private readonly minIntervalMs: number;
  private readonly forcedMinIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly revocationRecheckMs: number;
  private readonly revocationRecheckItems: number;
  private readonly now: () => number;
  private readonly lane: <T>(fn: () => Promise<T> | T) => Promise<T>;
  private readonly release: ReleaseFn;

  constructor(private readonly options: ConnectorDrainOptions) {
    this.ceilings = options.ceilings ?? ConnectorSideEffectCeilings.fromEnv();
    this.minIntervalMs = options.minIntervalMs ?? MIN_INTER_DRAIN_INTERVAL_MS;
    this.forcedMinIntervalMs =
      options.forcedMinIntervalMs ?? FORCED_DRAIN_FLOOR_MS;
    this.maxConcurrent = Math.max(
      1,
      options.maxConcurrent ?? MAX_CONCURRENT_DRAINS,
    );
    this.revocationRecheckMs =
      options.revocationRecheckMs ?? REVOCATION_RECHECK_MS;
    this.revocationRecheckItems = Math.max(
      1,
      options.revocationRecheckItems ??
        (options.removeOnRelease === true
          ? REVOCATION_RECHECK_ITEMS_SIDE_EFFECTING
          : REVOCATION_RECHECK_ITEMS),
    );
    this.now = options.now ?? (() => Date.now());
    this.lane = options.lane ?? runInWriteLane;
    this.release = options.release ?? surfaceOnly;
  }

  /**
   * §5.4 listed four triggers; under §10.1 = C exactly ONE of them is wired:
   *
   *   3. user visit — `POST /api/connectors/webhooks/drain` (passes `force`, because the user
   *      is right here and the 2 s anti-tight-loop interval is not aimed at them)
   *
   * The other three are retired deliberately, not by omission. 1 (the post-ack `onDelivery`
   * kick) and 2 (the five-minute timer) ran a full pass to hand ids to nobody — under C the
   * browser is the writer and nothing is listening between visits, so the background half of
   * the timer is now a bounded queue-maintenance sweep instead
   * ({@link startConnectorQueueMaintenanceTimer}). 4 (the fresh-grant kick from
   * `POST /api/delegations`) is forbidden: the server holds no connector delegation, and the
   * unrelated chat delegation must never reach into this feature.
   *
   * A kick while a drain is in flight sets `dirty` and returns THAT drain's promise; it never
   * starts a second one.
   */
  kick(input: {
    address: string;
    source?: string;
    force?: boolean;
  }): Promise<DrainResult> {
    let key: string;
    try {
      key = normalizeWebhookAddress(input.address);
    } catch {
      return Promise.reject(new Error("Invalid webhook config address"));
    }
    if (input.source !== undefined && !isValidSource(input.source)) {
      return Promise.reject(new Error("Invalid webhook source"));
    }
    if (this.stopped)
      return Promise.resolve(this.emptyResult(key, null, "stopped"));

    const inFlight = this.running.get(key);
    if (inFlight) {
      this.dirty.add(key);
      return inFlight;
    }

    const since =
      this.now() - (this.lastFinishedAt.get(key) ?? Number.NEGATIVE_INFINITY);
    if (!input.force) {
      if (since < this.minIntervalMs) {
        return this.schedule(key, this.minIntervalMs - since);
      }
    } else if (since < this.forcedMinIntervalMs) {
      // §5.4's `force` deliberately skips the anti-tight-loop interval ("the user is right
      // here") — but the per-address singleton coalesces only CONCURRENT kicks, so sequential
      // forced kicks each ran a full pass: a config read, a disabled-marker read, a queue read
      // (pending + dead) and a ledger read against the shared single-writer node, at the
      // companion bucket's 600 requests/15 min/IP and exempt from the global limiter. One
      // authenticated session could hold ~3,000 node round trips per 15 minutes against storage
      // every other tenant shares. The floor replaces the skipped interval WITHOUT costing the
      // user anything: they get the previous pass's result immediately rather than a deferral,
      // and nothing has changed in the intervening moment that a re-read would reveal.
      const previous = this.lastResult.get(key);
      if (previous !== undefined) {
        return this.replayForcedResult(key, previous);
      }
    }

    return this.start(key);
  }

  /**
   * §12a R3: a `DrainResult` is the SURFACING authority, so replaying one computed BEFORE a
   * revocation is a surfacing decision made under a stale grant. The floor's cached result was
   * returned without re-reading the marker, the config or the ledger, and `POST /drain` was safe
   * only because the ROUTE reads the marker itself first — a caller-side check standing in for
   * the drain's own verdict.
   *
   * Cheapest correct fix, per the residual: re-read just the durable disabled marker (one KV
   * get) before replaying. The other reads a full pass makes are what the floor exists to avoid;
   * this one is the only input whose change invalidates the cached verdict. Unreadable ⇒ aborted,
   * the same fail-closed rule `stillEnabled` and the purge ledger take.
   */
  private async replayForcedResult(
    key: string,
    previous: DrainResult,
  ): Promise<DrainResult> {
    try {
      if ((await this.options.control.readDisabled(key)) !== null) {
        return this.aborted(key, previous.source, "revoked");
      }
    } catch (error) {
      console.warn(
        "[connector-drain] forced-floor revocation re-check failed:",
        redactedErrorMessage(error),
      );
      return this.aborted(key, previous.source, "revoked");
    }
    logDrain(`op=drain-coalesce reason=forced_floor aid=${hashed(key)}`);
    return previous;
  }

  // No `drainAddresses` fan-out: under Option C nothing drains addresses in the background.
  // The timer below is a queue-maintenance sweep, and a drain runs only for the user who is
  // right here (§5.4 trigger 3) — see the trigger list on `kick`.

  /** The card line §5.4/§3.7 want: reauth state + both ceiling states, per address. */
  cardState(address: string): CardState {
    const key = normalizeWebhookAddress(address);
    return (
      this.cards.get(key) ?? {
        needsReauth: false,
        lastAbortReason: null,
        ceiling: this.ceilings.state(key),
      }
    );
  }

  needsReauth(address: string): boolean {
    return this.cardState(address).needsReauth;
  }

  /** Drain invocations for an address — the rig's `burst` assertion reads this (§5.4). */
  drainCount(address: string): number {
    return this.drains.get(normalizeWebhookAddress(address)) ?? 0;
  }

  totalDrains(): number {
    let total = 0;
    for (const count of this.drains.values()) total += count;
    return total;
  }

  /** Shutdown: refuse new kicks. In-flight drains finish; nothing is left half-settled. */
  stop(): void {
    this.stopped = true;
  }

  // ── Singleton, interval and global cap ───────────────────────────────

  private schedule(key: string, delayMs: number): Promise<DrainResult> {
    const already = this.scheduled.get(key);
    if (already) {
      this.dirty.add(key);
      return already;
    }
    const promise = new Promise<DrainResult>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.scheduled.delete(key);
          this.start(key).then(resolve, reject);
        },
        Math.max(0, delayMs),
      );
      // Unref'd, so a deferred drain never hangs `bun test` or blocks a shutdown.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    this.scheduled.set(key, promise);
    return promise;
  }

  private start(key: string): Promise<DrainResult> {
    const promise = (async (): Promise<DrainResult> => {
      await this.acquireSlot(key);
      try {
        const result = await this.runPasses(key);
        this.rememberResult(key, result);
        return result;
      } finally {
        this.releaseSlot();
        this.lastFinishedAt.set(key, this.now());
        this.running.delete(key);
      }
    })();
    // Registered SYNCHRONOUSLY, before the first await: a kick that lands while this drain is
    // waiting on the global cap must coalesce into it, not start a second one.
    this.running.set(key, promise);
    return promise;
  }

  /** Bounded like every other per-address map here, so an address stream cannot grow it. */
  private rememberResult(key: string, result: DrainResult): void {
    if (
      this.lastResult.size >= MAX_CEILING_ENTRIES &&
      !this.lastResult.has(key)
    ) {
      const oldest = this.lastResult.keys().next();
      if (!oldest.done) this.lastResult.delete(oldest.value);
    }
    this.lastResult.delete(key);
    this.lastResult.set(key, result);
  }

  private async acquireSlot(key: string): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    // No silent drops: the waiting address is logged, then it runs.
    logDrain(
      `op=drain-defer reason=global_cap waiting=${this.waiting.length + 1} aid=${hashed(key)}`,
    );
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  /** The `dirty` loop: the running drain re-reads the queue when it finishes and loops once more. */
  private async runPasses(key: string): Promise<DrainResult> {
    let result = await this.runOnce(key);
    while (this.dirty.has(key) && result.status === "ok" && !this.stopped) {
      this.dirty.delete(key);
      const next = await this.runOnce(key);
      result = {
        ...next,
        surfaced: [...new Set([...result.surfaced, ...next.surfaced])],
        dropped: result.dropped + next.dropped,
        completed: result.completed + next.completed,
        held: result.held + next.held,
        passes: result.passes + next.passes,
      };
    }
    this.dirty.delete(key);
    return result;
  }

  // ── One drain pass ───────────────────────────────────────────────────

  private async runOnce(address: string): Promise<DrainResult> {
    const { queue, tokens, control, abort } = this.options;
    this.drains.set(address, (this.drains.get(address) ?? 0) + 1);

    // §3.6 rule 3: the in-process flag is checked FIRST and between every item — it is what
    // stops the drain that is running right now.
    if (abort.isAborted(address)) return this.aborted(address, null, "revoked");

    const config = await tokens.config(address);
    if (config === null) return this.aborted(address, null, "not_configured");
    const source = config.source;

    // §3.6 rule 5: "delegation stored but no *enabled* config" is REVOKED. The durable marker
    // survives a CVM restart mid-revocation, which the in-process flag does not.
    if ((await control.readDisabled(address)) !== null) {
      return this.aborted(address, source, "revoked");
    }

    const due = await queue.due(source, address);
    if (due.length === 0) {
      // Nothing to release ⇒ nothing to authorize. Skipping the ledger read here costs the
      // 5-minute timer nothing in safety (no id is surfaced) and saves 288 reads/day/user.
      return this.ok(address, source, [], 0, 0, 0);
    }

    // §6.1 step -1 / §6.2: the ledger is an AUTHORIZATION input and FAILS CLOSED. A failed or
    // unparseable read ABORTS the drain for this address — it never falls through to an
    // assumed-empty ledger, and it burns no attempts (§5.5's `ledger_unavailable` class).
    let ledger: PurgeLedger | null = null;
    try {
      const read = await control.readLedger(source, address);
      if (read.status === "unparseable") {
        await control.quarantineLedger(source, address, read.raw);
        logDrainWarn(
          `op=ledger-quarantine source=${source} aid=${hashed(address)}`,
        );
        return this.aborted(address, source, LEDGER_UNAVAILABLE);
      }
      if (read.status === "ok") ledger = read.ledger;
    } catch (error) {
      console.warn(
        "[connector-drain] purge ledger read failed:",
        redactedErrorMessage(error),
      );
      return this.aborted(address, source, LEDGER_UNAVAILABLE);
    }

    // §3.6 rule 1: existence, expiry and policyHash of the STORED record, on every cache hit.
    const gate = await this.validateDelegation(address);
    if (!gate.ok) return this.aborted(address, source, DELEGATION_UNUSABLE);

    const outcomes: SettleOutcome[] = [];
    const surfaced: string[] = [];
    let dropped = 0;
    let completed = 0;
    let held = 0;
    let lastRecheckAt = this.now();
    let itemsSinceRecheck = 0;
    let abortReason: string | null = null;

    // §5.4: the secret is read ONCE per drain and held for the drain's lifetime, never per item.
    let secretPromise: Promise<string | null> | null = null;
    const secret = (): Promise<string | null> => {
      if (secretPromise === null) {
        secretPromise = (async () => {
          if (!this.options.readSecret) return null;
          if (!this.ceilings.trySecretRead(address)) {
            logDrainWarn(
              `op=ceiling reason=secret_read_ceiling aid=${hashed(address)} ` +
                `ceiling=${this.ceilings.secretReadCeiling}`,
            );
            return null;
          }
          return await this.options.readSecret(address);
        })();
      }
      return secretPromise;
    };

    for (const item of due) {
      // In-process and free — checked between EVERY item (§9.3's hoist).
      if (abort.isAborted(address)) {
        abortReason = "revoked";
        break;
      }
      // The durable half, re-read every N seconds OR every N items, whichever comes first,
      // rather than once per item: the cost (a node round trip and three manifest parses inside
      // the process-global lane) is not paid 200 times, and a whole queue can no longer drain
      // between two checks. See REVOCATION_RECHECK_MS for what the two halves each cover.
      if (
        this.now() - lastRecheckAt >= this.revocationRecheckMs ||
        itemsSinceRecheck >= this.revocationRecheckItems
      ) {
        lastRecheckAt = this.now();
        itemsSinceRecheck = 0;
        const stillEnabled = await this.stillEnabled(address, source);
        if (!stillEnabled.ok) {
          abortReason = stillEnabled.reason;
          break;
        }
      }
      itemsSinceRecheck += 1;

      // §6.1 step -1, BEFORE anything else touches the item. Under B/C this gates SURFACING:
      // an id handed to the client resurrects the meeting just as surely as a write would.
      if (isTombstoned(item, ledger)) {
        dropped += 1;
        outcomes.push({
          meetingId: item.meetingId,
          kind: item.kind,
          status: "done",
        });
        logDrain(
          `op=drop source=${source} mid=${hashed(item.meetingId)} ` +
            `reason=${tombstoneReason(item, ledger)} aid=${hashed(address)}`,
        );
        continue;
      }

      try {
        const outcome = await this.lane(() =>
          this.release({
            source,
            address,
            item,
            ceilings: this.ceilings,
            secret,
          }),
        );
        if (outcome.status === "released") {
          surfaced.push(item.meetingId);
          if (this.options.removeOnRelease === true) {
            completed += 1;
            outcomes.push({
              meetingId: item.meetingId,
              kind: item.kind,
              status: "done",
            });
          }
          continue;
        }
        if (outcome.status === "skipped") {
          completed += 1;
          outcomes.push({
            meetingId: item.meetingId,
            kind: item.kind,
            status: "done",
          });
          logDrain(
            // §6.3/T13: the reason comes from the release hook, and the log is public.
            `op=skip source=${source} mid=${hashed(item.meetingId)} ` +
              `reason=${sanitizeErrorCode(outcome.reason) ?? "unknown_reason"} ` +
              `aid=${hashed(address)}`,
          );
          continue;
        }
        held += 1;
        outcomes.push({
          meetingId: item.meetingId,
          kind: item.kind,
          status: "failed",
          lastError: outcome.reason,
          terminal: outcome.terminal,
        });
      } catch (error) {
        const classified = classifyDrainError(error);
        held += 1;
        outcomes.push({
          meetingId: item.meetingId,
          kind: item.kind,
          status: "failed",
          lastError: classified.lastError,
          terminal: classified.terminal,
        });
        logDrainWarn(
          // `classifyDrainError` returns `DrainError.code` verbatim; same public-log rule.
          `op=item-failed source=${source} mid=${hashed(item.meetingId)} ` +
            `reason=${sanitizeErrorCode(classified.lastError) ?? "unknown_error"} ` +
            `burns=${!NON_BURNING.has(classified.lastError)} aid=${hashed(address)}`,
        );
      }
    }

    if (outcomes.length > 0) await queue.settle(source, address, outcomes);

    if (abortReason !== null) {
      // Items 2..N of a revoked drain are neither surfaced nor written — that is the whole
      // point of rule 3. The outcomes settled above cover only the items already handled.
      return this.aborted(address, source, abortReason, {
        surfaced,
        dropped,
        completed,
        held,
      });
    }
    return this.ok(address, source, surfaced, dropped, completed, held);
  }

  private async validateDelegation(
    address: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.options.delegations) return { ok: true };
    try {
      const result = await this.options.delegations.validate(address);
      if (result.ok) {
        this.setCard(address, { needsReauth: false });
        return { ok: true };
      }
      this.setCard(address, { needsReauth: true });
      return { ok: false, reason: result.reason ?? DELEGATION_UNUSABLE };
    } catch (error) {
      // §5.5: user-state, not item-state. No attempts burned, nothing dead-lettered.
      console.warn(
        "[connector-drain] delegation validation failed:",
        redactedErrorMessage(error),
      );
      this.setCard(address, { needsReauth: true });
      return { ok: false, reason: DELEGATION_UNUSABLE };
    }
  }

  /** The hoisted per-write re-check (§9.3): durable marker + config existence, throttled. */
  private async stillEnabled(
    address: string,
    source: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      if ((await this.options.control.readDisabled(address)) !== null) {
        return { ok: false, reason: "revoked" };
      }
      const config = await this.options.tokens.config(address);
      if (config === null || config.source !== source)
        return { ok: false, reason: "revoked" };
    } catch (error) {
      // The revocation input is unreadable — the same fail-closed rule the ledger gets.
      console.warn(
        "[connector-drain] revocation re-check failed:",
        redactedErrorMessage(error),
      );
      return { ok: false, reason: "revoked" };
    }
    return this.validateDelegation(address).then((result) =>
      result.ok
        ? { ok: true as const }
        : { ok: false as const, reason: DELEGATION_UNUSABLE },
    );
  }

  // ── Result helpers ───────────────────────────────────────────────────

  private ok(
    address: string,
    source: string | null,
    surfaced: string[],
    dropped: number,
    completed: number,
    held: number,
  ): DrainResult {
    this.setCard(address, { lastAbortReason: null });
    return {
      address,
      source,
      status: "ok",
      surfaced,
      dropped,
      completed,
      held,
      passes: 1,
      ceiling: this.ceilings.state(address),
      needsReauth: this.cardState(address).needsReauth,
    };
  }

  private aborted(
    address: string,
    source: string | null,
    reason: string,
    partial: {
      surfaced: string[];
      dropped: number;
      completed: number;
      held: number;
    } = {
      surfaced: [],
      dropped: 0,
      completed: 0,
      held: 0,
    },
  ): DrainResult {
    this.setCard(address, { lastAbortReason: reason });
    logDrain(
      `op=abort source=${source ?? "-"} reason=${reason} aid=${hashed(address)} ` +
        `surfaced=${partial.surfaced.length} dropped=${partial.dropped}`,
    );
    return {
      address,
      source,
      status: "aborted",
      reason,
      ...partial,
      passes: 1,
      ceiling: this.ceilings.state(address),
      needsReauth: this.cardState(address).needsReauth,
    };
  }

  private emptyResult(
    address: string,
    source: string | null,
    reason: string,
  ): DrainResult {
    return {
      address,
      source,
      status: "aborted",
      reason,
      surfaced: [],
      dropped: 0,
      completed: 0,
      held: 0,
      passes: 0,
      ceiling: this.ceilings.state(address),
      needsReauth: this.cardState(address).needsReauth,
    };
  }

  private setCard(
    address: string,
    patch: Partial<Omit<CardState, "ceiling">>,
  ): void {
    const key = normalizeWebhookAddress(address);
    const current = this.cards.get(key) ?? {
      needsReauth: false,
      lastAbortReason: null,
      ceiling: this.ceilings.state(key),
    };
    this.cards.set(key, {
      ...current,
      ...patch,
      ceiling: this.ceilings.state(key),
    });
  }
}

function safeAddress(address: string): string {
  try {
    return normalizeWebhookAddress(address);
  } catch {
    return "invalid";
  }
}

// ── §5.4 trigger 2 under OPTION C: bounded queue maintenance ─────────
//
// This used to be a timed DRAIN. Under §10.1 = C the server holds no delegation and writes
// nothing to the user's space, so a background drain read the config, the disabled marker, the
// queue and the purge ledger every five minutes in order to hand an id list to NOBODY: a
// surfacing decision taken with no client on the other end, repeated forever for every address
// that ever configured a webhook. What survives is the part that still earns its cost — the
// TTL / dead-letter sweep, which surfaces no id and therefore needs no ledger read.
//
// The processing trigger under C is the authenticated user visit (`POST …/webhooks/drain`),
// because the browser is the only party that can read the Fireflies key and write the meeting.

export interface ConnectorQueueMaintenanceTimer {
  stop(): void;
  /** Run one scan now — what the timer does on each tick, exposed for tests and operators. */
  tick(): Promise<void>;
}

export interface ConnectorQueueMaintenanceOptions {
  /**
   * Per-address maintenance. MUST be bounded and MUST NOT surface ids — `ConnectorQueue.sweep`
   * returns counts precisely so this callback has nothing to leak.
   */
  sweep: (address: string) => Promise<unknown> | unknown;
  /** Addresses with a `webhooks/config/{address}` entry (§5.4). */
  listAddresses: () => Promise<string[]>;
  intervalMs?: number;
}

/**
 * The env override §5.4 requires ("default 5 min, env-tunable"), failing loudly on a bad value.
 * `CONNECTOR_DRAIN_INTERVAL_MS` keeps its name — it is a deployed surface (compose file, deploy
 * workflow, `allowed_envs`) — but it now paces the maintenance sweep, not a drain.
 */
export function drainIntervalFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveIntFromEnv(
    "CONNECTOR_DRAIN_INTERVAL_MS",
    env.CONNECTOR_DRAIN_INTERVAL_MS,
    DRAIN_INTERVAL_MS,
  );
}

/**
 * Started in `main()` ONLY when the flag is on, and **`unref()`'d so `bun test` does not hang**
 * — a 5-minute interval on a test process is a 5-minute hang.
 *
 * Sequential per address (§9.3: TinyCloud drops concurrent responses on one space), and one
 * address's failure never skips the addresses behind it — a maintenance pass that gave up on
 * the first unreadable queue would quietly stop honouring the TTL for everyone else.
 */
export function startConnectorQueueMaintenanceTimer(
  options: ConnectorQueueMaintenanceOptions,
): ConnectorQueueMaintenanceTimer {
  const intervalMs = options.intervalMs ?? DRAIN_INTERVAL_MS;
  let running = false;

  const tick = async (): Promise<void> => {
    // Never overlap ticks: a scan that outlives its interval must not stack.
    if (running) return;
    running = true;
    try {
      const addresses = await options.listAddresses();
      for (const address of addresses) {
        try {
          await options.sweep(address);
        } catch (error) {
          logDrainWarn(
            `op=maintenance-sweep result=error aid=${hashed(safeAddress(address))}`,
          );
          console.warn(
            "[connector-drain] queue maintenance sweep failed:",
            redactedErrorMessage(error),
          );
        }
      }
    } catch (error) {
      logDrainWarn(`op=maintenance-scan result=error`);
      console.warn(
        "[connector-drain] queue maintenance scan failed:",
        redactedErrorMessage(error),
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    stop: () => clearInterval(timer),
    tick,
  };
}

// ── The timer's address source ───────────────────────────────────────

const CONFIG_KEY_PREFIX = "webhooks/config/";
const ADDRESS_KEY_PATTERN = /^0x[0-9a-f]{40}$/;

/** KV `list` responses have been seen wrapped, doubly wrapped, and as bare arrays. */
function extractKeys(response: unknown): string[] {
  if (
    response !== null &&
    typeof response === "object" &&
    (response as { ok?: unknown }).ok === true
  ) {
    const data = (response as { data?: unknown }).data;
    if (
      data === null ||
      typeof data !== "object" ||
      !Array.isArray((data as { keys?: unknown }).keys) ||
      !(data as { keys: unknown[] }).keys.every(
        (key): key is string => typeof key === "string",
      )
    ) {
      throw new Error("malformed successful KV list result");
    }
    return (data as { keys: string[] }).keys;
  }

  const seen: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === "string") {
      seen.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const field of ["key", "name", "path"]) {
      if (typeof record[field] === "string") {
        seen.push(record[field] as string);
        return;
      }
    }
    visit(record.data, depth + 1);
  };
  visit(response, 0);
  return seen;
}

/**
 * Scan the backend's OWN KV for `webhooks/config/*` (§5.4 trigger 2). Backend-own keys are
 * auto-prefixed under `ops.tinychat.backend` — they do NOT carry the full
 * `xyz.tinycloud.tinychat/…` path a user-space call would.
 */
export function createWebhookConfigDirectory(
  node: TinyCloudNode,
): () => Promise<string[]> {
  return async () => {
    const kv = (
      node as unknown as {
        kv?: { list?: (options: unknown) => Promise<unknown> };
      }
    ).kv;
    if (!kv || typeof kv.list !== "function") {
      // Loud, not silent: without a scan the timer recovers nothing after a redeploy, and the
      // operator needs to know that rather than infer it from meetings that never arrive.
      logDrainWarn(
        "op=timer-scan result=unsupported reason=kv_list_unavailable",
      );
      return [];
    }
    const response = await withSessionRefresh(node, async () =>
      assertKvResult(await kv.list!({ prefix: CONFIG_KEY_PREFIX })),
    );
    const addresses: string[] = [];
    for (const key of extractKeys(response)) {
      const tail = key.startsWith(CONFIG_KEY_PREFIX)
        ? key.slice(CONFIG_KEY_PREFIX.length)
        : key;
      const candidate = tail.split("/").pop()?.toLowerCase() ?? "";
      if (
        ADDRESS_KEY_PATTERN.test(candidate) &&
        !addresses.includes(candidate)
      ) {
        addresses.push(candidate);
      }
    }
    return addresses;
  };
}

export { AWAITING_TRANSCRIPT, DELEGATION_UNUSABLE, LEDGER_UNAVAILABLE };
