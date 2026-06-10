# RedPill Verifier Integration — Authoritative Plan

> **Goal:** Replace TinyChat's bespoke verification stack with RedPill's **own**
> open-source verifier (`@redpill-ai/verifier`), wired the way RedPill's `verify()`
> API is designed to be used. Claim **exactly** what RedPill claims — no custom
> 4-leg reimplementation, no attempt to "fix" gaps RedPill itself doesn't close.
> Less code, matches upstream, honest by construction.
>
> **This document is authoritative.** Where this summary is vaguer than a concrete
> code reality you discover, prefer the code — but never weaken a Hard Constraint
> or a Locked Decision below.

This plan is consumed by the `tinychat-redpill-verifier` Smithers workflow. The
workflow branches fresh off `main` (NOT off `verifiable-inference`), re-vendors the
package, wires two backend passthroughs, forks exactly two fetch URLs, renders a
badge, and loops regression → audit → fix until clean.

---

## Locked decisions (confirmed with the requester — do not relitigate)

1. **Trust model: BROWSER-RUNS-VERIFIER.** The browser computes the verdict. The
   backend does only two *forge-proof* passthroughs (signature + NRAS) that compute
   **no** server-side verdict. The user's own device is the root of trust. (A
   TEE-backend was considered and rejected: it only closes the gap if the browser
   verifies the backend quote and binds the result — strictly more code, and it
   widens trust to Phala + reproducible builds. "Verify later, yourself" is an
   honor-system promise, not verification.)

2. **Proxy wiring: FORK EXACTLY TWO FETCH URLS.** RedPill's own verifier does no
   proxying (it's a Node CLI calling `api.redpill.ai` + NVIDIA NRAS directly with the
   key in hand). The proxy is our *browser-only* adaptation. Change only the fetch
   URLs in `fetchSignature` and `checkGpu` to point at our proxies; leave **every
   other line of verification logic byte-identical**. Document the two-line deviation
   in `VENDOR.md`. Do **not** rewrite `API_BASE` or broadly re-route `/v1/*`.

3. **Badge: MIRROR RedPill's CLI presentation.** RedPill's CLI prints: `VERIFIED` /
   `NOT VERIFIED` (the `verified` boolean), `Signature valid — signer: {address}`,
   model, provider, hardware array, and the per-leg attestation breakdown (TDX quote,
   report-data binding, nonce, GPU, compose hash, sigstore, on-chain DCAP). It does
   **NOT** print `responseHashMatch`, `requestHashMatch`, or any `model_name`-vs-request
   comparison. **Render the same fields RedPill renders; OMIT the secondary signals.**

4. **Model catalog: LEAVE AS-IS this pass.** Do not re-curate `FLAT_MODEL_BASENAMES`
   or change the picker/default in this work. The badge verifies whatever model the
   response used; for a non-TEE model, `verify()` naturally yields not-verified /
   unavailable — surface that honestly, do not hide it.

---

## What RedPill's `verified` actually means (so the copy is honest)

From the vendored `verify.ts` (verbatim logic):

- `verifyModel().verified = lightValid && deepValid && providerValid && chutesValid`.
  `lightValid = tdxResult.verified` (**the Intel TDX quote is valid**). `deepValid`
  **defaults to `true` in a browser** (the dstack Docker "deep" path is unavailable
  client-side). Provider/chutes checks default to `true` unless that exact provider.
  → In a browser this reduces to **"a valid Intel TDX quote (+ NVIDIA GPU attestation
  when present)."**
- `verify().verified = verifyModel().verified && signatureValid`, where `signatureValid`
  = "the per-message signature ECDSA-recovers to `signing_address`" (EIP-191).
- **`responseHashMatch` / `requestHashMatch` are OPTIONAL and EXCLUDED from `verified`.**
  RedPill's own SDK reports `verified: true` even when the displayed response does not
  hash-match the signed digest (its gateway re-chunks reasoning models, so the digest
  is not reproducible from the browser-delivered stream).
- **Model identity is never checked against your request.** Nothing compares the
  attested `model_name` to the model you asked for.

**Honest copy may therefore claim only:** *"A genuine Intel TDX (+ NVIDIA) enclave
with a valid hardware quote signed this response."* Do **NOT** imply "this is model X"
or "the displayed text is provably the signed text."

---

## Starting point & the two constrained calls

The vendored package hard-codes (in `constants.ts`):
- `API_BASE = 'https://api.redpill.ai'`
- `NVIDIA_NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu'`

