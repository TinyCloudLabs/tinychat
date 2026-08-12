import { randomBytes } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import * as serverPackage from "@tinyboilerplate/server";
import { redactedErrorMessage } from "./webhook-tokens.js";

const { assertKvResult, withSessionRefresh } = serverPackage;
const { isKvMissingKeyResult } = serverPackage as typeof serverPackage & {
  isKvMissingKeyResult: (result: unknown, key: string) => boolean;
};

/**
 * W9 — the **single-instance serialization guard** (backend-ingest plan §8.1 W9; §8.2 delta item
 * 11; DECISIONS `D4: single-instance`).
 *
 * D4 took the bounded first cut deliberately: ONE backend instance consumes the cohort's delivery
 * queues. Findings §2.2/§2.5 price the alternative — the queue's mutual exclusion is a *per-address
 * in-process mutex* and the storage lane is a *per-instance* lane, so a second instance is not
 * "more throughput", it is two consumers interleaving read-modify-writes on one array: dropped
 * enqueues, double fetches, and a write budget spent twice.
 *
 * W3 already keeps ONE worker per process (`fetch-worker.ts`'s seat). This module is the other
 * boundary — one worker per *deployment* — and it is the boundary a process-local variable cannot
 * see: a rolling deploy that overlaps, a second CVM, an operator running the backend locally
 * against the production space.
 *
 * ### What this is, exactly
 *
 * A **lease**, not a lock. The backend's own KV has no compare-and-set, so two simultaneous first
 * claims can both write; `claim()` closes the common window by re-reading its own write
 * (write-then-verify) and refusing when it does not see itself, but that is a detector with a
 * short race, not a mutex. That is the honest shape of D4's "declared and guarded", and
 * `docs/connector-webhooks-single-instance.md` says so where an operator will find it. Lifting the
 * constraint (D4 = multi-instance) means per-item keys / row locking on the D3 off-node substrate
 * — a different design, not a bigger number here.
 *
 * ### Fail closed
 *
 * A lease that cannot be read, cannot be parsed, or cannot be written REFUSES the seat. "I could
 * not tell who holds it" must never resolve to "nobody does": that reading is precisely how the
 * second consumer starts, silently, which is the failure this file exists to prevent. The refusing
 * instance keeps serving HTTP and simply ingests nothing — provably inert, and loud about it.
 */

/** Backend-own KV key. Auto-prefixed under the backend's space, like every other ingest key. */
export const INGEST_INSTANCE_LEASE_KEY = "webhooks/ingest/instance-lease";

/**
 * How long a lease survives without a heartbeat. Long enough that a slow GC pause or a stalled
 * node call does not hand the seat away mid-pass; short enough that a hard crash (SIGKILL, a CVM
 * that vanished) costs at most this much ingest downtime before another instance takes over.
 */
export const INSTANCE_LEASE_TTL_MS = 90_000;

/** Renewal cadence. Three heartbeats fit inside the TTL, so one lost write is not a handover. */
export const INSTANCE_HEARTBEAT_MS = 30_000;

/** Optional: pin the identity so a redeploy reclaims its OWN lease instead of waiting out the TTL. */
export const INGEST_INSTANCE_ID_ENV = "CONNECTOR_INGEST_INSTANCE_ID";

/** Same character class as every other id this codebase puts in a KV value: no `/`, no `.`-escape. */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface InstanceLeaseRecord {
  instanceId: string;
  /** ISO — when this holder first took the seat. */
  claimedAt: string;
  /** ISO — the liveness signal the TTL is measured against. */
  heartbeatAt: string;
}

export type InstanceClaimRefusal =
  | "held_by_other"
  | "lease_unreadable"
  | "lease_unparseable"
  | "lease_unwritable"
  | "lost_race";

export type InstanceClaim =
  | { status: "held"; instanceId: string }
  | { status: "refused"; reason: InstanceClaimRefusal };

/**
 * The substrate seam. `KvInstanceLeaseStore` is the shipped implementation; a test (or a future
 * D3 off-node move) supplies its own without this module learning about either.
 */
export interface InstanceLeaseStore {
  read(): Promise<unknown>;
  write(record: InstanceLeaseRecord): Promise<void>;
  clear(): Promise<void>;
}

