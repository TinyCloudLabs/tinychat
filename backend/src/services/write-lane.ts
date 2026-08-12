/**
 * The process-global serialized write lane (§5.4 "Single write lane", §9.3).
 *
 * The prod node is SQLite single-writer (`max_connections=1` + WAL, ~0.5 writes/sec shared
 * across ALL users; shared-eliza probe 2026-06-14) and TinyCloud drops concurrent responses on
 * the same space. Serialized, with a small inter-write gap, is not a performance compromise;
 * it is the only correct shape. Every drain — regardless of trigger — funnels through here.
 *
 * The lane is a module-level singleton on purpose: two lanes are no lane, and the thing being
 * protected (the node) is per-process, not per-service.
 */

/** A small gap between lane tasks, so a 200-item drain does not become one long burst. */
export const WRITE_LANE_GAP_MS = 25;

let lane: Promise<unknown> = Promise.resolve();
let gapMs = WRITE_LANE_GAP_MS;
let depth = 0;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process (or `bun test`) open for an inter-write gap.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Run `fn` in the process-global write lane. Rejections propagate to the caller and do NOT
 * poison the lane for the next task — a failed write is an item-state failure (§5.5), not a
 * reason to wedge every other user's writes.
 */
export function runInWriteLane<T>(fn: () => Promise<T> | T): Promise<T> {
  depth += 1;
  const next = lane.then(async () => {
    try {
      return await fn();
    } finally {
      depth -= 1;
      if (gapMs > 0) await sleep(gapMs);
    }
  });
  lane = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Tasks queued or running in the lane right now — an operator/test observable, never a gate. */
export function writeLaneDepth(): number {
  return depth;
}

/** Test hook (house convention, cf. `billing/stripe.ts`'s `_resetCache`). */
export function _setWriteLaneGapMs(ms: number): void {
  gapMs = Math.max(0, ms);
}

/** Test hook — restore the shipped gap. */
export function _resetWriteLane(): void {
  gapMs = WRITE_LANE_GAP_MS;
}