| Call (in the package) | Endpoint | Constraint | Handling |
|---|---|---|---|
| `fetchSignature` (`verify.ts`) | `GET ${API_BASE}/v1/signature/{id}` Bearer apiKey | **needs the key** | **proxy** → `GET <backend>/api/signature/:id?model=...` (backend injects key) |
| `checkGpu` → NRAS (`verifiers/cloud-api.ts`) | `POST NVIDIA_NRAS_URL` | **CORS-blocked** | **proxy** → `POST <backend>/api/nras-proxy` (+ `GET /api/nras-proxy/jwks` for the JWKS) |
| `fetchAttestation` | `GET ${API_BASE}/v1/attestation/report` | public, no auth | **call directly** |
| `detectProvider` | `GET ${API_BASE}/v1/models` | public | **call directly** |
| `checkTdxQuote` | `POST cloud-api.phala.network/.../verify` | **CORS-blocked in browser** (no ACAO header) — see correction below | left direct; its result is NOT used for the displayed verdict |
| on-chain DCAP (`verifyOnchain`) | `rpc.ata.network` eth_call | public, **CORS-open** | **call directly — this is the TDX leg we trust** |

Because `fetchAttestation` / `detectProvider` are public, **do not** redirect
`API_BASE`. Only fork the two constrained call sites.

### CORRECTION (2026-06-09, after live-browser test): the TDX leg

A real-browser smoke proved that `checkTdxQuote()` — which drives RedPill's
`verified` flag via `lightValid = tdxResult.verified` — does a **direct browser
`fetch` to `cloud-api.phala.network/.../verify` that is CORS-blocked** (no
`Access-Control-Allow-Origin`). So `result.verified` is **always `false` in a
browser**, even when signature + GPU + on-chain DCAP all pass. RedPill never hit
this: their verifier is a Node CLI (no CORS), and their own README + product treat
the **on-chain Automata DCAP** path as the trustless verification ("verified by
smart contract, not an API"; their product tells users to verify the `intel_quote`
at an on-chain TEE Attestation Explorer).