function logInstance(fields: string): void {
  console.log(`[connector-ingest] ${fields} t=${new Date().toISOString()}`);
}

function logInstanceWarn(fields: string): void {
  console.warn(`[connector-ingest] ${fields} t=${new Date().toISOString()}`);
}

/**
 * The per-process identity. Random by default — an id nobody else can guess is an id nobody else
 * can accidentally collide with — and pinnable via {@link INGEST_INSTANCE_ID_ENV} so a rolling
 * redeploy of the SAME logical instance reclaims its seat immediately rather than idling out the
 * TTL. A malformed pin falls back to a random id rather than becoming a shared identity every
 * instance would answer to.
 */
export function resolveInstanceId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[INGEST_INSTANCE_ID_ENV];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length > 0) {
    if (INSTANCE_ID_PATTERN.test(trimmed)) return trimmed;
    logInstanceWarn(
      `op=instance-id result=malformed action=generated env=${INGEST_INSTANCE_ID_ENV}`,
    );
  }
  return randomBytes(8).toString("hex");
}

/**
 * `{instanceId, claimedAt, heartbeatAt}` → the record, or null for anything else. Null is a
 * REFUSAL upstream, never an empty seat: a value we cannot read is the one case where guessing is
 * unrecoverable.
 */
export function parseInstanceLease(raw: unknown): InstanceLeaseRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.instanceId !== "string" ||
    !INSTANCE_ID_PATTERN.test(value.instanceId) ||
    typeof value.claimedAt !== "string" ||
    typeof value.heartbeatAt !== "string" ||
    !Number.isFinite(Date.parse(value.claimedAt)) ||
    !Number.isFinite(Date.parse(value.heartbeatAt))
  ) {
    return null;
  }
  return {
    instanceId: value.instanceId,
    claimedAt: value.claimedAt,
    heartbeatAt: value.heartbeatAt,
  };
}

export interface IngestInstanceGuardOptions {
  instanceId?: string;
  ttlMs?: number;
  now?: () => number;
}

export class IngestInstanceGuard {
  readonly instanceId: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private holder = false;
  private claimedAt: string | null = null;

