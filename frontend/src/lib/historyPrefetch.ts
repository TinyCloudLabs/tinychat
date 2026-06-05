import type { ThreadDoc } from "./threadStore";

// ── Background history prefetch queue ────────────────────────────────
//
// After boot converges the thread list, we want opening a thread to be
// instant — so we prefetch each thread's full message doc in the background
// and keep it in an in-memory session cache. Clicking a thread then renders
// from cache instead of paying a ~2s SQL round-trip.
//
// HARD CONSTRAINTS (verified live June 5 2026 — violating these reintroduces
// fixed bugs):
//   - The node degrades badly under concurrent `/invoke` (5–20s at 7-way
//     concurrency vs ~1.5–3s serial). So this queue is STRICTLY SEQUENTIAL:
//     exactly one fetch is ever in flight. Never parallelize "to make it
//     faster" — that is the regression this guards against.
//   - The cache is IN-MEMORY ONLY (message payloads can be large and
//     localStorage is ~5MB). Nothing here touches localStorage.
//
// The fetcher is injected so this module is pure and unit-testable under
// `bun test` (no vite-only imports). The app wires the real `getThread`
// fetcher via `setPrefetchFetcher`.

/** Fetches a thread's full doc by id. Resolves null when the thread is empty. */
export type ThreadFetcher = (id: string) => Promise<ThreadDoc | null>;

