import { describe, expect, it } from "bun:test";

import { createPrefetchQueue, type ThreadFetcher } from "./historyPrefetch";
import type { ThreadDoc } from "./threadStore";

// ── Test helpers ─────────────────────────────────────────────────────

function makeDoc(id: string): ThreadDoc {
  return {
    id,
    title: id.toUpperCase(),
    model: "m",
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    messages: [],
  };
}

/** Let all pending microtasks + the queue's drain step settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A fetcher whose individual fetches resolve/reject only when the test says so.
 * Records the order ids were requested, and lets the test assert how many are
 * in flight at once (the queue must keep this at exactly 1).
 */
function manualFetcher() {
  const calls: string[] = [];
  const pending = new Map<
    string,
    { resolve: (doc: ThreadDoc | null) => void; reject: (err: unknown) => void }
  >();

  const fetcher: ThreadFetcher = (id) => {
    calls.push(id);
    return new Promise<ThreadDoc | null>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  return {
    fetcher,
    calls,
    pendingCount: () => pending.size,
    isPending: (id: string) => pending.has(id),
    resolve(id: string, doc: ThreadDoc | null = makeDoc(id)) {
      const d = pending.get(id);
      if (!d) throw new Error(`resolve: ${id} is not in flight`);
      pending.delete(id);
      d.resolve(doc);
    },
    reject(id: string, err: unknown = new Error(`fetch failed: ${id}`)) {
      const d = pending.get(id);
      if (!d) throw new Error(`reject: ${id} is not in flight`);
      pending.delete(id);
      d.reject(err);
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("createPrefetchQueue", () => {
  it("drains newest-first and keeps exactly one fetch in flight", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    // Caller passes ids newest-first.
    q.enqueueAll(["c", "b", "a"]);
    await tick();

    // Only the first id is fetched; the rest wait behind it.
    expect(m.calls).toEqual(["c"]);
    expect(m.pendingCount()).toBe(1);

    m.resolve("c");
    await tick();
    expect(m.calls).toEqual(["c", "b"]);
    expect(m.pendingCount()).toBe(1);

    m.resolve("b");
    await tick();
    expect(m.calls).toEqual(["c", "b", "a"]);
    expect(m.pendingCount()).toBe(1);

    m.resolve("a");
    await tick();
    expect(m.pendingCount()).toBe(0);
  });

  it("promote moves an unqueued id to the front", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    q.enqueueAll(["c", "b"]);
    await tick();
    expect(m.calls).toEqual(["c"]); // c in flight

    // Promote a brand-new id: it jumps ahead of the still-queued "b".
    void q.promote("a");
    m.resolve("c");
    await tick();
    expect(m.calls).toEqual(["c", "a"]);

    m.resolve("a");
    await tick();
    expect(m.calls).toEqual(["c", "a", "b"]);
  });

  it("promote moves an already-queued id to the front", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    q.enqueueAll(["c", "b", "a"]);
    await tick();
    expect(m.calls).toEqual(["c"]); // c in flight, b & a queued

    void q.promote("a"); // a was last; jump it ahead of b
    m.resolve("c");
    await tick();
    expect(m.calls).toEqual(["c", "a"]);
  });

  it("promote returns the in-flight promise without a second fetch", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    q.enqueueAll(["a"]);
    await tick();
    expect(m.calls).toEqual(["a"]); // a in flight

    // Promote the id that is already fetching — must NOT call the fetcher again.
    const promoted = q.promote("a");
    await tick();
    expect(m.calls).toEqual(["a"]);
    expect(m.calls.filter((c) => c === "a").length).toBe(1);

    const doc = makeDoc("a");
    m.resolve("a", doc);
    await expect(promoted).resolves.toEqual(doc);
  });

  it("get returns cached docs; invalidate evicts them", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    q.enqueueAll(["a"]);
    await tick();
    const doc = makeDoc("a");
    m.resolve("a", doc);
    await tick();

    expect(q.get("a")).toEqual(doc);

    q.invalidate("a");
    expect(q.get("a")).toBeUndefined();
  });

  it("invalidate drops a queued id so it is never fetched", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    q.enqueueAll(["c", "b", "a"]);
    await tick();
    expect(m.calls).toEqual(["c"]); // c in flight; b, a queued

    q.invalidate("b"); // remove the queued one
    m.resolve("c");
    await tick();
    m.resolve("a");
    await tick();

    expect(m.calls).toEqual(["c", "a"]); // b was never fetched
  });

  it("clear empties the cache and stops the queue", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    q.enqueueAll(["c", "b", "a"]);
    await tick();
    expect(m.calls).toEqual(["c"]); // c in flight

    q.clear();
    m.resolve("c"); // the in-flight fetch settles after clear
    await tick();

    // Nothing else drains, and the settled fetch did not repopulate the cache.
    expect(m.calls).toEqual(["c"]);
    expect(q.get("c")).toBeUndefined();
  });

  it("a fetcher rejection does not wedge the queue; the id can be re-promoted", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    q.enqueueAll(["c", "b"]);
    await tick();
    expect(m.calls).toEqual(["c"]);

    // Reject the in-flight fetch — the queue must keep draining.
    m.reject("c");
    await tick();
    expect(m.calls).toEqual(["c", "b"]);

    m.resolve("b");
    await tick();

    // The failed id can be re-promoted and fetched again.
    const retried = q.promote("c");
    await tick();
    expect(m.calls).toEqual(["c", "b", "c"]);

    const doc = makeDoc("c");
    m.resolve("c", doc);
    await expect(retried).resolves.toEqual(doc);
    expect(q.get("c")).toEqual(doc);
  });

  it("promote of a cached id returns instantly and refreshes in the background", async () => {
    const m = manualFetcher();
    const q = createPrefetchQueue(m.fetcher);

    q.enqueueAll(["a"]);
    await tick();
    const first = makeDoc("a");
    m.resolve("a", first);
    await tick();
    expect(q.get("a")).toEqual(first);

    // Cached promote resolves to the cached doc immediately…
    await expect(q.promote("a")).resolves.toEqual(first);
    // …and schedules exactly one background refresh fetch.
    await tick();
    expect(m.calls).toEqual(["a", "a"]);
    expect(m.pendingCount()).toBe(1);
  });
});
