# Connector webhooks — the delegation gate, and the option it selected

**Status: RESOLVED by product decision — Option C is SELECTED and is what this branch builds.
The backend holds no connector delegation, `backendDelegationPermissions()` stays at v1's
`threads/`-only scope, and the drafted Option-B consent flow is rejected and deleted.**

This is no longer a record of blocked work. The gate below was real, it was walked, and it came
out at **C**: the server receives signed webhook notifications and queues meeting ids only; the
browser fetches the meeting with the user's own Fireflies key and writes it to the user's own
space; the server settles the queue afterwards via `POST /api/connectors/webhooks/ack`. The
sections that follow are the **grounds** for that decision — kept in full, because "we chose the
option that needs no delegation" is only meaningful next to what the delegation would have cost.

The two grounds, in one line each:

1. **The `att` is not verified** (§1). Every authorization input on the delegation-accept path is
   an unsigned, rewritable top-level field, and neither §9.2's verifier (branch V) nor its
   no-ship branch (F) is built.
2. **V4 came back negative** (§1a). The activated handle's `spaceId` is an **echo of the unsigned
   input field**, not a resolution, so §9.2's (F)-compatible owner-binding control cannot be
   built either. R10's escape hatch applied, and its two exits were "ship Option C" or "hold
   Phase 2". The operator chose C.

This file is still **not** the S1 verdict artifact — writing that without running V1 is exactly
the failure §9.2 names. Under C nothing depends on S1, which is precisely the point of C.

## 1. The `att` is not verified (design §9.2, build task S1)

Every authorization input on the delegation-accept path is an **unsigned, rewritable top-level
field** of the serialized bundle:

| Field | Read by | Feeds |
|---|---|---|
| `resources` | `extractPortableResources` | coverage, the overbroad ceiling, the activation shape |
| `ownerAddress` / `chainId` / `delegateDID` / `delegatorDID` | `extractPortableDelegationIdentity` | `wrong_delegator`, `wrong_delegatee` |
| `expiry` | `portableDelegationExpiry` | the stored `expiresAt` |

§9.2 requires either **(V)** a `verifiedAttFromDelegation()` chokepoint that verifies the JWT
signature and chains `iss` to the session's primary DID, or **(F)** the explicit no-ship branch
plus a derived space-id equality control (which has its own hard prerequisite, task **V4**).

**Neither is built, and S1's verdict on V-vs-F has not been produced** — §9.2 makes S1 (and S2,
S2b, S2c) blocked until task **V1** captures a real `att` from the actual frontend mint path,
which needs a live session the build agent does not have. The consequence to state plainly:

> A stolen bundle can be rebound to another account. Mallory rewrites the unsigned
> `ownerAddress`/`delegatorDID`, POSTs it authenticated as Mallory, and the backend stores and
> activates a delegation into **Alice's** space. Node-side chain validation authorizes it,
> because the chain really is Alice → this backend DID.

**The SDK verifies nothing on this path either, and that is worth stating separately**, because
it is easy to assume node-side validation catches a fabricated bundle at accept time. It does
not: `deserializeDelegation` is `JSON.parse` (`@tinycloud/node-sdk` `dist/core.js:5298`) and
`useDelegation` compares the unsigned `delegateDID` against our own DID and then constructs a
`DelegatedAccess` **locally, with no node round trip** (`dist/core.js:5056`). A hand-written
bundle with no `att`, no signature and a made-up `delegationHeader`/`cid` therefore clears
identity, coverage, the overbroad ceiling and activation, is stored verbatim, and is reported
`status: "active"` by `GET /api/delegations/status`. Two consequences:

1. The accept-side ceiling bounds only what the bundle **declares**. A bundle can declare a
   policy-shaped `resources` array while the real signed chain grants something else entirely.
2. The "background sync is authorized" state shown to the user, and the drain's `needsReauth`
   signal, are unfalsifiable. **Interim disclosure, shipped:** every `status: "active"` response
   (`GET /api/delegations/status` and the accept route) now also carries `verified: false`, and
   `openapi.yaml` documents what it means. The enum is deliberately unchanged — adding an
   `unverified` member is a breaking contract change and belongs with S1's verification path, not
   ahead of it — but the limitation is at least machine-readable today instead of implied.

