# TinyChat

Reusable TinyCloud app substrate with OpenKey browser identity, backend SIWE
session verification, manifest-backed backend delegation, stale-policy
invalidation, and one delegated KV probe.

This app was generated with:

- App id: `xyz.tinycloud.tinychat`
- App name: `TinyChat`
- Backend operational prefix: `ops.tinychat.backend`
- Frontend package: `@tinychat/frontend`
- Backend package: `@tinychat/backend`

## UI Style

The starter UI is intentionally minimal. It should open as a clean tool, not a
landing page or backend dashboard: app name and sign-in live in the header,
connection details live in a compact header disclosure, and the main content is
only the delegated probe work surface.

Preserve the restrained dashboard baseline when changing or scaffolding from
this template: neutral gray background, white panels, subtle gray borders,
system sans typography, compact spacing, and 8px-or-smaller radius. Avoid fake
nav, hero copy, decorative backgrounds, and always-visible protocol details.

## Local TLS

OpenKey/passkey checks may use HTTP localhost when the identity flow supports
it; otherwise use trusted HTTPS. If the browser shows a TLS certificate warning,
WebAuthn can fail even after clicking through the interstitial. Do not debug
auth or delegation flows on a warning page.

Searchable error:
`WebAuthn is not supported on sites with TLS certificate errors`.

If `frontend/localhost.pem` and `frontend/localhost-key.pem` exist, both dev
servers use the trusted local certificate:

- frontend: `https://localhost:5186`
- backend: `https://localhost:3014`

Without those files, both servers fall back to HTTP.

Generate local certs with:

```bash
mkcert -install
mkcert -key-file frontend/localhost-key.pem -cert-file frontend/localhost.pem localhost 127.0.0.1 ::1
```

## Run

Create a backend env file:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Then set `BACKEND_PRIVATE_KEY` in `backend/.env` or your shell and run from the
repo root:

```bash
bun run dev
```

Default local URLs:

- frontend: `http://localhost:5186`
- backend: `http://localhost:3014`

When trusted local certs exist, both switch to HTTPS on the same ports. Leave
`frontend/.env` without `VITE_BACKEND_URL` unless you need an explicit backend
override; the frontend derives `http` or `https` from the page protocol.

## Verification

Use build and root tests as unauthenticated smoke checks:

```bash
bun run build
bun run test
```

Those checks do not exercise OpenKey, WebAuthn, TinyCloud space setup, or the
browser delegation grant. For runtime verification, start the app and run the
interactive real-auth check from another terminal:

```bash
bun run test:real-auth
```

Playwright opens a headed browser, a human completes the real
OpenKey/WebAuthn/TinyCloud space and backend delegation flow, and then
Playwright keeps using that same live browser session to update and verify
the probe. This is not an auth bypass.

The command launches installed Chrome when available so platform passkeys
behave like a normal browser. If it asks for an external security key or
says to insert a key, rerun with:

```bash
REAL_AUTH_BROWSER=chrome REAL_AUTH_USER_DATA_DIR=.auth/chrome-profile bun run test:real-auth
```

When using trusted mkcert HTTPS, Bun's backend polling may also need the
mkcert root CA. The real-auth command auto-detects local mkcert certs when
possible; it only auto-switches to HTTPS when the mkcert root CA is
available. If your shell cannot find `mkcert`, run with the CA path explicitly:

```bash
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" FRONTEND_URL=https://localhost:5186 BACKEND_URL=https://localhost:3014 REAL_AUTH_BROWSER=chrome REAL_AUTH_USER_DATA_DIR=.auth/chrome-profile bun run test:real-auth
```

Use HTTP localhost or trusted HTTPS. Stop and fix the local certificate setup
if the browser shows a TLS warning page; WebAuthn is not supported on sites
with TLS certificate errors. Do not commit `.auth/`, browser traces,
screenshots, videos, or reports from real-auth runs.

## Chat Sharing

TinyCloud Chat supports read-only sharing for saved threads. The active chat
view exposes a share action after the thread has at least one message. Creating
a link:

- mints a temporary TinyCloud share session key for
  `xyz.tinycloud.tinychat/threads`;
- creates a `tinycloud.sql/read` delegation scoped to the share expiry;
- stores the encoded share payload in a `#share=` URL;
- opens the URL in a read-only shared transcript view without requiring sign-in.

The shared view enforces the thread id embedded in the share payload at the app
layer. The underlying TinyCloud grant is still a SQL read delegation for the
threads database, matching the current TinyCloud sharing primitive.

### Manual sharing verification

1. Start the local stack:

   ```bash
   bun run dev
   ```

2. Open the frontend URL shown by Vite, sign in with OpenKey, and create a chat
   with at least one message.
3. Click the share icon in the upper-right of the chat view.
4. Keep the default duration or choose another value, then click **Create
   link**. The link is copied to the clipboard and displayed in the dialog.
5. Open the copied link in a fresh browser profile or private window. It should
   show the shared transcript without prompting for sign-in.
6. Confirm the shared view is read-only: there is no composer, model picker, or
   settings surface.

Useful local checks for this code path:

```bash
bun run build:packages
bun test frontend/src/lib/tinychatShareLinks.test.ts
bun run build:frontend
bun run test:frontend
bun run lint
```

## Standalone App

This scaffold is ready to install and run on its own. It includes the app
template, shared workspace packages, root workspace config, and generated app
metadata.

```bash
bun install
bun run generate-key
bun run build
bun run test
```

`bun run generate-key` writes `BACKEND_PRIVATE_KEY` to `backend/.env`,
where the backend dev server reads it.

The root test command runs the backend tests and copied shared package tests.

The only app data route is the storage probe:

- `GET /api/probe`
- `PUT /api/probe` with `{ "value": "..." }`
- `DELETE /api/probe`

## Operational Notes

Probe delete is intentionally idempotent. The TinyCloud KV delete path can
return a successful empty/no-content response that the current SDK reports as
`Error parsing XML: no root element`. The starter treats that exact parse error
as a completed delete while still surfacing real storage, auth, and policy
errors.
