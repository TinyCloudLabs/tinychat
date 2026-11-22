# Connector webhooks — P1 residual backend findings (F005–F010)

Record for the handoff's *"P1 — close or explicitly accept residual backend findings"*. The
untracked `audit-findings.json` is an input, not a verdict: every finding below was re-read
against the code as it stands before anything was changed. Scope is F005–F010. F001–F003 are the
delegation-gate blockers (operator/V-task territory, unchanged here) and F004 is latent under
Option C — `classifyDrainError` is unreachable while `surfaceOnly` cannot throw — and is left to
task A3, which is what would make it reachable.

Option C is unchanged by all of this: nothing below mints, stores, refreshes or widens a
delegation, and `backendDelegationPermissions()` gained no connector entry.

| Finding | Verdict | Where |
|---|---|---|
| F005 clear/coalescing-batch race | **Fixed** | `services/connector-queue.ts` — `PendingBatch.superseded`, `flushBatch()` |
| F006 source switch orphans the old queue | **Fixed** | `routes/connector-webhooks.ts` — `POST /config` switch arm, `DELETE /config` all-sources sweep |
| F007 `POST /purged` for a revoked address | **Accepted as-is, documented + pinned** | `routes/connector-webhooks.ts` guard comment; two tests |
| F008 source-switch path untested | **Fixed** (two-source harness) | `__tests__/connector-companions.test.ts` |
| F009 stop() / eviction / timestamp boundary | **Fixed** (coverage) | `__tests__/connector-drain.test.ts`, `__tests__/connector-webhooks.test.ts` |
| F010 `queueDropped` is list-then-clear | **Fixed** | `ConnectorQueue.clear()` returns `ClearResult` |

## F005 — an accepted batch must not outlive the clear that dropped it

`enqueue` accepts into a 250 ms in-memory batch and flushes it later *inside* the per-address
mutex. `clear` takes the same mutex, so a clear that ran first was undone by the flush that fired
after it — the re-enable that promises a clean slate came back with items in it. The window is
narrow and re-enable rotates the token, so legitimate provider traffic cannot hit it; a delivery
signed with the `_PREV` master can.

`clear()` now marks the batch superseded **synchronously with the call, before any await**.
`enqueue` is synchronous up to the point it joins a batch, so every delivery accepted before the
clear is superseded and every one accepted after it starts a fresh batch. A superseded batch
touches no storage and returns `dropped` — the status the pending-cap eviction already returns,
which the ingest route answers with a 202 byte-identical to a queued one (never an oracle for the
victim's queue state). The drop count is logged (`op=flush-superseded`): no silent caps.

## F006 — a switch, and a disconnect, must leave one clean state

Every companion read follows `config.source`, so a queue belonging to any other source is
invisible: it cannot be listed, drained, acknowledged or purged, and it sits in KV until the
14-day TTL.

- `POST /config` with a different registered source now clears the **old** source's queue before
  the re-mint, in the same order enable uses. It does not clear the new source — this is not an
  enable transition.
- `DELETE /config` now sweeps **every registered source**, plus the configured one even if that
  has since left the registry, instead of only `existing.source`. A crash between a switch's
  rotate and its clear therefore still converges on the next disconnect.

Cost is recorded in `connector-webhooks-kv-write-budget.md` §2.3: unchanged for today's
one-entry registry, +2 deletes and +1 count read per additional source per disconnect.

## F007 — a revoked address may still record a purge (accepted)

The early-return no-op covers *never enabled* (`config === null && marker === null`) and
deliberately stops there. A **revoked** address (config deleted, marker standing) keeps writing
its tombstone, because that is the second half of disconnect-with-delete: the browser tears the
connector down first, so nothing can arrive mid-delete, and only then reports the ids it purged.

Refusing the write would be fail-**open**, which is why the fail-closed philosophy lands on
"keep it": re-enable clears the queue but never the ledger (only `DELETE /purged` does), so a
dropped tombstone is a meeting that comes back on reconnect. The KV-growth concern the guard
exists for does not reach this arm either — a disabled marker exists only for an address that
enabled at least once. Pinned by two tests, one of which asserts the tombstone survives a later
re-enable.

## F009 — the three coverage gaps that were worth closing

Priority came from the finding itself: `stop()` first (process shutdown), then the bounded-map
eviction ("no silent caps"), then the timestamp boundary (security-relevant — `NaN` used to
disable the freshness window).

- A kick after `stop()` returns the empty aborted sentinel, reads nothing, settles nothing and
  leaves the items queued for the next boot; a **forced** kick is refused too; a traversal
  address still rejects rather than being handed a sentinel.
- `ConnectorDrainAbortFlags` evicts the oldest entry only when it must, logs `op=abort-evict`
  with the cap and no address, and does not evict on a re-abort or after a `clear()`.
- `parseDeliveryTimestamp(1e11)` is epoch **seconds** (year 5138, which the ±24 h window then
  rejects as stale); `1e11 + 1` is the first millis value; the numeric-string form takes the
  identical branch.

## F010 — `queueDropped` is now exact

`ConnectorQueue.clear()` counts the stored pending items inside the same lock that deletes them
and returns `{ cleared, superseded }`. The teardown sums those counts and no longer calls
`list()` first, which removes both the TOCTOU (anything enqueued between the list and the clear
was dropped without being counted) and a node read per source. The count deliberately excludes
superseded in-flight entries — `cleared` means "durable items deleted"; the superseded count is
logged separately.

## Tests

- `backend/src/__tests__/connector-queue.test.ts` — supersession, non-stickiness, exact counts,
  per-address isolation, audit line.
- `backend/src/__tests__/connector-companions.test.ts` — two-source registry harness: switch,
  switch-back, same-source control, all-sources teardown, no-list()-first, revoked-address purge.
- `backend/src/__tests__/connector-drain.test.ts` — `stop()`.
- `backend/src/__tests__/connector-webhooks.test.ts` — timestamp boundary, abort-flag eviction.

`SECOND_SOURCE = "granola"` exists only inside harness-supplied registries. It is not in
`CONNECTOR_REGISTRY`, and the `unknown_source` tests still depend on that.
