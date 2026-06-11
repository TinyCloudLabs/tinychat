# General (Model-Level) Verification Plan — verify the enclave BEFORE you send

> **Goal:** Let the user verify the model/endpoint they're about to chat with is a
> genuine TEE enclave **before sending any message** — a model-level attestation
> indicator, like RedPill's. This reuses everything we built: `verifyModel(model)`
> needs no completion, so it runs the moment a model is selected. The per-message
> badge stays for *after-send* response binding.
>
> Builds on `docs/two-tier-verification-plan.md` + `docs/phala-parity-plan.md`.
> Badge-layer + one shared hook/component; vendored package untouched.

---

## The distinction (why this is a different surface)

| | Per-message badge (built) | Model-level indicator (this plan) |
|---|---|---|
| **When** | after a reply | as soon as a model is selected (pre-send) |
| **Verifies** | THIS reply (signature binds the text) | the MODEL's enclave attestation |
| **Inputs** | completion id + signature | model only (`verifyModel`) |
| **Best tier** | "Response verified" (signed) for flat models | "Enclave verified" — there is no per-message signature *yet* |
| **Proves** | this exact text came from the enclave | you are talking to a genuine TEE enclave running an attested quote |

Model-level verification can only ever reach **"Enclave verified"** (attestation), because
there is no response to sign before you send. That's honest by construction — and it answers
the real pre-send question: *"is this endpoint actually a TEE, or am I about to leak my prompt
to a plain API?"*

A bonus property: `verifyModel` sends a **fresh random nonce** that the enclave binds into
`report_data`. So a successful model-level verify proves **liveness** — "a genuine enclave
answered MY challenge just now," not a replayed old attestation. Surface that ("freshly
verified just now").

---

## What it shows

For the **active model**, a header indicator next to the model picker:

- **"Verifying…"** (spinner) while `verifyModel` runs.
- **"Enclave verified"** (green/teal) when `mr.onchain?.verified || mr.light?.tdx?.verified`.
  Click → details panel reusing the SAME leg breakdown as the per-message badge:
  - Intel TDX quote — verified by Phala attestation service `[VIA PHALA — RELAYED]`
  - Intel TDX quote — verified on-chain (Automata DCAP) `[TRUSTLESS — ON-CHAIN]`
  - Measurements — MRTD / RTMR0..3
  - NVIDIA GPU attested (when present); report-data / manifest (when present)
  - **Signability sub-signal (the honest pre-send hint):**
    - flat/signable model (in `VERIFIABLE_MODELS`): "✓ Responses are individually signed — each
      reply can be fully verified below."
    - otherwise: "Responses are attested at the enclave level, but not individually signed."
  - "Freshly verified just now" + the nonce/timestamp.
- **"Not verifiable"** (grey) for non-TEE models (`!isTeeCapableModel`) — shown WITHOUT a probe.
- **"Couldn't verify"** (grey, graceful) if `verifyModel` throws.

Honesty line for the panel: *"Verified: you're talking to a genuine Intel TDX enclave. This
attests the endpoint, not any single reply — see each message's badge for per-response proof."*

---

## Design (reuse first — minimal new surface)

1. **`frontend/src/lib/useModelVerification.ts`** (new hook) — `useModelVerification(model)`:
   runs `verifyModel({ model })` once per model, **caches per model id** in a module-level Map
   (so switching back is instant; a manual "re-verify" forces a fresh nonce). Returns
   `{ status: "idle"|"verifying"|"verified"|"unverifiable"|"error", mr, verifiedAt }`. Auto-runs
   for the active model. Non-blocking; never gates chat.

2. **Refactor the leg breakdown** out of `ModelVerificationBadge.tsx` into a shared
   `frontend/src/chat/AttestationDetails.tsx` (`<AttestationDetails mr={mr} signature={sig?} />`)
   used by BOTH the per-message badge and the model-level panel. The per-message badge passes the
   signature (→ tier-1 green); the model-level panel passes none (→ enclave-only). Single source
   of leg-rendering + trust labels + conditional "only when present" logic.

3. **`frontend/src/chat/ModelVerificationIndicator.tsx`** (new) — the header control for the
   active model. Uses `useModelVerification(activeModel)` + `<AttestationDetails>` + the
   signability sub-signal (`isResponseVerifiableModel`).

4. **Wire it into the header** (`App.tsx`) next to the model picker. OPTIONAL: also surface on the
   empty-chat welcome screen ("You're talking to a verified TEE enclave: {model}").

5. **The per-message badge reuses the cached `mr`** from `useModelVerification` (same model) and
   only adds the signature fetch — avoids re-running `verifyModel` per message (faster, fewer
   calls). Keep its existing tiering.

---

## Honesty / trust rules (rubric)

1. Model-level "verified" means **enclave-attested**, never response-bound. The panel says so
   explicitly and points to the per-message badge for reply-level proof.
2. Reuse the existing trust labels: Phala leg `[VIA PHALA — RELAYED]`, on-chain `[TRUSTLESS —
   ON-CHAIN]`. The on-chain leg is never dropped.
3. Every leg shown only when its data is present in `mr` — never fabricated.
4. The signability hint is driven by `VERIFIABLE_MODELS` (tier-1 set) — honest about whether
   replies *will* be signable, set BEFORE sending.
5. Non-TEE models show "Not verifiable" with no network probe; a thrown `verifyModel` degrades to
   "Couldn't verify", never a raw error.
6. Vendored package stays byte-identical (the three existing fork URLs); all of this is badge-layer.
7. Verification is non-blocking — it must never delay sending a message or block the composer.

---

## Locked decisions (user-confirmed)

- **Trigger: AUTO on model select** — `verifyModel` runs automatically when the active model is
  selected / chat opens (one cached call per model id; only the active model, never all ~90).
  The indicator shows "Verifying…" → "Enclave verified" before the user types.
- **Placement: HEADER, next to the model picker** — a small shield + status beside the active-model
  picker; click to expand `<AttestationDetails>`. (No welcome-screen panel this pass.)
- **Color: DISTINCT TEAL "Enclave verified"** — visually distinct from the per-message green
  "Response verified", so endpoint-attestation is never confused with response-binding. (Reuse the
  same teal as the tier-2 "Enclave attested" badge for consistency.)

---

## Verification (real browser, mine — drive it, read the screenshots)

1. Select `phala/gpt-oss-120b` → header shows "Verifying…" → **"Enclave verified"** with the legs
   + "✓ Responses are individually signed", BEFORE sending any message.
2. Select `phala/glm-5.1` → **"Enclave verified"** + "attested at the enclave level, not signed".
3. Select `openai/gpt-5-mini` → **"Not verifiable"** (no probe).
4. Send a message on gpt-oss-120b → the per-message badge still reaches green "Response verified"
   (reusing the cached model attestation + the signature). No regression, no extra latency spike.

## Open risks the implementer MUST check
- `verifyModel` latency (now includes Phala + on-chain + GPU) — the indicator must show a spinner
  and never block; cache aggressively per model id.
- Switching models rapidly must cancel/ignore stale verifies (race) — key results by model id and
  drop out-of-order responses.
- Don't auto-verify all ~90 models (only the active one) — the picker markers already mark the
  tier-1 set statically without probing.
</content>
