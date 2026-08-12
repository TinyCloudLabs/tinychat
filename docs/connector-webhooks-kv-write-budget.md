# Backend-KV write-rate budget — connector webhooks (build task W0)

**Status:** analysis complete, decision recorded.
**Owner:** build task **W0** (`tinychat-webhooks-design.md` §11 Phase 0, §9.3).
**Date:** 2026-08-04.
**Gates:** §5.1's queue shape. This runs *before* the queue is built (W2), not after.
**Operator decisions this analysis is written against:**
`{ingestShape: "B", dropThreadsEntry: true, queueLocation: "backend-kv", anomalyInterimAccepted: true, cohort: "operator-only"}`.

Option A numbers are carried alongside Option B throughout, because §7.5 stages 3–4 are the
cohort the acceptance criterion asks about and A is what runs there. Where the two differ the
row says so.

---

## 0. The verdict, up front

**Steady state: yes — the queue can stay on the node.** At the recorded operator-only cohort
it consumes **~0.1 %** of the node's write budget. It stays under 10 % of that budget up to
roughly **100 consenting users under Option B** and roughly **33 under Option A**.

**Burst, as §5.1/§5.2 currently specify it: no.** One address's 50-delivery burst (§8.1's
`burst` mode, and a real Fireflies backlog flush) costs **50 serialized backend-KV writes ≈
100 seconds of the node's entire write throughput**, shared across every user and every app on
that node — and the webhook `202` ack sits on that path, so the last delivery of the burst
waits ~100 s for its response and Fireflies retries into the same queue.

**Recorded decision: ACCEPT backend-KV and keep §5.1's shape (one JSON array per address —
do NOT switch to §5.2's per-item keys), CONDITIONAL on three cheap additions** listed in §6.
Per-item keys make the burst strictly *worse* (§6.4); they are the multi-instance answer, not
the burst answer. The conditions are small edits inside tasks that already own the relevant
code (W2, W5) and they collapse the burst term by one to two orders of magnitude.

Trip-wires that void this verdict are in §8.

---

## 1. The ceiling

| | |
|---|---|
| Node write throughput | **~0.5 writes/sec** — SQLite single-writer, `max_connections=1` + WAL |
| Source | shared-eliza probe **2026-06-14**, cited in §5.4 / §9.3. One probe, not re-measured here |
| Shared across | **all users and all apps on that host** — not per-space, not per-app |
| Derived | 30 writes/min · **1,800 writes/hour** · **43,200 writes/day** |

Backend KV rides the same node as user-space writes.
`createBackendIdentity` builds its `TinyCloudNode` on `TINYCLOUD_HOST` with prefix
`ops.tinychat.backend` (`packages/server/src/identity.ts:44-58`) — a **different space, the
same host, the same single writer**. Every figure below lands in the one budget above.

**Allowance assumed for this feature: 10 % of the ceiling = 4,320 writes/day = 0.05 writes/sec.**
This is a choice, not a measurement — see §7 (excluded: the node's actual baseline
utilisation was never measured). Percentages of the *full* ceiling are given as well so a
different allowance can be read straight off the table.

---

## 2. Writes per unit of work

Counted as **durable node round trips that mutate state**. Reads are excluded (§7).

### 2.1 Per delivery

| Event | Backend-KV writes | Notes |
|---|---|---|
| Verified delivery (`202`) | **1** | the enqueue RMW on `webhooks/pending/{source}/{address}` (§5.1). A dedup hit (§5.3) still rewrites the array to update `receivedAt`, so it is 1 either way |
| — per-token rate bucket increment | 0 | `express-rate-limit` in-memory store (§4.4) |
| — token → address lookup | 0 | in-process cache; a miss is a **read** |
| — `deliveriesRateLimited` / `needsReauth` flag | 0–1 | on *transition* only; amortises to ~0 |
| Rejected delivery (`401` bad signature / unknown token) | **0** | format check → cache → HMAC, no KV mutation. This is the property that makes the route cheap to attack and expensive for nobody |
| `400 stale_delivery` / `400 invalid_meeting_id` | **0** | rejected before enqueue (§4.5) |

**Per verified delivery: 1 write. Per rejected delivery: 0.**

### 2.2 Per drained item

The queue is **one JSON array per address** (§5.1), so a drain pass reads it once, mutates it
in memory, and writes it back once. Item count does not multiply the write count.

