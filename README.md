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

Exo's look comes from tokens, not per-component values. The palette (Exo's
neutral zinc greys, light and dark, following the system theme), the type roles (Literata for
display titles only, the system sans for everything else), radius, shadow and
motion are defined in `frontend/src/index.css` and `frontend/tailwind.config.js`.
`frontend/src/designTokens.test.ts` checks the palette's contrast pairs. To see
the tokens and primitives rendered, run the screenshot harness
(`bun run --cwd test exo-ui:screens`) and open the primitives gallery in its
contact sheet.

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

## Releases

Versions and changelogs are managed with [Changesets](https://changesets.dev)
v3, following the same beta/stable model as `TinyCloudLabs/js-sdk`. Nothing in
this repo is ever published to npm.

| Unit | Path | Tag | Version |
|---|---|---|---|
| `@tinychat/frontend` | `frontend/` | `@tinychat/frontend@X.Y.Z` | shared with desktop |
| `exo-desktop` | `desktop/` | `exo-desktop@X.Y.Z` | shared with web |
| `@tinychat/backend` | `backend/` | `@tinychat/backend@X.Y.Z` | independent, stays `0.x` |

Web and desktop (and, later, mobile) are one product version: a Changesets
`fixed` group, so a changeset for either bumps both. The backend takes only
`minor` and `patch` bumps; a `major` backend changeset fails the checks.
`packages/*` (`@tinyboilerplate/*`) and `test/` are private and ignored.

**Every PR needs a changeset**; the `Changeset` PR check fails without one:

```bash
bunx changeset                                          # pick units and bumps interactively
bunx changeset --minor @tinychat/frontend -m "Describe the change"
bunx changeset add --empty                              # nothing ships (docs, CI, refactors)
```

Name the deliverable a change affects, not the library it touches: a
`packages/core` change that alters the API needs a `@tinychat/backend`
changeset.

`main` stays in Changesets pre mode (`.changeset/pre.json`, tag `beta`):

- **Beta.** After each merge that adds changesets, the `Release` workflow
  versions betas (for example `0.3.0-beta.2`), commits them to main with
  `[skip ci]`, and tags each bumped unit `<name>@<version>`. Betas do not
  deploy web or backend. A major web/desktop bump is refused until someone
  runs the `Release` workflow with `confirm=major-beta`.
- **Stable.** The workflow keeps a **chore(release): release stable** PR open
  that only flips `.changeset/pre.json` to `"exit"` and records the plan in
  `.changeset/release-stable.json`; its description lists what stable would
  ship. Merging it versions the stable releases, tags them, and puts main back
  into beta pre mode. Stable only ships what betas already released: if the PR
  is stale (main moved on since the plan was recorded) or a changeset no beta
  has released is on main, the release is refused with recovery steps.

**Production deploys only on stable releases.** Merging the Release stable PR
makes the `Release` workflow dispatch `Deploy production` on the stable version
commit: the backend (Phala) first, then the web app (Cloudflare Pages), each only
if it got a new stable version. Web goes only after the production API proves it
serves the new backend (`/api/server-info` `backendRevision` equals the deployed
commit and `backendVersion` the released version). Betas and ordinary merges to
`main` deploy nothing to production (`main` gets a Pages preview build).
`Deploy production` is also the only manual path (the Phala workflow has no
trigger of its own). It always runs from `main` and deploys the commit it
resolves:

```bash
# Redeploy or roll back to a stable release (one side with -f backend=false / -f web=false)
gh workflow run deploy-production.yml --ref main -f tag=@tinychat/backend@0.1.1 -f web=false
# Unreleased hotfix: explicit opt-in plus the full SHA of the commit to deploy
gh workflow run deploy-production.yml --ref main -f allow_unreleased=true -f confirm_sha=<40-char SHA>
```

Release tags and the `production` branch are pushed only with the
`release-push` deploy key (rulesets let only deploy keys write them). The web
deploy fast-forwards `production`, which Pages builds as production, and the
run's final "Production state" table says what changed, including when a later
check failed. See [docs/deployment.md](docs/deployment.md) for the deploy key,
the rulesets and their residual risk.

`desktop/package.json` is the single source of the desktop version:
`tauri.conf.json` reads it (`"version": "../package.json"`), and the release
workflow copies it into `desktop/src-tauri/Cargo.toml` and `Cargo.lock`.
`bun run release:check` fails if they drift.

**Desktop releases.** For every new `exo-desktop@<version>` tag the `Release`
workflow runs `Desktop release (Exo)` **from main** with the tag as an input
(`gh workflow run desktop-release.yml --ref main -f tag=exo-desktop@<version>`,
which is also how to retry). It refuses any other ref, requires the tag to point
at a commit of `main`, builds exactly that commit with the same job as desktop
CI (`.github/workflows/desktop-build.yml`) and publishes a GitHub Release with
no manual step:

- a beta (`0.2.0-beta.3`) becomes a **pre-release** titled
  `Exo 0.2.0-beta.3 (beta)`, never marked latest;
- a stable version becomes a published Release marked **latest**.

**Signing follows the `EXO_DESKTOP_SIGNING` repository variable** (see Signing
mode below): `required` signs, notarizes and staples both channels and refuses
to publish unless the build reports `signed=true`; `unsigned` publishes an
unsigned build whose title (`Exo 0.2.0-beta.3 (beta, UNSIGNED)`) and notes say
so. An unset or unknown value fails the run before anything is built. Assets
are `Exo_<version>_aarch64.dmg`, the matching `.app.zip` and
`SHA256SUMS.txt`; the notes combine the desktop and
web changelog entries of the tagged commit. A published release is never
rebuilt (cut a new version).

Only the app source comes from the tagged commit: the release tooling the
workflows run (`scripts/release`: plan, bundle config, signing verification)
is always checked out at the workflow commit (`github.workflow_sha`, main), so
releasing an older tag never runs that tag's older scripts. A beta older than
the latest stable `exo-desktop` tag on main (`0.2.0-beta.3` once `0.2.0` is
out) is refused by the plan: superseded betas are not published.

Apple needs numeric bundle versions, so every build maps the semver:

| Exo version | `CFBundleShortVersionString` | `CFBundleVersion` (`XYYZZSSS`) |
|---|---|---|
| `0.2.0-beta.3` | `0.2.0` | `200003` |
| `0.2.0` | `0.2.0` | `200999` |
| `0.2.1-beta.0` | `0.2.1` | `201000` |

The build number grows with every beta and stable release (stage = beta
number, `999` for stable). The semver stays in the app itself, the tag, the
DMG name and the release title. `scripts/release/desktop-bundle-config.mjs`
writes the Info.plist overlay passed to `tauri build --config`, and the build
fails if the built Info.plist doesn't match.

Beta desktop builds embed the beta web app, which talks to the production API
(betas don't deploy the backend).

**Signing mode.** `Desktop release (Exo)` reads the `EXO_DESKTOP_SIGNING`
repository variable once, in its plan job, and has no default:

| Value | Build | Release |
|---|---|---|
| `required` | Developer ID signed, notarized, stapled and verified (`desktop-build.yml` with `sign: true`, `desktop-release` environment) | published only if the build reports `signed=true` |
| `unsigned` | `sign: false`: no `desktop-release` environment, no signing secret requested; ad-hoc sealed (`signingIdentity "-"`, same hardened runtime and entitlements) and the build fails unless `codesign --verify --deep --strict` accepts the app and the app in the DMG (Gatekeeper still rejects ad-hoc code) | title marked UNSIGNED; notes open with **UNSIGNED build — macOS will block it on first open. Open it once, then go to System Settings → Privacy & Security and click Open Anyway (macOS 15+). Or run: `xattr -dr com.apple.quarantine /Applications/Exo.app`.**; betas stay pre-releases, stables are marked latest |
| unset or anything else | nothing | the plan job fails with an error naming the two values |

The provenance checks (the workflow runs from `main`, the tag points at a
commit of `main`) apply in both modes. Until the Apple Developer ID exists,
the variable is `unsigned`:

```bash
gh variable set EXO_DESKTOP_SIGNING --body unsigned -R TinyCloudLabs/tinychat
```

To switch to signed releases once Apple approves the enrollment: add the 7
`APPLE_*` secrets to the `desktop-release` environment (one-time setup below),
then set the variable to `required`. The next release is signed; a release
already published unsigned stays unsigned (published releases are never
rebuilt; cut a new version).

```bash
gh variable set EXO_DESKTOP_SIGNING --body required -R TinyCloudLabs/tinychat
```

**Signing.** `required` release builds (`desktop-build.yml` with `sign: true`)
keep the Apple secrets away from every runner that runs project or third-party
build code; the job graph is in
[desktop/README.md](desktop/README.md#releases-and-signing). The secrets live only
in the `desktop-release` GitHub environment, which must allow deployments from
**`main` only** (set that up and check it before adding any secret:
[desktop/README.md](desktop/README.md#before-adding-any-signing-secret-restrict-desktop-release-to-main))
and has no required reviewer (fully automatic releases), so only `Desktop
release (Exo)` dispatched on main reaches it. Only two jobs use it, and both
check out nothing but `scripts/release` at the workflow commit: a preflight
re-checks provenance (`github.workflow_ref` is main's `desktop-release.yml`, the
workflow commit and the release commit are on freshly fetched `main`, and an
`exo-desktop@*` release tag points at the commit being built) and that every
secret is present, so a missing one fails before the build starts; the sign job
repeats both. The build job, with no environment and no secret, compiles and
bundles the app (`tauri build --no-bundle`, `tauri bundle`, ad-hoc sealed) and
hands it over as an artifact. The sign job runs no project code and no
`node_modules` binary: it imports the Developer ID certificate into a temporary
keychain, signs the app inside-out with `codesign` (no `--deep`; hardened
runtime; `desktop/src-tauri/Entitlements.plist` from the workflow commit, with
`com.apple.security.device.audio-input`), notarizes and staples it with
`notarytool`, builds the DMG with `hdiutil` and signs, notarizes and staples
that. `scripts/release/verify-desktop-signing.sh` then requires `codesign
--verify --deep --strict`, the Developer ID authority and team, the hardened
runtime, the audio-input entitlement (and no `get-task-allow`), `spctl`
accepting both as `Notarized Developer ID`, and `stapler validate` on both. The
keychain and the key are deleted before only the verified files are uploaded.
There is no unsigned fallback. Local builds stay unsigned (no identity in
`tauri.conf.json`).

Residual risk: `main` is not protected (team workflow), so anyone who can push
to `main` can change `desktop-release.yml` and reach the signing secrets. The
environment's `main`-only policy and the release-tag ruleset (see
[docs/deployment.md](docs/deployment.md)) stop tag- and branch-controlled code,
not a malicious writer. Treat write access as signing access.

Environment secrets (`desktop-release`):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application certificate + private key, exported as `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <Org name> (<TEAMID>)`, exactly as `security find-identity -v -p codesigning` prints it |
| `APPLE_TEAM_ID` | the 10-character Team ID |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID (UUID) |
| `APPLE_API_PRIVATE_KEY` | full contents of `AuthKey_<key id>.p8` (as is, collapsed onto one line, or base64); the sign job writes it to a temp file after signing the app and deletes it before uploading |

One-time setup (repo admin). Restrict the environment to `main` **first** and
check it before adding any secret (it had no branch policy on 2026-10-04):

```bash
repo=TinyCloudLabs/tinychat
# 1. Environment deployable from main only, no reviewers. Check: the last command must print ["main"].
gh api -X PUT repos/$repo/environments/desktop-release \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/$repo/environments/desktop-release/deployment-branch-policies \
  -f name=main -f type=branch
gh api repos/$repo/environments/desktop-release/deployment-branch-policies --jq '[.branch_policies[].name]'

# 2. Developer ID Application certificate: Keychain Access > My Certificates > select
# "Developer ID Application: ..." (with its private key) > Export > .p12 with a strong password.
base64 -i DeveloperIDApplication.p12 | tr -d '\n' | gh secret set APPLE_CERTIFICATE --env desktop-release --repo $repo
gh secret set APPLE_CERTIFICATE_PASSWORD --env desktop-release --repo $repo      # prompts
security find-identity -v -p codesigning                                         # copy the identity string
gh secret set APPLE_SIGNING_IDENTITY --env desktop-release --repo $repo --body 'Developer ID Application: <Org name> (<TEAMID>)'
gh secret set APPLE_TEAM_ID --env desktop-release --repo $repo --body '<TEAMID>'

# 3. App Store Connect > Users and Access > Integrations > App Store Connect API > Team Keys:
# generate a key with the Developer role, note the Key ID and Issuer ID, download AuthKey_<id>.p8 (once).
gh secret set APPLE_API_KEY --env desktop-release --repo $repo --body '<Key ID>'
gh secret set APPLE_API_ISSUER --env desktop-release --repo $repo --body '<Issuer ID>'
gh secret set APPLE_API_PRIVATE_KEY --env desktop-release --repo $repo < AuthKey_<id>.p8
```

Keep the `.p12`, its password and the `.p8` in the team password manager; the
`.p8` cannot be downloaded again. Never add these as repository secrets, which
any branch's workflow can read.

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
