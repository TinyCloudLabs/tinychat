# Backend Self-Attestation Plan (tinychat)

**Goal:** Give users a way to verify that `api.tinycloud.chat` — the relay that sees their prompt plaintext — is a genuine Intel TDX CVM on Phala Cloud running the *published* tinychat backend code, bound to the backend identity (DID) they already see, with per-request freshness.

**Status:** PLAN — awaiting GO. Spikes S0a/S0b can run immediately; S0c needs one prod deploy.

---

## 1. The claim we will make (and not more)

> "The backend relay is a genuine Intel TDX enclave (verified on-chain via Automata DCAP, and by Phala's attestation service), running exactly the compose file published in the tinychat GitHub repo (image pinned by digest), controlled by the backend identity `did:pkh:…0x0E84…2a27`, attested fresh for this session (your nonce is inside the quote)."

Honest ceilings (must appear in UI copy, same style as existing tiers):
- Attests the **endpoint + code identity**, not each individual response byte.
- The Phala-verifier leg is **relayed through the backend itself** (same as the existing model tier-2 leg); the **on-chain Automata DCAP leg is the trustless anchor**. Both shown, labeled, exactly like `AttestationDetails` does today.
- `event_log` and `app_compose` are served by the backend, but they are **tamper-evident**: RTMR3 in the Intel-signed quote commits to them (browser replays RTMR3 locally).
- Image is pinned by digest in the attested compose, but the image build itself is not reproducible — the digest links to GHCR/CI, not to source bytes. (Future: reproducible builds.)

## 2. Why this is credible (binding chain)

1. **Genuine TDX**: quote verifies via Automata DCAP on-chain (trustless, already proven to work in-browser for RedPill quotes — same TDX v4 format) + Phala hosted verifier (relayed, via existing `/api/phala-verify` proxy unchanged).
2. **Freshness + identity**: `report_data = sha256("tinychat-backend-attest-v1" || backendAddress || clientNonce)` (32 bytes, fits the 64-byte field; guest agent zero-pads, does NOT hash — POST path confirmed raw in dstack guest-agent source). Browser recomputes locally. Backend also signs the nonce (EIP-191, viem) with `BACKEND_PRIVATE_KEY`; browser recovers the signer and checks it equals the address in `report_data` AND the address inside `/api/server-info`'s DID. → a non-TEE impostor can't replay someone else's quote (wrong report_data) and can't forge the key-possession proof.
3. **Code identity**: dstack records `compose-hash` (= SHA256 of `app-compose.json`, which embeds our `docker-compose.phala.yml`) as an RTMR3 event at boot. Browser: replay RTMR3 from `event_log` (SHA384 chain from 48 zero bytes — `crypto.subtle` supports SHA-384) → must equal quote's `rtmr3`; then `sha256(app_compose) == compose-hash event digest`. The deploy workflow **already pins the backend image by SHA into docker-compose.phala.yml before deploy** (deploy-backend-phala.yml:168-169), so the attested compose binds the exact image digest. UI links the compose's `docker_compose_file` content + the GitHub file for eyeball/string comparison.
4. **Independent checks** (links, zero code): proof.t16z.com (paste quote), `cloud-api.phala.network/api/v1/attestations/view/{checksum}`, Trust Center `trust.phala.com/app/{app_id}` (S0a confirms availability), and — if live on our ingress image — `https://api.tinycloud.chat/evidences/` (dstack-ingress TLS-cert-in-TEE proof: `quote.json` report_data = sha256 of `sha256sum.txt` covering the LE cert).

## 3. Verified integration facts (from exploration, 2026-06-11)

