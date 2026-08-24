# TinyChat Deployment

TinyChat mirrors Listen's production topology:

| Layer | Host | URL |
| --- | --- | --- |
| Frontend (Vite SPA) | Cloudflare Pages | `https://tinycloud.chat` |
| Backend (Express on Bun) | Phala Cloud (TEE / dstack) | `https://api.tinycloud.chat` |

The backend runs in a Phala CVM behind a `dstack-ingress` sidecar that
terminates TLS for `api.tinycloud.chat` (Let's Encrypt via Cloudflare DNS-01).
The frontend is a static bundle; client routing (`BrowserRouter`) is handled by
the Pages SPA fallback in `frontend/public/_redirects`.

---

## 1. Frontend → Cloudflare Pages (`tinycloud.chat`)

The build output is `frontend/dist`. `VITE_*` values are baked at **build
time**: for manual `deploy:frontend` uploads from `frontend/.env.production`;
for Pages **Git builds** from the dashboard Production build environment
variables. (`wrangler.toml` `[vars]` are runtime Pages Functions bindings and do
**not** feed `vite build` — don't rely on them for `VITE_*`.) Keep the
`.env.production` values and the dashboard build env vars in sync.

### Option A — Pages Git integration (recommended; auto-deploys on push to main)

In the Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**:

- Repository: `TinyCloudLabs/tinychat`, production branch `main`
- Framework preset: **None**
- Build command: `bun run build:packages && bun run build:frontend`
- Build output directory: `frontend/dist`
- Root directory: `/`
- Environment variables (Production) — **required**, this is how Git builds get
  `VITE_*`: `VITE_OPENKEY_HOST=https://openkey.so`,
  `VITE_BACKEND_URL=https://api.tinycloud.chat`,
  `VITE_TINYCLOUD_HOST=https://tee.node.tinycloud.xyz`

### Option B — Direct upload from your machine

```bash
# Requires: wrangler auth (bunx wrangler login) and access to the CF account
# that owns tinycloud.chat.
bun run deploy:frontend
```

`deploy:frontend` builds `@tinychat/frontend` (and its workspace deps via turbo)
and runs `wrangler pages deploy` using `pages_build_output_dir` from
`wrangler.toml`. The Pages project name is `tinychat`.

> ⚠️ Confirm `CLOUDFLARE_ACCOUNT_ID` (default `9959301f03d2db1a5fcf5e004278d467`,
> the TinyCloud Labs account) is the account that owns `tinycloud.chat`. Override
> with `CLOUDFLARE_ACCOUNT_ID=<id> bun run deploy:frontend` if not.

### Custom domain

Pages project → **Custom domains → Set up a domain → `tinycloud.chat`**. Because
the zone is already on Cloudflare, Pages creates the apex `CNAME`/flattening
record automatically. Add `www` as a redirect to the apex if desired.

---

## 2. Backend → Phala Cloud (`api.tinycloud.chat`)

### One-time: provision the CVM

```bash
phala auth login                      # uses your Phala Cloud API key
phala cvms create \
  --name tinychat-backend \
  --compose docker-compose.phala.yml \
  --vcpu 1 --memory 2048 --disk-size 20
# note the returned CVM id and gateway.cname
phala cvms get <CVM_ID> --json | jq '{id, app_id, gateway}'
```

`phala.toml` (`name = "tinychat-backend"`, `gateway_domain = "api.tinycloud.chat"`,
`gateway_port = 3001`, `profile = "tinycloudxyz"`) records the intended config —
make sure the `profile` matches your local `phala` CLI auth profile.

### One-time: DNS for `api.tinycloud.chat`

The GitHub Actions deploy verifies these before probing the public API; the
manual `deploy:backend:phala` path does **not**, so confirm them yourself first.
In the `tinycloud.chat` Cloudflare zone:

- `CNAME  api.tinycloud.chat  →  <gateway.cname from `phala cvms get`>`  (DNS only / grey cloud)
- `TXT    _dstack-app-address.api.tinycloud.chat  →  "<app_id>:443"`

The ingress sidecar also sets a CAA record automatically (`SET_CAA=true`).

### Deploy

**Via GitHub Actions (production CD):** push to `main` touching `backend/**`,
`packages/**`, compose/phala/Dockerfile, etc., or run the
**Deploy Backend to Phala Cloud** workflow manually (`workflow_dispatch`). It
builds + pushes the backend and ingress images to GHCR, verifies DNS, deploys to
the CVM, waits for `running`, and probes `/health` + `/api/server-info`.

**Manually from your machine:**

```bash
# .env.prod holds the production secrets (never commit it):
#   BACKEND_PRIVATE_KEY, REDPILL_API_KEY, CLOUDFLARE_API_TOKEN, CERTBOT_EMAIL,
#   FRONTEND_URL=https://tinycloud.chat
#   (REDPILL_BASE_URL / REDPILL_DEFAULT_MODEL are optional — compose defaults apply)
TINYCHAT_CVM_ID=<id> PHALA_GATEWAY_CNAME=<gateway.cname> bun run deploy:backend:phala
```

---

## 3. Required GitHub configuration (backend workflow)

Repository **secrets**:

| Name | Notes |
| --- | --- |
| `PHALA_CLOUD_API_KEY` | Phala Cloud API key (deploy + CVM read). |
| `BACKEND_PRIVATE_KEY` | Backend wallet key — its TinyCloud identity/DID. `bun run generate-key`. |
| `REDPILL_API_KEY` | RedPill key for the `/api/chat` proxy. |
| `CLOUDFLARE_API_TOKEN` | Zone DNS edit for `tinycloud.chat` (ingress DNS-01 + CAA). |
| `CERTBOT_EMAIL` | Let's Encrypt contact for the ingress cert. |
| `WEBHOOK_HMAC_MASTER` | Connector-webhook HMAC master. `openssl rand -base64 32`. Required only when `CONNECTOR_WEBHOOKS_ENABLED=true`; a weak value refuses to boot. |
| `WEBHOOK_HMAC_MASTER_PREV` | Rotation grace key — the outgoing master, set only while a rotation drains. |
| `LOG_HASH_SALT` | Salt for the public log stream's keyed hashes. Its own `openssl rand -base64 32` value; never derived from `WEBHOOK_HMAC_MASTER`. |
| `STRIPE_SECRET_KEY` | Stripe secret key for `/api/billing` (`sk_live_…`; `sk_test_…` while testing). Optional until go-live — unset resolves everyone to the free tier and checkout/portal return `503 billing_not_configured` (`docs/stripe-setup.md`). |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_…`) of the Stripe webhook endpoint pointing at `/api/billing/webhook`. |
| `LEDGER_SERVICE_SECRET` | Shared secret for the Universal Ledger credits sidecar. Optional — unset disables the ledger client. |
| `ELIZA_SERVICE_SECRET` | Shared secret for the Eliza agent service. **Required** — the workflow's config check fails fast without it (agent triad with `AGENT_DID` / `ELIZA_SERVICE_URL`; unmounted `/api/agent` kills web search, cf. 2026-07-07). |
| `CONNECTOR_CREDENTIAL_MASTER` | W2 credential-custody master (backend ingest). Its own `openssl rand -base64 32` value; reusing `WEBHOOK_HMAC_MASTER` is a hard boot error. Must SURVIVE redeploys — stripping it orphans every stored credential. Required the moment `CONNECTOR_BACKEND_INGEST_ENABLED=true`. |
| `CONNECTOR_CONTENT_MASTER` | W4 content-custody master (backend ingest). Same rules — its own value, survives redeploys; wraps every stored meeting. |
| `FIREFLIES_OAUTH_CLIENT_ID` | Registered Fireflies OAuth app (custody branch b1). Required with the ingest flag armed. |
| `FIREFLIES_OAUTH_CLIENT_SECRET` | Fireflies OAuth app secret. Required with the ingest flag armed. |

Repository **variables** (all optional — defaults shown):

| Name | Default |
| --- | --- |
| `PHALA_CVM_ID` | _(required — no default; the workflow fails fast if unset)_ |
| `PHALA_INGRESS_DOMAIN` | `api.tinycloud.chat` |
| `TINYCHAT_BACKEND_URL` | `https://api.tinycloud.chat` |
| `TINYCHAT_FRONTEND_URL` | `https://tinycloud.chat` |
| `TINYCHAT_BACKEND_IMAGE` / `TINYCHAT_INGRESS_IMAGE` | `ghcr.io/tinycloudlabs/tinychat-backend` |
| `REDPILL_BASE_URL` | `https://api.redpill.ai/v1` |
| `REDPILL_DEFAULT_MODEL` | `z-ai/glm-5.2` (must stay an offered model — a non-offered value warns and falls back at runtime; `backend/src/routes/chat.ts` ST11) |
| `CONNECTOR_WEBHOOKS_ENABLED` | `false` (ships dark: route unmounted, maintenance timer off, section hidden) |
| `CONNECTOR_WEBHOOK_PUBLIC_ORIGIN` | _(empty — the minted callback host falls back to the request's `Host` header, with the scheme forced to `https`)_. Set it to `https://api.tinycloud.chat` before enabling the flag: this is the origin of the URL users paste into their provider dashboard, and a wrong host mints a webhook that silently never delivers. Origin only — `https`, no path, no trailing slash — or the companion router refuses to build. |
| `CONNECTOR_WEBHOOK_HOST_ALLOWLIST` | _(empty — DERIVED from `CONNECTOR_WEBHOOK_PUBLIC_ORIGIN`, so the host the public delivery route answers on cannot drift from the URL users paste into their dashboard)_. A delivery arriving at any other host is refused with the same generic `401` as any other pre-verify failure, before its body is read. Set a comma-separated list only when the ingress rewrites `Host`/`X-Forwarded-Host` to something internal; the single value `*` disables the check (logged). A present value with no usable host is a hard startup error, never a silent disable. Not an authentication boundary — the HMAC is (`docs/connector-webhooks-trust-proxy.md`). |
| `CONNECTOR_INGEST_INSTANCE_ID` | _(empty — a random id per process)_. **D4 = single-instance:** exactly one backend instance may consume the cohort's delivery queues, enforced by a lease in the backend's own KV; a second instance refuses the seat and ingests nothing. Pin this only when the same logical instance redeploys and should reclaim its own lease instead of waiting out the 90 s TTL. Read `docs/connector-webhooks-single-instance.md` **before** scaling to two replicas — that is a design change, not a replica count. |
| `CONNECTOR_DRAIN_INTERVAL_MS` | `300000` (paces the queue-maintenance TTL/dead-letter sweep — under Option C nothing drains in the background) |
| `CONNECTOR_A_FETCH_CEILING_PER_HOUR` | `20` (per address, rolling hour) |
| `CONNECTOR_A_SECRET_READ_CEILING_PER_HOUR` | `20` (per address, rolling hour) |
| `AGENT_DID` | _(required — no default; the workflow's config check fails fast if unset)_ — the backend agent's DID (agent triad; the deploy's `/api/agent/session` probe asserts the mount) |
| `ELIZA_SERVICE_URL` | _(required — no default; the workflow's config check fails fast if unset)_ — Eliza agent service URL (agent triad) |
| `PAYWALL_ENABLED` | `false`. This and every Stripe/credit/ledger row below may live as a repo **secret** or **variable** — secrets win (`docs/stripe-setup.md`). |
| `STRIPE_PRICE_PLUS_MONTHLY` / `STRIPE_PRICE_PLUS_YEARLY` / `STRIPE_PRICE_PRO_MONTHLY` / `STRIPE_PRICE_PRO_YEARLY` | _(empty — Stripe price ids `price_…`; see `docs/stripe-setup.md`)_ |
| `CREDIT_BUDGET_FREE` / `CREDIT_BUDGET_PLUS_WEEKLY` / `CREDIT_BUDGET_PRO_WEEKLY` | _(empty — code defaults in `backend/src/billing/tiers.ts`)_ |
| `LEDGER_SERVICE_URL` | _(empty — the ledger client is disabled when unset)_ |
| `LEDGER_AUTHORITATIVE` | `false` (workflow default — flipping ledger authority is a deliberate cutover action, not part of a routine deploy) |
| `LEDGER_OUTAGE_POLICY` | `bounded_k` |
| `CONNECTOR_BACKEND_INGEST_ENABLED` | `false` (**dark**; `true` only ARMS backend ingestion — addresses come from the cohort allowlist in the backend's own config KV. See §4 and the operator pre-rollout gates before ever setting this.) |
| `FIREFLIES_OAUTH_REDIRECT_URI` | _(empty — the registered OAuth redirect URI; required with the ingest flag armed)_ |
| `TRANSCRIPTION_API_URL` | _(empty — repo **variable**; the TinyCloud Private Transcription API base URL. With `TRANSCRIPTION_API_KEY` set, `/api/transcriber/meetings` mounts and Settings → Transcriber lights up; either empty ⇒ 404 and the card says it is not configured)_ |
| `TRANSCRIPTION_API_KEY` | _(empty — repo **secret**; the `tc_live_…` project key minted with the transcription service's `create-key` CLI. Never reaches the browser)_ |
| `TRANSCRIPTION_BOT_NAME` | `TinyCloud Private Notetaker` (repo variable; the bot's display name in the meeting) |

> Any env var added to the deploy must land in **four** places or the CVM silently
> drops it: the deploy step's `env:` block, the `printf` ENV_FILE block it writes
> (this is what `allowed_envs` is derived from — there is no static list), the
> `environment:` map in `docker-compose.phala.yml`, and `backend/.env.example` +
> these tables. `webhook-deploy-env.test.ts` and `ledger-deploy-env.test.ts` pin
> the first three; missing the second one is what unmounted `/api/agent` in
> production on 2026-07-07.

> `PHALA_CVM_ID` is read as a repo **variable** (not a secret) so it can be
> referenced in the workflow's top-level `env:`. The workflow's config check
> fails with a clear error if it is missing.

---

## 4. Connector webhooks (background sync) — what deploys, and the gates before it

**Ships dark.** `CONNECTOR_WEBHOOKS_ENABLED` defaults to `false`: the whole route
group is unmounted (every path 404s), the queue-maintenance timer never starts,
and the Settings section stays hidden. The post-deploy probe in
`.github/workflows/deploy-backend-phala.yml` asserts exactly that distinction —
mounted ⇒ `401` on a junk-signature POST, unmounted ⇒ `404`. Rollout cohort is
**operator-only**; do not flip the flag on a shared environment as part of a
routine deploy.

### What the backend actually does for a NON-COHORT address (ingest shape: **Option C**)

Operator decision 2026-08-04, recorded with its grounds in
`docs/connector-webhooks-delegation-gate.md`. This is the shipped path for every
address **outside the backend-ingest cohort**, and the backend-ingest plan §5.3
requires it to stay byte-identical while that feature is dark:

- Fireflies signs a delivery to `/api/connectors/webhooks/{source}/{token}`; the
  backend HMAC-verifies the raw body, resolves the tenant from the URL token, and
  **queues the meeting id and a timestamp**. That is the entire server-side job —
  no outbound fetch, no drain kick, nothing written to the user's space.
- Outside the cohort the backend **never receives the user's Fireflies API key** —
  it is never sent to us, never stored by us and never read by us — and it holds
  **no connector delegation**: `backendDelegationPermissions()`
  stays at v1's `threads/`-only scope
  (`backend/src/__tests__/consent-scope.test.ts` fails the build on any connector
  SQL/KV/secrets entry).
- Ingest happens in the **browser**, on the user's next authenticated visit:
  `POST /api/connectors/webhooks/drain` surfaces the ids, the browser fetches and
  writes them into the user's own space, and then settles them with
  `POST /api/connectors/webhooks/ack`. Unacknowledged ids stay queued for retry
  or expire on the 14-day TTL.
- The only recurring backend work is the bounded TTL / dead-letter sweep paced by
  `CONNECTOR_DRAIN_INTERVAL_MS`. It returns **counts, never ids**.

Operationally this means: **a queue that is not draining is a client-side
symptom, not a backend one.** Nobody but the user's own browser can move an item
out of the queue.

### What changes for a COHORT address (backend ingestion — plan §11 cutover)

`CONNECTOR_BACKEND_INGEST_ENABLED=true` **plus** the per-address allowlist in the
backend's own config KV (`webhooks/ingest/cohort`) reverses two of the invariants
above for the listed addresses. This is deliberate and operator-signed
(`DECISIONS` D1/D2 + the blast-radius acceptance), not a regression:

- The backend **holds a per-user Fireflies OAuth credential** (`V-a-branch: b1` —
  revocable, expiring), encrypted under `CONNECTOR_CREDENTIAL_MASTER`. Fireflies
  publishes no data scope, so that credential is **full-account**: it can read
  the user's meetings and also delete, reshare and re-role them. Revocation and
  expiry are the only bounds, which is why the breach-response runbook (plan
  §12.2, W11) is a precondition for enabling the flag rather than a follow-up.
- The backend **fetches the meeting and keeps its own copy**, encrypted under
  `CONNECTOR_CONTENT_MASTER`, for **90 days** (`D2a-retention-days`;
  `RETENTION_WINDOW_DAYS` in `backend/src/services/content-store.ts`). The
  retention sweep then deletes it and records a tombstone, so a provider replay
  cannot silently re-store aged-out content. Disconnect/purge deletes the stored
  meetings and the credential immediately.
- What does **not** change: the backend still holds **no connector delegation**.
  Custody is out of band (plan §6), so no new permission is minted inside a
  user's space and `backendDelegationPermissions()` stays `threads/`-only for
  cohort and non-cohort addresses alike.
- Cohort users read their meetings over `GET /api/connectors/meetings` on any
  signed-in device; the browser's `POST /api/connectors/webhooks/drain` surfaces
  nothing and `POST /api/connectors/webhooks/ack` is an idempotent no-op for
  them, because the fetch worker is the sole consumer of that address's queue.
- The consent text a cohort user must be shown is `BACKEND_INGEST_CONSENT_COPY`
  (`frontend/src/lib/connectors/consentCopy.ts`, mirrored for approval in
  `docs/connector-webhooks-backend-ingest-consent-copy.md`): it states the
  credential and what it could do if breached, the 90-day server-side retention,
  the attestation the user acknowledges, and what disconnect does — including a
  failed upstream revoke. **It is written, pinned and wired** (residual F011,
  closed 2026-08-11 as an operator-approved unfreeze): the consent renderer
  (`frontend/src/chat/BackgroundSyncSection.tsx`) probes the cohort-gated
  `GET /api/connectors/meetings` once at mount and selects the cohort text only
  on an affirmative answer; every other outcome — the 404 (`feature-dark`),
  auth, offline, retryable, rejected, a thrown probe, or no client at all —
  fails closed to Option C, so a non-cohort address can never be shown the
  cohort reversal. Under the cohort text the enable action stays inert until
  the attestation checkbox is checked, and the disconnect note renders with it.
  The Option-C surface for everyone else is byte-identical to the frozen
  drain-UX increment; gate 4 below records what remains to verify at enable
  time. The closure record is `docs/connector-webhooks-p1-residuals.md` §F011.
- Webhooks fire only for meetings the user **owns**; capture across a whole
  Fireflies account needs an Enterprise plan. Nothing may be described as
  capturing meetings owned by other people.

**Flipping the flag is an operator action.** No build step enables it, and the
gates below plus the W11 runbook come first.

### OPERATOR PRE-ROLLOUT GATES

All four are the operator's to close. None has been performed by the build, and
nothing below may be reported as done on its behalf.

1. **Provider-dashboard registration check (32-character secret).** The signing
   secret this backend mints is the **32-character** base64url prefix of the HKDF
   stream, with `-`/`_` and no padding — the V-b amendment that replaced the
   unregistrable **43-character** form against Fireflies' documented 16–32
   character field (`docs/connector-webhooks-gate5-checklist.md` §3,
   `backend/src/__tests__/webhook-secret-length.test.ts`). The delivery URL
   carries a routing token of the older shape. Before enabling the flag for any
   real account, paste one minted URL + secret pair into the actual Fireflies
   Webhooks V2 dashboard and confirm the form accepts both lengths and character
   sets, saves, and delivers a signed test event that this backend answers `202`.
   **This check has not been performed** — it needs a real Fireflies account, so
   it could not be run from the build branch. If the dashboard rejects either
   value, the mint is what changes; do not work around it by weakening
   verification.
2. **Trust-proxy / client-IP canary.** The delivery rate limiter keys on the
   client IP behind Phala's `dstack-ingress`. Confirm the resolved IP is the
   provider's and not the ingress sidecar's before relying on the per-token
   limiter in production.
3. **Backend-ingest cohort enable (plan §12).** Before
   `CONNECTOR_BACKEND_INGEST_ENABLED=true` reaches any address: the W11
   breach-response runbook exists and has been tabletop-rehearsed, the cohort
   consent text is approved, `CONNECTOR_CREDENTIAL_MASTER` and
   `CONNECTOR_CONTENT_MASTER` are set to distinct values that survive redeploys,
   and the cohort allowlist names only the operator's own address.
   The step-by-step form of this gate — preconditions, the obtain-flow seeding
   step (the Option-C vault key is **not** migrated), the exact allowlist edit,
   the smoke check and the rollback lever — is the cohort-enable checklist
   (`docs/specs/tinychat-webhooks-backend-ingest-cohort-enable-checklist.md` in
   the development repo). Its last smoke step is the W12 fresh-device goal
   acceptance lane (`docs/connector-webhooks-fresh-device-acceptance.md`), which
   is skipped by default and has never been run.
   **This has not been performed either**, and the build never performs it.
4. **The cohort consent copy is actually rendered (residual F011 — CLOSED
   2026-08-11).** `BACKEND_INGEST_CONSENT_COPY` is written, mirrored as the
   approval artifact, pinned to it by
   `backend/src/__tests__/consent-scope.test.ts` — and selected by the renderer.
   The unfreeze was operator-approved: `frontend/src/chat/BackgroundSyncSection.tsx`
   now probes the cohort-gated meetings API and renders the cohort text, the
   attestation checkbox (which holds the enable action inert until checked) and
   the disconnect note on an affirmative cohort answer only, failing closed to
   Option C on every other outcome; `frontend/src/chat/ConnectorsCard.test.ts`
   pins both constants and the single live checkbox, and
   `BackgroundSyncSection.test.tsx` asserts a cohort render carries neither
   retired custody sentence while the non-cohort surface stays byte-identical.
   What remains is the enable-time eyes-on check in the cohort-enable
   checklist's smoke sequence: the enrolled address actually sees the rendered
   B-ingest consent — heading, attestation checkbox, disconnect note, none of
   the retired sentences — before any real credential is seeded.

---

## Notes

- **Port:** the container listens on `3001` in production (`PORT=3001` is set in
  the compose/env), matching Listen and the ingress `TARGET_ENDPOINT`. Local dev
  still defaults to `3014`.
- **CORS:** the backend allows exactly `FRONTEND_URL`, so production must set
  `FRONTEND_URL=https://tinycloud.chat`.
- **TLS:** Phala's `dstack-ingress` terminates TLS for the API. The backend's
  local-only `HTTPS_CERT_FILE`/`HTTPS_KEY_FILE` path is unused in production.
- **What's not included yet:** CI (`ci.yml`) and PR-preview deployments. Port
  Listen's `ci.yml` / `preview-phala-cloudflare.yml` / `preview-cleanup.yml`
  when you want them.
