# Critical verification fixes — PR #13 (`redpill-verifier`)

> **Premise being defended.** The feature claims **trustless** attestation: a green
> "Response verified" badge must mean *this exact reply* is cryptographically bound to a
> *genuine enclave*, provable in the browser without trusting our backend. Findings 1, 2 and 4
> break that premise — a compromised or MITM'd backend can currently mint "Response verified"
> over arbitrary content. Finding 3 is a silent functional regression (memory never updates
> under the paywall). Findings 5–7 are MAJOR trust/billing gaps.
>
> This document is the **grading rubric** for the audit/fix loop. Each subtask (ST*) is
> independently verifiable. Do the blockers first, in order.

---

## Hard constraints (do NOT violate)

1. **Never lower a bar to make a check pass.** A fix that makes the green tier *easier* to reach
   (e.g. dropping a required equality, defaulting a boolean to `true`, widening an allowlist) is
   wrong by definition, even if it makes a test green. The only acceptable direction is *stricter*.
2. **Preserve the honest three-tier model.** The badge must keep exactly three tiers, each
   visually and semantically distinct:
   - **green** `response-verified` — on-chain/enclave TDX quote valid **AND** the signature binds
     **both** the enclave **and** the displayed reply, **AND** the quote is fresh.
   - **sky** `enclave-attested` — genuine TDX enclave proven, reply **not** bound. Must stay
     visually distinct from green (current `border-sky-500/30 …`).
   - **grey** `not-verifiable` — neither. Never red.
   Do not collapse tiers, recolor them to look alike, or add a fourth.
3. **Do not weaken the vendored package's public API beyond what's needed.** `verifyModel`,
   `verify`, `VerifyModelResult`, `checkReportData`, `checkGpu` keep their existing signatures and
   return shapes. Additive fields are allowed; renames/removals are not. The vendored fork stays
   "byte-identical except the documented URL/auth deviations" (see `VENDOR.md`) — any new
   verification logic the badge needs should live at the **badge layer** unless the change is
   genuinely intrinsic to a vendored primitive (ST5 is the one likely exception).
4. **Keep the existing honest tiering of models.** `VERIFIABLE_MODELS` (tier-1 allowlist) and the
   `phala/`-only catalog must not be widened to make a model "verifiable" that isn't. Adding an id
   requires a real-browser green confirmation (see `completionStore.ts` doc); this plan adds none.
5. **A "verified" flag is never set without the underlying cryptographic check passing.** No
   `signatureValid = true`, `quoteVerified = true`, `tier = "response-verified"`, or
   `verified: true` may be produced on any path where the corresponding check did not actually run
   and succeed.

---

## Precedence rules (how fix rounds resolve conflicts)

When an audit finding conflicts with this plan, or two subtasks pull in opposite directions, obey
this order (higher wins):

1. **Trust-correctness > everything.** Binding the signature to **both** the enclave
   (`sig.signing_address === mr.signingAddress` **and** `reportData.bindsAddress`) **and** the
   displayed reply (response-hash match) outranks UI polish, convenience, latency, and test
   green-ness. If a change would let green appear without all of these, reject it.
2. **Freshness is part of trust-correctness.** A replayable (stale-nonce) quote must not reach
   green. `embedsNonce` gating (ST4) ranks with rule 1, above UI concerns.
3. **Stricter beats looser.** When two proposed fixes differ only in how permissive they are,
   take the stricter. Ambiguity resolves toward *fewer* green badges, never more.
4. **Honest degradation beats false positives.** When a check cannot run (network/CORS/missing
   field), the result is a *lower* tier (sky or grey) or an honest "Not verifiable" — never a
   silent upgrade. Throwing/erroring must land grey, not green.
5. **Server gate is authoritative over the catalog view.** For billing/abuse decisions (ST7, ST6),
   the POST `/api/chat` gating path is the source of truth; a model absent from or pruned by the
   display catalog must still be rejected on the gate if it's disallowed/blocklisted.
6. **Functional correctness of memory (ST3) > cost optimization.** Memory must update under the
   paywall; picking a slightly costlier verifiable model is acceptable, silently-broken memory is
   not.