export interface PrefetchQueue {
  /**
   * Enqueue ids for background prefetch, in the given order (the caller passes
   * them newest-first). Ids already cached, already in flight, or already
   * queued are skipped — never double-fetched. Starts draining if idle.
   */
  enqueueAll(ids: string[]): void;
  /**
   * The user clicked a thread: move it to the FRONT of the queue and fetch it
   * next. If a fetch for this id is already in flight, returns that same
   * promise (in-flight dedupe — never double-fetches). Resolves with the doc
   * (or null) once fetched. Reorders the queue but never cancels the fetch
   * already running.
   */
  promote(id: string): Promise<ThreadDoc | null>;
  /** The cached doc for this id if it was prefetched this session, else undefined. */
  get(id: string): ThreadDoc | undefined;
  /**
   * Evict this id from the cache and drop it from the pending queue. If a fetch
   * for it is in flight, its result will not be cached. Called when a thread's
   * stored doc changes (append/rename/delete/import/model).
   */
  invalidate(id: string): void;
  /** Empty the cache + queue and stop draining (sign-out). */
  clear(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Create a sequential (concurrency-1) prefetch queue over the given fetcher.
 * Exported for unit tests; the app uses the `historyPrefetch` singleton below.
 */
export function createPrefetchQueue(fetcher: ThreadFetcher): PrefetchQueue {
  const cache = new Map<string, ThreadDoc>();
  const inFlight = new Map<string, Promise<ThreadDoc | null>>();
  // Waiters registered by `promote` for an id that is queued but not yet
  // fetching — resolved when its fetch completes.
  const waiters = new Map<string, Array<(doc: ThreadDoc | null) => void>>();
  // Ids invalidated WHILE their fetch was in flight: their result must not be
  // written to the cache when it lands.
  const staleInFlight = new Set<string>();
  // Ids that must be re-fetched even though a cached copy exists — a `promote`
  // on an open thread that wants fresh data (B.2). Cleared once refetched.
  const forceRefresh = new Set<string>();
  let queue: string[] = [];
  let active = false;
  // Bumped by clear() so an in-flight fetch from a prior session never writes
  // its result into the post-clear cache.
  let generation = 0;

  function resolveWaiters(id: string, doc: ThreadDoc | null): void {
    const list = waiters.get(id);
    if (!list) return;
    waiters.delete(id);
    for (const resolve of list) resolve(doc);
  }

  function addWaiter(id: string, resolve: (doc: ThreadDoc | null) => void): void {
    const list = waiters.get(id);
    if (list) list.push(resolve);
    else waiters.set(id, [resolve]);
  }

  function runFetch(id: string): Promise<ThreadDoc | null> {
    const myGen = generation;
    staleInFlight.delete(id);
    forceRefresh.delete(id);
    const p = (async () => {
      try {
        const doc = await fetcher(id);
        if (generation === myGen && doc && !staleInFlight.has(id)) {
          cache.set(id, doc);
        }
        return doc;
      } finally {
        // Concurrency is 1, so this id's entry is the only one — safe to drop
        // unconditionally once the fetch settles.
        inFlight.delete(id);
        staleInFlight.delete(id);
      }
    })();
    inFlight.set(id, p);
    return p;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const id = queue.shift() as string;
      // Already satisfied — unless a promote asked for a forced refresh of an
      // open thread (B.2), in which case fall through and re-fetch.
      if (cache.has(id) && !forceRefresh.has(id)) {
        resolveWaiters(id, cache.get(id) as ThreadDoc);
        continue;
      }
      const existing = inFlight.get(id);
      try {
        const doc = await (existing ?? runFetch(id));
        resolveWaiters(id, doc);
      } catch {
        // A fetcher rejection must not wedge the queue: swallow, resolve any
        // waiters with null, and keep draining. The id can be re-promoted.
        resolveWaiters(id, null);
      }
    }
    active = false;
  }

  function ensureDraining(): void {
    if (active) return;
    if (queue.length === 0) return;
    active = true;
    void drain();
  }

  return {
    enqueueAll(ids: string[]): void {
      for (const id of ids) {
        if (cache.has(id) || inFlight.has(id) || queue.includes(id)) continue;
        queue.push(id);
      }
      ensureDraining();
    },

    promote(id: string): Promise<ThreadDoc | null> {
      // Already fetched this session.
      const cached = cache.get(id);
      if (cached) {
        // Re-fetch in the background so an open thread converges to fresh data,
        // but only if one isn't already running (dedupe). Return the cached
        // doc immediately either way.
        if (!inFlight.has(id)) {
          forceRefresh.add(id);
          queue = [id, ...queue.filter((q) => q !== id)];
          ensureDraining();
        }
        return Promise.resolve(cached);
      }
      // A fetch is already in flight — hand back the same promise.
      const existing = inFlight.get(id);
      if (existing) return existing;
      // Move to the front and fetch next; resolve when it lands.
      queue = [id, ...queue.filter((q) => q !== id)];
      const d = deferred<ThreadDoc | null>();
      addWaiter(id, d.resolve);
      ensureDraining();
      return d.promise;
    },

    get(id: string): ThreadDoc | undefined {
      return cache.get(id);
    },

    invalidate(id: string): void {
      cache.delete(id);
      queue = queue.filter((q) => q !== id);
      forceRefresh.delete(id);
      if (inFlight.has(id)) staleInFlight.add(id);
    },

    clear(): void {
      generation++;
      queue = [];
      cache.clear();
      inFlight.clear();
      staleInFlight.clear();
      forceRefresh.clear();
      for (const list of waiters.values()) {
        for (const resolve of list) resolve(null);
      }
      waiters.clear();
      // Any in-flight fetch still settles, but its generation no longer matches
      // so it won't repopulate the cache. The drain loop sees an empty queue
      // and exits; a later enqueue/promote restarts it.
    },
  };
}

// ── App singleton (late-bound fetcher) ───────────────────────────────
//
// The real fetcher closes over the active `tcw`, which isn't known at module
// load. The runtime sets it via `setPrefetchFetcher` once the session exists;
// threadStore mutators reach the same queue to invalidate stale entries.

let boundFetcher: ThreadFetcher = async () => null;

/** Point the singleton queue at the real `getThread` fetcher for this session. */
export function setPrefetchFetcher(fetcher: ThreadFetcher): void {
  boundFetcher = fetcher;
}

export const historyPrefetch: PrefetchQueue = createPrefetchQueue((id) =>
  boundFetcher(id),
);
