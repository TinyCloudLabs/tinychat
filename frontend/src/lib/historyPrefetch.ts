import type { ThreadDoc } from "./threadStore";
import { inBackground, type Lane } from "./localFirst/requestLanes";

// ── History copy: background prefetch queue + the device's copy ──────
//
// After boot converges the thread list, opening a thread should be instant,
// so each thread's full message doc is copied in the background into an
// in-memory cache, and (when a device copy is attached) into IndexedDB so the
// next open starts with every thread already local. Clicking a thread renders
// from the copy and refreshes it.
//
// HARD CONSTRAINTS (verified live June 5 2026 — violating these reintroduces
// fixed bugs):
//   - The node degrades badly under concurrent `/invoke` (5–20s at 7-way
//     concurrency vs ~1.5–3s serial). So the background copy is STRICTLY
//     SEQUENTIAL: at most one background fetch is ever in flight, and it runs
//     in the background request lane (behind every foreground request, never
//     while the tab is hidden). Never parallelize "to make it faster".
//   - The user's own request is never queued behind the copy: `promote` of a
//     thread that is not local fetches it at once (foreground), and the copy
//     waits until that fetch is done.
//   - Nothing here touches localStorage (payloads can be large; ~5MB limit).
//
// The fetcher is injected so this module is pure and unit-testable under
// `bun test` (no vite-only imports). The app wires the real `getThread`
// fetcher via `setPrefetchFetcher`.

/** Fetches a thread's full doc by id in the given lane. Resolves null when the thread is empty. */
export type ThreadFetcher = (id: string, lane: Lane) => Promise<ThreadDoc | null>;

/** The device's copy of thread docs, written as fetches land and dropped on invalidation. */
export interface ThreadCopyStore {
  save(doc: ThreadDoc): void;
  remove(id: string): void;
}

export interface PrefetchQueue {
  /**
   * Enqueue ids for background prefetch, in the given order (the caller passes
   * them newest-first). Ids already in flight or already queued are skipped,
   * and so are cached ids, unless `updatedAt` (the thread list's) says the
   * cached doc is out of date: then it is copied again and not served until
   * it is. Starts draining if idle.
   */
  enqueueAll(ids: string[], updatedAt?: ReadonlyMap<string, string>): void;
  /**
   * The user opened a thread. Cached: resolves with the cached doc at once and
   * refreshes it. Not cached: fetches it now in the foreground lane (not
   * behind the queue) and resolves with the doc (or null). If a fetch for this
   * id is already in flight, returns that same promise (never double-fetches).
   * Never cancels a background fetch already running.
   */
  promote(id: string): Promise<ThreadDoc | null>;
  /** The cached doc for this id, if copied this session or loaded from the device copy, else undefined. */
  get(id: string): ThreadDoc | undefined;
  /** Seed the cache from the device copy (does not replace newer docs already fetched). */
  hydrate(docs: Iterable<ThreadDoc>): void;
  /**
   * Evict this id from the cache and drop it from the pending queue. If a fetch
   * for it is in flight, its result will not be cached. Called when a thread's
   * stored doc changes (append/rename/delete/import/model).
   */
  invalidate(id: string): void;
  /** Empty the cache + queue and stop draining (sign-out). */
  clear(): void;
}

/**
 * Create a prefetch queue over the given fetcher: one background fetch at a
 * time, foreground fetches for opened threads at once. Exported for unit
 * tests; the app uses the `historyPrefetch` singleton below.
 */