**Repo (tinychat, redpill-verifier merged):**
- `docker-compose.phala.yml`: backend service has NO volume mounts; only `dstack-ingress` mounts `/var/run/dstack.sock` (line 47). Backend base image `oven/bun:1.3.9`, entry `bun run start`, port 3001.
- `BACKEND_PRIVATE_KEY` loaded at `backend/src/index.ts:34`; identity via `createTinychatBackendIdentity` (`backend/src/startup.ts:20-24`) → `{node, did}`. No arbitrary-message signing helper exists — add viem (`privateKeyToAccount(...).signMessage`); viem already in frontend, NOT in backend deps.
- Route conventions (`backend/src/index.ts:81-129`): per-route json limits before global 64kb (nras 4mb, phala-verify 256kb); global CSRF middleware; verification proxies are auth-gated (Bearer + X-Requested-With) with their own rate-limit bucket; public routes = /health, /api/manifest, /api/server-info, /api/auth.
- Passthrough pattern: `backend/src/routes/phala-verify.ts` + `relay.ts` (`relayUpstream(res,url,init,label,timeout)`).
- Vendored verifier (3 documented forks, otherwise byte-identical): `checkTdxQuote(quoteHexOrB64)` POSTs `{hex}` to `/api/phala-verify` — **reusable for an arbitrary quote**; `verifyOnchain(quoteHex, 'automata-mainnet')` → `{verified, quoteHash, network, contract, explorer}` — **reusable**; `checkCompose` checks the RedPill `mr_config = 0x01{hash}` format — **NOT our mechanism** (ours is RTMR3 event-log replay → new util, not a vendored edit).
- Frontend patterns to mirror: `useModelVerification.ts` (module-level cache Map + inflight dedupe + generation counter; cache positive verdicts only), `AttestationDetails.tsx` (leg rows, relayed/trustless labels, honesty line), `signatureClient.ts` (SessionStore token + CSRF headers, never-throw), `BACKEND_ORIGIN` = `VITE_BACKEND_URL || localhost:3014`.
- Tests: `bun:test`, global fetch mock + restore, temp express server on random port, assert relay-verbatim + auth-gating (`__tests__/phala-verify-routes.test.ts`).
- Settings page exists (`SettingsPage.tsx`, sections Account/Memory/Data/Plan & Usage/Appearance) — natural mount point; header is space-constrained by the mobile 3-button rule.

**dstack/Phala (web research, sources in agent report):**
- Guest agent socket `/var/run/dstack.sock` (tappd.sock = legacy). SDK `@phala/dstack-sdk` 0.5.8: `DstackClient.getQuote(reportData)` POSTs `{report_data: hex}` to `/GetQuote`; ≤64 bytes, **raw, not hashed** (guest-agent `pad64` confirmed in source); returns `{quote, event_log, replayRtmrs()}`. `info()` returns `app_id, instance_id, app_cert, tcb_info, compose_hash, app_compose, os_image_hash, mr_aggregated…`.
- SDK transport = node `http` + raw `net.createConnection` for unix sockets — Bun compat UNCONFIRMED. **Fallback that removes the dep entirely: Bun's native `fetch(url, {unix: "/var/run/dstack.sock"})`.** (S0b decides.)
- Phala hosted verifier: POST `{"hex": …}` → `{success, quote:{header, body:{mrtd, rtmr0-3, reportdata}, verified}, checksum, quote_collateral}`. **Does NOT return the event log** → we must ship `event_log` from getQuote and replay RTMR3 in the browser.
- Automata `AutomataDcapAttestationFee` v1.1 on Automata Mainnet (chainId 65536, rpc.ata.network): `0x27188ABA3a26CBb806eF4C67de9b05D7d792EC10`; verifies TDX v4. NOTE: check address the vendored `onchain.ts` uses — RedPill quotes verified fine with it, so reuse as-is; only flag if S0c fails.
- Known docs discrepancy: GET `/GetQuote?report_data=` may sha256 the input (old docs) vs POST path raw (current source). **Use the POST path; confirm empirically in S0c.**

## 4. Design decisions (defaults, flag at review)

| # | Decision | Default | Rationale |
|---|----------|---------|-----------|
| D1 | Endpoint auth | **Auth-gated** (Bearer+CSRF), same bucket as phala-verify | Consistent with all verification proxies; quote gen is cheap but rate-limit anyway. Follow-up: public pre-sign-in variant if wanted. |
| D2 | Quote per request vs cached | **Fresh quote per verify call** (client nonce in report_data) | That's the whole freshness point; rate limiter bounds cost. |
| D3 | Key bound in report_data | **`BACKEND_PRIVATE_KEY` address** (the existing DID) | Binds the identity users already see in /api/server-info; no new key mgmt. dstack `getKey` derived key = future alternative. |
| D4 | UI placement | **Settings → new "Infrastructure" section** + one cross-link line in model `AttestationDetails` ("backend relay: attested → view") | Header is mobile-budgeted (3-button rule); settings page was built exactly for this kind of surface. |
| D5 | Vendored package | **Untouched** (stays 3 forks) | New code lives in `frontend/src/lib/backendAttestation/`; reuses vendored `checkTdxQuote`/`verifyOnchain` as imports. |
| D6 | Local dev (no TEE) | Route returns **503 `{error:"attestation_unavailable"}`**; UI shows grey "Not attestable in this environment" | Explicit, no fake fallback (debugging-strategy rule). Optional: `DSTACK_SIMULATOR_ENDPOINT` env passthrough for dev. |
| D7 | SDK vs native | **Prefer Bun-native `fetch {unix}`** (zero deps, ~30 LOC client) if S0b passes; SDK only if needed | Removes UNCONFIRMED Bun-compat risk entirely. |

