# Backend Attestation Verification — Build Plan (R-track)

Authoritative build sheet for the `tinychat-backend-attestation-verify` (`tc-ba-verify`)
Smithers workflow. This promotes the Settings → Infrastructure surface from amber
**Quote issued** to green/teal **Backend attested** by implementing the browser-side
verification of the backend self-attestation quote.

Companion design docs (in the tinychat repo):
- `docs/backend-attestation-verification-handoff.md` — task definition
- `docs/backend-attestation-smithers-plan.md` — §4 R-track + §5 path guardrails
- `docs/backend-attestation-plan.md` — §5 wire contract + verdict composition

This plan captures the **R0 spike ground truth (real prod capture, 2026-06-11)**. Those
facts OVERRIDE any guesses in the older design docs. The workflow is STATIC (no LLM
planning step — lesson from the tc-import run failures).

---

## R0 spike ground truth (REAL prod quote, 2026-06-11)

Fixtures: `.smithers/fixtures/ba-spike/{attestation.json, phala-verify.json, meta.json}`
(real prod capture; `meta.json` has the nonce that was used). These are copied into the
tinychat repo at `frontend/src/lib/backendAttestation/__fixtures__/` for unit tests.

1. **Phala verifier response** (via `POST /api/phala-verify {hex}`): top-level
   `{id, success, quote:{header, cert_data, body, verified}, checksum, quote_collateral,
   proof_of_cloud, node_provider}`. Body fields are **LOWERCASE with 0x prefix**:
   `quote.body.reportdata` (0x + 128 hex = 64 bytes), `quote.body.rtmr3` (0x + 96 hex).
   The vendored `checkTdxQuote` returns `{verified, message, quote}`, so code reads
   `result.quote.body.reportdata`. Real capture has `quote.verified === true`.

2. **report_data lands RAW, zero-padded to 64 bytes (NOT re-hashed):**
   `body.reportdata = 0x<sha256("tinychat-backend-attest-v1" + getAddress(address) + nonce)><32 zero bytes>`.
   The address MUST be EIP-55 checksummed (viem `getAddress`) BEFORE hashing — verified
   exact match against prod.

3. **nonce_signature is EIP-191** over `tinychat-backend-attest-v1:<nonce>`;
   `recoverMessageAddress` recovers `0x0E84D126A6bF22A3026580022AF0f3ed7E582a27`, which
   equals the address in the `/api/server-info` DID.

4. **RTMR3 replay (CONFIRMED formula, exact match vs Intel-signed quote):** the served
   `event_log` is a JSON string of an array of
   `{imr, event_type, digest, event, event_payload}`; ALL `imr===3` events have EMPTY
   `digest`. Derive each
   `digest = sha384( uint32LE(event_type) || ":" || event_name(utf8) || ":" || hexDecode(event_payload) )`,
   then chain `mr = sha384(mr || digest)` starting from **48 zero bytes** over imr-3
   events in order. (For events with a non-empty `digest`, use it as-is.) The browser must
   use `crypto.subtle` SHA-384 (NO node `Buffer` in frontend lib code — use `Uint8Array`).

5. **compose-hash event:** `event_payload === info.compose_hash` (hex string, sha256 of
   the app-compose envelope). **GAP:** `info.app_compose` is **ABSENT** from the current
   prod response — the backend `dstackClient.info()` only maps the top-level raw
   `app_compose`, but the dstack guest agent likely nests it (e.g. inside `tcb_info` JSON).
   So `sha256(app_compose) == compose_hash` can only fully bind after a backend fix is
   deployed. Until then the compose sub-check is **fail-honest** (incomplete, not green).

6. **Automata on-chain DCAP** (`verifyAndAttestOnChain` at
   `0xE26E11B257856B0bEBc4C759aaBDdea72B64351F` via `rpc.ata.network`) ACCEPTS our CVM
   quote: verified true. The vendored `verifyOnchain(quote, "automata-mainnet")` is
   reusable as-is.

Confirmed from the fixtures directly: `attestation.json` keys =
`[quote, event_log, report_data, identity, info]`; `identity` =
`{did, address, nonce, nonce_signature}` with address
`0x0E84D126A6bF22A3026580022AF0f3ed7E582a27`; `info` =
`{app_id, instance_id, compose_hash, os_image_hash}` (NO `app_compose`); `phala-verify.json`
`quote.body.reportdata` is 130 chars (0x + 128), `quote.body.rtmr3` is 98 chars (0x + 96),
`quote.verified === true`.

---

## Task list (STATIC — no LLM planning)

### B0 — backend app_compose extraction
- **File:** `backend/src/attestation/dstackClient.ts` — `info()` must ALSO try extracting
  `app_compose` from a nested `tcb_info` field (parse the JSON string if needed; the
  top-level value wins; absent stays `undefined`, NO fabrication). Extend
  `backend/src/__tests__/attestation-self.test.ts` coverage.
- **Honesty note:** until this deploys to prod, the `app_compose` sub-check CANNOT pass
  against live. The verdict logic must treat missing `app_compose` as a FAILED/incomplete
  sub-check (honest non-green for the compose leg), with copy that says the backend does
  not serve the compose file yet.

### F0 — fixtures
- Copy `.smithers/fixtures/ba-spike/{attestation.json, phala-verify.json, meta.json}` (from
  the development repo) into tinychat at
  `frontend/src/lib/backendAttestation/__fixtures__/` for unit tests. These are REAL prod
  captures — tests must assert against them, not synthetic shapes. Synthetic fixtures are
  allowed ONLY for cases the real capture can't express (e.g. an `app_compose`-present
  compose check, or tamper/mismatch cases).