7. **Do not regress a higher-numbered finding to satisfy a lower one.** If fixing ST1 would
   reintroduce ST3, the fix is incomplete — both constraints hold simultaneously.

---

## Subtasks

### ST1 — [BLOCKER] Bind the green tier to the enclave

**Problem.** `frontend/src/chat/ModelVerificationBadge.tsx` (~L130–149) sets `signatureValid`
purely from `signer === sig.signing_address` — but **both** values come from the same proxied
`/api/signature` response, so a malicious backend can return a self-consistent
`{text, signature, signing_address}` triple and pass. The signing key is never tied to the
attested enclave: `mr.signingAddress` (the enclave-attested address, `verify.ts` L285/428) is never
compared to `sig.signing_address`, and `mr.light.reportData.bindsAddress` (computed in
`checkReportData`, `cloud-api.ts` L61–83; surfaced at `verify.ts` L306–313 / L430) is never gated.

**Files / functions.**
- `frontend/src/chat/ModelVerificationBadge.tsx` — `runVerify()`, tier computation (L141–149),
  `Verdict` interface (L73–80) and what's passed to `AttestationDetails`.

**Concrete change.** Introduce an explicit `enclaveBound` predicate and require it for green:
```ts
const enclaveBound =
  sig != null &&
  signer != null &&
  signer.toLowerCase() === sig.signing_address.toLowerCase() &&        // signer matches claimed key
  mr.signingAddress != null &&
  sig.signing_address.toLowerCase() === mr.signingAddress.toLowerCase() && // claimed key == attested key
  mr.light?.reportData?.bindsAddress === true;                          // attested key bound in the TDX quote
```
Then `signatureValid` (the value feeding the green tier) must require `enclaveBound` — not the
old self-consistency check alone. Tier stays green only when `quoteVerified && enclaveBound &&
<ST2 reply-bind> && <ST4 freshness>`. Surface the new sub-conditions in `Verdict` so
`AttestationDetails` can show them (additive only).

**Acceptance criterion.** With a mocked signature proxy returning a self-consistent triple whose
`signing_address` does **not** equal `mr.signingAddress` (or with `reportData.bindsAddress !==
true`), `runVerify()` resolves to tier `enclave-attested` (sky) or lower — **never**
`response-verified`. Green is reachable **only** when `sig.signing_address === mr.signingAddress`
**and** `mr.light.reportData.bindsAddress === true`. A new frontend unit test asserts both the
positive (all three equal/true → green) and negative (mismatch → not green) cases.

---

### ST2 — [BLOCKER] Compare the signed text to the displayed reply

**Problem.** The badge recovers a signer over `sig.text` but never checks that `sig.text`
corresponds to the assistant message **rendered on screen** — `useMessage` only reads `m.id`
(L54). So the backend could sign *any* text and the badge would still go green. The vendored
`verify()` already supports this via a response-hash compare (`verify.ts` L482–488:
`sha256(responseText) === respHashServer`, where `respHashServer` is parsed out of the
`reqHash:respHash`-style `sig.text`).

**Files / functions.**
- `frontend/src/chat/ModelVerificationBadge.tsx` — `ModelVerificationBadge` (read rendered
  content via `useMessage`), pass it down to `VerificationBadge`, and add a `replyBound` check in
  `runVerify()`.
- Reuse `sha256` and the `sig.text` split logic from
  `frontend/src/lib/vendor/redpill-verifier/utils.js` / `verify.ts` L482–488 (import the helper or
  mirror the exact same parse — do **not** fork the vendored file).

**Concrete change.**
1. In `ModelVerificationBadge`, read the rendered text: `const content = useMessage((m) =>
   m.content.map(p => p.type === "text" ? p.text : "").join(""))` (mirror `messageText` in
   `runtime.tsx`) and pass it as a prop to `<VerificationBadge … renderedText={content} />`.
2. In `runVerify()`, after fetching `sig`, parse the server response hash from `sig.text` exactly
   as `verify.ts` L482–483 does, compute `sha256(renderedText)`, and set
   `replyBound = (await sha256(renderedText)) === respHashServer`.
3. Require `replyBound` for the green tier (alongside ST1's `enclaveBound` and ST4's freshness).

