# TinyChat Mobile (Expo) — Implementation Plan

Status: **Plan / pre-build.** Branch `feature/mobile-app`. Author: investigation + risk-retirement spike, 2026-06-12.

An official Expo (React Native) client that replicates the TinyChat web app, including the OpenKey/TinyCloud auth and storage plumbing.

---

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | TinyCloud storage access | **Direct-to-node** — the app signs its own invocations and talks straight to the TinyCloud node, exactly like the web app. Backend never sees user chat data. |
| 2 | Auth | **Modify OpenKey + use its OAuth.** Build a Bearer-authenticated delegate endpoint + space auto-creation in the `openkey` repo; the app signs in via `@openkey/sdk-react-native` (OAuth 2.1 PKCE, passkey/Google in system browser). |
| 3 | Billing v1 | **External payment link** — show tier/pricing + a "Subscribe" button that opens web Stripe checkout. No native IAP. |
| 4 | Target | **Dev-build, MVP scope.** Chat, threads, model picker, auth, settings. Defer memory, Claude import, attestation badges. No store submission yet. |

**Repo location (decided):** a **`mobile/` workspace inside this monorepo** — no new repo. Shared types (the backend API contract, SQLite schema) are imported from the existing `packages/*` workspaces rather than copied. Note: Expo's Metro bundler needs explicit configuration to work inside the bun/turbo workspace (node_modules resolution, watchFolders) — validated as part of the chat spike.

---

## Why this is feasible — the spike result

The one hard blocker was that TinyCloud's web/node SDK does its cryptographic signing in Rust→WASM, and Hermes (React Native's JS engine) can't run that WASM.

A risk-retirement spike (2026-06-12, artifacts in `.mobile-spike/`) **disproved the blocker**: a pure-TypeScript, zero-WASM `/invoke` header signed with `@noble/curves` was accepted by the live node at `node.tinycloud.xyz` for both reads and writes, and came out **byte-identical** to the SDK's WASM-produced header (deterministic Ed25519 → matching signature = exact format proof). The signer is ~90 LOC and imports only `@noble/curves` + `@scure/base`.

So the phone does only plain Ed25519 signing — no WASM. OpenKey performs the WASM-heavy delegation creation server-side, and (confirmed in the spike) can bind that delegation to an **app-supplied public key**, so the private key is generated on-device and never leaves it.

### Confirmed `/invoke` wire format (from the spike — authoritative)