**What holds the line on the generic `/api/delegations` route** — the chat delegation, which
Option C leaves exactly as it found it (all in-process, none node-enforced):

- §3.2's scope floor — the policy is still v1's `threads/` grant, so nothing connectors-shaped
  is accepted at all (`400 insufficient_delegation`).
- §3.2a's least-privilege clamp — hardened in this pass: paths carrying a `.`, `..`, empty or
  backslash segment are refused rather than prefix-matched, the clamp emits the **policy's**
  space rather than the granted string, and a `tinycloud:`-prefixed space passes only when it is
  the delegation's own (`portable-delegation.ts`, `manifest.ts`). **The clamp is real — but it is
  an in-process bound on what THIS process invokes. It constrains neither what is stored nor what
  a holder of the stored bundle could invoke.**
- The same space-identity rule now runs on the **accept** side too (`foreignSpaceResources`,
  wired into `POST /api/delegations`), so the ceiling and the clamp agree about a resource naming
  another user's space instead of disagreeing about it. `isCapabilitySubset` compares a space by
  the segment after its last colon, so `tinycloud:0xVICTIM:applications` used to read as the
  policy's own `applications` and come back with an **empty** offending list.
- The bundle's own top-level **`spaceId`** is bound to the authenticated address
  (`foreignSpaceIdDelegations`, wired into `POST /api/delegations` **and** into
  `activatePortableDelegation` via `options.ownerAddress`, so the middleware and the drain gate
  re-run it on the STORED bundle). This closes a concrete hole: `activateResource` reads
  `delegation.spaceId` as the invocation target whenever the clamped resource carries no
  `tinycloud:` space — and since the clamp deliberately re-emits the policy's bare `applications`,
  it **always** does. The only rule that consulted `spaceId` compared it against the attacker's
  own resource string, an equality an attacker arranges by setting both sides to a victim's space
  (and which is skipped entirely when the resource declares no space). Three bundle shapes were
  accepted `200` and activated against a victim's space before this. **What it is not:** §9.2's
  owner-binding control. Every field it reads is still unsigned, so it does nothing about a
  bundle whose *signed chain* genuinely grants a third party's space — that is T9, and it stays
  open on §1a's escalation. **The bare-name seam is now closed too:** a `spaceId` that is not a
  parseable `tinycloud:pkh:eip155:{chainId}:{address}…` URI — including a bare space NAME like
  `applications` — is REFUSED rather than skipped. An audit confirmed the bare form was forwarded
  verbatim to `node.useDelegation`, and what the node resolves a nameless space against is exactly
  the guess this rule exists not to make. An **absent** `spaceId` is still accepted: there is then
  no attacker-chosen fallback target for `activateResource` to read.
- `activatePortableDelegation` can no longer fail open: the
  `delegations.length === 1 → node.useDelegation(...)` arm is **deleted** (S2b), so a zero
  projection throws instead of activating straight from the unsigned top level.
- Activations are **strictly sequential** (§9.3), and the bundle is capped at accept: 64 kB
  serialized, 4 delegations, **4** resources (S2e — the literal
  `docs/connector-webhooks-kv-write-budget.md` §2.3 computes its node-call row at; it shipped at 8
  for one round, which doubled the per-`PUT` budget and voided that row).
- The activated KV handle is routed through `createKvRouter` even for a single resource (W4), so
  a key outside the granted prefix throws in-process rather than relying on the node.
- Nothing consumes `req.delegatedAccess` — the delegation middleware is not wired (`index.ts`).

### 1a. V4 has now run, and its answer is ESCALATE

`test/connectors/fixtures/V4_VERDICT.json` (probe: `backend/src/__tests__/space-id-derivation.test.ts`).
R10 requires **both** halves to be yes before §9.2's (F)-branch owner-binding control may be built:

| Half | Answer |
|---|---|
| A deterministic in-process `did:pkh → spaceId` derivation | **YES** — `makePkhSpaceId(address, chainId, name)`, pure, no network, no session, address canonicalized |
| The activated `DelegatedAccess` exposes the space id it **resolved to** | **NO** — `get spaceId()` returns `this._delegation.spaceId`, the unsigned input field. It is an echo, not a resolution |