**Acceptance criterion.** When the rendered message text does not hash to the response hash
embedded in `sig.text`, `runVerify()` never yields `response-verified` (falls to sky/grey). A new
frontend unit test feeds a `sig.text` whose response hash matches a known string and asserts:
identical rendered text → green-eligible; altered rendered text (one char changed) → **not** green.
The hash comparison must use the same algorithm/encoding as the vendored `sha256` so a genuine
match is not falsely rejected (Hard constraint 1: do not relax — verify against the real helper).

---

### ST3 — [BLOCKER] Memory extraction broken under the paywall

**Problem.** `frontend/src/chat/runtime.tsx` L60 sets
`MEMORY_EXTRACTION_MODEL = "openai/gpt-5-mini"`. The extraction `completeChat` POSTs to
`/api/chat` (L429–436). With `PAYWALL_ENABLED`, every tier's `modelPatterns` is `["phala/"]`
(`tiers.ts` L84/93/102), so `isModelAllowed(tier, "openai/gpt-5-mini")` is false →
`chat.ts` L175 returns **402**, and extraction silently never updates memory
(`runtime.tsx` `runExtraction` swallows the failure).

**Files / functions.**
- `frontend/src/chat/runtime.tsx` — `MEMORY_EXTRACTION_MODEL` (L60), used at L432.
- (Verify only) `backend/src/routes/chat.ts` L175, `backend/src/billing/tiers.ts`.

**Concrete change (primary).** Set `MEMORY_EXTRACTION_MODEL` to a small, cheap **verifiable**
`phala/*` model that is on the tier-allowed `phala/` prefix **and** in `VERIFIABLE_MODELS` and
**not** in `MISLABELED_BLOCKLIST` — e.g. `"phala/gpt-oss-20b"` (small/cheap, flat-signature model).
Update the L53–60 doc comment accordingly. Do **not** weaken tier gating to admit non-`phala/`
models (that would also reopen ST7/abuse surface).

> Alternative (only if a `phala/*` extraction model proves unworkable): add a narrowly-scoped
> server-side exemption for the extraction call. This is **less preferred** because it carves a
> hole in the gate; if taken, it must be a distinct, clearly-bounded signal (e.g. an internal
> `purpose: "memory-extraction"` flag that is rate-limited and billed), never a blanket bypass.

**Acceptance criterion.** A new backend regression test (extend
`backend/src/__tests__/chat-gating.test.ts`) asserts that with the paywall enabled and a `free`
tier, a POST `/api/chat` using `MEMORY_EXTRACTION_MODEL` is **not** rejected with 402
(`isModelAllowed("free", MEMORY_EXTRACTION_MODEL) === true`). The chosen id starts with `phala/`
and is present in `VERIFIABLE_MODELS` and absent from `MISLABELED_BLOCKLIST`. Backend test +
frontend build stay green.

---

### ST4 — [MAJOR] Enforce replay / freshness (`embedsNonce`)

**Problem.** `verify.ts` L417–421 computes `verified` from `lightValid && deepValid && …` but
**excludes** `reportData.embedsNonce`. The badge's `quoteVerified` (L143–144) reads only
`mr.onchain.verified` / `mr.light.tdx.verified`. So a replayed *genuine historical* TDX quote
passes: a fresh `nonce` is generated (`verify.ts` L268) and embedded in the attestation request,
but whether the returned quote actually embeds **that** nonce (`checkReportData` →
`embedsNonce`, `cloud-api.ts` L77–81) is never gated.

**Files / functions.**
- `frontend/src/chat/ModelVerificationBadge.tsx` — `runVerify()` freshness gate feeding the green
  tier.
- (Optional, additive) `frontend/src/lib/vendor/redpill-verifier/verify.ts` — may expose a
  `fresh`/`embedsNonce` convenience boolean on the result **additively** (no signature change),
  but the gating decision the badge trusts must include freshness regardless.

