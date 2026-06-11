# Backend Attestation Verification Handoff

**Date:** 2026-06-11  
**Repo:** `TinyCloudLabs/tinychat`  
**Current branch:** `main`  
**Last merged PR:** [#14 Add backend self-attestation](https://github.com/TinyCloudLabs/tinychat/pull/14)  
**Merge commit:** `661b3b657e7c4537fd927b85beb5c3fcb4233d9f`

## Current State

Backend self-attestation quote issuance is shipped and deployed.

- Production backend deploy succeeded via **Deploy Backend to Phala Cloud** run `27371107989`.
- `https://api.tinycloud.chat/health` returns `{"ok":true,"app":"xyz.tinycloud.tinychat"}`.
- `https://api.tinycloud.chat/api/server-info` returns backend DID `did:pkh:eip155:1:0x0E84D126A6bF22A3026580022AF0f3ed7E582a27`.
- Settings -> Infrastructure now reaches the Phala/dstack socket and shows amber **Quote issued**.
- A real quote payload is returned to the frontend with Backend DID, `report_data`, and Phala `app_id`.

This is **not** the final trust state. Amber **Quote issued** is the current honest ceiling.
The next agent's job is to implement browser-side verification and promote the UI to green
**Backend attested** only when the proof legs pass.

## Important Context

The earlier docs were written before the RedPill verifier branch landed. On current `main`,
the verifier is now present:

- `frontend/src/lib/vendor/redpill-verifier/index.ts`
- `frontend/src/lib/vendor/redpill-verifier/verifiers/cloud-api.ts`
- `frontend/src/lib/vendor/redpill-verifier/verifiers/onchain.ts`

Do **not** edit the vendored verifier unless there is no other route. Prefer importing from it.

Useful exports:

- `checkTdxQuote(quote)` posts through `/api/phala-verify` and returns Phala's TDX verdict.
- `verifyOnchain(quote, "automata-mainnet")` verifies the TDX quote via Automata DCAP.
- `verifyWithDstack(quote, eventLog, vmConfig)` exists, but requires a local dstack-verifier service and is not the default browser path.

Existing backend attestation client:

- `frontend/src/lib/backendAttestation.ts`
- `fetchBackendSelfAttestation({ backendUrl, sessionStore })`
- Returns `available`, `unavailable`, `unauthenticated`, or `error`.

Existing UI:

- `frontend/src/chat/SettingsPage.tsx`
- `BackendAttestationPanel` currently displays **Quote issued** for `available`.
- Current copy explicitly says full browser-side verification is the next attestation step.

## Desired Final State

Settings -> Infrastructure should show green/teal **Backend attested** only when all required checks pass:

1. **TDX quote leg**
   - Phala hosted verifier says quote verified, via `checkTdxQuote`, and/or
   - Automata on-chain DCAP says quote verified, via `verifyOnchain`.
   - Keep trust labels honest: Phala is relayed; Automata is trustless/on-chain.

2. **Fresh backend identity binding**
   - Browser recomputes:
     `sha256("tinychat-backend-attest-v1" || backendAddress || nonce)`
   - Recomputed digest matches the quote `reportdata` prefix/body.
   - `identity.nonce_signature` recovers to `identity.address`.
   - `identity.address` matches the address in `/api/server-info` DID.

3. **App / compose identity**
   - Replay RTMR3 from `event_log` and compare to the quote's `rtmr3`.
   - Verify `sha256(info.app_compose)` matches the dstack compose-hash event or `info.compose_hash`.
   - Surface the app id and compose evidence in the UI.

Any missing, failed, or thrown check must keep the UI non-green.

## Recommended Implementation

Add new frontend modules rather than expanding `SettingsPage.tsx` directly:

- `frontend/src/lib/backendAttestation/verify.ts`
- `frontend/src/lib/backendAttestation/rtmr3.ts`
- `frontend/src/lib/useBackendAttestation.ts`
- `frontend/src/chat/BackendAttestationDetails.tsx`

Keep `frontend/src/lib/backendAttestation.ts` as the fetch/client layer unless a small migration is worthwhile.

Mirror these existing patterns:

- `frontend/src/lib/useModelVerification.ts` for cache, inflight dedupe, `reverify()`, and positive-only caching.
- `frontend/src/chat/AttestationDetails.tsx` for leg rows, trust labels, honesty copy, and external proof links.
- `frontend/src/lib/vendor/redpill-verifier/verifiers/cloud-api.ts` for auth headers and Phala verifier behavior.

Do not make the composer or chat runtime depend on backend attestation. This is an informational Settings surface.

## Technical Notes

Backend report data is built in `backend/src/attestation/selfAttest.ts`.

The prefix is exact:

```text
tinychat-backend-attest-v1
```

The nonce signature message is exact:

```text
tinychat-backend-attest-v1:<nonce>
```

Use `viem` in the frontend for:

- `sha256`
- `recoverMessageAddress`
- address checksum/normalization

Quote body shape comes from Phala verifier output, usually under:

```text
tdx.quote.body.reportdata
tdx.quote.body.rtmr3
```

Confirm exact casing/field names in code with a real production quote before locking tests.

## Tests To Add

Add focused tests before changing the UI:

- `frontend/src/lib/backendAttestation/verify.test.ts`
  - report data recompute succeeds with fixed nonce/address.
  - nonce signature recovers backend address.
  - server-info DID mismatch fails.
  - Phala/on-chain quote failure prevents green.

- `frontend/src/lib/backendAttestation/rtmr3.test.ts`
  - parses a dstack event log fixture.
  - replays SHA-384 RTMR chain.
  - compose hash match passes; mismatch fails.

- `frontend/src/lib/useBackendAttestation.test.ts` if hook behavior gets non-trivial.

- Existing tests to keep green:
  - `frontend/src/lib/backendAttestation.test.ts`
  - `backend/src/__tests__/attestation-self.test.ts`
  - `backend/src/__tests__/openapi.test.ts`

## Verification Commands

Run at minimum:

```bash
bun test frontend/src/lib/backendAttestation.test.ts
bun test frontend/src/lib/backendAttestation
bun test backend/src/__tests__/attestation-self.test.ts backend/src/__tests__/openapi.test.ts
bun run lint
bun run build
```

Then run a logged browser smoke against production:

1. Open `https://tinycloud.chat/chat/settings`.
2. Sign in if needed.
3. Click **Recheck** in Infrastructure.
4. Confirm final green state only if all proof legs pass.

## Acceptance Criteria

The handoff is complete only when:

- Amber **Quote issued** still appears for quote-only success with incomplete verification.
- Green **Backend attested** appears only after TDX, identity binding, and compose/app checks pass.
- UI shows enough proof detail for the user to inspect which legs passed.
- Local dev without dstack remains honest as **Not attestable here**.
- Production dstack quote is verified from the browser, not merely displayed.
- No vendored verifier files are modified unless the reason is documented.

## Pitfalls

- Do not wait for amber to turn green. It never will without more code.
- Do not equate successful `/api/attestation/self` with verified attestation.
- Do not trust `event_log` or `app_compose` by themselves; they matter only because the quote commits to measurements.
- Do not use a fake local unix socket as proof. It is useful only for UI plumbing.
- Do not call the state **Backend attested** unless the browser-side checks have actually passed.

## Known Good Checkpoint

As of this handoff, production has reached the expected intermediate state:

```text
Infrastructure
Quote issued
Backend DID: did:pkh:eip155:1:0x0E84D126A6bF22A3026580022AF0f3ed7E582a27
App: 2faaa9242e190fe9cbbff7bc8667b5c4e52c3acf
```

That is the starting point for the next implementation pass.
