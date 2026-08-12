import { keyedLogHash } from "./webhook-tokens.js";

/**
 * W4/D2a — the thing that makes the **retention window a fact** rather than a method (backend-ingest
 * plan §5.1 W4, §7, §11 requirement 2; DECISIONS `D2a-retention-days: 90`).
 *
 * `ContentStore.sweepRetention` is the per-tenant primitive; this is the periodic caller. Without a
 * caller the only bound on a cohort address's server-side archive is W4's overflow cap — a churn
 * policy, not a time bound — and the retention tombstones delta 5 depends on ("a replay never
 * re-stores aged-out content") are never produced in a live deployment.
 *
 * Three properties, and they are the whole design:
 *
 *  - **One instance sweeps.** This is a {@link SupervisedWorker}, driven by the D4 lease exactly
 *    like the fetch worker: an instance that refused the seat sweeps nothing. Two processes
 *    rewriting one tenant's index is the interleaved read-modify-write W9 exists to prevent.
 *  - **Sequential across tenants.** One `sweepRetention` at a time — never `Promise.all` across
 *    addresses (§9.3: TinyCloud drops concurrent responses on one space).
 *  - **Fail closed, and cheap.** A cohort read that fails sweeps NOTHING (it never guesses a tenant
 *    list), one tenant's failure never costs the others theirs, and the pass logs numbers only:
 *    an address appears hashed or not at all (§6.3).
 */

/** Slow on purpose: the window is 90 days, so four passes a day is ample and costs ~nothing. */
export const RETENTION_SWEEP_INTERVAL_MS = 6 * 3_600_000;

/** The slice of `ContentStore` this needs. Narrowed so it cannot reach a read or a purge. */
export interface RetentionSweepTarget {
  sweepRetention(input: { source: string; address: string }): Promise<{
    swept: number;
    bytesFreed: number;
    tombstones: number;
  }>;
}

export interface IngestRetentionSweeperDeps {
  content: RetentionSweepTarget;
  /** `IngestModeService.cohort` — the only addresses that HAVE server-side content. */
  cohort: () => Promise<ReadonlySet<string>>;
  sources: readonly string[];
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

  constructor(private readonly deps: IngestRetentionSweeperDeps) {}

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * One pass over the cohort. NEVER rejects: this runs from a timer, and a retention sweep that
   * could reject into a timer callback would be an unhandled rejection on a schedule.
   */
  async sweepOnce(): Promise<RetentionPassResult> {
    if (this.passing) return { addresses: 0, swept: 0, errors: 0 };
    this.passing = true;
    try {
      let cohort: ReadonlySet<string>;
      try {
        cohort = await this.deps.cohort();
      } catch {
        // Fail closed: "I could not read the cohort" is never "there is nobody to sweep" *and*
        // never a licence to sweep an invented list. Skip the pass; the next one retries.
        warnRetention(`op=retention-pass result=cohort_unavailable`);
        return { addresses: 0, swept: 0, errors: 1 };
      }

      let swept = 0;
      let errors = 0;
      let addresses = 0;
      for (const source of this.deps.sources) {
        for (const address of cohort) {
          addresses += 1;
          try {
            // Sequential by construction — one node call at a time, across every tenant.
            const result = await this.deps.content.sweepRetention({
              source,
              address,
            });
            swept += result.swept;
          } catch {
            // One tenant's substrate failure is not the cohort's. Counted, hashed, and carried on.
            errors += 1;
            warnRetention(
              `op=retention-sweep result=failed source=${source} aid=${hashed(address)}`,
            );
          }
        }
      }

      logRetention(
        `op=retention-pass result=ok sources=${this.deps.sources.length} ` +
          `tenants=${addresses} swept=${swept} errors=${errors}`,
      );
      return { addresses, swept, errors };
    } finally {
      this.passing = false;
    }
  }

  /** Start the periodic pass. The timer is unref'd: retention never holds the process open. */
  start(): void {
    if (this.timer !== null) return;
    const intervalMs = this.deps.intervalMs ?? RETENTION_SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.sweepOnce().catch(() => {
        // `sweepOnce` does not reject; this is the belt to that brace.
        warnRetention(`op=retention-pass result=unexpected_error`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