| | Option B (selected) | Option A |
|---|---|---|
| Marginal **backend-KV** writes per item | **0** | **0** |
| Backend-KV writes per drain **pass** | **1–2** — the queue rewrite, plus a dead-letter write or a flag transition when one occurs | same |
| **User-space** writes per item | **0** — §4.7 is binding: the drain writes nothing to the user's space under B | **3** — `INSERT`/`UPDATE connector_meeting`, the KV body put, the `connector_state` counter update (§6.1 steps 3/4, 5, 7). Steps 1, 1b and 6 are reads |
| Delegation re-activation | **0 in the steady state** — under B the drain has no reason to hold the user's delegation at all, so `DelegationCache`'s 50-min TTL does not drive activations from delivery volume | up to **~2 node delegation-row writes per cache miss** (§2.3), bounded by the 50-min cache TTL rather than by item count |

The per-item marginal cost being **zero** is the single most important structural fact in this
budget, and it is a direct consequence of §5.1's array shape. It is why the answer to "can the
queue stay on the node" is yes at all, and why §6.4 declines per-item keys.

### 2.2a Per settlement (`POST /ack`) — READS, which this budget otherwise ignores

Writes are not the whole exposure. The companion bucket is **600 requests / 15 min / IP** and is
exempt from `globalLimiter`, so a route's per-call **round-trip count is the amplification factor**
one authenticated session can aim at the single-writer node every tenant shares — the same class
`connector-drain.ts`'s `forcedMinIntervalMs` closed for §5.4 trigger 3.

`/ack` read the config, the disabled marker, the purge ledger and the pending list to decide what
to settle, and then `pendingPayload` re-read all four to build the response: **10 round trips**,
five of them a pure duplicate, even for a 200-id batch that wrote nothing.

| Batch | Round trips now | Was |
|---|---|---|
| Settles ≥1 identity | **6** — config, marker, ledger, list, acknowledge, dead | 10 |
| Settles nothing (the lost-response retry; the shape an abusive caller sends) | **5** — no write lock is reached at all | 10 |

Two changes, both in `routes/connector-webhooks.ts`:

- the handler hands `pendingPayload` the state it already read (`PendingPrefetch`), including the
  post-settlement item list derived from the snapshot and the identities just removed. The one
  case that deliberately does NOT prefetch is an unreadable ledger: that answer must be
  recomputed, not passed on;
- only identities the **ledger-tested snapshot actually held** are settled. That is a correctness
  rule first (an identity absent from the snapshot was never tested against the purge ledger, so
  removing it sight-unseen is the one way a tombstoned item leaves the queue classified as
  ingested) and the zero-write short-circuit second.

A drain-style replay floor is **rejected** for this route: the legitimate client sends settlement
batches back to back (`targetedSync.acknowledgeSettled`), so replaying a previous snapshot instead
of settling would strand every batch after the first.

### 2.3 Per delegation activation (node round trips at S2e's cap)

`activatePortableDelegation` issues **one `node.useDelegation` per resource**, sequential after
B1b replaces `portable-delegation.ts:162-168`'s `Promise.all` with a loop (§3.5). Node
delegation rows are insert-only and never GC'd (§9.3), so each is treated here as a durable write.

| Path | Backend-KV writes | Node delegation writes | Total |
|---|---|---|---|
| Accept + activate, **B's actual shape** (1 sql + 1 kv, `threads/` entry dropped per §3.2 and the recorded `dropThreadsEntry: true`) | 1 — `DelegationStore.put` (`packages/server/src/delegation-store.ts:44`) | **2** | **3** |
| Accept + activate, **at S2e's cap** | 1 | **≤4** | **≤5** |
| Re-activation from the stored bundle on a `DelegationCache` miss (50-min TTL) | 0 | 2 (B) / 2 (A) per miss | 2 |
| Revocation teardown (Option C) | **2** — disabled marker, config delete. The delegation-remove write is gone: teardown no longer touches the app's unrelated backend delegation (`connector-webhooks-delegation-gate.md` §1a). Plus **2 deletes + 1 count read per REGISTERED source** (F006, below) | 0 | 2 + 3/source |
| Enable (§3.6 rule 6) | **2–4** — config write, plus the idempotent clear of pending / dead-letter / abort flag. A source SWITCH clears the OLD source instead: 2 deletes + 1 count read (F006) | 0 | 2–4 |