**Concrete change.** Add `const fresh = mr.light?.reportData?.embedsNonce === true;` and require
`fresh` for the **green** tier. (Sky `enclave-attested` may remain for a valid-but-stale quote
only if the product intends that; default: require freshness for green, allow sky for
quote-valid-without-fresh-nonce, and document the distinction in `AttestationDetails`.) Do not set
`fresh` true on any path where `embedsNonce` was not actually computed and equal to the generated
nonce.

**Acceptance criterion.** With `mr.light.reportData.embedsNonce === false` (replayed/stale quote),
`runVerify()` never yields `response-verified`. A new frontend unit test asserts: `embedsNonce:
true` + all other green conditions → green; flipping only `embedsNonce` to `false` → not green.

---

### ST5 — [MAJOR] Verify the NRAS GPU JWT signature (or stop claiming it)

**Problem.** `frontend/src/lib/vendor/redpill-verifier/verifiers/cloud-api.ts` L98–100
`decodeJwtPayload(jwt)` reads the NRAS verdict claim **without verifying NVIDIA's ES384
signature**. The proxy route `GET /api/nras-proxy/jwks`
(`backend/src/routes/nras-proxy.ts` L62–76), added specifically to enable signature verification,
has **no caller** — it is dead code. So the GPU leg is trust-the-backend, not forge-proof.

**Files / functions.**
- `frontend/src/lib/vendor/redpill-verifier/verifiers/cloud-api.ts` — `checkGpu()` (L85–103).
- `backend/src/routes/nras-proxy.ts` — `GET /jwks` (consumer added) **or** removed.
- Possibly add a JWT/JWKS verify dependency (`jose`) to `frontend/package.json` — none present
  today; `@peculiar/x509` + WebCrypto `crypto.subtle.verify` with ES384 is an alternative that
  avoids a new dep.

**Concrete change (preferred — make it real).** In `checkGpu`, before trusting `verdict`:
fetch the JWKS via `${BACKEND_ORIGIN}/api/nras-proxy/jwks`, select the key matching the JWT
header `kid`/`alg` (ES384), and verify the JWT signature (via `jose.jwtVerify` or
`crypto.subtle.verify('ECDSA', {name:'ECDSA',hash:'SHA-384'}, …)`). Only then read
`x-nvidia-overall-att-result`. Add a `signatureVerified: boolean` to `GpuResult` (additive) and
treat an unverifiable signature as a non-passing GPU verdict. This is the documented exception to
Hard constraint 3 (the change is intrinsic to the vendored GPU primitive); keep `checkGpu`'s
signature compatible (additive return field only).

**Alternative (honest removal).** If JWT verification is out of scope for this PR: stop claiming
the GPU leg is forge-proof — remove the dead `GET /jwks` route, and update the NRAS proxy /
verification docs/comments to state the GPU verdict is backend-relayed and **not** independently
verified in-browser. Do **not** leave the route present implying a guarantee that isn't wired up.

**Acceptance criterion.** Either (a) `checkGpu` verifies the JWT against the JWKS and a tampered
JWT payload yields a non-passing verdict (covered by a new frontend unit test with a forged token),
**and** `GET /api/nras-proxy/jwks` now has a real caller; or (b) the `/jwks` route is removed and
no comment/doc claims the GPU JWT is verified in-browser. A grep for `/jwks` shows it is either
called from `cloud-api.ts` or absent from the codebase — never present-and-uncalled.

---

### ST6 — [MAJOR] `defaultModel()` is self-denying under `phala/`-only tiers

**Problem.** `backend/src/routes/chat.ts` L25/27 default to `"openai/gpt-5-mini"`; a model-less
POST resolves to it (L153) and 402s under the paywall (L175), and it's also the post-stream rates
baseline (L283). Under `phala/`-only tiers a default request is dead on arrival.

**Files / functions.**
- `backend/src/routes/chat.ts` — `DEFAULT_BASELINE_MODEL` (L25), `defaultModel()` (L26–28).

**Concrete change.** Default to a verifiable `phala/*` model that all tiers allow and that is in
`VERIFIABLE_MODELS` / not blocklisted (e.g. `phala/gpt-oss-120b` or align with the frontend
`DEFAULT_MODEL`). Keep `REDPILL_DEFAULT_MODEL` env override. Confirm the rates baseline at L372 /
L283 still resolves sensibly with the new default (it reads from the full catalog, so a `phala/`
default is fine).

