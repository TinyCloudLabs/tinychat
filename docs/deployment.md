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
  `VITE_BACKEND_URL=https://api.tinycloud.chat`

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

Repository **variables** (all optional — defaults shown):

| Name | Default |
| --- | --- |
| `PHALA_CVM_ID` | _(required — no default; the workflow fails fast if unset)_ |
| `PHALA_INGRESS_DOMAIN` | `api.tinycloud.chat` |
| `TINYCHAT_BACKEND_URL` | `https://api.tinycloud.chat` |
| `TINYCHAT_FRONTEND_URL` | `https://tinycloud.chat` |
| `TINYCHAT_BACKEND_IMAGE` / `TINYCHAT_INGRESS_IMAGE` | `ghcr.io/tinycloudlabs/tinychat-backend` |
| `REDPILL_BASE_URL` | `https://api.redpill.ai/v1` |
| `REDPILL_DEFAULT_MODEL` | `openai/gpt-5-mini` |

> `PHALA_CVM_ID` is read as a repo **variable** (not a secret) so it can be
> referenced in the workflow's top-level `env:`. The workflow's config check
> fails with a clear error if it is missing.

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