**F006 / F010 amendment (P1 residuals).** The teardown now clears **every registered source**, not
only `config.source`: a queue left by another source is invisible to every companion read (they
all follow `config.source`) and would sit in KV until the 14-day TTL. With today's one-entry
registry the teardown cost is unchanged; each additional registered source adds 2 deletes and 1
count read to an operation that happens once per disconnect. Against that, the teardown's
per-source `queue.list()` is **gone** — `ConnectorQueue.clear()` returns the count it deleted from
inside its own lock — so each source costs one round trip fewer than the old list-then-clear, the
sweep write a `list()` can trigger is no longer paid on a queue about to be deleted, and
`queueDropped` is exact rather than a lower bound.

**S2e's total-resource cap has no number in the design, and an unset bound in a
DoS control ships as Infinity** — the same failure §5.4 corrected for the Option-A ceilings.
§3.5 caps `bundle.delegations` at **N = 4** and justifies it as "sql + connectors-kv + two
secrets entries", which is exactly **4 resources**. **This analysis is computed at a total
resource cap of 4 and recommends S2e pin that literal**, with its test asserting `4`, not
"some cap". Without a pinned number the ≤4 round trips above are unbounded and this row of the
budget is void.

**Status: pinned.** `MAX_ACTIVATABLE_RESOURCES = 4` in `backend/src/portable-delegation.ts`, and
`portable-delegation.test.ts` asserts both the rejection message and the literal `4`, so raising
the cap fails a test that names this document. It shipped at `8` for one round — "4 covers the
widest legitimate shape, 8 leaves room" — which silently doubled the per-`PUT` node budget above
and voided the row it was computed for. Room is exactly the thing this cap is not supposed to
leave.

**Assumption flagged for measurement:** re-submitting an *already registered* delegation via
`useDelegation` is counted here as a full node write. If the node de-duplicates by CID it is a
read and the re-activation term collapses to zero. **B1b already runs ≥20 consecutive live
activations** — count node-side delegation rows before and after that probe and record the
delta. It is nearly free there and nowhere else.

---

## 3. Per consenting user per day

Delivery volume: §5.4 establishes that "a heavy real user records well under 10 meetings a
day", and §8.6 notes the operator's own Fireflies account holds 10 transcripts *in total*.
Fireflies fires both a `transcript` and a `summary` event per meeting (§5.6), so:

**D = 20 verified deliveries / user / day** — a deliberately generous heavy-user figure.

| Term | Option B | Option A |
|---|---|---|
| Enqueue (D × 1) | 20 | 20 |
| Drain-pass queue writes | ~20 | ~20 |
| Ack / flag transitions | ~2 | ~2 |
| Mint + renew (7-day TTL, renew at T-48 h ⇒ ≤1 per 5 days; §3.3) | ~0.6 | ~0.6 |
| Cache-miss re-activations (50-min `DelegationCache` TTL) | ~0 — the B drain does not use the delegation | up to **~58** (28.8 misses × 2 resources) |
| User-space writes (3 per ingested meeting × 10) | 0 — §4.7 binding | 30 |
| **Total writes / user / day** | **≈ 42** | **≈ 130** |

Under B the drain-pass term is the one soft number: it assumes ~1 pass per delivery after
§5.4's drain singleton coalesces. §6.2's "no-op drains write nothing" rule is what keeps the
5-minute timer (288 scans/day) from adding 288 writes/day/user on top.

---

## 4. Multiplied by cohort

Against **43,200 writes/day** node-wide.

| Cohort | Stage (§7.5) | B: writes/day | B: % of ceiling | A: writes/day | A: % of ceiling |
|---|---|---|---|---|---|
| **1** (operator only) | **1 — the recorded cohort** | **42** | **0.10 %** | 130 | 0.30 % |
| 5 | 2 (operator + 2–3 invited) | 210 | 0.49 % | 650 | 1.5 % |
| 25 | 3′ / early 4 | 1,050 | 2.4 % | 3,250 | 7.5 % |
| 50 | plausible stage 4 | 2,100 | 4.9 % | 6,500 | 15 % |
| 100 | stage 4 | 4,200 | 9.7 % | 13,000 | 30 % |
| 250 | stage 4 | 10,500 | 24 % | 32,500 | 75 % |
| 500 | stage 4 | 21,000 | 49 % | 65,000 | **150 % — over the hard ceiling** |