export function createPrefetchQueue(fetcher: ThreadFetcher, copy?: () => ThreadCopyStore | null): PrefetchQueue {
  const cache = new Map<string, ThreadDoc>();
  const inFlight = new Map<string, Promise<ThreadDoc | null>>();
  // Background fetches that have actually been sent (not just waiting for their lane turn).
  const sent = new Set<string>();
  // Foreground fetches (opened threads) in flight; the background drain waits for them.
  const foreground = new Set<Promise<ThreadDoc | null>>();
  // The thread list's updatedAt per id: a cached doc older than this is not served.
  const listed = new Map<string, string>();
  // Ids invalidated this session: a device copy read before the write must not come back.
  const invalidated = new Set<string>();
  // Ids invalidated WHILE their fetch was in flight: their result must not be
  // written to the cache when it lands.
  const staleInFlight = new Set<string>();
  let queue: string[] = [];
  let active = false;
  // Bumped by clear() so an in-flight fetch from a prior session never writes
  // its result into the post-clear cache.
  let generation = 0;

  function fresh(id: string): ThreadDoc | undefined {
    const doc = cache.get(id);
    const known = listed.get(id);
    return doc && (known === undefined || known === doc.updatedAt) ? doc : undefined;
  }

  function runFetch(id: string, lane: Lane): Promise<ThreadDoc | null> {
    const myGen = generation;
    staleInFlight.delete(id);
    const self: { p?: Promise<ThreadDoc | null> } = {};
    const p: Promise<ThreadDoc | null> = (async () => {
      try {
        let doc: ThreadDoc | null;
        if (lane === "foreground") doc = await fetcher(id, lane);
        else {
          await Promise.resolve(); // `p` is registered in inFlight before its turn can start
          const result = await inBackground(async () => {
            // The user opened it while this waited for its turn: that fetch owns it now.
            if (inFlight.get(id) !== self.p) return { superseded: true as const };
            sent.add(id);
            return { superseded: false as const, doc: await fetcher(id, lane) };
          });
          if (result.superseded) return fresh(id) ?? null;
          doc = result.doc;
        }
        if (generation === myGen && doc && !staleInFlight.has(id)) {
          cache.set(id, doc);
          copy?.()?.save(doc);
        }
        return doc;
      } finally {
        if (inFlight.get(id) === self.p) {
          inFlight.delete(id);
          staleInFlight.delete(id);
        }
        sent.delete(id);
      }
    })();
    self.p = p;
    inFlight.set(id, p);
    if (lane === "foreground") {
      foreground.add(p);
      void p.catch(() => undefined).finally(() => foreground.delete(p));
    }
    return p;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      // The user's own fetch goes first: wait until it has landed.
      while (foreground.size > 0) await Promise.allSettled([...foreground]);
      const id = queue.shift();
      if (id === undefined) break;
      // Already satisfied — unless the thread list says it changed.
      if (fresh(id)) continue;
      try {
        await (inFlight.get(id) ?? runFetch(id, "background"));
      } catch {
        // A fetcher rejection must not wedge the queue: swallow and keep
        // draining. The id can be re-promoted.
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
    enqueueAll(ids: string[], updatedAt?: ReadonlyMap<string, string>): void {
      for (const [id, at] of updatedAt ?? []) listed.set(id, at);
      for (const id of ids) {
        if (inFlight.has(id) || queue.includes(id) || fresh(id)) continue;
        queue.push(id);
      }
      ensureDraining();
    },

    promote(id: string): Promise<ThreadDoc | null> {
      queue = queue.filter((q) => q !== id);
      const existing = inFlight.get(id);
      // Only a fetch already on the wire is shared; one still waiting for its
      // background turn is replaced by a foreground fetch now.
      const running = existing && (foreground.has(existing) || sent.has(id)) ? existing : undefined;
      const cached = fresh(id);
      if (cached) {
        // Return the copy now; refresh it so an open thread converges to fresh data.
        if (!running) void runFetch(id, "foreground").catch(() => undefined);
        return Promise.resolve(cached);
      }
      if (running) return running;
      return runFetch(id, "foreground").catch(() => null);
    },

    get(id: string): ThreadDoc | undefined {
      return fresh(id);
    },

    hydrate(docs: Iterable<ThreadDoc>): void {
      for (const doc of docs) {
        if (!cache.has(doc.id) && !inFlight.has(doc.id) && !invalidated.has(doc.id)) cache.set(doc.id, doc);
      }
      // Copies the list already showed to be out of date are copied again.
      ensureDraining();
    },

    invalidate(id: string): void {
      cache.delete(id);
      invalidated.add(id);
      copy?.()?.remove(id);
      queue = queue.filter((q) => q !== id);
      if (inFlight.has(id)) staleInFlight.add(id);
    },

    clear(): void {
      generation++;
      queue = [];
      cache.clear();
      inFlight.clear();
      sent.clear();
      foreground.clear();
      listed.clear();
      invalidated.clear();
      staleInFlight.clear();
      // Any in-flight fetch still settles, but its generation no longer matches
      // so it won't repopulate the cache. The drain loop sees an empty queue
      // and exits; a later enqueue/promote restarts it.
    },
  };
}

// ── App singleton (late-bound fetcher and device copy) ───────────────
//
// The real fetcher closes over the active `tcw`, which isn't known at module
// load. The runtime sets it via `setPrefetchFetcher` once the session exists;
// threadStore mutators reach the same queue to invalidate stale entries.

let boundFetcher: ThreadFetcher = async () => null;
let boundCopy: ThreadCopyStore | null = null;

/** Point the singleton queue at the real `getThread` fetcher (and this account's device copy) for this session. */
export function setPrefetchFetcher(fetcher: ThreadFetcher, copy: ThreadCopyStore | null = null): void {
  boundFetcher = fetcher;
  boundCopy = copy;
}

export const historyPrefetch: PrefetchQueue = createPrefetchQueue(
  (id, lane) => boundFetcher(id, lane),
  () => boundCopy,
);
