# Two-Tier Verification Plan — "Response verified" vs "Enclave attested"

> **Goal:** Show a verification badge on **every TEE model**, honestly tiered by the
> strength of the guarantee — instead of green-on-some / nothing-on-the-rest. Reach
> RedPill's coverage (a badge on all confidential models) WITHOUT RedPill's dishonesty
> (one uniform "verified" that conflates a signed-response proof with a mere
> enclave-exists proof).
>
> This builds on the shipped `redpill-verifier` branch. The vendored package stays
> byte-identical (still only the two forked fetch URLs); all new logic is badge-layer.

---

## The three tiers

| Tier | Label | Color | Means | Models |
|---|---|---|---|---|
| **1** | **Response verified** | green | on-chain TDX quote **+ per-message ECDSA signature** → this exact reply was signed by a genuine enclave | flat/NearAI (gpt-oss-120b, deepseek-v4-flash) |
| **2** | **Enclave attested** | sky/indigo (NOT green) | on-chain TDX quote valid (genuine enclave) + provider policy — but **no per-response signature**, so the specific reply is NOT cryptographically bound | Tinfoil (glm-5.1), Chutes |
| **0** | **Not verifiable** | neutral grey | non-TEE model, or the quote itself can't be verified | openai/*, anthropic/*, … |

The honest distinction is **response-binding**: tier 1 proves *this reply* came from the
enclave (signature); tier 2 only proves *a genuine enclave exists running an attested
quote* — it does not bind the displayed text. The badge must never blur the two.

---

## Evidence this is grounded in (already confirmed live)

- `phala/glm-5.1` `/api/signature/{id}` returns `{ attestation_type: "tinfoil",
  intel_quote, all_attestations }` — **no `.text` / `.signature` / `.signing_address`**
  (that's why `verify()` crashed at `sig.text.split`). So Tinfoil/Chutes models carry **no
  per-message signature** → they can never be tier 1.
- But glm-5.1's report **has an `intel_quote`** → `verifyOnchain` (Automata DCAP, CORS-open,
  already works in-browser) can verify the quote → tier 2 is reachable.
- `gpt-oss-120b` / `deepseek-v4-flash`: flat shape, real per-message signature → tier 1
  (already green; must not regress).
- RedPill verifies each type via `verifyModel`'s per-type paths (signature / `verifyTinfoil`
  / `verifyChutes`), all in Node (no CORS). We reach parity by doing the same browser-side,
  but tier the claim.

---

## Design — badge-layer orchestration (vendored package untouched)

Today the badge calls `verify(completionId, {model, apiKey})`, which **mandates a signature**
(`fetchSignature` → `sig.text.split`) and throws on Tinfoil/Chutes. Replace that with badge-
layer orchestration over two vendored primitives that DON'T require a signature:

```
// 1. Attestation — works for every TEE model, no apiKey, no signature, no crash.
const mr = await verifyModel({ model });
//    → mr.onchain (Automata DCAP), mr.tinfoil, mr.chutes, mr.light, mr.hardware, mr.signingAddress, mr.provider

// 2. Per-message signature — fetched + checked by US (only flat models have it).
const sig = await fetchSignatureProxy(completionId, model);   // new small helper, /api/signature
let signatureValid = false, signer = null;
if (sig?.text && sig?.signature && sig?.signing_address) {
  signer = await recoverMessageAddress({ message: sig.text, signature: sig.signature });
  signatureValid = signer.toLowerCase() === sig.signing_address.toLowerCase();
}

// 3. Tier from results.
const tier =
  (mr.onchain?.verified && signatureValid) ? "response-verified"   // tier 1 (green)
  : (mr.onchain?.verified)                 ? "enclave-attested"    // tier 2 (sky)
  :                                          "not-verifiable";     // tier 0 (grey)
```

- `verifyModel()` needs **no apiKey** and runs fully in-browser (`fetchAttestation` +
  `detectProvider` are CORS-open — confirmed; its internal `checkTdxQuote` Phala-API call is
  CORS-blocked but caught → cosmetic; we use `mr.onchain`, not `mr.light.tdx`).
- The signature helper is the badge-callable equivalent of the forked `fetchSignature`
  (same `/api/signature/:id?model=` proxy call, bearer + `X-Requested-With`), but it returns
  `null`/parsed instead of throwing on a missing `.text`. Extract it to a small shared
  `lib/signatureClient.ts` so the vendored fork can stay as-is (documented, now unused by the
  badge) — do **not** edit the vendored package.

---

## Files to change (all frontend; vendored untouched)

1. **`frontend/src/lib/signatureClient.ts`** (new) — `fetchSignatureProxy(completionId, model)`:
   GET `<backend>/api/signature/:id?model=…` with session bearer + `X-Requested-With`; parse
   JSON; return `{text, signature, signing_address}` when present, else `null`. No throw.

2. **`frontend/src/chat/ModelVerificationBadge.tsx`** — rewrite the verdict path to the
   `verifyModel` + signature orchestration above; 3-tier state machine; per-tier styling,
   icon, label, and copy; details panel adapts per tier (see "Per-tier UI"). Keep the existing
   graceful "Not verifiable" fallback for any thrown/empty result.

