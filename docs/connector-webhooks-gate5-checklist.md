# Gate 5 — provider + surface hardening: the checklist

Gate 5's exit artifact (backend-ingest plan §4, §10; work package W9). Plan §4 requires every
gate to exit with a *written artifact, not a feeling*, so each §10 item below carries a verdict
and a citation. Every path cited here is asserted to exist by
`backend/src/__tests__/connector-gate5-hardening.test.ts` — a checklist pointing at a deleted test
is worse than no checklist.

Scope note: this gate is about the **provider-facing surface**. The multi-tenant/durability delta
is Gate 4's (`§8.2` items 1–12); the consent rewrite is Gate 6's.

---

## 1. 2xx < 10 s proven under a stubbed slow upstream — **DONE**

Fireflies drops a delivery that does not get a 2xx quickly; Listen's live bug is a sync-before-ack
that blocked the response for minutes on 429 retries (§9 anti-pattern 2). Two tests, deliberately
at different layers:

- `backend/src/__tests__/connector-backend-ingest.test.ts` — `[delta-07]`: a 30 s **nudge** does
  not delay the 202. The seam itself cannot couple.
- `backend/src/__tests__/connector-gate5-hardening.test.ts` — end to end with the **real fetch
  worker** registered and the Fireflies fetcher stubbed at 30 s: the 202 lands in well under 10 s,
  the item is already durably queued when it does, and the upstream fetch is provably still open.

The 202 waits on the durable enqueue and on nothing to its right (plan §5.2). The burst half of
the same window — a same-address 50-delivery burst still acking < 10 s each — is `[delta-08]` in
`backend/src/__tests__/connector-backend-ingest.test.ts`.

## 2. `X-Hub-Signature` HMAC-SHA256 over the RAW body — **DONE (regression held)**

Shipped in `backend/src/services/webhook-verify.ts`; the regression suite stays green in this
build: `backend/src/__tests__/webhook-verify.test.ts`. `JSON.parse` runs strictly **after** verify
— the route reads `express.raw` bytes, verifies, and only then parses, so an unverified body is
never handed to a parser. The mount stays inside the raw-body window (`inflate:false`, 64 kb),
pinned by `backend/src/__tests__/index-wiring.test.ts`.

## 3. V-b — the 16–32 character webhook secret — **CLOSED by amendment**

Recorded verdict in the decision record: **`V-b: risk-deferred`**, docs-grounded, with the
amendment named as real pre-launch work. The finding: Fireflies' dashboard webhook-secret field
accepts **16–32** characters, and the shipped derivation emitted `base64url` of a 32-byte HKDF
output = **43** characters, which cannot be registered at all — a correctness bug in the **shipped
Option-C** registration path as much as a pre-requisite for anything backend ingest registers,
since both call the same `deriveWebhookSecret`.

What was done (`backend/src/services/webhook-tokens.ts`, one scheme, documented at the derivation
site): take **24 bytes** of the same HKDF stream → exactly **32** base64url characters, no
padding. Because HKDF-Expand's L=24 output is the 24-byte prefix of its L=32 output, "derive 24
bytes" and "truncate the base64url to 32 chars" are the same string — a future reader cannot pick
the wrong reading. 192 bits of HMAC key material.

Compatibility, so nothing already registered breaks silently: `verifyWebhookDelivery` keeps a
**verification-only** legacy arm for the 43-char form under the same master, counts every token
still using it (`webhookSecretFormCohort()`), and warns on the transition so re-registration can
be driven to zero. Nothing mints the legacy form.

Evidence: `backend/src/__tests__/webhook-secret-length.test.ts`.

**Still open for the operator (not code):** V-b is documentation-grounded, never live-tested. Before
cohort enable, register a hook with the 32-char secret in a real Fireflies dashboard, send a test
delivery, and record the live verdict in the decision record. If any hook was registered earlier
with a 43-char value, re-register it and watch the legacy cohort counter reach zero.

## 4. Owns-only webhooks documented — **DONE**