## 5. Wire contract

```
GET /api/attestation/self?nonce=<32-byte hex>        (auth-gated, CSRF, rate-limited)
  400 {error:"invalid_nonce"}  if nonce missing/not 64 hex chars
  503 {error:"attestation_unavailable", message}     if socket absent/agent error
  200 {
    quote: "<hex>",                  // TDX v4 quote, report_data = sha256(PREFIX || address || nonce)
    event_log: "<json string>",      // verbatim from guest agent (RTMR replay input)
    report_data: "<hex>",            // what we put in (pre-padding), for transparency
    identity: {
      did: "did:pkh:eip155:1:0x…",   // same as /api/server-info
      address: "0x…",
      nonce: "<echo>",
      nonce_signature: "0x…"         // EIP-191 sig over `tinychat-backend-attest-v1:<nonce>`
    },
    info: {                          // from guest agent /Info (subset)
      app_id, instance_id, compose_hash, app_compose, os_image_hash
    }
  }
PREFIX = "tinychat-backend-attest-v1" (exact bytes; documented in code + plan)
```

Browser verdict (all must pass for teal "Backend attested"):
- `legQuote` = phala-verify `quote.verified` (relayed) **OR** `verifyOnchain().verified` (trustless) — same `onchain || light.tdx` composition as model tier-2; show both legs with labels.
- `legBinding` = quote body `reportdata` startsWith `sha256(PREFIX || address || nonce)` (locally recomputed) AND `recoverMessageAddress(nonce_signature) == address` AND address == address parsed from server-info DID.
- `legCompose` = replayRtmr3(event_log) == quote `rtmr3` AND sha256(app_compose) == compose-hash event digest. (Shown as its own leg; if event_log replay fails, verdict = NOT attested — no partial green.)
- Any sub-check null/error ⇒ NOT attested (never false-positive; same rule as the critical-fixes pass).

## 6. Atomic subtasks

