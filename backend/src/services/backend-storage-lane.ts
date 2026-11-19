/**
 * The single serialized lane shared by every component that writes to the backend's own TinyCloud
 * space (§9.3): the connector queue, the KV-bound content store, the KV-bound credential row
 * store. TinyCloud drops concurrent responses on one space, so a queue-settle for user A and a
 * content-upsert for user B cannot overlap at the node without one of them being silently dropped
 * as a duplicate response. The queue's per-instance lane and the content store's per-instance
 * lane used to be independent (audit finding: cross-component KV concurrency untested); this
 * shared lane is the fix — one lane per PROCESS's backend node, injected into every component.
 *
 * Rejections propagate to the caller and do NOT poison the lane — a failed write is item-state,
 * not a reason to wedge every other user's writes. Analogous to write-lane.ts, which serves the
 * user-space drain path.
 *
 * Jobs still run one at a time, but a waiting `foreground` job (a request handler) starts before
 * any waiting `background` job (the calendar-autojoin worker), so a request queues behind the job
 * already running rather than a whole reconcile pass (TC-1006). Background work is not starved:
 * after FOREGROUND_BURST foreground starts in a row that overtook waiting background work, the
 * oldest background job starts next. Each priority is FIFO, so jobs from one store keep their
 * order. A job given `waitTimeoutMs` that has not started by then is removed without running and
 * rejects with `BackendStorageLaneTimeout`.
 */
export type BackendStorageLanePriority = "foreground" | "background";

export interface BackendStorageLaneRunOptions {
  priority?: BackendStorageLanePriority;
  waitTimeoutMs?: number;
}

/** Wait budget for lane work done inside an HTTP request. One node KV call that has already
 * started (~2-4 s) can still finish after it, so budget plus that call stays under the clients'
 * 20 s abort. */
export const REQUEST_LANE_WAIT_MS = 12_000;

const SLOW_WAIT_MS = 1_000;
export const FOREGROUND_BURST = 4;

export class BackendStorageLaneTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendStorageLaneTimeout";
  }
}

interface Job {
  priority: BackendStorageLanePriority;
  enqueuedAt: number;
  start: () => Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

export class BackendStorageLane {
  private readonly waiting: Record<BackendStorageLanePriority, Job[]> = {
    foreground: [],
    background: [],
  };
  private running = false;
  private overtaken = 0;

  run<T>(fn: () => Promise<T>, options: BackendStorageLaneRunOptions = {}): Promise<T> {
    const priority = options.priority ?? "foreground";
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        priority,
        enqueuedAt: Date.now(),
        start: async () => {
          const waitedMs = Date.now() - job.enqueuedAt;
          if (waitedMs >= SLOW_WAIT_MS) {
            console.warn(`[storage-lane] op=slow-wait priority=${priority} waitedMs=${waitedMs}`);
          }
          try {
            resolve(await fn());
          } catch (error) {
            reject(error);
          }
        },
      };
      if (options.waitTimeoutMs !== undefined) {
        job.timer = setTimeout(() => {
          const queue = this.waiting[priority];
          const index = queue.indexOf(job);
          if (index === -1) return;
          queue.splice(index, 1);
          const waitedMs = Date.now() - job.enqueuedAt;
          console.warn(`[storage-lane] op=wait-timeout priority=${priority} waitedMs=${waitedMs}`);
          reject(new BackendStorageLaneTimeout(`backend storage lane wait exceeded ${waitedMs}ms`));
        }, options.waitTimeoutMs);
      }
      this.waiting[priority].push(job);
      this.drain();
    });
  }

  private drain(): void {
    if (this.running) return;
    const job = this.next();
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    this.running = true;
    // Start on a microtask, as the previous promise-chain lane did, never inside `run()` itself.
    void Promise.resolve().then(job.start).finally(() => {
      this.running = false;
      this.drain();
    });
  }

  private next(): Job | undefined {
    const { foreground, background } = this.waiting;
    if (background.length > 0 && (foreground.length === 0 || this.overtaken >= FOREGROUND_BURST)) {
      this.overtaken = 0;
      return background.shift();
    }
    this.overtaken = background.length > 0 ? this.overtaken + 1 : 0;
    return foreground.shift();
  }
}