Half 2 is no, so per R10 the answer is the escape hatch and **not** a weaker probe. **Operator
decision required:** ship **Option C** (no delegation at all, §10.1/§10.2 option (c)), or **hold
Phase 2** until node-sdk exposes either a verifier (branch V) or a genuinely resolved space id.
Do not substitute the read-through-the-activated-handle check — §9.2 already records that that
half *succeeds for the attacker* in T9's rebinding attack.

**Operator decision, 2026-08-04: OPTION C.** The server receives signed webhook notifications
and queues meeting ids only. It never receives or reads the Fireflies API key, never writes
meeting content to the user's space, and holds **no connector delegation** —
`backendDelegationPermissions()` stays at the v1 non-connector scope and gains no connector SQL,
KV or secrets entry (`consent-scope.test.ts` guards this). Nothing in this feature mints, stores,
refreshes or removes a delegation. The drafted Option-B consent flow is rejected.

The dependency that Option-B shape left on the *generic* `/api/delegations` route is therefore
removed, in both directions:

| Was | Now |
|---|---|
| `POST /api/delegations` consulted the connector disabled marker: 409 `background_sync_disabled` while it stood, fail-closed 503 when it was unreadable (`isBackgroundSyncDisabled`) | No connector read at all. A Fireflies toggle is not an authorization input for chat. |
| An accepted delegation kicked the connector drain (`onDelegationAccepted`, §5.4 trigger 4) | Nothing. There is no server-side writer to drain into; the browser drains on the user's next usable visit. |
| `DELETE /api/connectors/webhooks/config` removed + evicted the app's backend delegation (steps 3-4 of §3.6 rule 5) | Teardown is marker → config/token delete → queue drop. The chat delegation is untouched. |

> **INGEST-CUTOVER(plan §11), 2026-08-10 — what this decision still covers, and what it no longer
> describes.** The 2026-08-04 decision above stands as written **for every address outside the
> backend-ingest dark cohort**, and plan §5.3 requires that path to stay byte-identical; nothing in
> the historical text above has been edited. For a **cohort** address
> (`CONNECTOR_BACKEND_INGEST_ENABLED` + the per-address allowlist) two of its halves are
> deliberately reversed and one survives:
>
> - *"never receives or reads the Fireflies API key"* → **reversed.** The backend holds a per-user
>   Fireflies OAuth credential (DECISIONS `V-a-branch: b1`), encrypted under
>   `CONNECTOR_CREDENTIAL_MASTER`. Fireflies publishes no data scope, so it is full-account; the
>   operator's signed blast-radius acceptance is what carries it.
> - *"never writes meeting content"* / *"there is no server-side writer to drain into"* →
>   **reversed for the server's own store.** The fetch worker fetches the meeting and keeps an
>   encrypted 90-day copy (`RETENTION_WINDOW_DAYS`, `services/content-store.ts`), and the delivery
>   route nudges it. The Now-column rationale in the table above is therefore *dated*, not current,
>   for cohort addresses — `backend/src/__tests__/delegations.test.ts` carries the rewritten
>   rationale.
> - *"holds no connector delegation"* → **survives, unchanged, for everyone.** Custody is
>   out-of-band (plan §6, §9 row 3), so no new permission is minted in any user's space and
>   `backendDelegationPermissions()` stays `threads/`-only. This is the half the cutover did *not*
>   touch, and `consent-scope.test.ts` still fails the build on any connector SQL/KV/secrets entry.
>
> What a cohort user is told is `BACKEND_INGEST_CONSENT_COPY`
> (`docs/connector-webhooks-backend-ingest-consent-copy.md`) — **not yet rendered**; see residual
> F011 and operator pre-rollout gate 4 in `docs/deployment.md`. The cohort enable is an operator
> action and has not been performed.

The design's §3.6 rule 4 and rule 5 steps 3-4 protected a connector delegation that does not
exist under C; what was left was an optional notification connector able to refuse or revoke the
delegation every authenticated TinyChat write depends on.
`backend/src/__tests__/connector-delegation-independence.test.ts` drives both routers against one
delegation store to pin that disabling Fireflies webhooks cannot break normal chat access.

The same removal applies to the **drain worker and its triggers** (`index.ts`,
`services/connector-drain.ts`, pinned by the `index.ts wiring` block in
`connector-drain.test.ts`):

