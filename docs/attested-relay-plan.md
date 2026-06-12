# Attested Relay Signing — Implementation Plan (Option A)

## Why

The per-message "Response verified" (green) tier is unreachable on prod, and the
expanded panel shows a red **"Signature invalid — signer: 0x…"** even though the
signature is cryptographically valid. Root cause (confirmed live, 2026-06-11):

RedPill's enclave signs `sha256(request_body):sha256(response_body)` over the
HTTP exchange **between the gateway and the enclave**, not the exchange we see.
The gateway rewrites both bodies (the signed text names the upstream model,
e.g. `Qwen/Qwen3.6-35B-A3B-FP8`, not the `phala/` alias; substituting the name
back does NOT reproduce either hash; raw bytes, content-only, reasoning
variants, stream and non-stream all miss). A hash of HTTP bytes only binds the
two endpoints of one HTTP exchange — we are two hops downstream, so
`replyBound` (ST2) is false for every model, and `assembleSignatureState`
mislabels the result "Signature invalid".

**The fix is to add the binding leg we CAN prove**: our relay backend already
runs in an attested Phala CVM (teal "Backend attested", PR #15). Have it sign
the reply it forwards with the same key the attestation already binds, and
verify that signature in the browser. Claim becomes: *every machine that
handled this reply is an attested TEE, and the bytes on screen are exactly the
bytes the attested relay received from RedPill.*

## What already exists (verified in code)

| Piece | Where | Status |
|---|---|---|
| secp256k1 backend account, address bound into quote `report_data` | `backend/src/attestation/selfAttest.ts` (`buildBackendReportData`) | ✅ shipped |
| Browser verification of that binding (+ RTMR3 replay, nonce freshness) | `frontend/src/lib/backendAttestation.ts`, `useBackendAttestation.ts` | ✅ shipped, module-cached per backend URL |
| Relay already accumulates concatenated `delta.content` per stream | `backend/src/routes/chat.ts` `UsageScanner.completionText` | ✅ exists (used for billing estimates) |
| Per-message completion-ref capture (messageId → completionId/model) | `frontend/src/lib/completionStore.ts`, populated by `runtime.tsx` | ✅ shipped |
| Pure predicate layer + unit tests for badge verdicts | `frontend/src/chat/verification-predicates.ts` (+ `.test.ts`) | ✅ shipped |
| `backendPrivateKey` wired into router factories | `backend/src/index.ts` | ✅ same key available to chat router |

## Hash preimage — the load-bearing decision

The whole RedPill failure happened because the preimage wasn't reproducible by
the verifier. Ours must be definable on both sides byte-for-byte:

```
preimage  = concatenation of every `choices[0].delta.content` string,
            in order, from the SSE chunks forwarded to the client
hash      = sha256(preimage), lowercase hex
message   = `tinychat-relay-sign-v1:${completionId}:${model}:${hash}`
signature = viem account.signMessage(message)   // EIP-191, same as nonce_signature
```

- Backend side: `UsageScanner.completionText` is already exactly this.
- Frontend side: the badge's `renderedText` (joined text parts) must equal it.
  This equality is asserted by unit test AND one live E2E — non-negotiable,
  it's the lesson of the RedPill post-mortem.
- `reasoning_content` deltas are deliberately EXCLUDED (not rendered).
- Freshness: not needed — the signature arrives in-band on the same TLS
  response it signs; `completionId` binds it to this completion. (No nonce.)

## Phase 1 — Backend: relay signature frame (~1 day)

`backend/src/routes/chat.ts`:

1. `createChatRouter()` → `createChatRouter(config: { privateKey: string })`;
   wire `backendPrivateKey` in `backend/src/index.ts` (it's already in scope).
   Memoize `privateKeyToAccount` at factory level.
2. Extend `UsageScanner` to also capture the completion `id` from chunks
   (first chunk carries it).
3. In the stream-forwarding loop, **hold back the upstream terminator**: when
   the scanner sees the `data: [DONE]` line, do not forward it yet. After the
   upstream iterator ends (and only on clean completion — not abort/error):
   - compute the signature over the preimage above,
   - write `data: {"tinychat_relay_signature":{"v":1,"completion_id":…,"model":…,"content_sha256":…,"signature":…,"address":…}}\n\n`,
   - then write `data: [DONE]\n\n` and `res.end()`.
   On abort/error: end without a frame (client treats the reply as unsigned —
   fail-honest, never a fabricated signature).
4. Signing failure (should be impossible — key is validated at boot): log,
   still forward `[DONE]`. The reply path is never gated on signing.

Tests (`backend/src/__tests__/`): preimage equals forwarded deltas for a
multi-chunk fixture (incl. reasoning chunks excluded); frame emitted before
`[DONE]`; no frame on abort; signature recovers to the configured address.

## Phase 2 — Frontend: capture the frame (~0.5 day)

1. `frontend/src/lib/chatApi.ts`: while parsing SSE, recognize the
   `tinychat_relay_signature` frame (skip it for text rendering), surface it on
   the stream result.
2. `completionStore.ts`: extend `CompletionRef` with optional
   `relaySignature: { contentSha256, signature, address, v }`;
   `runtime.tsx` passes it through in `setCompletion`.

Tests: chatApi fixture stream with the frame → text unchanged, ref carries it;
frame absent → ref without it (old backend = graceful degrade, both directions:
old FE + new BE just ignores the frame, new FE + old BE shows no relay leg).

## Phase 3 — Badge: verify + relabel (~1–1.5 days)

New pure predicates in `verification-predicates.ts` (unit-tested, no DOM):

1. `isRelayBound({ renderedHash, frame, attestedRelayAddress })` — true iff
   `renderedHash === frame.contentSha256` AND
   `recoverMessageAddress(message) === frame.address` AND
   `frame.address === attestedRelayAddress` (the address from the CACHED teal
   backend-attestation verdict — expose a non-hook
   `getCachedBackendAttestation()` accessor mirroring
   `getCachedModelVerification`; if the backend isn't attested or no cache
   exists, the leg renders "not verified", never green).
2. **Relabel the RedPill signature leg** (the prod bug): add reason
   `"binding_unverifiable"` to `SignatureLegState` — chosen when the signature
   recovers to the enclave-attested signer (`enclaveBound`) and is fresh but
   `replyBound` is false. Label: *"Signature valid — reply binding not
   independently verifiable"*, non-destructive dot. "Signature invalid" remains
   ONLY for recovery failure / signer mismatch / malformed (ST7).
3. **Fix the contradictory footer** in `AttestationDetails.tsx`: when
   `signature != null`, the tier-2 honesty line must not say "this model does
   not sign individual responses". Three variants: signature present (explain
   the gateway-rewrite limitation), no signature + teal model, model-level.
4. New leg in `AttestationDetails`: *"Relay signed — reply bound to attested
   TinyCloud relay"* with a `RELAYED — TEE` trust tag, shown whenever a frame
   was captured (ok/fail by `isRelayBound`). Renders on BOTH tiers (teal models
   get it too — it's model-agnostic).

**Tier semantics (decision):** keep the existing three tiers and their gates
unchanged — green stays unreachable until RedPill fixes gateway-side signing.
`relayBound` is an additive leg, not a tier upgrade. Rationale: green's
documented claim is "reply bound to the *model enclave*"; relay binding proves
custody, not origin. If product later wants a fourth visual state
("Relay verified"), it's a one-line `computeTier` change with the predicates
already in place. Stricter-only, consistent with the existing honesty rules.

## Phase 4 — E2E + live verification (~1 day)

- `verification-predicates.test.ts`: full matrix for the new reason +
  `isRelayBound`.
- Bun integration test: backend fixture stream → frontend parse → predicate
  pass, asserting preimage equality end-to-end in one test.
- Playwright (channel: "chrome", persisted profile) against a local
  backend+frontend: send a message, expand the badge, assert the relay leg is
  green and the signature leg reads "valid — reply binding not independently
  verifiable". This is the check the previous feature skipped; it ships only
  after this passes against the REAL stack.

## Phase 5 — Deploy (~0.5 day)

Docker rebuild → `phala deploy` (CVM update, not create) → CF Pages
(`wrangler pages deploy`, `bun install` in build cmd) → verify live on
tinycloud.chat with a real reply. Deploy backend FIRST (frame is ignored by old
frontend; reverse order just means no leg until BE lands).

## Optional Phase 6 — RedPill gateway-attestation leg (+0.5–1 day, cuttable)

The `/v1/attestation/report` response carries `gateway_attestation` (own Intel
TDX quote, ed25519 key in `report_data`, our nonce embedded — confirmed live).
Verifying it (reuse vendored quote-check path) completes "every hop is a TEE"
with a *"Gateway attested"* leg. Independent of Phases 1–5; ship without it.

## In parallel (no code): file the RedPill request

Their gateway already holds an attested signing key. If the gateway signed the
hash of the body it sends the customer, client-side reply binding would work
for everyone and green becomes reachable again. File against
`redpill-ai/redpill-verifier` / support channel.

## Effort summary

| Phase | Effort |
|---|---|
| 1. Backend frame | 1 day |
| 2. Frontend capture | 0.5 day |
| 3. Badge verify + relabel + copy | 1–1.5 days |
| 4. Tests + live E2E | 1 day |
| 5. Deploy | 0.5 day |
| **Core total** | **~4 days** |
| 6. Gateway leg (optional) | +0.5–1 day |

## Hard constraints (grading rubric — violating any is a blocker)

1. **Reply path is never gated on signing.** Any failure in hashing/signing
   (missing key, scanner error) must still forward the stream and `[DONE]`.
   No new awaits between upstream chunks and `res.write(chunk)`.
2. **Fail-honest, never false-green.** A missing frame, hash mismatch, signer
   mismatch, or missing/cached-unattested backend attestation renders the relay
   leg failed or absent — never green. No fallbacks that fabricate validity.
3. **Preimage parity is tested, not assumed.** Backend `completionText` and
   frontend `renderedText` must be proven byte-equal for the SAME fixture
   stream (shared fixture file, read by both tests). This is the RedPill
   post-mortem lesson; a build without this test is incomplete.
4. **Tier gates unchanged.** `computeTier` keeps its existing inputs/outputs;
   relayBound must NOT upgrade any tier. Green stays unreachable.
5. **"Signature invalid" only for cryptographic failure** (recovery throws,
   recovered ≠ claimed, claimed ≠ attested). Valid-but-unbindable gets
   `binding_unverifiable`, valid-but-stale keeps `nonce_not_fresh`.
6. **Forwarded bytes stay byte-identical except the terminator handling**: the
   only permitted change to the relayed stream is holding back the final
   `data: [DONE]` line and emitting the signature frame before it.
7. **Old client / old server compatibility.** New frontend with old backend
   (no frame) shows no relay leg and no error; old frontend with new backend
   ignores the frame (it carries no `choices`, so parsers must skip it — and
   the existing UsageScanner-style parsers already do).
8. **No localStorage of signatures, no backend verdict endpoints.** The
   browser computes the verdict; the backend only signs what it forwarded.

## Precedence rules (for audit/fix loops)

1. These Hard constraints beat any specific code suggestion elsewhere in this
   document. If a snippet conflicts with a constraint, the constraint wins.
2. The existing shipped behavior (teal backend attestation flow, billing
   scanner, tier composition, vendored verifier byte-identity) beats this
   feature: when in doubt, leave shipped code paths unchanged and add beside
   them.
3. Exact message format is normative: `tinychat-relay-sign-v1:${completionId}:${model}:${contentSha256}`
   signed via viem `signMessage` (EIP-191). Auditors flag deviations as
   blockers; fixers change the deviating side to match THIS string, never
   invent a new format.
4. If a finding asks for scope beyond this plan (new tiers, persistence,
   gateway leg), record it as a `nit` recommendation — do not implement.
5. Phase 4's live-browser Playwright pass and Phase 5 deployment run OUTSIDE
   the automated audit/fix loop (they need a real backend + real attestation,
   unavailable in-loop). In audit rounds their absence is a `nit` (tracked,
   never fixed in-loop); fixers must not create Playwright tests or deploy
   scripts in response to such findings.

## Risks / edge cases

- `renderedText` vs `completionText` drift (assistant-ui normalization,
  multi-part messages) — covered by the integration test; if they ever diverge
  the leg fails closed (never false-green).
- `[DONE]` hold-back must not stall: if upstream ends without `[DONE]`, still
  emit frame + `[DONE]` on clean end; on error, end plain.
- Client abort mid-stream → no frame → no leg. Fine.
- Backend key rotation between attestation cache and message: `isRelayBound`
  compares against the cached attested address; on mismatch the leg fails —
  user can re-verify (teal indicator `reverify()`) and re-run the badge.
- Multiple `choices` — relay always requests n=1; scanner reads `choices[0]`.