  constructor(
    private readonly store: InstanceLeaseStore,
    options: IngestInstanceGuardOptions = {},
  ) {
    this.instanceId = options.instanceId ?? resolveInstanceId();
    this.ttlMs = options.ttlMs ?? INSTANCE_LEASE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  isHolder(): boolean {
    return this.holder;
  }

  /**
   * Take the seat, or refuse. The order matters: READ (who is there?) → decide → WRITE → READ
   * again (did our write survive?). The confirming read is what turns a CAS-less substrate from
   * "both instances think they won" into "at most one instance believes it won", in the window
   * that is actually reachable — two boots seconds apart, not two boots in the same millisecond.
   */
  async claim(): Promise<InstanceClaim> {
    let existingRaw: unknown;
    try {
      existingRaw = await this.store.read();
    } catch (error) {
      return this.refuse("lease_unreadable", error);
    }

    if (existingRaw !== null && existingRaw !== undefined) {
      const existing = parseInstanceLease(existingRaw);
      if (existing === null) return this.refuse("lease_unparseable");
      if (existing.instanceId !== this.instanceId) {
        const age = this.now() - Date.parse(existing.heartbeatAt);
        // A live holder keeps the seat. An expired one does not — otherwise a SIGKILL would take
        // ingest down until an operator noticed and deleted a KV key by hand.
        if (age < this.ttlMs) return this.refuse("held_by_other");
        logInstance(
          `op=instance-lease result=expired_takeover age_ms=${Math.max(0, age)} ttl_ms=${this.ttlMs}`,
        );
      } else {
        // Our own lease, from before a restart with a pinned id: reclaim it, keep its start time.
        this.claimedAt = existing.claimedAt;
      }
    }

    const nowIso = new Date(this.now()).toISOString();
    const record: InstanceLeaseRecord = {
      instanceId: this.instanceId,
      claimedAt: this.claimedAt ?? nowIso,
      heartbeatAt: nowIso,
    };

    try {
      await this.store.write(record);
    } catch (error) {
      return this.refuse("lease_unwritable", error);
    }

    let confirmedRaw: unknown;
    try {
      confirmedRaw = await this.store.read();
    } catch (error) {
      return this.refuse("lease_unreadable", error);
    }
    if (parseInstanceLease(confirmedRaw)?.instanceId !== this.instanceId) {
      return this.refuse("lost_race");
    }

    this.holder = true;
    this.claimedAt = record.claimedAt;
    logInstance(`op=instance-lease result=held ttl_ms=${this.ttlMs}`);
    return { status: "held", instanceId: this.instanceId };
  }

  /**
   * Stamp a new heartbeat. Returns false — and DROPS holder status — the moment the lease is
   * someone else's, unreadable or unwritable: an instance that cannot prove it still holds the
   * seat must stop consuming, not carry on assuming.
   */
  async renew(): Promise<boolean> {
    if (!this.holder) return false;
    try {
      const existing = parseInstanceLease(await this.store.read());
      if (existing === null || existing.instanceId !== this.instanceId) {
        this.holder = false;
        logInstanceWarn(`op=instance-lease result=lost`);
        return false;
      }
      await this.store.write({
        instanceId: this.instanceId,
        claimedAt: existing.claimedAt,
        heartbeatAt: new Date(this.now()).toISOString(),
      });
      return true;
    } catch (error) {
      this.holder = false;
      logInstanceWarn(`op=instance-lease result=renew_failed`);
      console.warn(
        "[connector-ingest] instance lease renew failed:",
        redactedErrorMessage(error),
      );
      return false;
    }
  }

  /**
   * Hand the seat back on a clean shutdown so the next instance starts immediately instead of
   * idling out the TTL. Deletes ONLY our own lease — a stale process releasing on the way out must
   * not evict the live holder that already replaced it.
   */
  async release(): Promise<void> {
    const wasHolder = this.holder;
    this.holder = false;
    if (!wasHolder) return;
    try {
      const existing = parseInstanceLease(await this.store.read());
      if (existing !== null && existing.instanceId !== this.instanceId) return;
      await this.store.clear();
      logInstance(`op=instance-lease result=released`);
    } catch (error) {
      // A failed release costs one TTL of ingest downtime, nothing more — but it is never silent.
      logInstanceWarn(`op=instance-lease result=release_failed`);
      console.warn(
        "[connector-ingest] instance lease release failed:",
        redactedErrorMessage(error),
      );
    }
  }

  private refuse(
    reason: InstanceClaimRefusal,
    error?: unknown,
  ): InstanceClaim {
    this.holder = false;
    logInstanceWarn(`op=instance-lease result=refused reason=${reason}`);
    if (error !== undefined) {
      console.warn(
        "[connector-ingest] instance lease unavailable:",
        redactedErrorMessage(error),
      );
    }
    return { status: "refused", reason };
  }
}

// ── The supervisor ───────────────────────────────────────────────────

/** The `{start,stop,isRunning}` slice of W3's worker the supervisor drives. */
export interface SupervisedWorker {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export type SupervisorState = "unstarted" | "holder" | "inert";

export interface IngestInstanceSupervisorOptions {
  guard: IngestInstanceGuard;
  worker: SupervisedWorker;
  /**
   * W4/D2a's retention sweep (`IngestRetentionSweeper`). It rides the SAME seat as the worker for
   * the same reason: two processes rewriting one tenant's content index is the interleaved
   * read-modify-write this lease exists to prevent, and an instance that ingests nothing has no
   * business aging out another instance's archive.
   */
  retention?: SupervisedWorker;
  /** Tick cadence. One value for both renewal and re-claim: a tick is "am I still the one?". */
  intervalMs?: number;
  now?: () => number;
}

/**
 * Binds the lease to the worker's lifetime: hold the seat ⇒ the worker runs; lose or fail to take
 * it ⇒ the worker does not, and this process consumes nothing.
 *
 * `tick()` is the whole state machine and is safe to call by hand, which is how the acceptance
 * tests exercise a 90-second TTL in microseconds.
 */
export class IngestInstanceSupervisor {
  readonly guard: IngestInstanceGuard;
  readonly worker: SupervisedWorker;
  readonly retention: SupervisedWorker | null;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: SupervisorState = "unstarted";
  private lastInertLogAt = 0;