| Was | Now |
|---|---|
| The drain was constructed with `delegations: createStoredDelegationGate(…)` — §3.6 rule 1's stored-record re-validation | No gate. Under C there is no connector delegation to re-validate, so the only record a gate could check is the app's unrelated **chat** delegation: an expired chat grant would silently stop the connector card and `needsReauth` would ask the user to re-grant something this feature never used. `DrainDelegationGate` stays an unwired Option-A seam. |
| §5.4 trigger 1 — a post-ack `onDelivery` drain kick after **every** delivery | Retired. Enqueueing the id is the whole server-side job; the kick ran a full pass (config, disabled marker, queue, purge ledger) to hand ids to a fire-and-forget promise nobody consumed. The route keeps the optional hook, unwired. |
| §5.4 trigger 2 — a five-minute **drain** over every configured address | Re-scoped to bounded queue maintenance: `startConnectorQueueMaintenanceTimer` calls `ConnectorQueue.sweep(source, address)`, which applies the TTL / dead-letter promotion and returns **counts, never ids**. No surfacing, so no ledger read. It earns its tick because an abandoned connector's queue is otherwise swept only when a delivery or a visit touches it, and the 14-day TTL is a retention promise. `CONNECTOR_DRAIN_INTERVAL_MS` keeps its name (deployed surface) and now paces this sweep. |
| §5.4 trigger 4 — a fresh-grant kick from `POST /api/delegations` | Forbidden (see the table above). |

§5.4 trigger 3 — the authenticated user-visit drain (`POST /api/connectors/webhooks/drain`) — is
therefore **the** processing trigger. Dropping the gate removes one authorization input and no
others: the durable disabled marker, the purge ledger and the per-item tombstone still gate every
surfaced id, because an id handed to the browser resurrects a purged meeting as surely as a write
would, and a genuinely blocked surface still answers with a visible `surfaceBlocked` rather than
an empty queue (`gateless drain (Option C construction)` in `connector-drain.test.ts`).

Also pending an operator decision: **what `GET /api/delegations/status` should report** for an
unverified record. It currently says `active`, which §9.2 flags as a state that is not actually
checkable. Changing it is a user-visible contract change, so it is named here rather than
guessed.

**Interim clamp on the TTL (part of S2c).** `expiresAt` is now `min(bundle.expiry, now + 7d)`
with **no** 365-day fallback (`routes/delegations.ts`). The full fix still requires the verified
`exp`; this only bounds a number whose source remains untrustworthy.

## 2. The SQL delegation scope escape (design §0a, artifact V3)

`test/connectors/fixtures/V3_VERDICT.json` ships `escapeReproduces: true`. While it stands, no
confinement claim may appear in the consent copy — and **dropping the grant does not license one
either**. Option C's copy says *no permission is granted*, which is a checkable fact about our own
policy; it never says what a permission cannot reach, which is the unprovable shape.
`backend/src/__tests__/consent-scope.test.ts` enforces both halves: the deny-list runs against the
shipped copy unconditionally, and the activated backend scope is asserted to carry **no** entry
under `xyz.tinycloud.tinychat/connectors` — no SQL entry, no secrets entry, nothing exportable.
The old ordering assertion (the consent surface must not exist while the policy is pre-widening)
is gone with the widening it was sequencing: there is no widening, so a Settings surface can land
without ever putting a grant in front of a user. What replaced it is stricter — the connectors
policy is not a tolerated alternative state any more, it is a build failure.

**Operator action outstanding — the verdict is not empirical.** The artifact records
`provenance: "static-analysis"` and `liveProbeRun: false`: its booleans were derived by reading
`tinycloud-node` source, not by observing a live node, while §11's V3 acceptance criterion
requires the exact resource strings sent and the node's responses for all six cases (authorize;
which database it resolves to; `DROP TABLE` on the other database; `SqlRequest::Export` under a
read-only grant; the DuckDB variant; the KV negative control). Running
`probe-sql-scope-escape.ts` needs an operator-controlled node with a scratch space carrying a
second database — it is not runnable from this branch. Until it runs, the direction is the safe
one (the deny-list is applied as if the escape reproduces) but the artifact must not be described
as a probe result, and `escapeReproduces` must not be flipped without a live re-run. Re-run after
every node upgrade.

