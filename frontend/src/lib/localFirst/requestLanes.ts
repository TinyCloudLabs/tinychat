/**
 * Two lanes for node traffic, so what the user is looking at is never queued
 * behind copying.
 *
 * - foreground: reads and writes for the visible screen or a user action. They
 *   start at once, always.
 * - background: the history copy and any other catch-up work queued here. At
 *   most one runs at a time; none starts while a foreground
 *   request is in flight, within `FOREGROUND_QUIET_MS` of the last one, or while
 *   the tab is hidden (TC-2086: a hidden tab makes no scheduled reads).
 *
 * A background request already running is not cancelled; a foreground request
 * therefore waits behind at most one background request at the node (the node
 * serves only a few SQL connections at once: TC-2016).
 *
 * Feed first: an open that lands on the Feed holds the other startup reads
 * (`afterFeedFirst`) and the whole background lane until the Feed's first
 * network load has rendered (`markFeedFresh`), the user is no longer on the
 * Feed (`noteScreen`), or `FEED_FIRST_MAX_MS` after the first held work. The
 * node serves about 4 SQL calls per account at once, so startup reads issued
 * beside the Feed's queue the Feed behind them. Released work runs in the lane
 * it asks for, as before.
 */

export type Lane = "foreground" | "background";

/** Background work resumes only after the foreground has been quiet this long. */
export const FOREGROUND_QUIET_MS = 400;
const BACKGROUND_CONCURRENCY = 1;
/** A foreground call stops holding background work after this long, answered or not. */
export const FOREGROUND_COUNT_MAX_MS = 20_000;
/** The longest startup work waits for the Feed's first network load. */
export const FEED_FIRST_MAX_MS = 3_000;

interface QueuedWork {
  work: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

let foregroundActive = 0;
let backgroundActive = 0;
let lastForegroundEnd = Number.NEGATIVE_INFINITY;
let pumpTimer: ReturnType<typeof setTimeout> | undefined;
const backgroundQueue: QueuedWork[] = [];
const idleWaiters = new Set<() => void>();
let visibilityHooked = false;
/** undecided until App names the first screen; holding while a Feed landing waits; then released for good. */
let feedFirst: "undecided" | "holding" | "released" = "undecided";
let feedFirstCap: ReturnType<typeof setTimeout> | undefined;
const feedFirstWaiters: Array<() => void> = [];

/** The first held work starts the cap, so nothing waits on a Feed that never reports. */
function armFeedFirstCap(): void {
  feedFirstCap ??= setTimeout(releaseFeedFirst, FEED_FIRST_MAX_MS);
}

function releaseFeedFirst(): void {
  if (feedFirst === "released") return;
  feedFirst = "released";
  clearTimeout(feedFirstCap);
  feedFirstCap = undefined;
  for (const resolve of feedFirstWaiters.splice(0)) resolve();
  pump();
}

/**
 * App: the screen the user is looking at, on every change. The first call
 * decides whether this open lands on the Feed; any later screen other than the
 * Feed releases held work, since what the user looks at never waits.
 */
export function noteScreen(onFeed: boolean): void {
  if (feedFirst === "undecided" && onFeed) feedFirst = "holding";
  else if (!onFeed) releaseFeedFirst();
}

/** The Feed's first network load rendered (or failed): held startup work goes now. Idempotent. */
export function markFeedFresh(): void {
  releaseFeedFirst();
}

/**
 * Startup work that must not compete with the Feed's first load: runs `work`
 * at once unless this open landed on the Feed and the Feed has not reported
 * yet, else once it does (or the user leaves the Feed, or the cap passes).
 */
export function afterFeedFirst<T>(work: () => Promise<T>): Promise<T> {
  if (feedFirst !== "holding") return work();
  armFeedFirstCap();
  return new Promise<void>((resolve) => { feedFirstWaiters.push(resolve); }).then(work);
}

function pump(): void {
  if (!visibilityHooked && typeof document !== "undefined") {
    visibilityHooked = true;
    document.addEventListener("visibilitychange", pump);
  }
  clearTimeout(pumpTimer);
  pumpTimer = undefined;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // visibilitychange pumps again
  if (feedFirst === "holding") {
    if (backgroundQueue.length > 0 || idleWaiters.size > 0) armFeedFirstCap();
    return; // releaseFeedFirst pumps again
  }
  if (foregroundActive > 0) return; // the last foreground request pumps again
  const wait = lastForegroundEnd + FOREGROUND_QUIET_MS - Date.now();
  if (wait > 0) {
    pumpTimer = setTimeout(pump, wait);
    return;
  }
  for (const resolve of [...idleWaiters]) resolve();
  idleWaiters.clear();
  while (backgroundActive < BACKGROUND_CONCURRENCY && backgroundQueue.length > 0) {
    const next = backgroundQueue.shift() as QueuedWork;
    backgroundActive++;
    void next.work().then(next.resolve, next.reject).finally(() => {
      backgroundActive--;
      pump();
    });
  }
}

/** Run user-visible work now; background work waits until it and its quiet gap end. */
export async function inForeground<T>(work: () => Promise<T>): Promise<T> {
  foregroundActive++;
  clearTimeout(pumpTimer);
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    foregroundActive--;
    lastForegroundEnd = Date.now();
    pump();
  };
  // A response that never arrives must not hold background work for the session.
  const cap = setTimeout(release, FOREGROUND_COUNT_MAX_MS);
  try {
    return await work();
  } finally {
    clearTimeout(cap);
    release();
  }
}

/** Queue catch-up work behind every foreground request. */
export function inBackground<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    backgroundQueue.push({ work, resolve: resolve as (value: unknown) => void, reject });
    pump();
  });
}

export function inLane<T>(lane: Lane, work: () => Promise<T>): Promise<T> {
  return lane === "foreground" ? inForeground(work) : inBackground(work);
}

/**
 * Resolves once the tab is visible and the foreground has been quiet for
 * `FOREGROUND_QUIET_MS`. For background work that issues its own requests
 * outside this module (the SDK's replica sync).
 */
export function whenForegroundIdle(): Promise<void> {
  return new Promise<void>((resolve) => {
    idleWaiters.add(resolve);
    pump();
  });
}

/**
 * Count a SQL handle's calls as foreground. Wraps `query`, `execute` and
 * `batch`; everything else passes through.
 */
export function foregroundDatabase<T extends object>(database: T): T {
  return new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property !== "query" && property !== "execute" && property !== "batch") return value.bind(target);
      return (...args: unknown[]) => inForeground(() => Reflect.apply(value, target, args) as Promise<unknown>);
    },
  });
}

export function laneSnapshot(): { foreground: number; background: number; queued: number } {
  return { foreground: foregroundActive, background: backgroundActive, queued: backgroundQueue.length };
}

/** Tests only. */
export function resetLanesForTests(): void {
  clearTimeout(pumpTimer);
  pumpTimer = undefined;
  foregroundActive = 0;
  backgroundActive = 0;
  lastForegroundEnd = Number.NEGATIVE_INFINITY;
  backgroundQueue.length = 0;
  idleWaiters.clear();
  visibilityHooked = false;
  feedFirst = "undecided";
  clearTimeout(feedFirstCap);
  feedFirstCap = undefined;
  feedFirstWaiters.length = 0;
}
