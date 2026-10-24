# Gate 5 — provider + surface hardening: the checklist

Gate 5's exit artifact (work package W9). Plan §4 requires every
gate to exit with a *written artifact, not a feeling*, so each §10 item below carries a verdict
and a citation. Every path cited here is asserted to exist by
`backend/src/__tests__/connector-gate5-hardening.test.ts` — a checklist pointing at a deleted test
is worse than no checklist.

Scope note: this gate is about the **provider-facing surface**. The items that belonged to backend-owned
Fireflies ingestion (the slow-upstream 2xx proof, the Host-header allowlist and the single-instance
constraint) were removed with that feature.

---

## 1. `X-Hub-Signature` HMAC-SHA256 over the RAW body — **DONE (regression held)**

Shipped in `backend/src/services/webhook-verify.ts`; the regression suite stays green in this
build: `backend/src/__tests__/webhook-verify.test.ts`. `JSON.parse` runs strictly **after** verify
— the route reads `express.raw` bytes, verifies, and only then parses, so an unverified body is
never handed to a parser. The `index.ts` mount precedes the shared JSON parser with
`inflate:false` and a 64 kb cap; signed raw ingress is exercised in
`backend/src/__tests__/connector-gate5-hardening.test.ts`.

## 2. V-b — the 16–32 character webhook secret — **CLOSED by amendment**

Recorded verdict in the decision record: **`V-b: risk-deferred`**, docs-grounded, with the
amendment named as real pre-launch work. The finding: Fireflies' dashboard webhook-secret field
accepts **16–32** characters, and the shipped derivation emitted `base64url` of a 32-byte HKDF
output = **43** characters, which cannot be registered at all — a correctness bug in the **shipped
Option-C** registration path.

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
enabling the flag for a real account, register a hook with the 32-char secret in a real Fireflies dashboard, send a test
delivery, and record the live verdict in the decision record. If any hook was registered earlier
with a 43-char value, re-register it and watch the legacy cohort counter reach zero.

## 3. Owns-only webhooks documented — **DONE**

Normal Fireflies webhooks fire only for meetings the user **owns**; team-wide capture requires
**Enterprise**. This bounds what "always there" can honestly promise: a meeting a user was merely
invited to may never produce a delivery, so it may never be ingested, and no surface may imply
otherwise. The shipped consent copy
(`frontend/src/lib/connectors/consentCopy.ts`) is checked negatively against team-wide phrasing in
`backend/src/__tests__/connector-gate5-hardening.test.ts`; Gate 6 owns the positive rewrite.

## 4. Accept-path defense-in-depth carried, unchanged — **VERIFIED, not modified**

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
- **Fireflies Option C mints no Fireflies connector delegation into user spaces.**
  Its credential custody remains out of band (plan §6). TC-641 separately
  advertises a transcript-writer grant on connector SQL read/write and
  transcriber KV get/put. Acceptance is off by default. With delivery enabled and
  an active grant, Fireflies and Google consent surfaces disclose this separate
  transcript-writer permission; the inactive copy remains unchanged.
- No fail-open consumption of `req.delegatedAccess`: the middleware stays unwired-or-strict.
  Full `att` verification remains the A-branch item (plan §13), never a B dependency.

---

## Gate 5 verdict

**Green on the code items (1, 2-amendment, 3, 4).** One operator action remains before the
flag is enabled for a real account and it is not a build item: the **live** V-b confirmation in a
real Fireflies dashboard (§2 above), recorded in the decision record.