**Break-even at the 10 % allowance:** Option B **≈ 103 consenting users**; Option A **≈ 33**.
**Hard wall (100 % of the node, everything else starved):** B ≈ 1,030; A ≈ 330.

§7.5 stage 4 is "opt-in for all", and the cohort is controlled by the per-user opt-in itself
(no allowlist), so the size at stage 4 is *not knowable in advance*. The honest form of the
answer is the break-even numbers above plus §8's trip-wire, not a guessed headcount.

**Steady state is not the binding constraint at any plausible cohort. §5 is.**

---

## 5. Burst — the part that does not fit

### 5.1 One address's burst

§8.1's `burst` mode is 50 deliveries in <1 s; a real Fireflies backlog flush is the same shape
(§4.4: "Fireflies bursts are real — it fires a backlog at once").

The §5.2 per-address mutex serialises every enqueue RMW. So 50 deliveries =
**50 sequential writes**, and at ~0.5 writes/sec that is:

> **~100 seconds during which one address's enqueues consume the node's entire write
> throughput** — every other user's and every other app's writes queue behind it.

And the `202` ack is downstream of the durable enqueue, so the **last delivery of the burst
waits ~100 s for its response**. That is past any reasonable webhook client timeout; Fireflies
retries, and the retries enqueue behind the burst.

