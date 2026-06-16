# HANDOFF — TinyChat Expo Mobile Client

**To:** the agent picking up the mobile build.
**From:** investigation + risk-retirement phase, 2026-06-12.
**Branch:** `feature/mobile-app` (in `/Users/roman/Documents/GitHub/tinychat`).
**Full plan:** `docs/mobile-app-plan.md` (read it — this handoff is the operational summary, the plan has the rationale).

---

## 0. What you're building

An **official Expo / React Native client** that replicates the TinyChat web app (chat, threads, model picker, auth, settings), living as a **`mobile/` workspace inside this monorepo** (no new repo). Dev-build MVP first — no store submission yet.

The investigation is **done and the architecture is fully de-risked** (two live spikes passed). You are picking up at the **start of the build**, with a runnable scaffold already in `mobile/`. Do not re-litigate the architecture — it's settled and proven. Build it.

---

## 1. Decisions (locked — do not revisit)

| # | Decision |
|---|----------|
| Storage | **Direct-to-node.** App signs its own UCAN invocations and talks straight to the TinyCloud node. Backend never sees user chat data. |
| Auth | **OpenKey OAuth + modify the `openkey` repo** (Bearer-auth delegate path + space creation). App holds an Ed25519 session key on-device. |
| Billing v1 | **External payment link** — show pricing + a "Subscribe" button that opens web Stripe checkout. No native IAP. |
| Target | **Dev-build, MVP scope.** Defer memory, Claude import, attestation badges. |
| Repo | **`mobile/` workspace in this monorepo.** Already added to root `package.json` `workspaces`. |

---

## 2. What's already proven (don't redo these)

**Spike 1 — pure-TS, no-WASM invocation signing → PASS (live).**
A ~90-LOC TypeScript signer using only `@noble/curves` + `@scure/base` produced a `/invoke` header **byte-identical** to the SDK's WASM output, and the live node at `https://node.tinycloud.xyz` accepted it for SQL **read and write**. Hermes can't run TinyCloud's WASM; it doesn't need to. Artifacts: `.mobile-spike/pure-ts-signer.mjs`, `live-test.mjs`, `session.json`, `known-good-header.txt`.

**Spike 2 — OpenKey delegation chain → PASS (source-airtight + live node half).**
OpenKey's `/api/delegate` runs the same SDK calls the SDK uses to mint a session, and binds the delegation to an **app-supplied public key** (verified in `tinycloud-sdk-wasm/src/session.rs:326/341/357`). So the app generates its Ed25519 keypair locally, sends only the public JWK, keeps the private key on-device. Two gaps in OpenKey to fix — see §5.

**Spike 3 — Expo-in-monorepo + chat runtime → PASS (bundle + harness).**
`mobile/` bundles inside the bun/turbo monorepo (Hermes `.hbc`, 1457 modules). `@assistant-ui/react-native@0.1.23` has the identical adapter shape to the web app's, so the custom streaming adapter ports directly. Streaming confirmed against the real `/api/chat` (19 incremental deltas). `tsc --noEmit` clean.

---

## 3. The `/invoke` wire format (authoritative — reproduce exactly)

This is the load-bearing reference. Byte-exactness matters: the node verifies an Ed25519 signature over the raw JSON, so **JSON key order is fixed**.

- **Route:** `POST {node}/invoke` — node host `https://node.tinycloud.xyz` (prod TEE: `https://tee.node.tinycloud.xyz`).
- **Header:** `Authorization: <raw UCAN JWT>` (**no `Bearer ` prefix**) + `Content-Type: application/json`.
- **JWT header** (key order): `{"alg":"EdDSA","jwk":{kid,kty:"OKP",crv:"Ed25519",x},"typ":"JWT","ucv":"0.10.0"}` — embeds the public JWK, carries `ucv`, **no `crit`**.
- **JWT payload** (UCAN 0.10 short keys, this order): `iss` (session-key `did:key` **with** `#fragment`), `aud` (same `did:key` **without** fragment), `exp` (float seconds, ~now+60), `nnc` (`urn:uuid:…`), `prf` (`[delegationCid]`), `att`. Omit `nbf` when absent.
- **`att` for SQL:** `{ "{spaceId}/sql/{dbName}": { "tinycloud.sql/{read|write}": [{}] } }` — ability value is an array holding one empty caveat `{}`. Action `read` for queries, `write` for execute/insert.
- **proof:** `[delegationCid]` — one CIDv1 string (`bafkr4i…`, raw codec, blake3).
- **Body:** reads `{"action":"query","sql":"…","params":[]}`; writes `{"action":"execute","sql":"…","params":[…]}`.
- **Signing input:** `base64url(headerJson) + "." + base64url(payloadJson)`, Ed25519-signed, sig base64url-appended.
- `did:key` = `z` + base58btc(`0xed 0x01` ‖ pubkey).