## 2a. Accepted residuals (recorded, not fixed)

- **A captured signed delivery replays for up to 24 h.** Nothing binds a delivery to a nonce or a
  provider delivery id, so the only bounds are the ±24 h freshness window and the 60-per-5-min
  per-token success bucket; dedup happens inside `ConnectorQueue.enqueue`, i.e. after the batched
  read-modify-write, so each replay costs a queue RMW before the dedup probe answers (the drain
  kick that used to ride along with it is retired under Option C). Requires possession of a captured signed request. Closable only if the provider
  exposes a per-delivery id (then: an in-process seen-set keyed on `(token, delivery id,
  timestamp)`, answered 202 without touching the queue). Recorded next to T1.
- **`REVOCATION_RECHECK_ITEMS = 20` makes §3.6 rule 2's per-write guarantee a per-20-items
  guarantee for revocations that do not pass through this process** (a second instance, an
  operator or repair job writing the marker, a crashed teardown). The in-process abort flag gives
  the per-item guarantee locally; the durable re-read is the hoisted one. Under Option C a
  released item is a surfaced id and nothing else — the server writes nothing — so the exposure is
  20 ids handed to the user's own browser before the
  drain returns `aborted`. **The Option-A half is now closed by construction rather than by a
  reminder:** `removeOnRelease: true` selects `REVOCATION_RECHECK_ITEMS_SIDE_EFFECTING = 1`, so a
  release whose effects leave this process re-reads the durable marker per item unless a caller
  explicitly overrides `revocationRecheckItems`. A test pins it. The 20-item bound remains for the
  surface-only shape, where a missed revocation costs surfaced ids and nothing else.

## 3. What the selected product is, and what it would take to revisit it

**The selected product.** No step below is pending; this is what ships behind
`CONNECTOR_WEBHOOKS_ENABLED`:

1. The user pastes a delivery URL and a signing secret into the Fireflies dashboard. The secret is
   revealed exactly once, by the mint/rotate `POST`, and is never written to localStorage,
   connector SQL, analytics or a log line.
2. Fireflies signs a delivery; the public route HMAC-verifies the raw body, resolves the tenant
   from the URL token, and **queues the meeting id and nothing else**. A 202 is the whole
   server-side job — no fetch, no drain kick, no write.
3. On the user's next authenticated visit, `POST /api/connectors/webhooks/drain` surfaces the
   queued ids (still gated by the durable disabled marker, the purge ledger and the per-item
   tombstone). The browser reads the Fireflies key, fetches those exact ids, normalizes, and
   writes SQL + KV into the user's own space.
4. **Only after the space write succeeds**, the browser calls
   `POST /api/connectors/webhooks/ack` with the exact `(meetingId, kind)` identities. The server
   removes only those, idempotently. A failed item stays queued for the retry schedule or the
   14-day TTL.
5. The only background work is `startConnectorQueueMaintenanceTimer` — a bounded TTL /
   dead-letter sweep that returns counts, never ids.

**Backend delegations: none of it.** Nothing in this feature mints, stores, refreshes, widens or
removes a delegation. `backendDelegationPermissions()` gains no connector SQL, KV or secrets entry
under any circumstance, including on the recommendation of a future finding — a finding that
recommends one has misread the ingest shape, not found a gap.

**What it would take to revisit.** Only if a *product* need for server-side writing appears —
none exists today, and Option C's cost is one deferred visit, not a lost meeting:

1. Run **V1** (capture a real `att`) → then **S1**, and check in its V-vs-F verdict the way
   `V3_VERDICT.json` is checked in. **V4 has already run and is negative** (§1a), so branch (F)
   still has no compatible owner-binding control; only branch (V), a real signature verifier in
   node-sdk, reopens the question.
2. Build the verified projection and make it the single source for coverage, activation, identity
   **and** expiry.
3. Only then would widening `backendDelegationPermissions()` and a consent surface disclosing the
   grant be discussable — and §0a's SQL scope escape (§2) would still have to be fixed first,
   because a connectors-scoped SQL grant confines to nothing while `V3_VERDICT.json` stands.

Reopening any of this is an operator decision recorded here, not a build-time judgement call.
