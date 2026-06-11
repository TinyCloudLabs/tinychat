# Backend Self-Attestation — Smithers Execution Plan

Companion to [`backend-attestation-plan.md`](./backend-attestation-plan.md). That document
is the design; this one is the build sheet: what can land on current `main`, what must wait
for the RedPill verifier, the ordered subtasks with exact files/tests/acceptance, and the
path guardrails the workflow must obey.

**Branch inspected:** `codex/backend-attestation` (2026-06-11). A first implementation pass
already exists on the branch — this plan records the target state so the workflow can audit,
finish, and harden it rather than rebuild from scratch.

---

## 0. Repo reality check (what is already on the branch)

Confirmed present and aligned with the design doc §5/§6:

| Area | File | State |
|------|------|-------|
| Infra mount | `docker-compose.phala.yml` | `tinychat-backend` mounts `/var/run/dstack.sock:...:ro` ✓ |
| dstack client | `backend/src/attestation/dstackClient.ts` | Bun-native `fetch(url,{unix})`, `existsSync` guard, typed `DstackUnavailableError` ✓ (D7 native path chosen) |
| Attest service | `backend/src/attestation/selfAttest.ts` | `buildBackendReportData` = SHA-256(prefix‖checksummed address‖nonce); `selfAttest` signs `prefix:nonce` via viem ✓ |
| Route | `backend/src/routes/attestation-self.ts` | GET `/`, 64-hex nonce gate → 400 before dstack, 503 on unavailable, 500 fallback ✓ |
| Mount | `backend/src/index.ts` | mounted after `/api/chat`, `authMiddleware` + dedicated `verificationLimiter` (30/15min) ✓ |
| Backend deps | `backend/package.json`, `bun.lock` | `viem ^2.52.0` added ✓ |
| Backend tests | `backend/src/__tests__/attestation-self.test.ts` | report_data exact-bytes, sig recovery, 400/503/auth-gate ✓ |
| OpenAPI | `backend/openapi.yaml` + `openapi.test.ts` | route + `BackendSelfAttestation` schema + security assertion ✓ |
| FE client | `frontend/src/lib/backendAttestation.ts` | never-throw, Bearer + `X-Requested-With`, 503→`unavailable`, 401→`unauthenticated` ✓ |
| FE client test | `frontend/src/lib/backendAttestation.test.ts` | header capture, available + unavailable paths ✓ |
| FE UI | `frontend/src/chat/SettingsPage.tsx` | "Infrastructure" `SectionCard` + `BackendAttestationPanel`; max green = amber **"Quote issued"** ✓ |
| FE wiring | `frontend/src/App.tsx` | passes `backendUrl` + `sessionStore` to `SettingsPage` ✓ |

**Vendor status:** `frontend/src/lib/vendor/redpill-verifier` **does not exist** on this branch.
Therefore every browser-side cryptographic leg (relayed Phala verify, on-chain Automata DCAP,
RTMR3 replay, compose-hash check) is **out of reach** and the deferred section below applies.

---

## 1. Implementable on current `main`

Everything that does **not** require the vendored verifier. This is the entire "honest quote
issuance + transparent display" track:

- **Backend**: socket mount, dstack unix client, report_data construction, nonce signature,
  route with nonce validation + 503 + auth-gate + rate-limit, OpenAPI documentation.
- **Frontend**: never-throw fetch client, nonce generation, Settings "Infrastructure" surface
  that calls the route with Bearer + `X-Requested-With` and reports **quote availability only**.
