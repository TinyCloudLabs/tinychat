# PR #13 (redpill-verifier) — Prod-Readiness Plan

Grading rubric for the audit/fix loop. Each subtask is independently verifiable.
Findings re-confirmed against the working tree on 2026-06-10 (line references below
match the current branch).

The crypto core is sound: the hash input is the raw accumulated stream, on-chain
DCAP gives a trustless anchor, and live green badges have been demonstrated. The
bugs cluster in (a) **migration** of pre-PR persisted state into the new phala-only
catalog and (b) **error/edge handling** in the new verification UI. F1+F2+F3 compound
into one user-facing failure chain (a stale persisted model survives, the backend
proxies it because gating is paywall-scoped, and the resulting 402 pops a dialog that
can't fix it), so they are the three blockers and are sequenced first.

---

## Hard constraints (every fix round obeys these)

1. **Vendored verifier is upstream-verbatim except deviations documented in
   VENDOR.md.** The sanctioned deviations are exactly: (a) the **3 URL redirects**
   (signature → `${BACKEND_ORIGIN}/api/signature/...` in `verify.ts`;
   NRAS → `${BACKEND_ORIGIN}/api/nras-proxy`; Phala TDX → `${BACKEND_ORIGIN}/api/phala-verify`
   in `verifiers/cloud-api.ts`), and (b) the **ST5 GPU-JWT verification** in
   `verifiers/cloud-api.ts` (`verifyNrasJwt` import + `fetchNrasJwks()` + the JWKS
   GET to `/api/nras-proxy/jwks`), added deliberately by the critical-fixes round
   (commit `fa4861c`) — do NOT revert it; reverting weakens a trust check and
   violates constraint 2. VENDOR.md MUST accurately document every deviation: the
   stale paragraph claiming checkGpu "decodes the NRAS JWT payload WITHOUT fetching
   NVIDIA's JWKS" must be corrected to describe the ST5 verification (a VENDOR.md
   doc fix, not a vendor-code edit). Any deviation beyond (a)+(b) is a blocker.
   The vendored `body[0][1]` NRAS-indexing quirk is upstream's and fail-closed —
   do NOT "fix" it. All other new logic lives in non-vendor files
   (`verification-predicates.ts`, `AttestationDetails.tsx`, the badge, hooks).
2. **Never weaken a trust check to make an audit pass.** The three badge tiers stay
   visually AND semantically distinct: green `response-verified` (emerald), sky
   `enclave-attested`, grey `not-verifiable`; the header indicator stays TEAL
   `Enclave verified` (distinct from per-message green). A `"verified"`/green flag is
   set ONLY when the underlying cryptographic check passes. `computeTier` /
   `isEnclaveBound` / `isFresh` / `isQuoteVerified` may become STRICTER, never looser.
   Ambiguity always resolves toward FEWER green/verified badges.
3. **Suites stay green; new behavior gets new tests.** The existing backend test
   suite (147 tests at PR time) and the frontend build must stay green. New tests are
   REQUIRED for: ST1 (stale-model healing), ST2 (paywall-off offered-model gating),
   ST11 (env-override validation — a test that does NOT delete `REDPILL_DEFAULT_MODEL`,
   distinct from the existing ST6 test that deletes it).
4. **No regression of the two perf/UX wins.** The instant new-chat boot (localStorage
   paints the picker before SQL reconcile) and the June-5 history fixes (single-doc
   threading via `remoteId ?? id`; receipt hooks at entry before the slow `await
   appendMessage`) MUST NOT regress. Specifically: model sanitization must not block
   the first paint, and per-thread handoff keying (ST4) must not reintroduce
   cross-thread doc splitting.
5. **Product design is not a bug.** All tiers offer all verifiable models;
   differentiation is credit-budget only (`modelPatterns: ["phala/"]` on every tier).
   Do NOT "fix" this by re-introducing per-tier model gating.

---

## Precedence rules (when an audit finding conflicts with this plan)

Apply in this strict order so the loop converges instead of oscillating:

1. **Trust-correctness** — a real cryptographic/attestation weakness outranks
   everything. If a fix would let a green/verified badge appear without its check
   passing, the fix is wrong regardless of UX or cleanliness.
2. **Migration correctness** — stale persisted state must heal to a valid catalog
   model and the corrected value must persist (no recurrence next sign-in).
3. **UX honesty** — labels must describe the ACTUAL verdict (e.g. "Signature valid,
   nonce not fresh" ≠ "Signature invalid"); dialogs must offer an action that can
   resolve the error they surface.
4. **Efficiency / cleanup** — dedup, helpers, caching. Lowest priority; never pursued
   at the cost of 1–3.

The PR's stated product design (point 5 above) is OUTSIDE this ordering — it is a
fixed requirement, never "fixed."

---

## Subtasks

### ST1 — [BLOCKER] Heal stale persisted models through one sanitize choke point

**Problem.** A pre-PR persisted model id (e.g. `openai/gpt-5-mini`) re-enters
selection state from three places with no catalog validation, and nothing rewrites
the stale source, so it recurs every sign-in:
- `frontend/src/App.tsx` ~L177–194 — SQL `active_model` reconcile calls
  `setSelectedModel(saved)` + `writeLocalModel(saved)` with no validation; it resolves
  AFTER the one-shot `/models` membership fallback (~L344–366, which runs once per
  sign-in), so the stale value deterministically wins the race.
- `frontend/src/App.tsx` ~L344–366 — the `/models` fallback only fixes the picker
  if the saved id is absent from the list at that instant; it does not persist a
  correction and is raced by the SQL restore.
- `frontend/src/chat/runtime.tsx` ~L531–541 — opening any pre-PR thread calls
  `getThreadModel` → `onActiveThreadModel(model)` (= `setSelectedModel`), re-restoring
  that thread's stale model with no validation.

**Change.** Add one pure helper and apply it at every entry point:
- New `frontend/src/lib/sanitizeModel.ts`: `sanitizeModel(model: string | null,
  offered: ReadonlySet<string> | string[], fallback = DEFAULT_MODEL): string` — returns
  `model` when it is an offered (phala/*, catalog-present, non-blocklisted) id,
  otherwise `fallback`. Offered set is derived from the loaded `/models` list (already
  in `App` state as `models`); before that list loads, fall back to
  `isTeeCapableModel(model)` (a `phala/` prefix gate) so a non-phala legacy id is still
  rejected.
- `App.tsx` SQL restore (L184–185): wrap `saved` in `sanitizeModel`; when the result
  differs from `saved`, **persist the correction back** via `pickModel(corrected)` (which
  writes localStorage + `setSetting(tcw, "active_model")`), not just `setSelectedModel`.
- `App.tsx` localStorage init read (`readLocalModel`, L57–61) and the `/models`
  fallback (L354–358): route through `sanitizeModel` against the freshly loaded list and
  persist via `pickModel` so the SQL row + localStorage both heal.
- `runtime.tsx` thread restore (L535–536): sanitize the `getThreadModel` result; when it
  was non-offered, call `setThreadModel(activeTcw, threadId, corrected)` to heal the
  thread row, then `onActiveThreadModel(corrected)`.

**Files/functions:** `frontend/src/lib/sanitizeModel.ts` (new),
`frontend/src/App.tsx` (`readLocalModel`, SQL-restore effect, `/models` effect,
`pickModel`), `frontend/src/chat/runtime.tsx` (thread-model sync effect),
`frontend/src/lib/threadStore.ts` (`setThreadModel` already exported).

**Acceptance.** A new unit test seeds `active_model` = a non-phala/non-catalog id and
a pre-PR thread row with the same; after the restore path runs, the selected model is
`DEFAULT_MODEL`, AND the persisted SQL setting + thread row have been rewritten to a
valid offered id (assert the `setSetting`/`setThreadModel` calls), so a second
sign-in surfaces no stale value. The instant-paint path (ST-constraint 4) still
renders a valid model on first paint without awaiting `/models`.

---

### ST2 — [BLOCKER] Enforce the verifiable-only (offered-model) invariant regardless of paywall

**Problem.** `backend/src/routes/chat.ts`: `isModelAllowed` (L196) runs ONLY inside
`if (paywallEnabled())` (L181–228). `paywallEnabled()` is `false` whenever
`PAYWALL_ENABLED !== "true"` (`stripe.ts` L45–47), which is the default deployment. The
blocklist check (L168–174) is deliberately paywall-independent and `GET /models`
(L399) filters to `phala/*` unconditionally — but `POST /` will proxy ANY non-TEE
model upstream when the paywall is off, contradicting the verifiable-only UI claim.

**Change.** Hoist an authoritative offered-model gate OUT of the paywall block, right
after the blocklist check (after L174), mirroring the blocklist pattern: reject any
model that is not `phala/*` (the offered namespace) with a 403 (e.g.
`error: "model_not_offered"`) before any upstream fetch or billing. Tier/credit gating
(`isOverBudget`, rates) stays inside the `paywallEnabled()` block. Since every tier's
`modelPatterns` is `["phala/"]`, the existing `isModelAllowed` 402 inside the paywall
block becomes redundant for namespace purposes but stays for forward-compat tier
semantics — the new unconditional gate is the authoritative one.

**Files/functions:** `backend/src/routes/chat.ts` (`router.post("/")`, insert gate
after blocklist L174).

**Acceptance.** New backend test: with `PAYWALL_ENABLED` unset, `POST /api/chat` with
`model: "openai/gpt-4o"` returns 403 (not a proxied stream and not 402), and NO
upstream fetch is attempted. An existing-style test confirms a valid `phala/*` model
still streams with the paywall off. The 147-test suite stays green.

---

### ST3 — [MAJOR] Route 402s to the right remedy (don't pop an un-fixable upgrade dialog)

**Problem.** `frontend/src/App.tsx` ~L306–311: `onPaywallError` unconditionally calls
`setPricingOpen(true)` for ANY 402. `chatApi.ts` L152–168 emits `paywall` for every
402. For `model_not_allowed`, `backend/src/routes/chat.ts` L202 omits `requiredTier`
(because `requiredTierForModel` is non-null but equals the caller's tier for every
phala model — all tiers share `["phala/"]`), so the upgrade dialog cannot resolve it.

**Change.** Make the handler branch on `payload.error` (already typed in
`PaywallErrorPayload`, `chatApi.ts` L13–19):
- `credit_budget_exceeded`, OR `model_not_allowed` WITH a `requiredTier` present and
  higher than current → `refreshBillingStatus()` + `setPricingOpen(true)` (upgrade can
  fix it).
- `model_not_allowed` WITHOUT an actionable `requiredTier` (or the new ST2
  `model_not_offered` if surfaced as 402) → do NOT open pricing; instead switch the
  active model to a supported default via `pickModel(sanitizeModel(...))` and surface a
  brief notice ("Switched to a verifiable model"). Reuse the ST1 sanitize helper.

**Files/functions:** `frontend/src/App.tsx` (`onPaywallError` effect L306–311),
optionally `frontend/src/lib/chatApi.ts` (keep the emit; the branch lives in App).

**Acceptance.** A test/manual check: a `model_not_allowed` 402 with no actionable
`requiredTier` does NOT open the pricing dialog and DOES reset the picker to an offered
model; a `credit_budget_exceeded` 402 still opens the pricing dialog.

---

### ST4 — [MAJOR] Key the completion/receipt handoff per thread, not at module scope

**Problem.** `frontend/src/chat/runtime.tsx`: `pendingCompletion` (L118) and
`pendingReceipt` (L105) are single module-level slots, set on stream finish (L191/L197)
and consumed in the history adapter's `append` (L360–365 receipt, L377–378 completion).
assistant-ui keeps prior-thread runtimes alive after `switchToThread`, so while thread
A awaits `computeReceipt` (raced up to `RECEIPT_COMPUTE_TIMEOUT_MS` ≈ 1.5s), thread B's
finish overwrites the slot: A's message gets B's `completionId`+`model` (its badge then
fetches B's signature → wrong downgrade/mismatch) and B's message gets none.
`pendingReceipt` has the same race with a smaller window.

**Change.** Replace both module-level slots with per-thread handoff. Preferred: move
the slots into the per-thread adapter closure (the same place `lastExchange` lives,
created per `createHistoryAdapter`/`createChatModelAdapter` binding), OR key a
`Map<threadId, PendingCompletion>` / `Map<threadId, PendingReceipt>` and have `run()`
write under the active threadId and `append()` read+delete its own threadId's entry.
Cover `pendingReceipt` with the same keying. Must preserve the June-5 single-doc
threading and the entry-before-await receipt timing (ST-constraint 4).

**Files/functions:** `frontend/src/chat/runtime.tsx` (`pendingCompletion` L118,
`pendingReceipt` L105, `createChatModelAdapter.run` L190–198, `createHistoryAdapter`
append L360–385, `computeReceipt` L461–462).

**Acceptance.** A test simulating two interleaved thread finishes (A finishes, B
finishes while A's append still pending) asserts A's stored completion ref carries A's
`completionId` and B's carries B's — no cross-keying — and each receipt lands on its own
thread. Frontend build stays green; new-chat boot unaffected.

---

### ST5 — [MAJOR] Give verification proxies their own rate-limit bucket

**Problem.** `backend/src/index.ts` L99–106 mounts ONE global limiter (120 req /
15 min / IP); `/api/signature`, `/api/nras-proxy`, `/api/phala-verify` (L131–133) and
`/api/chat` (L130) all share it. Each badge click ≈ 4 backend hits, each model probe ≈ 3;
~25 verifications plus normal chatting empties the bucket and the next `POST /api/chat`
gets a non-SSE 429 that `streamChat` treats as a fatal error.

**Change.** Create a SEPARATE `rateLimit` instance with a higher limit (e.g. 600 req /
15 min) and apply it to the three verification mounts; keep the global limiter on
`/api/chat` and the rest at 120. Do NOT raise the global limit. Mount order: apply the
verification limiter on those three `app.use(...)` lines (L131–133) before/instead of
inheriting the global one — or exempt the three paths from the global bucket via a
`skip` predicate. Keep `standardHeaders: "draft-7"`.

**Files/functions:** `backend/src/index.ts` (limiter setup L99–106; mounts L130–133).

**Acceptance.** New/updated backend test: 130 rapid hits to `/api/signature` do NOT
exhaust the `/api/chat` bucket (a subsequent `/api/chat` is not 429'd by verification
traffic); the global chat limiter still 429s after its own 120. Suite green.

---

### ST6 — [MAJOR] Don't cache transient verification failures for the whole session; allow retry

**Problem.** `frontend/src/lib/useModelVerification.ts` commits `"error"`/`"unverified"`
verdicts to the module `cache` with no TTL (L100/L105 → cached at L114), so a transient
provider/network blip sticks for the SPA session.
`ModelVerificationIndicator.tsx` L36 gates expand/`reverify` on `status === "verified"`,
so the Re-verify affordance is unreachable exactly when it's needed (error state).

**Change.**
- In `useModelVerification.ts`: do NOT cache negative verdicts (`error`/`unverified`)
  in the long-lived `cache`, OR give them a short TTL (e.g. stamp `verifiedAt` and treat
  a cached negative as a miss after ~30s). Positive (`verified`) verdicts stay cached as
  today. `getCachedModelVerification` must continue to return only fresh `verified`
  results (unchanged).
- In `ModelVerificationIndicator.tsx`: make the pill clickable to retry when
  `status` is `error`/`unverified` (call `reverify()`), not only when `verified`.

**Files/functions:** `frontend/src/lib/useModelVerification.ts` (`runVerification`
commit L109–117, `useEffect` L141–180), `frontend/src/chat/ModelVerificationIndicator.tsx`
(`expandable`/`onClick` L36–41, pill affordance).

**Acceptance.** A test/manual check: after a forced `error` verdict, a subsequent probe
for the same model is NOT served from a stale negative cache (it re-runs), and the
header indicator is clickable to retry in the error state. Trust semantics unchanged
(positive caching path untouched).

---

### ST7 — [MAJOR] A malformed signature must not discard an already-proven attestation

**Problem.** `frontend/src/chat/ModelVerificationBadge.tsx` L156–159:
`recoverMessageAddress` runs inside the single `runVerify` try-block; a present-but-
invalid signature (truncated / format change) throws in viem and the `catch` (L190–196)
sets `verdict=null`/`phase="error"`, rendering grey "Not verifiable" — even though
`verifyModel` (L148) already established the enclave-attested (sky) tier.

**Change.** Wrap ONLY the signature leg (recover + hash compare, L155–166) in its own
inner try/catch. On throw: treat the signature as invalid (`signer=null`,
`replyBound=false`) but CONTINUE to `computeTier` from the already-resolved `mr` (the
quote leg still yields `enclave-attested`). The outer catch then fires only for a
thrown `verifyModel`/attestation failure (true tier-0).

**Files/functions:** `frontend/src/chat/ModelVerificationBadge.tsx` (`runVerify`
L140–197).

**Acceptance.** A predicate/component test: with a valid `mr` (quote verified) and a
signature string that throws in recovery, the badge renders `enclave-attested` (sky),
NOT `not-verifiable` (grey), and never reaches the green tier. Green still requires all
four legs (ST-constraint 2).

---

### ST8 — [MAJOR] Honor AttestationDetails' signature null-contract; label stale-but-valid honestly

**Problem.** `ModelVerificationBadge.tsx` L244 always passes
`signature={{ valid, signer }}`, even when no signature was fetched. `AttestationDetails`
(L33, L58–71) renders the signature leg whenever `signature != null`, so a reply with
NO fetched signature shows "Signature invalid — signer: null". Separately, a
cryptographically valid signature that fails ONLY freshness (`embedsNonce=false`) is
labeled "Signature invalid" (the leg's `valid` is the green-tier flag, not signature
self-consistency).

**Change.**
- In the badge: pass `signature={null}` when no signature was fetched (`sig == null`),
  so `AttestationDetails` omits the leg per its documented contract. Only pass an object
  when a signature was actually retrieved.
- Distinguish signature self-consistency from green-tier binding: when the signature is
  cryptographically valid but the reply isn't fully bound (e.g. valid recover + hash
  match but `embedsNonce=false`), label the ACTUAL failure (e.g. "Signature valid —
  nonce not fresh") rather than "Signature invalid". This may require passing a small
  reason/sub-state to `AttestationDetails` instead of a single `valid` boolean — keep the
  three tiers' meaning intact (this changes only the leg's label text, never the tier).

**Files/functions:** `frontend/src/chat/ModelVerificationBadge.tsx` (verdict assembly
L178–187, `AttestationDetails` props L242–246), `frontend/src/chat/AttestationDetails.tsx`
(signature leg L55–71).

**Acceptance.** Component/predicate test: (a) a reply with no fetched signature renders
NO signature leg (not "Signature invalid — signer: null"); (b) a valid-but-stale
signature renders a label naming freshness, not "invalid"; (c) a genuinely invalid
signature still renders "Signature invalid". Tier colors unchanged.

---

### ST9 — [MINOR] GPU leg must reflect nonce freshness (no green for replayed evidence)

**Problem.** `frontend/src/chat/AttestationDetails.tsx` L38: `gpuPass = gpu?.verdict ===
"true" || "PASS"` ignores `gpu.nonceMatches`; `nonceMatches` only toggles the cosmetic
", nonce bound" suffix (L176) and the tier-1 summary appends "NVIDIA GPU attested"
unconditionally (L217). Display-only (the GPU leg doesn't gate the tier), but the trust
claim shown is wrong and asymmetric with the TDX leg, which DOES gate on freshness
(`isFresh`). `AttestationDetails.tsx` is non-vendor → editable.

**Change.** Factor `gpu.nonceMatches` into `gpuPass` (require verdict PASS AND
`nonceMatches` for a green dot), into the dot color, and into the tier-1 summary line
(L217) so "NVIDIA GPU attested" is only appended when the GPU evidence is fresh. A
replayed-nonce GPU leg renders as not-passing (destructive dot) with an honest label.

**Files/functions:** `frontend/src/chat/AttestationDetails.tsx` (`gpuPass` L38, GPU leg
L171–180, summary L212–219).

**Acceptance.** Test: a `gpu` with `verdict: "PASS"` but `nonceMatches: false` renders a
non-green GPU leg and is NOT appended to the response-verified summary line; a fresh GPU
(`nonceMatches: true`) renders green and is appended. No change to which TIER is
computed.

---

### ST10 — [MINOR] Consume the force-reverify token so it doesn't permanently bypass the cache

**Problem.** `frontend/src/lib/useModelVerification.ts` L139/L183: `setForce` is set but
never reset. The effect depends on `[model, force]` (L180); once forced, every A→B→A
switch back to the forced model re-deletes `cache`+`inflight` (L157–158) and relaunches a
full probe (deleting `inflight` also permits a second concurrent probe).

**Change.** Consume the force token after the forced probe commits — e.g. clear `force`
(or mark it consumed in a ref) once `runVerification` resolves for the forced model, so
subsequent selections of that model hit the cache again. Preserve the intended behavior:
a single `reverify()` click forces exactly one fresh probe (fresh enclave nonce →
re-proves liveness), then normal caching resumes.

**Files/functions:** `frontend/src/lib/useModelVerification.ts` (`useEffect` L141–180,
`reverify` L182–184; add a consumed-ref).

**Acceptance.** Test: after one `reverify()`, the model probes once; switching away and
back to that model does NOT re-probe (cache hit) and does NOT delete `inflight`. A
second `reverify()` still forces a fresh probe.

---

### ST11 — [MINOR] Validate the REDPILL_DEFAULT_MODEL override (warn + fall back)

**Problem.** `backend/src/routes/chat.ts` L35–36: `defaultModel()` returns
`process.env.REDPILL_DEFAULT_MODEL` verbatim despite the adjacent comment requiring a
`phala/*`, non-blocklisted id. A stale env value (e.g. the pre-PR `openai/gpt-5-mini`)
makes every model-less `POST` self-deny: ST2's offered-model gate (or the paywall 402)
rejects it on every tier.

**Change.** Validate the override at boot (module init) or first use: if
`REDPILL_DEFAULT_MODEL` is set but is non-`phala/*` or blocklisted
(`isBlocklistedModel`), `console.warn` loudly and fall back to `DEFAULT_BASELINE_MODEL`.
`defaultModel()` returns only validated values. Keep it read-at-call-time-compatible or
memoize a validated value; the validation itself must be deterministic.

**Files/functions:** `backend/src/routes/chat.ts` (`defaultModel` L35–37,
`DEFAULT_BASELINE_MODEL` L34), `backend/src/billing/catalog.ts` (`isBlocklistedModel`).

**Acceptance.** New backend test that SETS `REDPILL_DEFAULT_MODEL` to a non-phala id
(distinct from the existing ST6 test, which DELETES the var): `defaultModel()` returns
`DEFAULT_BASELINE_MODEL` and a warning is logged; a valid `phala/*` override is returned
unchanged. Suite green.

---

### ST12a — [MINOR] Extract one upstream-relay helper with a timeout

**Problem.** The four upstream-relay blocks are copy-pasted:
`backend/src/routes/nras-proxy.ts` POST (L36–54) + GET `/jwks` (L62–76),
`backend/src/routes/phala-verify.ts` POST (L31–49), `backend/src/routes/signature.ts`
GET (L31–61). None set an upstream timeout, so a hung upstream hangs the request.

**Change.** Add `relayUpstream(res, url, init, label)` (e.g. in a new
`backend/src/routes/relay.ts` or a shared util) that performs the fetch with
`AbortSignal.timeout(...)`, on success relays status + content-type + body verbatim, and
on failure returns the existing `502 { error: "upstream_error", message }`. Refactor all
four blocks to call it. Behavior (verbatim relay, no server-side verdict) must be
byte-for-byte preserved — this is forge-proof passthrough; do not add parsing.

**Files/functions:** `backend/src/routes/relay.ts` (new) + `nras-proxy.ts`,
`phala-verify.ts`, `signature.ts`.

**Acceptance.** All four routes call the shared helper; a test asserts an upstream that
never resolves yields a 502 (timeout) rather than hanging, and that status/body are still
relayed verbatim on success. The 147-test suite (existing proxy tests) stays green.

---

### ST12b — [MINOR] Make the vendor URL redirects self-verifying across upstream bumps

**Problem.** `frontend/src/lib/vendor/redpill-verifier/VENDOR.md` documents the update
procedure as "copy upstream over this directory," which silently reverts the 3 redirected
fetch URLs (signature/NRAS/Phala) on the next bump.

**Change.** Add a checked-in patch/verify script — e.g.
`scripts/apply-vendor-redirects.mjs` that re-applies the 3 redirects, plus a test that
greps `frontend/src/lib/vendor/redpill-verifier/**` for direct `api.redpill.ai` /
`nras.attestation.nvidia.com` / `cloud-api.phala.network` fetches in the redirected code
paths and FAILS loudly if a redirect was lost. The vendor files themselves are NOT edited
by this subtask (constraint 1) — the script/test only guard them. Update VENDOR.md to
reference the script.

**Files/functions:** `scripts/apply-vendor-redirects.mjs` (new), a new test (frontend or
a repo-level grep test), `frontend/src/lib/vendor/redpill-verifier/VENDOR.md` (doc only).

**Acceptance.** A test fails if any of the 3 redirected fetch sites reverts to a direct
upstream URL; running the script re-applies the redirects idempotently. Vendor source
otherwise byte-identical to upstream.

---

### ST12c — [MINOR] parseResponseHash fails safe on unexpected colon-part counts

**Problem.** `frontend/src/chat/verification-predicates.ts` L67–72: for a `sig.text`
with an unexpected number of colon-separated parts (≠2 and ≠3) it returns
`parts[1]` regardless, i.e. a model-name fragment masquerading as a hash.

**Change.** Return `null`/`undefined` when `parts.length` is neither 2 nor 3 (only the
documented `reqHash:respHash` and `model:reqHash:respHash` shapes yield a hash). The
caller (`ModelVerificationBadge.tsx` L163–165) already treats a null hash as "not bound"
(`replyBound=false`), so this is fail-safe.

**Files/functions:** `frontend/src/chat/verification-predicates.ts` (`parseResponseHash`
L67–72), covered by `verification-predicates.test.ts`.

**Acceptance.** Unit test: a `sigText` with 1 or 4+ colon parts returns
null/undefined (→ `replyBound=false`, never green); the 2-part and 3-part shapes still
return the correct `respHash`.

---

## Regression note — deterministic checks that MUST stay green

Run after every fix round; all must pass before the round is accepted:

1. **Backend typecheck** — `cd backend && bun run typecheck` (or the repo's tsc check).
2. **Backend test suite** — the full suite (147 tests at PR time) plus the new tests
   from ST2, ST5, ST11, ST12a. No net deletions; new behavior adds coverage.
3. **Frontend build** — `cd frontend && bun run build` (tsc + vite) green, plus the
   new/updated frontend tests from ST1, ST4, ST6–ST10, ST12b, ST12c.

A round that reds any of these, weakens a trust check (constraint 2), edits vendored
files beyond the 3 redirects (constraint 1), or regresses instant boot / June-5 history
(constraint 4) is rejected regardless of what else it fixes.