§5.4 already names this dynamic for *drains* ("one address's drain storm serializes in front of
every other user's writes") and fixes it with the drain singleton. **The same dynamic on the
enqueue path had no mitigation** — the singleton bounds drains, and nothing bounds enqueues.

### 5.2 The per-token rate limit is not a node-protective bound

§4.4's per-token bucket allows **60 verified deliveries / 5 min per token** = 0.2 writes/sec of
enqueue traffic **from a single address**, i.e. **40 % of the node's entire write budget, per
user, within policy**. Three addresses at their own limits exceed the node. The per-token bucket
is an abuse bound on one user; it is not, and must not be described as, a load bound on the node.

### 5.3 Value size, noted not budgeted

The RMW rewrites the whole array. A `PendingItem` serialises to roughly 200 bytes, so at §5.3's
200-item cap the queue value is **~40 kB rewritten per delivery**. That is bandwidth and node
work, not write *count*, and it is excluded from the arithmetic above (§7) — but it is a second
reason the burst path wants coalescing.

---

## 6. Conditions of acceptance

The decision in §0 is **conditional on these four**. Each is small and lands inside a task that
already owns the code.

### 6.1 Coalesced enqueue flush — **W2, required**

Behind the existing §5.2 per-address mutex, accumulate deliveries arriving within a short
window (**250 ms** suggested) in memory and write the queue value **once per window** instead of
once per delivery.

- 50 deliveries in <1 s ⇒ **1–4 writes instead of 50**; burst cost falls from ~100 s to ~2–8 s.
- **Send the `202` after the flush completes, not before**, so there is no durability
  regression: an acked delivery is still a durably enqueued delivery. Worst-case added ack
  latency ≈ window + one write ≈ **2.25 s**, comfortably inside any webhook timeout.
- A crash mid-window loses only *un-acked* deliveries, which is the same guarantee the design
  already gives (§4.6's retry semantics).
- Steady-state traffic (deliveries arriving seconds apart) sees no batching and no change.

### 6.2 A no-op drain writes nothing — **W5, required**

The 5-minute timer (§5.4 trigger 2) scans `webhooks/config/*` and drains addresses with
non-empty queues. Under Option B a pass over a queue whose items are all still pending changes
nothing. **Write the queue value only when the in-memory array actually differs.** Without this
rule, each user with a persistently non-empty queue costs up to **288 writes/day** of pure
no-op, which is ~7× the entire per-user budget in §3 and would move Option B's break-even from
~103 users to ~13.

### 6.3 Hoist the purge-ledger read out of the per-item loop — **W4/W5**

§6.1 step -1 reads `webhooks/purged/{source}/{address}` "for each item". It is a read, not a
write, so it does not appear in the tables above — but at a 200-item queue it is 200 node round
trips inside the process-global write lane, on the event loop of a public HTTP server, for a
value that changes only when the user themselves POSTs to §4.8's route. **Read it once per
drain pass.** Fail-closed semantics (§6.2: abort with `reason=ledger_unavailable`, burn no
attempts, quarantine, never assume empty) are unchanged — a single failed read still aborts the
whole pass, which is exactly the specified behaviour.

### 6.4 Do **not** adopt §5.2's per-item keys for this — **§5.1's shape stands**

`webhooks/pending/{source}/{address}/{meetingId}` + `list` is naturally concurrent-safe and
needs no mutex, and §10.3 correctly names it **the required shape if the backend ever runs more
than one instance**. It is the wrong answer to *this* problem:

- Burst gets **worse**: 50 deliveries = 50 writes with no coalescing possible (each key is
  distinct), where §6.1 gets the same burst down to 1–4.
- Per-drained-item cost goes from **0** marginal writes to **1 delete each**, so a 200-item
  drain becomes 200 writes instead of 1 — turning §2.2's most favourable number into the worst
  one in the budget.
- It adds a `list` per drain against the same node.

The §5.2 code comment stays exactly as specified — the per-item shape is documented as the
multi-instance migration, and this budget is explicitly void the day a second instance ships
(§8).

### 6.5 Pin S2e's total-resource cap at 4 — **S2e**

Stated in §2.3. Not a load mitigation on its own; without it the activation row of this budget
has no upper bound to compute.

---

## 7. What this analysis excludes

Named explicitly, per the W0 acceptance criterion. Every item below is *not* in the arithmetic.

1. **Reads.** ~0.5 writes/sec is a **write** ceiling. Token→address lookups on cache miss,
   the purge-ledger read, `webhooks/config/*` scans (288/day), §6.1's step-0 pre-probe and
   step-1/1b/6 probes and read-back verifies, and `GET /pending` are all excluded. Under
   SQLite + WAL readers do not block the writer, but they are still node round trips and CVM
   latency, and their volume is comparable to the write volume. **Not budgeted; not measured.**
2. **The node's existing baseline utilisation. This is the largest single uncertainty in the
   document.** The ceiling is shared with every other user and every other app on the host
   (tinychat v1 client sync, threads, eliza, anything else). This analysis claims a 10 %
   allowance of a budget whose current free headroom nobody has measured. If the node is
   already at 70 % utilisation, every percentage in §4 is against the wrong denominator.
3. **The ~0.5 writes/sec figure itself.** One probe, shared-eliza, 2026-06-14. Not re-derived,
   not re-measured, and not confirmed still current. Inherited from §5.4/§9.3 as given.
4. **v1 client-sync writes.** The existing feature's writes into user spaces are unchanged by
   this build and are counted in neither the numerator nor the baseline.
5. **Whether a repeat `useDelegation` of an already-registered delegation is a write.** Assumed
   yes (§2.3). B1b is asked to measure it.
6. **Fireflies retry storms** on the `503` path (§4.6) and provider-side backoff behaviour.
   Retries after an ack timeout are named as a *consequence* in §5.1 but are not modelled.
7. **Queue value size / bandwidth** (§5.3) — write *count* only.
8. **Option A's Fireflies-side quota**, which §5.4's two per-hour ceilings bound separately.
9. **Multi-instance behaviour.** Everything here assumes the single Bun process on a single CVM
   that §5.2 assumes. See §8.
10. **CVM-local disk as an alternative substrate** (§9.3's "a durable file inside the CVM plus a
    periodic KV snapshot"). Not evaluated — §6.1's coalescing makes it unnecessary at the
    cohorts in §4, and it is the fallback if §8's trip-wires fire.

---

## 8. Trip-wires — re-run this budget if any of these become true

- **Consenting cohort exceeds 50 under Option A, or 100 under Option B** (§4's break-even
  against a 10 % allowance).
- **The backend runs more than one instance.** This budget and §5.2's mutex both die at that
  moment; the per-item-key shape becomes mandatory and §6.4's reasoning inverts.
- **The ~0.5 writes/sec figure is re-measured and moves**, in either direction.
- **Option A ships to a cohort larger than operator-only** — A is 3× B per user and its
  re-activation term (§3) is the volatile one.
- **The 50-minute `DelegationCache` TTL is shortened**, which multiplies the Option-A
  re-activation term linearly.
- **Any of §6.1–§6.3 is dropped or weakened during the build.** §6.2 alone moves Option B's
  break-even from ~103 users to ~13.