  constructor(options: IngestInstanceSupervisorOptions) {
    this.guard = options.guard;
    this.worker = options.worker;
    this.retention = options.retention ?? null;
    this.intervalMs = options.intervalMs ?? INSTANCE_HEARTBEAT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Everything the seat owns. The worker is FIRST in both directions: it is the queue consumer. */
  private supervised(): readonly SupervisedWorker[] {
    return this.retention === null ? [this.worker] : [this.worker, this.retention];
  }

  state(): SupervisorState {
    return this.current;
  }

  async tick(): Promise<Exclude<SupervisorState, "unstarted">> {
    if (this.guard.isHolder()) {
      if (await this.guard.renew()) {
        for (const task of this.supervised()) {
          if (!task.isRunning()) task.start();
        }
        return this.settle("holder");
      }
      // The seat is gone. Stop BEFORE anything else touches the queue.
      for (const task of this.supervised()) {
        if (task.isRunning()) task.stop();
      }
      return this.settle("inert");
    }

    const claim = await this.guard.claim();
    if (claim.status !== "held") return this.settle("inert");

    try {
      for (const task of this.supervised()) task.start();
    } catch (error) {
      // The in-process seat is taken (W3's guard) — hand the lease back rather than holding a seat
      // we cannot use, so another instance can have it. Anything that DID start comes back down
      // with it: a released lease must leave nothing of ours consuming.
      logInstanceWarn(`op=instance-lease result=worker_refused`);
      console.warn(
        "[connector-ingest] fetch worker refused to start:",
        redactedErrorMessage(error),
      );
      for (const task of this.supervised()) {
        if (task.isRunning()) task.stop();
      }
      await this.guard.release();
      return this.settle("inert");
    }
    return this.settle("holder");
  }

  /** Take a first tick immediately, then keep ticking. The timer never holds the process open. */
  start(): void {
    void this.tick().catch(() => {
      // `tick` already logged; an unhandled rejection out of a supervisor would be a worse
      // outcome than the missed tick the next interval retries.
    });
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const task of this.supervised()) {
      if (task.isRunning()) task.stop();
    }
    await this.guard.release();
    this.current = "unstarted";
  }

  private settle(
    next: Exclude<SupervisorState, "unstarted">,
  ): Exclude<SupervisorState, "unstarted"> {
    // Log on TRANSITION, and at most once per TTL while inert — the same discipline the sig-key
    // cohort uses. A refused instance ticks forever; it must not narrate forever.
    const changed = this.current !== next;
    const staleEnough = this.now() - this.lastInertLogAt >= INSTANCE_LEASE_TTL_MS;
    if (next === "inert" ? changed || staleEnough : changed) {
      if (next === "inert") this.lastInertLogAt = this.now();
      logInstance(`op=ingest-instance state=${next}`);
    }
    this.current = next;
    return next;
  }
}

// ── The shipped substrate: the backend's own KV ──────────────────────

/**
 * Same read/write discipline as `IngestModeService`: the SDK reports a durable KV failure as a
 * resolved `{ok:false,error}` rather than a rejection, so the assertion runs INSIDE
 * `withSessionRefresh` and a failed read THROWS instead of arriving here as `null`. That
 * distinction is the whole fail-closed property above — a swallowed read error would read as an
 * empty seat.
 */
export class KvInstanceLeaseStore implements InstanceLeaseStore {
  constructor(
    private readonly node: TinyCloudNode,
    private readonly key: string = INGEST_INSTANCE_LEASE_KEY,
  ) {}

  async read(): Promise<unknown> {
    const result = await withSessionRefresh(this.node, async () => {
      const r = await this.node.kv.get(this.key);
      if (isKvMissingKeyResult(r, this.key)) return null;
      return assertKvResult(r);
    });
    const response = (result as { data?: unknown } | null)?.data as
      | { data?: unknown }
      | null
      | undefined;
    if (response === null || response === undefined) return null;
    const value = (response as { data?: unknown }).data ?? response;
    if (typeof value !== "string") return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  async write(record: InstanceLeaseRecord): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      assertKvResult(await this.node.kv.put(this.key, record));
    });
  }

  async clear(): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.delete(this.key);
      if (isKvMissingKeyResult(result, this.key)) return;
      assertKvResult(result);
    });
  }
}
