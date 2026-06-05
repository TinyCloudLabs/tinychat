# Fresh thread history on boot — implementation spec

Goal: when the app boots, thread history converges to server truth in the
background — the sidebar updates to the fresh list, and message histories are
prefetched so opening a thread is instant — WITHOUT regressing the instant
new-chat boot.

## Product requirements (in priority order)

1. **New chat is instantly usable.** Boot-to-welcome stays at current speed
   (~500ms after session restore; verified June 5 2026). The composer and
   welcome screen NEVER wait on any history work. This outranks everything
   below.
2. **The sidebar converges to server truth.** Today the SWR revalidate writes
   localStorage only — the rendered list stays stale until next reload. After
   this change, when the background revalidate returns a list that differs
   from what's rendered, the UI updates (subject to the refresh guardrails
   below).
3. **Message histories prefetch in the background, newest-first.** After the
   list revalidate completes, prefetch each thread's messages so clicking a
   thread renders instantly with fresh data. A thread opened before its
   prefetch completes uses the existing load path (HistorySkeleton) — that
   skeleton is acceptable and expected.
4. **Loading states live where the loading is.** Sidebar shows its sync
   shimmer while the list loads (already implemented); an unprefetched thread
   shows HistorySkeleton in the chat pane when opened. Never show a loading
   state over the new-chat welcome screen.

## Hard constraints (verified live; violating these reintroduces fixed bugs)

- **The node degrades badly under concurrent `/invoke`**: measured 5–20s per
  call at 7-way concurrency vs ~1.5–3s serial. The prefetch queue MUST be
  sequential (concurrency 1). Do not fire per-thread fetches in parallel.
- **Prefetch must wait for boot-critical reads to finish first**: do not
  enqueue anything until `listThreads`' background revalidate has resolved
  (it shares the schema batch via `ensureSchema`'s in-flight dedupe — reuse
  it, do not duplicate schema logic).
- **Persisted thread ids keep their `__LOCALID_` prefix forever.** Never use
  the prefix to infer "unsaved". Use `isKnownThreadId` (threadStore.ts) for
  membership checks.
- **`tcw.spaceId` is undefined on restored sessions.** Key anything
  per-account off `tcw.did ?? tcw.spaceId` (see `cacheKey` in threadStore.ts).
- **localStorage is ~5MB.** v1 prefetch cache is IN-MEMORY only (a
  `Map<threadId, ThreadDoc>` for the session). Do NOT write message payloads
  to localStorage.
- **No backend changes, no manifest changes, no new capabilities.**

## Design

### A. Prefetch module — `frontend/src/lib/historyPrefetch.ts` (NEW, pure + testable)

A sequential prefetch queue with:
- `enqueueAll(ids: string[])` — newest-first order (caller passes the sorted
  summaries' ids).
- `promote(id)` — user clicked a thread: move it to the front; if its fetch is
  already in flight, return that promise (dedupe by in-flight map — never
  double-fetch a thread).
- `get(id)` — returns the cached ThreadDoc if prefetched this session.
- `invalidate(id)` / `clear()` — called on append/rename/delete of a thread
  (mutators in threadStore) and on sign-out respectively.
- Injectable fetcher (`(id) => Promise<ThreadDoc | null>`) so the queue logic
  is unit-testable under `bun test` with a fake fetcher (no vite-only imports
  in this module).
- Concurrency: exactly 1 fetch in flight; the queue drains in order; promote
  reorders but never cancels an in-flight fetch.

### B. History adapter integration — `frontend/src/chat/runtime.tsx`

In `createHistoryAdapter.load()`:
1. Keep the existing `isKnownThreadId === false` short-circuit FIRST (instant
   new-chat is requirement #1).
2. Then check the prefetch cache: hit → return it (and trigger a background
   refresh of that one thread so an open thread is also fresh — reuse the
   queue's promote/dedupe so this never double-fetches).
3. Miss → `promote(threadId)` and await (existing skeleton shows).

Queue start: after `listThreads`' revalidate resolves (see C), enqueue all
known ids newest-first, excluding the active thread.

### C. Sidebar freshness — `frontend/src/lib/threadStore.ts` + runtime

- Add a subscription point to threadStore: `subscribeThreadIndex(cb)` invoked
  with the fresh summaries whenever a revalidate or mutator lands a list that
  differs (deep-compare by id+title+updatedAt) from the last delivered one.
- The runtime/adapter layer uses the assistant-ui-supported mechanism to
  refresh its thread list from this callback. RESEARCH REQUIRED: inspect the
  bundled runtime core (`frontend/node_modules/.vite/deps/chunk-CA26RFFZ.js`,
  `useRemoteThreadListRuntime` / `getLoadThreadsPromise` around line 7690) and
  the `@assistant-ui/react` docs/types for a list-refetch API. Prefer a
  supported API over remounting.
- **Refresh guardrails (MUST hold, in this order of precedence):**
  1. Never refresh while an assistant message stream is running.
  2. Never unmount/remount `AssistantRuntimeProvider` as the refresh
     mechanism if any in-session thread has unsent composer text or a
     running stream. (Full remount is the LAST resort and only when the
     active thread is a pristine new chat.)
  3. The active thread selection must survive a refresh.
  4. If no safe mechanism exists, queue the refresh until the next safe
     moment (stream ends) rather than skipping it.

### D. Cache invalidation correctness

- `appendMessage` / `renameThread` / `deleteThread` invalidate that thread's
  prefetch entry (delete also removes it from the queue).
- Sign-out clears the prefetch cache and stops the queue (`clear()`).
- The prefetch fetcher is the existing `getThread` — it already runs
  `ensureSchema` (memoized, deduped).

## Testing (must pass under `bun test`)

`frontend/src/lib/historyPrefetch.test.ts` (NEW):
- newest-first drain order; exactly one fetch in flight at any moment.
- `promote` moves an unqueued/queued id to front; returns the in-flight
  promise for an already-fetching id (no duplicate fetcher calls — assert
  fetcher call counts).
- `get` returns cached docs; `invalidate` evicts; `clear` empties and stops.
- A fetcher rejection does not wedge the queue (next item still drains; the
  failed id can be re-promoted).

## Precedence rules (when this spec conflicts with itself or with code)

1. Requirement #1 (instant new chat) beats every freshness requirement.
2. The concurrency-1 constraint beats prefetch speed. Never parallelize to
   "make it faster".
3. Refresh guardrails C.1–C.4 beat sidebar freshness — stale-but-stable wins
   over fresh-but-disruptive.
4. If the assistant-ui API research (C) finds no supported refetch mechanism
   and the guardrails can't be met, implement A+B+D fully and leave C as the
   documented gap — do NOT ship a guardrail-violating refresh.
5. Existing behaviors fixed on June 5 2026 (welcome-screen exemption for new
   threads in Thread.tsx, `relative` scroll container in ThreadList.tsx,
   `ensureSchema` did-keyed memo + in-flight dedupe in threadStore.ts) are
   load-bearing — do not revert or "simplify" them.