**Acceptance criterion.** With the paywall enabled (free tier) and a POST `/api/chat` that omits
`model`, the request is **not** rejected with `model_not_allowed` (402) — i.e.
`isModelAllowed("free", defaultModel()) === true`. A backend test (extend `chat-gating.test.ts`)
asserts `defaultModel()` starts with `phala/` and is tier-allowed. Backend typecheck + tests green.

---

### ST7 — [MAJOR] Enforce `MISLABELED_BLOCKLIST` on the gating/billing path

**Problem.** `backend/src/billing/catalog.ts` L35–40/134 prunes the blocklist **only** in
`getCatalog()`. POST `/api/chat` gates solely on the `phala/` prefix (`tiers.ts`
`isModelAllowed`), and `resolveRates()` (`chat.ts` L110–113) falls back to baseline rates for
catalog-absent ids — so a direct `POST {model:"phala/glm-4.7"}` is callable and billable despite
being blocklisted (it's a deceptively-labeled model we refuse to serve).

**Files / functions.**
- `backend/src/billing/catalog.ts` — export the blocklist check (e.g.
  `export function isBlocklistedModel(id: string): boolean` over `MISLABELED_BLOCKLIST`).
- `backend/src/routes/chat.ts` — POST `/` gating block (after `resolvedModel`, around L153–184),
  reject blocklisted ids regardless of `paywallEnabled()`.

**Concrete change.** Add `isBlocklistedModel` to `catalog.ts` and, in `chat.ts`, reject a
blocklisted `resolvedModel` early (e.g. 403/402 `model_blocklisted`) **before** the upstream fetch
— on the gating path, not just the display catalog. Apply it even when the paywall is disabled
(per Precedence rule 5: the gate is authoritative). The `/models` view already hides them; this
closes the direct-POST hole.

**Acceptance criterion.** A backend test asserts `POST /api/chat {model:"phala/glm-4.7"}` (a
blocklisted id) is **rejected** (not 200, no upstream call, no `recordUsage`) both with the paywall
enabled and disabled. `isBlocklistedModel("phala/glm-4.7") === true` and
`isBlocklistedModel("phala/gpt-oss-120b") === false`. Existing catalog tests stay green.

---

## Regression / verification gate

These deterministic checks MUST stay green after every subtask (run from the relevant package):

- **Backend typecheck** — `cd backend && bun run build` (`tsc --noEmit`).
- **Backend tests** — `cd backend && bun test` (existing suites:
  `chat-gating`, `billing-catalog`, `billing-tiers`, `nras-proxy-routes`, `signature-routes`, …).
- **Frontend build** — `cd frontend && npm run build` (`tsc && vite build`).

**New tests each subtask must add:**

| Subtask | New test |
|---|---|
| ST1 | Frontend unit: enclave-binding — `sig.signing_address === mr.signingAddress` **and** `reportData.bindsAddress === true` required for green; mismatch → sky/grey. |
| ST2 | Frontend unit: reply-binding — rendered-text hash must equal `sig.text` response hash for green; altered text → not green. |
| ST3 | Backend regression in `chat-gating.test.ts`: memory-extraction model is tier-allowed under the paywall (no 402). |
| ST4 | Frontend unit: freshness — `embedsNonce === false` → never green. |
| ST5 | Frontend unit: forged NRAS JWT → non-passing GPU verdict (if verifying); **or** assert `/jwks` route removed (if descoping). |
| ST6 | Backend: `defaultModel()` is `phala/`-prefixed and tier-allowed; model-less POST not 402. |
| ST7 | Backend: blocklisted-id POST rejected (paywall on **and** off), no upstream call / no usage recorded. |

> Frontend currently ships no test runner in `frontend/package.json`. ST1/ST2/ST4(/ST5) tests
> require adding one (e.g. `vitest`) as a dev dependency, or — if that is out of scope — the
> binding/freshness logic must be extracted into a pure, framework-free helper module that a
> backend-style `bun test` can import and assert. Either way, the binding and freshness predicates
> must be covered by an automated, deterministic test — not left to manual browser checking alone.