### R1 — verify.ts (3-leg verdict)
- **File:** `frontend/src/lib/backendAttestation/verify.ts` — 3-leg verdict per design §5:
  - **legQuote** = phala (via vendored `checkTdxQuote` import) **OR** onchain (vendored
    `verifyOnchain`).
  - **legBinding** = report_data recompute (checksummed address! raw zero-padded compare
    against quote body `reportdata`) **AND** `recoverMessageAddress(nonce_signature) ==
    address` **AND** `address == server-info DID address`.
  - **legCompose** = RTMR3 replay == quote body `rtmr3` **AND** compose-hash event payload
    == `info.compose_hash` **AND** `sha256(app_compose) == compose_hash` (this last
    sub-check fails-honest when `app_compose` is absent).
  - Any null/thrown sub-check ⇒ that leg fails ⇒ overall **not attested**.
- **Test:** `verify.test.ts` using the real fixtures.

### R2 — rtmr3.ts (pure replay)
- **File:** `frontend/src/lib/backendAttestation/rtmr3.ts` — pure `event_log` parse +
  SHA-384 replay + compose-hash event extraction per the formula above (`crypto.subtle`,
  async, `Uint8Array` only).
- **Test:** `rtmr3.test.ts` asserting the replayed value equals the REAL quote `rtmr3` from
  the fixture, plus a mismatch case.

### R3 — useBackendAttestation.ts (hook)
- **File:** `frontend/src/lib/useBackendAttestation.ts` — mirror `useModelVerification.ts`
  EXACTLY (module-level cache, inflight dedupe, generation counter, positive-only caching,
  `reverify()`); statuses
  `idle/verifying/attested/unattested/unavailable/unauthenticated/error`.

### R4 — BackendAttestationDetails.tsx (UI)
- **File:** `frontend/src/chat/BackendAttestationDetails.tsx` + wire into
  `BackendAttestationPanel` in `SettingsPage.tsx` — leg rows in the
  `AttestationDetails.tsx` visual language (Leg/TrustTag/Field patterns; Phala leg labeled
  "via Phala — relayed", on-chain labeled trustless), honesty copy, external links
  (explorer link from `verifyOnchain` result, `https://proof.t16z.com`,
  `https://trust.phala.com/app/<app_id>`, `https://api.tinycloud.chat/evidences/`). One
  cross-link line in `frontend/src/chat/AttestationDetails.tsx`.

### R5 — promotion
- Green/teal **Backend attested** pill ONLY when all three legs pass; amber **Quote
  issued** remains the state for quote-fetched-but-verification-incomplete; existing
  grey/red states unchanged. Update panel copy honestly.

---

## PATH_RULES (hard allowlist — embedded in every impl + fix prompt)

**Allowed:**
- `docs/backend-attestation-*.md`
- `backend/src/attestation/dstackClient.ts`
- `backend/src/__tests__/attestation-self.test.ts`
- `backend/openapi.yaml` + `backend/src/__tests__/openapi.test.ts` (only if the schema changes)
- `frontend/src/lib/backendAttestation.ts` (+ `.test.ts`)
- `frontend/src/lib/backendAttestation/**` (new — verify.ts, rtmr3.ts, __fixtures__/, tests)
- `frontend/src/lib/useBackendAttestation.ts` (+ test)
- `frontend/src/chat/BackendAttestationDetails.tsx`
- `frontend/src/chat/SettingsPage.tsx`
- `frontend/src/chat/AttestationDetails.tsx`

**FORBIDDEN:**
- `frontend/src/lib/vendor/**` (byte-identical — the regression must assert this)
- `frontend/src/chat/runtime.tsx`
- `frontend/src/lib/threadStore.ts`
- anything billing

A subtask that would edit anything outside this allowlist must STOP, not widen scope.

---

## Workflow shape

- **Setup:** a small `scriptAgent` asserts the tinychat tree is clean and creates/reuses
  branch `feature/backend-attestation-verify` off `main`. No other git phase.
- **Implement:** static atomic tasks B0 → F0 → R1 → R2 → R3 → R4 → R5, one by one.
- **Audit loop (standing loop-order lesson — fix BEFORE regression):**
  code audit (min 85; findings to `tinychat/.ba-verify-audit/code.json` via the
  `read-audit.mjs` scriptAgent capture pattern — NEVER capture LLM echo directly) → fix →
  regression. Exit gate happy = `auditClean && regression.passed && lastFix.changed ===
  false`. `maxRounds` 4. **NO Playwright/uiux audit round** — the green path can't render
  locally (local backend has no dstack socket); the orchestrator does the live browser
  smoke personally after deploy.
- **Regression script:** wraps `.smithers/scripts/backend-attestation-regression.mjs` with
  structural asserts for this track:
  - vendored dir byte-identical vs `main`
  - new files exist
  - SettingsPage wires the details component
  - no "Backend attested" string reachable without the verdict gate
  - plus `bun --bun run build` + `bun test` of the focused backend/frontend test files + lint.

---

## Manual-only (never automated, never relayed)

- The live browser smoke against prod (the green path can only render where a real dstack
  socket exists). The orchestrator runs this personally after deploy.
- Any prod deploy. The app_compose backend fix (B0) only fully binds the compose leg once
  deployed.