3. **`frontend/src/lib/completionStore.ts`** — `isTeeCapableModel(model)` → back to "any
   `phala/` model" (attempt verification on all confidential models; the graceful fallback +
   tiering make this safe, no crash). **Keep `VERIFIABLE_MODELS`** as the **tier-1** set
   (drives the default model + the green picker shield). Add `isResponseVerifiableModel`
   (= `VERIFIABLE_MODELS` membership, tier-1) alongside the broad `isTeeCapableModel`.

4. **`frontend/src/App.tsx`** (picker) — keep the green ShieldCheck on tier-1
   (`VERIFIABLE_MODELS`). OPTIONAL: add a subtler, non-green marker (e.g. a muted Shield) on
   the other `phala/*` models to signal "confidential (TEE) — enclave-attestable", mirroring
   the two tiers. If it complicates the picker, skip and keep only the tier-1 shield.

---

## Per-tier UI (the details panel)

- **Tier 1 — "Response verified" (green, ShieldCheck):** unchanged from today — Signature
  valid + signer; Intel TDX verified on-chain (Automata DCAP); NVIDIA GPU when present; footer
  "Intel TDX quote verified on-chain · response signature valid · …".

- **Tier 2 — "Enclave attested" (sky/indigo, ShieldCheck-but-not-green):**
  - "Intel TDX quote — verified on-chain (Automata DCAP, {network})" (from `mr.onchain`).
  - Provider policy when present: Tinfoil → `mr.tinfoil` (hardware/manifest policy result);
    Chutes → `mr.chutes` (anti-tamper E2E binding + debug-mode-disabled). Show as supplementary
    legs; do **not** hard-require them (manifest repo / e2e data may be absent client-side).
  - **Explicit honesty line (required):** "This model does not sign individual responses, so
    the reply above is **not** cryptographically bound to the enclave. The attestation proves a
    genuine Intel TDX enclave produced it." 
  - Identity: model, provider, hardware.

- **Tier 0 — "Not verifiable" (grey):** unchanged.

---

## Honesty rules (grading rubric)

1. Tier 2 is **visually distinct** from tier-1 green (different color + the honesty line). Never
   the same green; never the word "verified" alone for tier 2 ("Enclave attested" only).
2. Tier 2 **requires `mr.onchain.verified`** (a genuine, on-chain-verified TDX quote). If even
   that fails → tier 0. Never show "attested" on an unverified quote.
3. Tier 1 still requires `mr.onchain.verified && signatureValid`. No regression.
4. No `responseHashMatch` / `requestHashMatch` / `model_name`-vs-request claims (unchanged).
5. Vendored package stays **byte-identical** except the two existing URL forks; all tiering is
   badge-layer. Update `VENDOR.md` only if the badge stops importing `verify` (note it, no code
   change to the package).
6. Verification stays non-blocking and user-triggered (never on the reply path).

---

## Verification (must confirm in a real browser, per tier — drive it, read the screenshots)

1. `phala/gpt-oss-120b` → **Tier 1 green "Response verified"** (regression: must still work).
2. `phala/glm-5.1` → **Tier 2 "Enclave attested"** (sky), on-chain TDX verified, the honesty
   line present, **no crash**.
3. A real Chutes model (one whose `all_attestations[0]` has `e2e_pubkey` + `gpu_evidence`) →
   Tier 2 with the E2E-binding leg; if such data is absent, on-chain-only Tier 2 is acceptable.
4. `openai/gpt-5-mini` → **Tier 0** (no green, no attestation).

---

## Open risks the implementer MUST check (don't assume)

- **Does `verifyModel` actually run `verifyTinfoil`/`verifyChutes` for these models, or does
  `provider` resolve to `'phala'` and skip them?** Inspect `mr.tinfoil` / `mr.chutes` for a real
  glm-5.1 run. If null/skipped, Tier 2 rests on `mr.onchain` alone (still honest — "enclave
  attested on-chain"); show the provider-policy leg only when present. Do NOT fabricate a policy
  result.
- Confirm `verifyModel({model})` runs end-to-end in the browser for a Tinfoil model (the
  `checkTdxQuote` CORS throw is caught; `fetchAttestation`/`detectProvider` are CORS-open).
- Some `phala/*` models may error entirely (provider/upstream down) → graceful Tier 0. Fine.

---

## Implementation path

Author a Smithers workflow `tinychat-verification-tiers` modeled on `tinychat-redpill-verifier`
but WITHOUT the git-setup phase (we're already on `redpill-verifier`, work uncommitted —
re-running setup would shelve it): a short atomic-subtask sequence (signatureClient → badge
tiering → completionStore/App markers) → deterministic regression (build + the structural
checks) → audit→fix loop. Then the orchestrator drives the real-browser per-tier verification
above and reads the screenshots. Alternatively, implement directly (3 focused files) + verify
in-browser. Either way: **confirm each tier in a real browser before claiming done.**