The working reference implementation is `.mobile-spike/pure-ts-signer.mjs`. Port it into `mobile/`, swapping Node `Buffer` / `crypto.randomUUID` / `TextEncoder` for RN-safe equivalents (`react-native-get-random-values` imported first in the entry file; `@scure/base` for base64url; `expo-crypto`/`crypto.randomUUID` shim).

---

## 4. Current scaffold — `mobile/` (runnable, NOT committed)

```
mobile/
├── app/_layout.tsx, app/index.tsx   # Expo Router + RN Thread/Composer/Message primitives
├── src/chat/adapter.ts              # custom streaming ChatModelAdapter (expo/fetch + SSE)
├── src/chat/runtime.tsx             # useLocalRuntime(adapter) + AssistantRuntimeProvider
├── src/config.ts                    # EXPO_PUBLIC_BACKEND_URL / _MODEL / _CHAT_TOKEN
├── metro.config.js                  # the 5-line monorepo config (keep it)
├── tsconfig.json, app.json, package.json
└── spike/stream-harness.mjs         # the streaming proof harness
```

Stack: Expo SDK 56, React 19.2.3, RN 0.85.3, Hermes, dev-client (**not Expo Go** — native modules coming).

**Metro config that makes the monorepo work (already in place — don't remove):**
```js
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// disableHierarchicalLookup NOT needed — bun's hoist layout resolves fine.
```

**Verify the scaffold:**
```bash
cd mobile && bunx tsc --noEmit          # expect exit 0
cd mobile && bunx expo export --platform ios   # expect a Hermes bundle in mobile/dist/
```

---

## 5. Phase 1a — the OpenKey changes (the only real "build, not port"; ~1 day)

Repo: `/Users/roman/Documents/GitHub/development/repositories/openkey`. **Confirm with the user before modifying it — it's a shared repo.**

**Gap (a) — Bearer auth (~0.5d).** `/api/delegate` requires a better-auth session cookie; the RN app holds an OAuth **access JWT** (`sub = user.id`). The enabled `bearer()` plugin only accepts better-auth session tokens, so the access JWT 401s today (live-confirmed). Add middleware `apps/api/src/middleware/oauth.ts` that validates the access token via the OAuth provider's **introspect** endpoint (`oauth2/introspect`, resolves token→userId) or `verifyAccessToken`/`verifyJWT`, then `prisma.user.findUnique({ where:{ id: sub } })`. Apply it to the delegate route instead of/alongside `requireSession`.
Sub-gap: the route needs a body `keyId` for a MANAGED key the app won't know. Fallback: select the user's keyIndex-0 managed key — `prisma.ethereumKey.findFirst({ where:{ userId, keyType:'MANAGED', archivedAt:null }, orderBy:{keyIndex:'asc'} })`.

**Gap (b) — space creation (~0.5d).** `/api/delegate` computes `spaceId` and calls `activateSessionWithHost` but **never creates the space** (`hostActivated` is logged-and-ignored at `delegate.ts:127-129`) → node 404s on first invoke. After the private key is unsealed (`delegate.ts:87`), add:
```ts
import { TinyCloudNode } from '@tinycloud/node-sdk';   // already a dep
const node = new TinyCloudNode({ host, privateKey: privateKey.replace(/^0x/,''), prefix, autoCreateSpace: true });
await node.signIn();   // idempotently creates the space; assert node.spaceId === spaceId
```
(Pattern copied from `apps/api/src/services/tinycloud-service.ts:25-31`.)

**Then:** run the banked 30-min live smoke — obtain an OpenKey-issued delegation for an app keypair and confirm `.mobile-spike/` pure-TS invoke returns a SQL row from the node. (Local OpenKey needs Postgres + `.env`; dev email-OTP backdoor `test@openkey.dev` / `000000` at `auth.ts:90-93`. Budget 0.5–1d to stand up if a live loop is wanted.)

---

## 6. Remaining phases (see `docs/mobile-app-plan.md` for detail)

- **Phase 1b/c — app auth:** integrate `@openkey/sdk-react-native` (PKCE, system browser); generate Ed25519 keypair → `expo-secure-store`; send public JWK to `/api/delegate`; persist `delegationHeader`/`delegationCid`/`spaceId`.
- **Phase 2 — storage (next big port):** port the signer into `mobile/`; build the SQL client (`query`/`execute` → node `/invoke`); reimplement the `frontend/src/lib/threadStore.ts` surface (`listThreads`, `getThread`, `appendMessage`, `setThread*`, `deleteThread`, `getSetting`/`setSetting`); reuse the SQLite schema **verbatim** (`threads`, `messages`, `settings`). Add an `expo-sqlite` local cache (replaces the web app's localStorage SWR). **Preserve the web app's concurrency fixes:** sequential reads (node drops responses under concurrency), key-on-`remoteId ?? id`, lazy doc creation.
- **Phase 3 — chat:** mostly done in the scaffold. Finish the model picker (`GET /api/chat/models`), per-thread model persistence, wire history/thread-list adapters to the Phase 2 store.
- **Phase 4 — billing:** `GET /api/billing/config` + `/status`; "Subscribe" → open web checkout via `Linking`.
- **Phase 5 — settings:** account / DID / space / sign-out, theme.
- **Cross-cutting — TinyChat backend:** the backend enforces exact-origin CORS + `X-Requested-With` CSRF. A native app sends **no `Origin`**. Add a native-client auth path (Bearer without the Origin check, gated on a mobile client id/header) in `backend/src/index.ts` + middleware. Small but `/api/chat` and `/api/billing/*` won't work without it.

---

## 7. Known issues / residuals to handle

1. **On-device streaming UNPROVEN.** `expo/fetch` incremental `getReader()` was verified under Node, not Hermes. Run `cd mobile && bunx expo run:ios` on a simulator/device and confirm deltas arrive incrementally. **Ask the user to do this** — agents can't reliably boot simulators. This is the one device-bound risk.
2. **Native dev-client build never run** (`expo run:ios`/`run:android` → CocoaPods/Gradle).
3. **React lockfile bump:** adding the workspace pushed the frontend's React 19.1 → 19.2.6. **Pin `react`/`react-dom` in root `package.json` `overrides`** before committing, and re-verify the frontend builds.
4. **Auth not wired on-device:** chat adapter uses a placeholder `EXPO_PUBLIC_CHAT_TOKEN`. Replace with the real OpenKey-derived JWT once Phase 1 lands.
5. **Product bug (ticket-worthy, not mobile-specific):** `backend/.env REDPILL_DEFAULT_MODEL=openai/gpt-5-mini` is invalid — backend warns and falls back to `phala/gpt-oss-120b`; free tier only allows `phala/*` (`openai/*` → 403). Mobile default must be a `phala/*` model.

---

## 8. How to run / verify what exists

```bash
# typecheck + bundle the scaffold
cd /Users/roman/Documents/GitHub/tinychat/mobile
bunx tsc --noEmit
bunx expo export --platform ios

# the no-WASM signer + live node proof (reference)
cd /Users/roman/Documents/GitHub/tinychat/.mobile-spike
node live-test.mjs        # SELECT/INSERT/readback against node.tinycloud.xyz → HTTP 200

# stream against real backend (needs backend running + a minted JWT)
# backend mints tokens via packages/server issueSessionToken + BACKEND_PRIVATE_KEY (backend/.env)
node mobile/spike/stream-harness.mjs
```

State log (full session history, decisions, spike details): `/Users/roman/Documents/GitHub/development/.claude/state.local.log` (search "Expo" / "SPIKE").

---

## 9. First moves (recommended order)

1. Get user confirmation to modify the `openkey` repo.
2. Pin React in root `overrides`; verify frontend still builds (protects prod).
3. Phase 1a: apply the two OpenKey diffs (§5) + 30-min live smoke.
4. Phase 2: storage layer (the biggest port) — start here if OpenKey is blocked on user confirmation.
5. Ask the user to run the on-device streaming check (§7.1) early — it's the last unproven mechanic.
6. Backend native-client auth path (§6 cross-cutting) — needed before on-device chat works against the real backend.

**Operating note:** this work has been run in Chief-of-Staff mode (orchestrator + subagents, state persisted to `.claude/state.local.log`). Continue persisting decisions/progress there. Nothing in `mobile/` or `.mobile-spike/` is committed yet.
