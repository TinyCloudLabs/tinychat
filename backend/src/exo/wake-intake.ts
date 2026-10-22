/**
 * TC-1013 S3: intake for Exo wakes. The route answers before any store read, so verification and
 * the job write run here, detached. Pending work is capped globally and per owner, deduped on
 * (owner, request id), and served round-robin with one verification in flight per owner, so one
 * owner's flood cannot starve another owner. Over a cap, a random pending entry is dropped and the
 * newcomer is kept, so a sender cannot choose whose work is lost.
 */

export const WAKE_QUEUE_GLOBAL_CAP = 256;
export const WAKE_QUEUE_OWNER_CAP = 16;
export const WAKE_QUEUE_CONCURRENCY = 4;

/** Wakes per verified owner per fixed window. Spent only by a wake that creates a new job record. */
export const EXO_WAKE_OWNER_LIMIT_PER_MIN = 30;
export const EXO_WAKE_OWNER_WINDOW_MS = 60_000;

/** Bound on the shutdown wait for queued and running wakes. Past it, shutdown exits non-zero. */
export const WAKE_DRAIN_TIMEOUT_MS = 30_000;

const BUDGET_SWEEP_AT = 1024;

export interface WakeQueueOptions {
  globalCap: number;
  ownerCap: number;
  concurrency: number;
  /** Returns a value in [0, 1). Injected by tests; eviction picks `floor(random * n)`. */
  random: () => number;
}

interface PendingWake {
  readonly owner: string;
  readonly requestId: string;
  readonly run: () => Promise<void>;
}

const DEFAULT_OPTIONS: WakeQueueOptions = {
  globalCap: WAKE_QUEUE_GLOBAL_CAP,
  ownerCap: WAKE_QUEUE_OWNER_CAP,
  concurrency: WAKE_QUEUE_CONCURRENCY,
  random: Math.random,
};

function keyOf(owner: string, requestId: string): string {
  return JSON.stringify([owner, requestId]);
}

export class WakeQueue {
  private readonly options: WakeQueueOptions;
  private readonly pendingByOwner = new Map<string, Map<string, PendingWake>>();
  /**
   * Owners with pending work, front first. An owner whose run is in flight keeps its place until that
   * run finishes, then moves to the back if it still has work.
   */
  private readonly rotation: string[] = [];
  private pendingCount = 0;
  private readonly busyOwners = new Set<string>();
  /** (owner, request id) pairs queued or running. A pair is in here at most once. */
  private readonly live = new Set<string>();
  private readonly running = new Set<Promise<void>>();

  constructor(options: Partial<WakeQueueOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Queues one wake. The owner key must already be normalised by the caller. Never throws. */
  offer(owner: string, requestId: string, run: () => Promise<void>): void {
    const key = keyOf(owner, requestId);
    if (this.live.has(key)) return;

    const ownerEntries = this.pendingByOwner.get(owner);
    if (ownerEntries && ownerEntries.size >= this.options.ownerCap) {
      this.evict(this.pickRandom([...ownerEntries.values()]));
    }
    if (this.pendingCount >= this.options.globalCap) {
      this.evict(this.pickRandom([...this.pendingByOwner.values()].flatMap((entries) => [...entries.values()])));
    }

    let entries = this.pendingByOwner.get(owner);
    if (!entries) {
      entries = new Map<string, PendingWake>();
      this.pendingByOwner.set(owner, entries);
      this.rotation.push(owner);
    }
    entries.set(requestId, { owner, requestId, run });
    this.live.add(key);
    this.pendingCount++;
    this.pump();
  }

  /** Resolves once nothing is queued or running. Tests wait on it; the route never does. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /**
   * Resolves once nothing is queued or running. Rejects if work is still pending after `timeoutMs`, so shutdown can
   * exit non-zero rather than drop job records that were already acknowledged with 202.
   */
  drain(timeoutMs: number = WAKE_DRAIN_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("exo wake drain timed out")), timeoutMs);
      this.idle().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  stats(): { pending: number; running: number } {
    return { pending: this.pendingCount, running: this.busyOwners.size };
  }

  private pickRandom<T>(items: T[]): T {
    const index = Math.min(items.length - 1, Math.floor(this.options.random() * items.length));
    return items[index];
  }

  private evict(entry: PendingWake): void {
    this.unlink(entry.owner, entry.requestId);
    this.live.delete(keyOf(entry.owner, entry.requestId));
  }

  /** Removes one pending entry. An owner left with none leaves the rotation. */
  private unlink(owner: string, requestId: string): void {
    const entries = this.pendingByOwner.get(owner);
    if (!entries || !entries.delete(requestId)) return;
    this.pendingCount--;
    if (entries.size > 0) return;
    this.pendingByOwner.delete(owner);
    this.rotation.splice(this.rotation.indexOf(owner), 1);
  }

  /** Moves a served owner that still has work to the back of the line. */
  private requeue(owner: string): void {
    const at = this.rotation.indexOf(owner);
    if (at < 0) return;
    this.rotation.splice(at, 1);
    this.rotation.push(owner);
  }

  private pump(): void {
    while (this.busyOwners.size < this.options.concurrency) {
      const owner = this.rotation.find((candidate) => !this.busyOwners.has(candidate));
      if (owner === undefined) return;
      const [next] = this.pendingByOwner.get(owner)!.values();
      this.unlink(owner, next.requestId);
      this.busyOwners.add(owner);
      const started: Promise<void> = (async () => {
        await next.run();
      })()
        .catch(() => console.error("[exo] wake not recorded"))
        .then(() => {
          this.busyOwners.delete(owner);
          this.live.delete(keyOf(owner, next.requestId));
          this.running.delete(started);
          this.requeue(owner);
          this.pump();
        });
      this.running.add(started);
    }
  }
}

/**
 * Fixed-window counter per key. `spend` returns false once a key has used its `limit` in the current
 * window, including a limit of zero. The caller supplies the clock, so tests control time.
 */
export class FixedWindowBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  spend(key: string, now: number): boolean {
    let window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      if (this.windows.size >= BUDGET_SWEEP_AT) this.sweep(now);
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) return false;
    window.count++;
    return true;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