### Phase S0 — spikes (cheap, before any build)
- **S0a — DONE (2026-06-11)**: `https://api.tinycloud.chat/evidences/` is LIVE (200; serves acme-account.json, cert-api.tinycloud.chat.pem, quote.json — TLS-cert-in-TEE proof available today, link it in UI). app_id = `2faaa9242e190fe9cbbff7bc8667b5c4e52c3acf` (from `_dstack-app-address.api.tinycloud.chat` TXT record); `https://trust.phala.com/app/2faaa9242e190fe9cbbff7bc8667b5c4e52c3acf` returns 200 (Next.js page — confirm it renders real per-app data during T7, else drop that link).
- **S0b** (30 min, local): dstack simulator (or plain unix-socket echo server) + Bun `fetch(url,{unix})` GetQuote POST round-trip → decides D7 (native vs SDK). Also confirm `crypto.subtle.digest("SHA-384",…)` chain replay matches a known dstack event_log sample (one exists in Phala docs).
- **S0c** (post-T1 deploy, 15 min): one real `getQuote` on the prod CVM → confirm report_data lands RAW (not sha256'd) in the verified quote body; confirm Automata on-chain accepts our CVM's quote (collateral availability). **Gates T4 verdict logic; everything else can build in parallel.**

### Phase A — backend (tinychat repo)
- **T1 — infra**: `docker-compose.phala.yml`: add `volumes: [/var/run/dstack.sock:/var/run/dstack.sock:ro]` to `tinychat-backend`. No Dockerfile/CI change (compose is in-repo; CI already deploys it). *Files: docker-compose.phala.yml only.*
- **T2 — attestation service**: `backend/src/attestation/dstackClient.ts` — minimal client per S0b (Bun-native unix fetch preferred): `getQuote(reportDataHex)`, `info()`; lazy-connect; typed errors. `backend/src/attestation/selfAttest.ts` — builds report_data (sha256 of PREFIX‖address‖nonce), calls getQuote + info, signs nonce via viem `privateKeyToAccount` (add `viem` to backend deps), assembles the §5 response. *Files: 2 new + backend/package.json.*
- **T3 — route + mount**: `backend/src/routes/attestation-self.ts` (GET /, nonce validation, 503 path, calls selfAttest). Mount in `index.ts` after phala-verify, auth-gated, add to the verification rate-limit bucket. *Files: 1 new + index.ts (+~3 lines).*
- **T4 — backend tests**: `__tests__/attestation-self-routes.test.ts` per house pattern (mock dstack client module, not fetch): 200 happy shape, report_data composition exact-bytes test (fixed key+nonce vector), 400 bad nonce, 503 socket-missing, auth-gated-never-hits-agent. Unit test for `selfAttest` report_data + signature recovery round-trip. *Files: 1-2 new test files.*

### Phase B — frontend (tinychat repo)
- **T5 — verification lib**: `frontend/src/lib/backendAttestation/client.ts` (fetch /api/attestation/self with SessionStore headers, never-throw null pattern like signatureClient); `verify.ts` (the 3-leg verdict per §5 — imports vendored `checkTdxQuote` + `verifyOnchain`, local sha256/recoverMessageAddress via viem, parses server-info DID); `rtmr3.ts` (event_log parse + SHA-384 replay + compose-hash event extraction — pure, ~60 LOC). *Files: 3 new; vendored untouched.*
- **T6 — hook**: `frontend/src/lib/useBackendAttestation.ts` — mirror useModelVerification exactly (module cache keyed `"backend"`, inflight dedupe, generation counter, cache positive only, `reverify()`); statuses idle/verifying/attested/unattested/unavailable/error. *Files: 1 new.*
- **T7 — UI**: `frontend/src/chat/BackendAttestationDetails.tsx` — new "Infrastructure" card in `SettingsPage.tsx`: status pill (teal "Backend attested" / grey / red), expandable legs in AttestationDetails visual language (Quote: Phala [RELAYED] + on-chain [TRUSTLESS] · Identity binding: report_data + nonce sig + DID match · Code: RTMR3 replay + compose hash, with "view compose on GitHub" link to the pinned-digest docker-compose.phala.yml + proof.t16z / trust-center / /evidences/ links per S0a) + honesty lines (§1). One cross-link line added to `AttestationDetails.tsx` ("Relay: backend attestation → Settings"). *Files: 1 new + SettingsPage.tsx + AttestationDetails.tsx (1 line).*
- **T8 — copy/tests**: vitest/bun unit tests for rtmr3 replay (fixture event_log) + report_data recompute; lint/build green; update `docs/` plan copy installed as `tinychat/docs/backend-attestation-plan.md`.

### Phase C — ship + live verify (sequenced; needs prod CVM)
- **T9 — deploy + S0c**: merge T1-T4 (route returns 503 until socket lands → safe), redeploy via existing GH Action, run S0c probe against prod, adjust verdict constants if report_data semantics differ (only T5 touched).
- **T10 — live browser smoke (ME, not relayed)**: prod + local-frontend-against-prod-backend: Settings shows teal "Backend attested" with all 3 legs green; tamper checks: wrong nonce → unattested; screenshots as evidence.

### Workflow notes (if built as smithers tc-* run)
- Static task plan (T1-T8), PATH_RULES allowlist per task above; vendored dir + runtime.tsx FORBIDDEN; regression = existing `redpill-verifier-regression.mjs` + new structural asserts (route mounted, vendored untouched, compose mount present); loop order audit→fix→regression; exit gate `lastFix.changed===false`.
- T9/T10 stay MANUAL (prod deploy + my own browser verification — standing lesson: don't relay smoke results).

## 7. Effort

- S0 spikes: ~1h total (+S0c after first deploy).
- Backend T1-T4: ~0.5-1 day. Frontend T5-T8: ~1-1.5 days. Ship/verify T9-T10: ~0.5 day (mostly deploy latency).
- Total: **~2-3 days**, same shape as the phala-parity/genverify phases.

## 8. Out of scope (explicit)

- Per-response signing by the backend enclave (would need response-signature plumbing; model tier-1 already covers model-side).
- Public (pre-auth) attestation endpoint — follow-up if wanted for marketing/landing.
- Reproducible image builds (digest→source binding) — future hardening.
- RA-TLS / channel binding — the /evidences/ link covers the TLS-in-TEE story if available.