- **Honest ceiling**: the maximum green state is **"Quote issued"** (amber), explicitly *not*
  "Backend attested". The panel must say the full browser-proof legs are staged for the
  RedPill verifier base. (Acceptance #8, current-main half.)

All of acceptance criteria **#1–#7** are satisfiable on current `main`, plus the
current-main clause of **#8**.

## 2. Deferred until `frontend/src/lib/vendor/redpill-verifier` exists

These require importing the vendored `checkTdxQuote` and `verifyOnchain`, so they are blocked
and must NOT be attempted while the vendor dir is absent:

- `frontend/src/lib/backendAttestation/verify.ts` — the 3-leg verdict (quote leg via relayed
  Phala verify **OR** trustless on-chain; identity-binding leg; compose leg).
- `frontend/src/lib/backendAttestation/rtmr3.ts` — `event_log` parse + SHA-384 RTMR3 replay +
  compose-hash event extraction; `sha256(app_compose)` check.
- `frontend/src/lib/useBackendAttestation.ts` — `useModelVerification`-shaped hook (module
  cache, inflight dedupe, generation counter, cache-positive-only, `reverify()`).
- `frontend/src/chat/BackendAttestationDetails.tsx` — full leg-row UI (RELAYED/TRUSTLESS
  labels, honesty lines, GitHub compose link, proof.t16z / trust-center / `/evidences/` links).
- `frontend/src/chat/AttestationDetails.tsx` — one cross-link line to the backend surface.
- Promotion of the green state to teal **"Backend attested"**, gated on all three legs passing.

**Deferral gate:** a subtask in this group may run only if a pre-flight check confirms
`frontend/src/lib/vendor/redpill-verifier` is a directory. If absent → skip and leave the
"Quote issued" ceiling untouched. (Acceptance #8, RedPill-base half.)

**Also deferred (manual, never automated):** real-CVM spike S0c (report_data lands raw, not
re-hashed; Automata accepts our quote) and the live browser smoke (T10). Per the design doc's
standing lesson, do not relay smoke results — these stay operator-run.

---

## 3. Ordered subtasks (current-main track)

Each subtask lists exact files, tests, and acceptance. Because a first pass already exists,
each is framed as **finish + verify against acceptance**, not greenfield. Order respects
dependencies (infra → service → route → docs → frontend → build gate).

### M1 — Infra mount
- **Files:** `docker-compose.phala.yml`
- **Do:** ensure `tinychat-backend` has `volumes: [/var/run/dstack.sock:/var/run/dstack.sock:ro]`
  and nothing else gained a writable mount.
- **Acceptance (#4):** the `:ro` mount is present on `tinychat-backend`; `dstack-ingress`
  mount unchanged; no Dockerfile/CI edits.

### M2 — Attestation service + deps
- **Files:** `backend/src/attestation/selfAttest.ts`, `backend/src/attestation/dstackClient.ts`,
  `backend/package.json`, `bun.lock`
- **Do:** confirm `buildBackendReportData` = `sha256("tinychat-backend-attest-v1" ‖ address ‖ nonce)`
  with the **checksummed** address (matches what the browser will recompute from the DID);
  confirm `selfAttest` signs `tinychat-backend-attest-v1:<nonce>` (EIP-191) and the signer
  recovers to `BACKEND_PRIVATE_KEY`'s address; confirm dstack client lazy-connects, guards on
  `existsSync`, and raises `DstackUnavailableError` for missing socket / non-OK / bad JSON.
- **Tests:** `backend/src/__tests__/attestation-self.test.ts` (report_data exact-bytes vector +
  signature recovery round-trip — already present).
- **Acceptance (#3):** report_data formula exact; `recoverMessageAddress(nonce_signature)` ==
  backend address. No fake fallback anywhere in the service.

### M3 — Route + mount
- **Files:** `backend/src/routes/attestation-self.ts`, `backend/src/index.ts`
- **Do:** GET handler validates nonce against `/^[0-9a-fA-F]{64}$/` and returns
  `400 {error:"invalid_nonce"}` **before** any dstack call; on `DstackUnavailableError` returns
  `503 {error:"attestation_unavailable", message}`; mounted with `authMiddleware` +
  `verificationLimiter` after `/api/chat`.
- **Tests:** `backend/src/__tests__/attestation-self.test.ts` — 400-before-dstack (asserts
  `getQuote`/`info` call counts are 0), 503 path, auth-gate-before-dstack (already present).
- **Acceptance (#1, #2):** auth-gated; 64-hex validation returns 400 pre-dstack; no-socket →
  503 `attestation_unavailable` with no synthetic quote.

### M4 — OpenAPI
- **Files:** `backend/openapi.yaml`, `backend/src/__tests__/openapi.test.ts`
- **Do:** confirm `/api/attestation/self` GET is documented with `bearerAuth`, the nonce query
  param pattern, 200 `BackendSelfAttestation` schema, and 400/401/503 responses; spec test lists
  the path and asserts its security.
- **Acceptance (#6):** route + response schema documented; `openapi.test.ts` green.

### M5 — Frontend client
- **Files:** `frontend/src/lib/backendAttestation.ts`, `frontend/src/lib/backendAttestation.test.ts`
- **Do:** confirm `fetchBackendSelfAttestation` sends `Authorization: Bearer <token>` +
  `X-Requested-With: XMLHttpRequest`, never throws (returns discriminated result), maps 503→
  `unavailable`, 401→`unauthenticated` (and clears session), other non-OK→`error`; nonce is a
  fresh lowercase 32-byte hex.
- **Tests:** header-capture, available, unavailable (already present); add an `error`-path case
  if not covered.
- **Acceptance (#5, partial):** route called with Bearer + `X-Requested-With`; honest result
  states distinguish availability from proof.

### M6 — Settings Infrastructure surface
- **Files:** `frontend/src/chat/SettingsPage.tsx`, `frontend/src/App.tsx`
- **Do:** confirm the "Infrastructure" `SectionCard` + `BackendAttestationPanel` render; the
  status pill's maximum positive state is **"Quote issued"** (amber), never "Backend attested";
  the honesty line states full browser-proof legs are staged for the RedPill verifier base;
  `App.tsx` passes `backendUrl` + `sessionStore`.
- **Acceptance (#5, #8 current-main):** surface calls the route honestly; "Quote issued" is the
  maximum green state on current `main`; no copy claims full attestation.

### M7 — Build + focused-test gate
- **Files:** none (verification only)
- **Do:** run focused backend tests (`attestation-self`, `openapi`), focused frontend test
  (`backendAttestation`), backend build, frontend build.
- **Acceptance (#7):** all four green. This is the workflow's exit gate for the current-main track.

---

## 4. Ordered subtasks (RedPill-base track — run only if vendor present)

Guarded by the §2 deferral gate. Mirrors design-doc T5–T8; promotes the green state only when
all legs verify.

- **R1 — verify lib:** `frontend/src/lib/backendAttestation/verify.ts` (3-leg verdict, imports
  vendored `checkTdxQuote` + `verifyOnchain`, local sha256 / `recoverMessageAddress`, parses
  server-info DID). **Test:** report_data recompute + verdict composition.
- **R2 — rtmr3 replay:** `frontend/src/lib/backendAttestation/rtmr3.ts` (event_log parse,
  SHA-384 chain from 48 zero bytes, compose-hash extraction). **Test:** fixture event_log →
  replayed RTMR3 equals known value; compose-hash mismatch ⇒ fail.
- **R3 — hook:** `frontend/src/lib/useBackendAttestation.ts` (cache/dedupe/generation/reverify,
  statuses idle/verifying/attested/unattested/unavailable/error).
- **R4 — details UI:** `frontend/src/chat/BackendAttestationDetails.tsx` (leg rows + honesty +
  external links); wire into the Settings panel; cross-link line in
  `frontend/src/chat/AttestationDetails.tsx`.
- **R5 — promotion:** allow teal **"Backend attested"** in the Settings panel **only** when all
  three legs pass; any null/error ⇒ not-attested (no partial green).
- **Acceptance (#8 RedPill-base):** no UI says "Backend attested" until the browser proof legs
  complete; any sub-check failure keeps it red/grey.

---

## 5. Path guardrails (hard allow-list for the workflow)

**Allowed for the current-`main` implementation track:**
- `docs/backend-attestation-plan.md`
- `docs/backend-attestation-smithers-plan.md`
- `docker-compose.phala.yml`
- `backend/package.json`, `bun.lock`
- `backend/openapi.yaml`
- `backend/src/attestation/**`
- `backend/src/routes/attestation-self.ts`
- `backend/src/index.ts`
- `backend/src/__tests__/attestation-self.test.ts`
- `backend/src/__tests__/openapi.test.ts`
- `frontend/src/lib/backendAttestation.ts`
- `frontend/src/lib/backendAttestation.test.ts`
- `frontend/src/chat/SettingsPage.tsx`
- `frontend/src/App.tsx`

**Allowed additionally — IF AND ONLY IF `frontend/src/lib/vendor/redpill-verifier` exists:**
- `frontend/src/lib/backendAttestation/**`
- `frontend/src/lib/useBackendAttestation.ts`
- `frontend/src/chat/BackendAttestationDetails.tsx`
- `frontend/src/chat/AttestationDetails.tsx`

**Never touch (this feature):**
- `frontend/src/chat/runtime.tsx`
- `frontend/src/lib/vendor/redpill-verifier/**`

A subtask that would edit anything outside its track's allow-list must stop, not widen scope.

---

## 6. Acceptance bar (must hold at exit)

1. `/api/attestation/self` is auth-gated, validates nonce as 64 hex chars, and returns 400
   **before** any dstack work for an invalid nonce.
2. Local / no-socket returns `503 {error:"attestation_unavailable"}` with no fake fallback.
3. `report_data` is `sha256("tinychat-backend-attest-v1" || backendAddress || nonce)` and
   `nonce_signature` recovers to `BACKEND_PRIVATE_KEY`'s address.
4. `docker-compose.phala.yml` mounts `/var/run/dstack.sock` read-only into `tinychat-backend`.
5. Settings has an Infrastructure surface that calls the route with Bearer + `X-Requested-With`
   and honestly distinguishes quote availability from full browser proof.
6. OpenAPI documents the route and response.
7. Focused backend/frontend tests, backend build, and frontend build pass.
8. On a RedPill verifier base, browser-proof legs must be completed before any UI says
   "Backend attested"; on current `main`, "Quote issued" is the maximum honest green state.

---

## 7. Workflow notes

- **Loop shape:** audit → fix → focused-test/build regression; exit when the last fix pass
  produces no changes and M7 (and R-track gate, if active) is green.
- **Structural asserts each round:** route mounted in `index.ts`; `:ro` socket mount present;
  `frontend/src/chat/runtime.tsx` and `frontend/src/lib/vendor/redpill-verifier/**` untouched;
  no copy promotes "Backend attested" while the vendor dir is absent.
- **Manual-only (do not automate, do not relay results):** S0c real-CVM probe and T10 live
  browser smoke.