**Decision (confirmed): compose the displayed verdict at the BADGE LAYER** from the
legs that verify trustlessly in-browser — **on-chain DCAP (`result.onchain.verified`,
Automata) + per-message signature (`result.signature.valid`) + NVIDIA GPU** — and do
**NOT** display `result.verified` as the overall state. The vendored package stays
byte-identical (still only the two URL forks): `checkTdxQuote` is left in place (its
CORS error is caught by `verifyModel`'s try/catch and is cosmetic console noise); we
simply do not rely on its result. This keeps our backend OUT of the TDX trust chain
(the browser → public RPC → DCAP contract), which is strictly more trustless than
proxying Phala's API.

---

## Implementation — atomic subtasks (each self-verifies its build/test)

The setup phase (deterministic, before these) has already: created branch
`redpill-verifier` off `main`; copied the vendored package into
`frontend/src/lib/vendor/redpill-verifier/`; copied `backend/src/routes/signature.ts`
and `backend/src/routes/nras-proxy.ts`; and installed this plan doc. If any of those
artifacts are missing when a subtask needs them, that subtask re-creates them.

### S1 — Vendor builds cleanly (deps + polyfills)
- Confirm `frontend/src/lib/vendor/redpill-verifier/` exists (verbatim `js/src` of
  github.com/redpill-ai/redpill-verifier @ `f93cefd87eb55c92511c3ae0425665e409cedd15`,
  v1.0.0, MIT, with `VENDOR.md` + `LICENSE`). If missing, re-vendor it the same way
  (clone upstream, copy `js/src/.`, drop the Node CLI, keep LICENSE + write VENDOR.md).
  Do **not** modify its logic.
- Ensure `viem` is a frontend dependency (it is the package's sole runtime dep).
- `frontend/vite.config.ts`: re-add `vite-plugin-node-polyfills` with
  `globals: { Buffer: true, process: true, global: true }` and `reflect-metadata`
  (needed by `@peculiar/x509` for on-chain DCAP quote encoding and NRAS JWT parsing).
- Confirm the package imports cleanly: `bun --bun run build:frontend` resolves
  `@/lib/vendor/redpill-verifier` (or the relative path) with no errors.

### S2 — Backend passthroughs present, mounted, tested
- Ensure `backend/src/routes/signature.ts` exists: `GET /:id?model=...` forwards to
  `${REDPILL_BASE_URL}/signature/{id}?model=...&signing_algo=ecdsa` with
  `Authorization: Bearer ${REDPILL_API_KEY}`, relays status + bytes **verbatim**,
  computes **no** verdict. Returns 500 `no_api_key` if the key is unset.
- Ensure `backend/src/routes/nras-proxy.ts` exists: `POST /` forwards the JSON body to
  NRAS verbatim; `GET /jwks` relays NVIDIA's public JWKS verbatim. No verdict.
- Mount both in `backend/src/index.ts` behind the existing auth middleware, mirroring
  the other routes. **The nras-proxy mount needs a 4 MB JSON body limit**
  (`app.use("/api/nras-proxy", express.json({ limit: "4mb" }))`) registered *before*
  the global 64 KB `express.json()` — GPU evidence payloads are large.
- Add `backend/src/__tests__/signature-routes.test.ts` and `nras-proxy-routes.test.ts`
  (key-injection, verbatim relay, no-key path, auth-gating). Run
  `bun run build:backend && bun run test:backend` until green.

### S3 — Fork exactly the two fetch URLs (the only logic deviation)
- In the vendored `verify.ts` `fetchSignature`: change the URL from
  `${API_BASE}/v1/signature/${chatId}?...` to `${BACKEND_ORIGIN}/api/signature/${chatId}?model=...`
  and **drop the `Authorization` header** (the backend injects the key). The `apiKey`
  param becomes unused for the URL — keep the signature compatible; the proxy ignores it.
- In the vendored `verifiers/cloud-api.ts` `checkGpu`: change the NRAS `POST` URL from
  `NVIDIA_NRAS_URL` to `${BACKEND_ORIGIN}/api/nras-proxy`, and any JWKS GET to
  `${BACKEND_ORIGIN}/api/nras-proxy/jwks`.
- `BACKEND_ORIGIN` must be the **absolute backend origin** (dev: `https://localhost:3014`
  vs frontend `5186`; prod: `https://api.tinycloud.chat` vs `tinycloud.chat`). Source it
  from the frontend's existing backend-URL config / `import.meta.env` (discover how the
  rest of the frontend addresses the backend and reuse that — do not hardcode a literal).
  POSTs to the backend must carry the CSRF header `X-Requested-With: XMLHttpRequest` and
  the session bearer, exactly like the existing `chatApi.ts` requests.
- Update `VENDOR.md` to record these as the **only** deviations from upstream (file +
  line + reason). Touch **nothing else** in the vendored tree.

### S4 — Badge renders `verify()`'s fields, RedPill-style
> **Verdict composition (per the TDX-leg correction above):** the overall badge state
> is composed at the BADGE LAYER from `result.onchain.verified` (Automata DCAP) **&&**
> `result.signature.valid` **&&** the GPU leg — NOT from `result.verified` (which is
> always false in-browser because of the CORS-blocked Phala-API TDX leg). Honest copy
> names each leg: "Intel TDX quote verified on-chain (Automata DCAP) · response
> signature valid · NVIDIA GPU attested." This matches RedPill's own "verified by smart
> contract, not an API" framing and their verify-via-explorer product flow.

- New component (e.g. `frontend/src/chat/ModelVerificationBadge.tsx`) that calls
  `verify(completionId, { model, responseText?, requestBody? })` and renders:
  - Primary: `VERIFIED` / `NOT VERIFIED` from the composed verdict above (green only
    when on-chain DCAP + signature [+ GPU when present] all pass).
  - `Signature valid — signer: {result.signature.recoveredAddress}` from
    `result.signature.valid`.
  - `model`, `provider`, `hardware[]` (e.g. `INTEL_TDX`, `NVIDIA_CC`).
  - A details panel with the per-leg breakdown available on the result
    (`light.tdx`, `light.gpu`, `light.compose`, `onchain`, signer).
  - **Pending / unavailable / not-verified states are visually distinct and NEVER green.**
  - Do **NOT** render `responseHashMatch` / `requestHashMatch` / a `model_name`-vs-request
    comparison (RedPill omits them; matching RedPill is the point).
- Capture the RedPill completion id: confirm the chat path surfaces the response `id`
  from the streamed completion (the SSE `id` field). If `frontend/src/lib/chatApi.ts`
  does not yet expose it, thread it through (raw SSE → capture `id` → hand to runtime →
  badge). This is non-blocking: never delay or break the reply to verify.
- Wire the badge into the chat UI where a model/response verdict belongs (research the
  current `App.tsx` / `Thread.tsx` structure on the fresh branch and place it
  consistently with the existing design language). The badge only attempts verification
  for TEE-capable models; for others it shows a neutral "not verifiable" state.
- The browser has **no** API key. `verify()`'s `apiKey` option is unused because the
  forked `fetchSignature` goes through the proxy — pass a placeholder/empty string and
  confirm the forked code path never sends it anywhere.
- `bun --bun run build:frontend` until green.

### S5 — No bespoke verification code (must stay absent)
- The fresh branch starts from `main`, so the bespoke files never existed here. **Do
  not create** `frontend/src/lib/verifyClient.ts`, `frontend/src/lib/verifySignature.ts`,
  or a hand-rolled normalizer. The only verification logic in the tree is the vendored
  package + the thin proxies + the badge that renders `verify()`'s fields.
- Confirm there are no imports of those removed modules anywhere.

---

## Hard constraints (the grading rubric)

1. **Trustless:** nothing in the `verified` verdict rests on trusting TinyCloud's
   backend. The browser fetches signature + NRAS *through* our proxies but does the
   ECDSA recovery and signature checks itself; the proxies compute no verdict.
2. **Two-URL deviation only:** the vendored package is byte-identical to upstream
   except the two forked fetch URLs (`fetchSignature`, `checkGpu`/JWKS), documented in
   `VENDOR.md`. No `API_BASE` rewrite, no logic edits.
3. **Honest claim:** UI copy claims only "a genuine Intel TDX (+NVIDIA) enclave with a
   valid hardware quote signed this response." No "this is model X", no "displayed text
   is provably the signed text", no implied response-hash guarantee.
4. **No secondary signals in the badge:** `responseHashMatch` / `requestHashMatch` /
   `model_name`-vs-request are NOT shown (matches RedPill's CLI exactly).
5. **No bespoke stack:** `verifyClient.ts` / `verifySignature.ts` / custom normalizer
   are absent.
6. **Passthroughs are forge-proof:** signature route keeps `REDPILL_API_KEY`
   server-side and relays verbatim; nras-proxy relays verbatim (POST + JWKS); neither
   computes a verdict; both are auth-gated; nras-proxy has a 4 MB body limit.
7. **Non-blocking:** verification never delays or breaks a chat reply.
8. **Catalog untouched:** no changes to `FLAT_MODEL_BASENAMES` / default model / picker.
9. **Green builds + tests:** `build:packages`, `build:backend`, `build:frontend`,
   `test:backend`, `test:packages`, `lint` all pass.

---

## Success criteria

1. Fresh branch `redpill-verifier` off `main` with `@redpill-ai/verifier` vendored
   (only the two documented fetch-URL forks), `viem` present.
2. Browser calls `verify(completionId, { model, ... })`; the API key never ships to the
   browser; signature + NRAS go through the two verdict-free backend passthroughs.
3. A badge that renders `verify()`'s returned fields RedPill-style, with honest copy.
4. The bespoke `verifyClient.ts` / `verifySignature.ts` / normalizer are absent.
5. **Verified in a real browser** (persisted session, default `phala/gpt-oss-120b` or
   `phala/deepseek-v4-flash`): `verify()` returns `verified: true` with `signature.valid`
   true and a populated `hardware` array. (This live smoke is run manually / via the
   `vi-probe.mjs` harness after the workflow lands the code — Bun unit tests have
   `Buffer` but no DOM, so they can pass while the browser path fails. Always confirm in
   a real browser.)

---

## Test harness (reuse — a logged-in session already exists)

- Dev: frontend `https://localhost:5186` (`cd frontend && bun run dev`), backend
  `https://localhost:3014` (`cd backend && bun run dev`).
- Persisted logged-in Chrome profile: `/tmp/tinychat-chrome-profile` (account
  `0x7d03…73f2`). Drive headless via Playwright 1.60 (`channel:"chrome"`, `headless:true`,
  `launchPersistentContext`, `ignoreHTTPSErrors:true`). Playwright resolves under
  `development/.smithers`.
- Scripts: `development/.smithers/scripts/vi-capture.mjs`, `vi-probe.mjs`.
- Session token: `localStorage["xyz.tinycloud.tinychat:session"].token`.
- `REDPILL_API_KEY` lives in `backend/.env`. Public endpoints need no key; `/v1/signature`
  does.
</content>
