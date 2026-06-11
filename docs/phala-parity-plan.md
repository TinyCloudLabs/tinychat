# Phala Parity Plan — make "Enclave attested" do the real Phala attestation

> **Goal:** The teal tier-2 "Enclave attested" badge currently shows only the on-chain
> DCAP quote check — it looks empty because it **skips the actual Phala attestation**
> (`checkTdxQuote` → `cloud-api.phala.network/.../verify`), which is CORS-blocked in the
> browser. Reach parity with what Phala/RedPill's light mode verifies by proxying that
> call — the same CORS-bypass pattern already used for the signature + NRAS legs.
>
> Builds on `docs/two-tier-verification-plan.md`. Vendored package gains a **third**
> documented fork-URL (no logic change); everything else is badge-layer.

---

## Confirmed (server-side probe of Phala's verifier with a real glm-5.1 quote)

`POST cloud-api.phala.network/api/v1/attestations/verify {hex}` → `200`:
```
success: true,  quote.verified: true
quote.header: { version 4, tee_type TEE_TDX, ak_type ECDSA_P256, ... }
quote.cert_data: Intel SGX PCK certificate chain (-----BEGIN CERTIFICATE-----)
quote.body: { tee_tcb_svn, mrseam, mrsignerseam, seamattributes, tdattributes,
              xfam, mrtd, mrconfig, mrowner, mrownerconfig, rtmr0..3, reportdata }
+ quote_collateral, node_provider, checksum, verified_at
```
This is the real TDX quote verification (cert chain + TCB + signature) plus the parsed
measurements — exactly the depth the teal badge is missing. It's `checkTdxQuote`'s call.

Note: glm-5.1's `mrconfig` is all-zeros and its report carries no `app_compose`, so the
`checkCompose` (manifest-hash) leg won't apply to it — show it only when present. The
substantive parity wins for glm-5.1 are: **Phala's TDX verdict + the measurements**
(MRTD, RTMRs) + TCB, on top of the trustless on-chain DCAP.

---

## Implementation

### 1. Backend — `POST /api/phala-verify` (new verdict-free passthrough)
- `backend/src/routes/phala-verify.ts`: forward the JSON body to
  `${PHALA_TDX_VERIFIER_URL ?? "https://cloud-api.phala.network/api/v1/attestations/verify"}`
  and relay status + bytes **verbatim**. No server-side verdict. Mirror
  `nras-proxy.ts` exactly (it's the same shape).
- Mount in `backend/src/index.ts` behind auth, with a JSON body limit (~256kb — the hex
  quote is a few KB but give headroom), registered before the global 64kb parser (like
  the nras-proxy mount).
- Add `backend/src/__tests__/phala-verify-routes.test.ts` (verbatim relay, auth-gated,
  no verdict). `bun run build:backend && bun run test:backend` green.

### 2. Vendored — third fork URL (documented; no logic change)
- `verifiers/cloud-api.ts` → `checkTdxQuote`: change `PHALA_TDX_VERIFIER_URL` to
  `${BACKEND_ORIGIN}/api/phala-verify` and add the `tinychatBackendHeaders(true)` (session
  bearer + CSRF) — reuse the existing `BACKEND_ORIGIN` + `tinychatBackendHeaders` helper
  already in that file (added for the NRAS fork). Drop `PHALA_TDX_VERIFIER_URL` from the
  import if now unused. **Touch nothing else.**
- Update `VENDOR.md`: now **three** forked fetch URLs (signature, NRAS, Phala TDX verify),
  all CORS/key-bypass passthroughs; every other line byte-identical.

### 3. Badge — surface the real Phala attestation on tier-2 (and tier-1)
With the fork in place, `verifyModel({model})` runs full light mode in-browser, so
`mr.light.tdx` populates (`{verified, quote:{header, body:{mrtd, rtmr0..3, mrconfig,
reportdata, ...}}}`), and `mr.light.reportData` / `mr.light.compose` populate when data
allows. Update `ModelVerificationBadge.tsx`:
- **Tier-2 verdict** becomes: `mr.onchain?.verified || mr.light?.tdx?.verified` (the quote
  is verified by the trustless on-chain path AND/OR Phala's verifier). Keep tier-1
  (`+ signatureValid`) and tier-0 unchanged.
- **Tier-2 legs** (show each only when present, never fabricate):
  - "Intel TDX quote — verified by Phala attestation service" (`mr.light.tdx.verified`).
  - "Intel TDX quote — verified on-chain (Automata DCAP, {network})" (`mr.onchain`, the
    trustless anchor — keep).
  - "Measurements — MRTD {short}, RTMR0..3 present" (from `mr.light.tdx.quote.body`).
  - "Report-data binding" (`mr.light.reportData`) and "Manifest hash matches measured
    config" (`mr.light.compose`) — **only when present** (absent for glm-5.1).
  - Provider policy (`mr.tinfoil` / `mr.chutes`) — only when present.
- **Keep the honesty line** (tier-2 still has no per-response signature → the reply is not
  bound to the enclave). Tier-2 stays sky, never green.
- **Trust labelling:** mark the Phala-verifier leg as "via Phala (relayed)" vs the on-chain
  leg as "trustless (on-chain)", so the user can see which leg trusts whom. The Phala leg's
  verdict is relayed through our backend (trusts Phala + our relay); the on-chain DCAP leg
  is the trustless anchor. This is additive — the on-chain leg is not removed.

---

## Honesty / trust rules (rubric)

1. Tier distinction unchanged: tier-1 (green) requires a valid per-message signature; tier-2
   (sky) never claims the reply is signed/bound — the honesty line stays.
2. The Phala-verifier leg is **labelled as relayed-through-our-backend** (trusts Phala + us);
   the **on-chain DCAP leg remains** as the trustless anchor and is shown alongside. Never
   drop the on-chain leg in favour of the Phala one.
3. Every leg (measurements, report-data, compose, provider policy) is shown **only when its
   data is actually present** in `mr` — never assumed/fabricated.
4. Backend `phala-verify` is a verbatim, verdict-free passthrough, auth-gated.
5. Vendored package byte-identical except the now-**three** documented fork URLs.
6. No `responseHashMatch` / `model_name` claims; verification stays non-blocking/user-triggered.

---

## Verification (real browser, mine — drive it, read the screenshots)

1. `phala/glm-5.1` → tier-2 "Enclave attested" now shows the **Phala TDX verdict +
   measurements (MRTD/RTMRs) + on-chain DCAP** — real verification visible, honesty line
   present, no crash.
2. `phala/gpt-oss-120b` → tier-1 "Response verified" still green; may now also show the Phala
   TDX leg + report-data/compose. Signature leg intact.
3. `openai/*` → tier-0 grey.

## Open risks the implementer MUST check
- Confirm the proxied `checkTdxQuote` actually populates `mr.light.tdx` in-browser (the
  AbortSignal timeout is 30s; Phala verify can be slow — the badge already shows a spinner).
- `checkCompose`/`checkReportData` may be absent for some models (no app_compose / no
  signing_address) — gate the legs on presence; never show a failed/empty leg as a finding.
- Does `verifyModel` resolve `provider` to run `verifyTinfoil`/`verifyChutes`? If not, tier-2
  still has the Phala TDX + measurements + on-chain legs (the parity win); show provider
  policy only when present.
</content>
