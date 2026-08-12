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
 */
export class BackendStorageLane {
  private lane: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lane.then(fn, fn);
    this.lane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
