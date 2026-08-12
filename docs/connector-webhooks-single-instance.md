# Backend ingest runs on ONE instance — the D4 constraint, written down

**Decision:** `D4: single-instance` (backend-ingest DECISIONS, 2026-08-10 — plan §2/§8.1 W9,
delta item 11). This file is the "documented constraint" half of that item; the code half is
`backend/src/services/ingest-instance.ts` plus W3's per-process worker seat in
`backend/src/services/fetch-worker.ts`.

Read this **before** scaling the backend to two replicas. Nothing here is a preference.

## Why one

Backend ingest reuses the shipped connector queue, and that queue's mutual exclusion is
*per-address, in-process* — a JS mutex — over a *per-instance* storage lane. Neither crosses a
process boundary. So a second instance is not more throughput; it is two consumers interleaving
read-modify-writes on the same pending array (findings §2.2, §2.5):

- **Lost enqueues.** Two RMWs over one array: last writer wins, and the other delivery is gone —
  a delivery the provider already got a 202 for.
- **Double fetches.** Both instances claim the same `pending` item, so one meeting costs two
  credentialed upstream calls against a shared Fireflies budget.
- **The write budget, spent twice.** The ~0.5 writes/sec single-writer ceiling is shared by every
  user and app on the node; a second instance voids the projection the substrate decision rests on.

## What the guard actually does

`IngestInstanceGuard` takes a **lease** in the backend's own KV at
`webhooks/ingest/instance-lease`:

```json
{ "instanceId": "…", "claimedAt": "…", "heartbeatAt": "…" }
```

- The holder renews every `INSTANCE_HEARTBEAT_MS` (30 s); the lease expires after
  `INSTANCE_LEASE_TTL_MS` (90 s) without a heartbeat, so a hard crash costs at most one TTL of
  ingest downtime rather than a permanent outage.
- A second instance that finds a live lease **refuses the seat and stays provably inert**: it
  serves HTTP normally, starts no fetch worker, registers no delivery nudge, and consumes nothing.
- A clean shutdown releases the lease, so a rolling deploy hands over immediately.
- `CONNECTOR_INGEST_INSTANCE_ID` optionally pins the identity. Set it when the *same* logical
  instance redeploys and you want it to reclaim its own lease without waiting out the TTL. Unset,
  each process generates a random id.
- Nothing tenant-shaped is in the record or in its log lines: an instance id, two timestamps.

**Fail closed.** A lease that cannot be read, parsed or written **refuses**. "I could not tell who
holds it" never resolves to "nobody does" — that reading is exactly how the second consumer starts
silently.

## What the guard is NOT — read this part

TinyCloud KV offers no **compare-and-set** (CAS). The claim is therefore
read → decide → write → re-read-and-confirm (`lost_race` when the confirming read does not see
us). That closes the reachable window — two boots seconds apart, a redeploy overlapping an old
container — and it does **not** close a true simultaneous-write race in the same millisecond.

So: this is a **detector and a declaration**, not a distributed mutex. It makes a second instance
loud and inert in every case an operator will actually create. It is not a licence to run two.

## Lifting the constraint (D4 = multi-instance)

Raising the replica count is not a config change; it is a design change, and it is out of scope
for this build:

1. Move the pending queue off the shared single-writer node onto the D3 off-node substrate.
2. Replace the array-shaped queue with **per-item keys** and real row locking / conditional
   updates (`SELECT … FOR UPDATE`, or a CAS-capable store).
3. Re-run delta item 11's acceptance test in its *multi-instance* form: two workers over one
   shared queue, zero loss and zero duplication.
4. Re-decide D4 in the decision record (an edit after launch is a re-decision; relaunch the
   decisions gate).

Until all four are done, **one instance**.

## Operating notes

- Steady state, one line: `[connector-ingest] op=ingest-instance state=holder`.
- A refused instance logs `op=instance-lease result=refused reason=held_by_other` and then
  `state=inert` — repeated at most once per TTL, so a permanently-refused replica is visible in
  the log without flooding it.
- `reason=lease_unreadable` / `lease_unparseable` means ingest is **stopped**, not degraded. That
  is deliberate; the alert is the point.
- If ingest is silent after a crash, expect up to 90 s of takeover delay before another instance
  claims the seat.
