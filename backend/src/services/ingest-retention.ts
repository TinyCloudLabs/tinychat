import { keyedLogHash } from "./webhook-tokens.js";

/**
 * W4/D2a — the thing that makes the **retention window a fact** rather than a method (backend-ingest
 * plan §5.1 W4, §7, §11 requirement 2; DECISIONS `D2a-retention-days: 14`).
 *
 * `ContentStore.sweepRetention` is the per-index primitive; this periodic caller enumerates every
 * stored index, independent of the ingest flag and its current cohort.
 *
 * Three properties, and they are the whole design:
 *
 *  - **One instance sweeps.** This is a {@link SupervisedWorker}, driven by the D4 lease exactly
 *    like the fetch worker: an instance that refused the seat sweeps nothing. Two processes
 *    rewriting one tenant's index is the interleaved read-modify-write W9 exists to prevent.
 *  - **Sequential across indexes.** One `sweepRetention` at a time — never `Promise.all` across
 *    addresses (§9.3: TinyCloud drops concurrent responses on one space).
 *  - **Fail closed, and cheap.** An unreadable directory sweeps NOTHING rather than guessing;
 *    one index's failure never costs the others theirs, and the pass logs numbers only.
 */

/** Frequent sweeps keep physical deletion close to the 14-day boundary. */
export const RETENTION_SWEEP_INTERVAL_MS = 5 * 60_000;

/** The slice of `ContentStore` this needs. Narrowed so it cannot reach a read or a purge. */
export interface RetentionSweepTarget {
  sweepRetention(input: {
    source: string;
    address: string;
    safetyMarginMs?: number;
  }): Promise<{
    swept: number;
    bytesFreed: number;
    tombstones: number;
    storedAtBackfilled?: number;
    unreadableIndex?: boolean;
  }>;
}

export interface RetentionIndex {
  source: string;
  address: string;
}

export interface IngestRetentionSweeperDeps {
  content: RetentionSweepTarget;
  /** All existing ContentStore indexes, not the feature's current allowlist/cohort. */
  indexes: () => Promise<readonly RetentionIndex[]>;
  intervalMs?: number;
}


export interface RetentionPassResult {
  addresses: number;
  swept: number;
  errors: number;
}

/** The guarded form every peer call site uses: a missing `LOG_HASH_SALT` drops the field rather
 * than throwing out of the logger — and here, out of a sweep pass. */
function hashed(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

function logRetention(fields: string): void {
  console.log(`[connector-retention] ${fields} t=${new Date().toISOString()}`);
}

function warnRetention(fields: string): void {
  console.warn(`[connector-retention] ${fields} t=${new Date().toISOString()}`);
}

export class IngestRetentionSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private passing = false;
  private deploySummaryLogged = false;
  private readonly intervalMs: number;

  constructor(private readonly deps: IngestRetentionSweeperDeps) {
    this.intervalMs = deps.intervalMs ?? RETENTION_SWEEP_INTERVAL_MS;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * One pass over every stored content index. NEVER rejects: this runs from a timer, and a
   * retention sweep that could reject into a timer callback would be an unhandled rejection.
   */
  async sweepOnce(): Promise<RetentionPassResult> {
    if (this.passing) return { addresses: 0, swept: 0, errors: 0 };
    this.passing = true;
    try {
      let indexes: readonly RetentionIndex[];
      try {
        indexes = await this.deps.indexes();
      } catch {
        warnRetention(`op=retention-pass result=index_directory_unavailable`);
        return { addresses: 0, swept: 0, errors: 1 };
      }

      let swept = 0;
      let errors = 0;
      let addresses = 0;
      let storedAtBackfilled = 0;
      let unreadableIndexes = 0;
      for (const { source, address } of indexes) {
        addresses += 1;
        try {
          // Sequential by construction — one node call at a time, across every tenant.
          const result = await this.deps.content.sweepRetention({
            source,
            address,
            safetyMarginMs: this.intervalMs,
          });
          swept += result.swept;
          storedAtBackfilled += result.storedAtBackfilled ?? 0;
          if (result.unreadableIndex) unreadableIndexes += 1;
        } catch {
          // One tenant's substrate failure is not the directory's. Count and continue.
          errors += 1;
          warnRetention(
            `op=retention-sweep result=failed source=${source} aid=${hashed(address)}`,
          );
        }
      }
      if (!this.deploySummaryLogged) {
        const tenantHashes = indexes
          .map(({ source, address }) => `${source}:${hashed(address)}`)
          .sort()
          .join(",");
        logRetention(
          `op=deploy-retention-summary tenants_swept=${addresses} ` +
            `stored_at_backfilled=${storedAtBackfilled} ` +
            `unreadable_indexes=${unreadableIndexes} errors=${errors} ` +
            `tenant_hashes=${tenantHashes || "none"}`,
        );
        this.deploySummaryLogged = true;
      }

      logRetention(
        `op=retention-pass result=ok indexes=${addresses} swept=${swept} errors=${errors}`,
      );
      return { addresses, swept, errors };
    } finally {
      this.passing = false;
    }
  }

  private runPass(): void {
    void this.sweepOnce().catch(() => {
      // `sweepOnce` does not reject; this is the belt to that brace.
      warnRetention(`op=retention-pass result=unexpected_error`);
    });
  }

  /** Start with a pass immediately, then sweep periodically without keeping the process open. */
  start(): void {
    if (this.timer !== null) return;
    const intervalMs = this.intervalMs;
    this.runPass();
    this.timer = setInterval(() => this.runPass(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