Normal Fireflies webhooks fire only for meetings the user **owns**; team-wide capture requires
**Enterprise**. This bounds what "always there" can honestly promise: a meeting a user was merely
invited to may never produce a delivery, so it may never be ingested, and no surface may imply
otherwise. The shipped consent copy
(`frontend/src/lib/connectors/consentCopy.ts`) is checked negatively against team-wide phrasing in
`backend/src/__tests__/connector-gate5-hardening.test.ts`; Gate 6 owns the positive rewrite.

## 5. Host-header allowlist live on the public routes — **DONE**

Findings §6 control 6, load-bearing the moment the server fetches on webhooks: under Option C an
off-target delivery cost one enqueue; for a cohort address it would cost a credentialed upstream
fetch and an encrypted server-side content row.

`createConnectorWebhookHostGuard` runs **first** on the public delivery mount — ahead of the
pre-limiter, ahead of `express.raw` — so a delivery that did not arrive at the hostname we minted
into the provider's dashboard is refused before a byte of its body is read. Rejection is the same
generic `401 invalid_signature` every other pre-verify path returns (a host-shaped oracle is still
an oracle) and lands in the same scanner buckets. The offending host is never echoed to the
`public_logs=true` stream.

Configuration: `CONNECTOR_WEBHOOK_HOST_ALLOWLIST`, defaulting to the host of the pinned
`CONNECTOR_WEBHOOK_PUBLIC_ORIGIN` so the host we answer on cannot drift from the URL we hand out;
`*` disables it, loudly, for an ingress that rewrites Host. Both ride the four-place `allowed_envs`
dance (`backend/src/__tests__/webhook-deploy-env.test.ts`).

**This is not an authentication boundary — the HMAC is.** The ingress hop count is UNDETERMINED
(`docs/connector-webhooks-trust-proxy.md`), so a forwarded host is worth exactly what the proxy in
front of it is worth. The control removes untargeted surface: raw-IP probing, a stale domain still
pointed at the CVM, a rebinding attempt. Nothing here claims more.

Evidence: `backend/src/__tests__/connector-host-allowlist.test.ts`.

## 6. Accept-path defense-in-depth carried, unchanged — **VERIFIED, not modified**

W9 changed nothing on the accept path; these are re-verified as regression guards (findings §1,
plan §9 row 3):

- **S2b's fail-open arm stays deleted** — activation throws on a zero projection rather than
  activating unclamped: `backend/src/__tests__/portable-delegation.test.ts`.
- **S2c's TTL clamp** stays enforced on the accept route:
  `backend/src/__tests__/delegations.test.ts`.
- **S2e's caps** (oversize `serialized` rejected before deserialization, bundle-size cap,
  duplicate-resource cap, activation cap pinned at 4) stay enforced:
  `backend/src/__tests__/delegations.test.ts` and
  `backend/src/__tests__/portable-delegation.test.ts`.
- **B mints no new connector delegation into user spaces**, so the backend delegation policy stays
  `threads/`-only — `backendDelegationPermissions()` is unchanged and pinned by
  `backend/src/__tests__/manifest.test.ts`. Custody is out-of-band (plan §6), which is why this
  survives the reversal at all.
- No fail-open consumption of `req.delegatedAccess`: the middleware stays unwired-or-strict.
  Full `att` verification remains the A-branch item (plan §13), never a B dependency.

---

## Also landed under W9 (Gate 4's delta item 11, listed here because it is startup surface)

**D4 = single-instance**, guarded and documented: one backend instance consumes the cohort queues,
enforced in-process by W3's worker seat and cross-process by a durable lease
(`webhooks/ingest/instance-lease`). A second instance refuses the seat and stays provably inert; an
unreadable lease refuses too. Constraint, its blast radius, and the four things that must change to
lift it: `docs/connector-webhooks-single-instance.md`. Evidence:
`backend/src/__tests__/connector-serialization-guard.test.ts`.

---

## Gate 5 verdict

**Green on the code items (1, 2, 3-amendment, 4, 5, 6).** One operator action remains before
cohort enable and it is not a build item: the **live** V-b confirmation in a real Fireflies
dashboard (§3 above), recorded in the decision record.