- **Route:** `POST {node}/invoke`
- **Header:** `Authorization: <raw UCAN JWT>` (no `Bearer ` prefix) + `Content-Type: application/json`
- **JWT header:** `{"alg":"EdDSA","jwk":{kid,kty:"OKP",crv:"Ed25519",x},"typ":"JWT","ucv":"0.10.0"}` — embeds the public JWK, carries `ucv`, **no `crit`**.
- **JWT payload** (UCAN 0.10 short keys, this exact field order): `iss` (session-key `did:key` **with** `#fragment`), `aud` (same `did:key` **without** fragment), `exp` (float seconds, ~now+60), `nnc` (`urn:uuid:…`), `prf` (`[delegationCid]`), `att`. `nbf` omitted when absent.
- **`att` (capability) for SQL:** `{ "{spaceId}/sql/{dbName}": { "tinycloud.sql/{read|write}": [{}] } }` — ability value is an array holding one empty caveat `{}`. Action `read` for queries, `write` for execute/insert.
- **proof:** `[delegationCid]` — one CIDv1 string (`bafkr4i…`, raw codec, blake3).
- **Body:** reads `{"action":"query","sql":"…","params":[]}`; writes `{"action":"execute","sql":"…","params":[…]}`.
- **Signing input:** `base64url(headerJson) + "." + base64url(payloadJson)`; **JSON key order is load-bearing** (must match the ssi crate's struct order). `did:key` = `z` + base58btc(`0xed 0x01` ‖ pubkey).

Node host: `https://node.tinycloud.xyz` (prod TEE node `https://tee.node.tinycloud.xyz`).

---

## Architecture

```
┌──────────────────────────┐
│      Expo app (Hermes)    │
│                           │
│  OpenKey RN OAuth SDK ────┼──► OpenKey  (api.openkey.so)
│   (PKCE, system browser)  │      • OAuth 2.1 sign-in (passkey/Google)
│                           │      • POST /api/delegate {app pubkey}  [NEW: Bearer auth + space create]
│  Ed25519 session key      │        └─► returns delegationHeader, delegationCid, spaceId
│   (SecureStore, private   │
│    key never leaves) ─────┼──► TinyCloud node (node.tinycloud.xyz)
│  Pure-TS invocation signer│      • POST /invoke  (60s UCAN JWT, signed on-device)
│   (~90 LOC, @noble)       │      • SQL: threads / messages / settings  [DIRECT, user-owned]
│                           │
│  assistant-ui-RN +        │
│   expo/fetch SSE ─────────┼──► TinyChat backend (api.tinycloud.chat)
│                           │      • POST /api/chat  (SSE proxy to RedPill)
│  expo-sqlite local cache  │      • GET  /api/chat/models, /api/billing/{config,status}
└──────────────────────────┘      • POST /api/billing/checkout → web Stripe URL
```

The app talks to **three** services: OpenKey (sign-in + delegation), the TinyCloud node (storage, direct), and the TinyChat backend (LLM proxy + billing).

---

## Workstreams

### Phase 0 — Foundations (~0.5–1 day)
- Scaffold Expo app (SDK 54+, Expo Router, dev client — **not** Expo Go; we need native modules).
- Core deps: `expo-router`, `expo-secure-store`, `react-native-get-random-values` (imported first in entry), `@noble/curves`, `@noble/hashes`, `@scure/base`, `@assistant-ui/react-native`, `react-native-streamdown`, `expo-sqlite`.
- EAS Build config for dev-client on a real device.

### Phase 1 — Auth (~3–5 days; the long pole, has real build work)
**1a. OpenKey backend changes (`openkey` repo, ~2–3 days)**
- Add a **Bearer-authenticated** path to `POST /api/delegate` (today it requires a better-auth session cookie; `apps/api/src/routes/delegate.ts`). Validate the OAuth access token and resolve the user from its claims.
- **Space auto-creation:** the delegate flow computes a `spaceId` but does not create the space (node 404s on first use). Add creation (`autoCreateSpace` path or a new endpoint).
- Verify end-to-end against the deployed flow.

**1b. App OAuth (~1 day)**
- Integrate `@openkey/sdk-react-native` PKCE; register a redirect scheme; store tokens in SecureStore; wire refresh.

**1c. App session key + delegation (~1 day)**
- Generate an Ed25519 keypair on-device; store the private key in SecureStore.
- Send the **public** JWK to `/api/delegate`; persist the returned `delegationHeader` / `delegationCid` / `spaceId`.

### Phase 2 — Storage layer, direct-to-node (~3–4 days)
- Port the spike's pure-TS invocation signer into the app, RN-shimmed (`Buffer`/`crypto.randomUUID`/`TextEncoder` → RN-safe equivalents).
- Build the TinyCloud SQL client: construct `query`/`execute` invocations, POST to node `/invoke`.
- Reimplement the `frontend/src/lib/threadStore.ts` surface against it: `listThreads`, `getThread`, `appendMessage`, `setThreadTitle/Model`, `deleteThread`, `getSetting/setSetting`. Reuse the existing SQLite schema **verbatim** (`threads`, `messages`, `settings`; `memory` schema kept but unused in MVP).
- `expo-sqlite` local mirror for instant paint + offline, replacing the web app's localStorage SWR cache. Preserve the web app's hard-won fixes: sequential reads (the node drops responses under concurrency), key-on-`remoteId ?? id`, lazy doc creation.

### Phase 3 — Chat (~4–6 days)
- `@assistant-ui/react-native`, reusing the shared runtime: `ChatModelAdapter` (SSE via `expo/fetch` to the existing `POST /api/chat`, with Bearer + the native-auth path from cross-cutting work below), `ThreadHistoryAdapter` + `RemoteThreadListAdapter` backed by the Phase 2 storage layer.
- Streaming markdown via `react-native-streamdown`; `FlashList` message list.
- Model picker (`GET /api/chat/models`), per-thread model persistence, the high-burn nudge.

### Phase 4 — Billing, external-link (~1–2 days)
- `GET /api/billing/config` + `/status`: usage chip + tier display + pricing.
- "Subscribe" → open the web checkout URL via `Linking`; handle return.

### Phase 5 — Settings + polish (~1–2 days)
- Account (address / DID / space / sign-out), connection status, theme.
- Deferred: memory, Claude import, attestation badges.

### Cross-cutting — TinyChat backend (small but essential)
- The backend enforces exact-origin CORS and an `X-Requested-With` CSRF header (`backend/src/index.ts`, middleware). A native app sends **no `Origin`** and can't rely on browser CSRF. Add a native-client auth path (Bearer without the Origin check, e.g. gated on a mobile client id/header). Small change, but `/api/chat` and `/api/billing/*` won't work without it.

---

## Effort estimate (dev-build MVP, one focused dev)

| Phase | Estimate |
|-------|----------|
| 0 Foundations | 0.5–1d |
| 1 Auth (incl. OpenKey) | 3–5d |
| 2 Storage | 3–4d |
| 3 Chat | 4–6d |
| 4 Billing | 1–2d |
| 5 Settings/polish | 1–2d |
| Backend native-auth path | 0.5d |
| **Total** | **~2.5–4 weeks** |

Phases 1a (OpenKey) and 3 (chat against a stubbed store) can run in parallel with scaffolding to compress wall-clock.

---

## Risks remaining (post-spike)

1. **assistant-ui-RN hosting the app's *custom* adapters unchanged** — the web app uses custom `useLocalRuntime` adapters, not a stock runtime. The RN package shares the runtime, but porting these specific adapters is unproven. *Validate first in Phase 3 with a small spike against the real `/api/chat`.* (Medium.)
2. **OpenKey OAuth ↔ delegate** — the new Bearer path must let an OAuth token stand in for the session cookie inside better-auth's authorization. Confirm early in Phase 1a. (Medium.)
3. **`expo/fetch` SSE ↔ assistant-ui-RN transport** — historical ReadableStream type mismatches with AI-SDK-style consumers; verify on current SDK. (Low–medium.)
4. **Passkey continuity** — using a web-created passkey (`tinycloud.chat` RP ID) inside the native app needs Associated Domains / assetlinks. Deferred: a fresh mobile sign-in is acceptable for the dev-build. (Low for MVP.)

## Recommended first move
Run two things in parallel: **(a)** the OpenKey backend changes (Phase 1a — the only multi-day external dependency), and **(b)** a thin Phase-3 spike proving `@assistant-ui/react-native` + `expo/fetch` streams from the real `/api/chat` — the next-largest unknown. Everything else is well-grounded by the inventory + the signing spike.
