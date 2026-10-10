# Exo desktop

Desktop app for **Exo** (exo.tinycloud.xyz) — the TinyCloud chat product,
wrapped in [Tauri 2](https://v2.tauri.app) around the existing `frontend/`
React app, with local meeting transcription from
[fastrepl/anarlog](https://github.com/fastrepl/anarlog)'s MIT-licensed plugins.

## Layout

- `src-tauri/` — Rust shell (`productName: Exo`, identifier `xyz.tinycloud.exo`).
  - `tauri.conf.json` points `devUrl` at the frontend Vite dev server
    (`http://localhost:5186`) and `frontendDist` at `frontend/dist`, so the
    desktop app is the same SPA that ships to the web.
- `scripts/gen-icons.mjs` — placeholder icon generator (PNG/ICO/ICNS, no deps).
  Replace with real branding: `bunx tauri icon <1024x1024.png>`.

## Develop

```sh
bun install                 # repo root
bun run dev:desktop         # = tauri dev (transcription enabled by default)
```

Prereqs: Rust stable, Bun 1.3.9, and full Xcode (not just the Command Line
Tools) with the Metal Toolchain component installed
(`xcodebuild -downloadComponent MetalToolchain`) — the local transcription
engine compiles whisper.cpp/MLX Metal shaders and SwiftPM packages. Exo desktop
is macOS-only (Apple Silicon, macOS 14.2+), because the default `transcription`
feature targets Core Audio process taps and Metal; CI builds macOS only.
Use `cargo check --no-default-features` to check the shell on other platforms.

Build notes:

- The vendored `swift-rs` (`desktop/vendor/swift-rs`) forces SwiftPM's
  `native` build system; Xcode 27's default `swiftbuild` hides the Swift
  bridge symbols from the release link. See its `PROVENANCE.md`.
- `src-tauri/.cargo/config.toml` forces an empty `POSTHOG_API_KEY`: anarlog's
  transitive analytics crate reads it at compile time, and Exo never
  registers that plugin or embeds a vendor key. Cargo only reads this file
  when run under `desktop/src-tauri` (the tauri CLI does).
- `[profile.release.build-override] strip = "none"` works around macOS 27
  rejecting stripped proc-macro dylibs (rust-lang/rust#157750).

`bun run build:desktop` produces installers with local transcription enabled
(builds the frontend first with production env: `VITE_BACKEND_URL=https://api.tinycloud.chat`).

## Desktop recorder and local Whisper

The shared recorder is the desktop recording flow. It writes crash-recoverable
segments under Exo's app-data vault, imports them into a mono 16 kHz, 64 kbps
note file, and exposes bounded file reads to the webview for uploads. The
System audio setting defaults on: enabled segments mix microphone and system
audio; disabled segments record the microphone alone. Pause releases the mic.

The `transcription` Cargo feature is enabled by default. It supplies the
anarlog MIT transcription, local-stt, settings and audio-actual plugins.
`tauri-plugin-transcription` records segments and runs batch Whisper after a
note stops. `tauri-plugin-local-stt` manages model downloads and the local
Whisper server. The shared server lease gives recording priority over Whisper
jobs. The frontend stores the note and transcript through the shared recorder
store and upload path; the desktop-only cloud capture uploader was retired.

The webview gets only the commands it needs through
`src-tauri/capabilities-transcription/transcription.json`. The capture and
file commands are declared in `build.rs`. Native recorder state and its model
download listener start on the first recorder command; a corrupt settings
file returns an error from the command instead of blocking app launch.

Whisper models download into `models/stt/` under Exo's app-data dir. The
vendored model downloader retries and resumes partial downloads and checks
size and CRC32 before installation. The vendored Whisper transcription code
reports work during receive, decode, VAD and inference, so long quiet notes do
not look stalled. Its supported maximum is eight hours.

The vault lives under `~/Library/Application Support/xyz.tinycloud.exo` in
both dev and release builds. Exo's vendored anarlog storage crate uses the
host bundle identifier, so it does not share an upstream app's vault. A
`vault_path` in Exo's own `global.json` or `CHAR_VAULT_BASE` can redirect it.

macOS prompts for microphone and system-audio capture when those sources are
used. `Entitlements.plist` grants audio input to signed bundles.

## Content-Security-Policy

Built apps (`tauri build`, including `--debug`) serve the frontend with the
policy in `src-tauri/tauri.conf.json` → `app.security.csp`. `tauri dev` loads
the Vite dev server directly and applies no CSP.

- `script-src 'self' 'wasm-unsafe-eval'`: only the bundled scripts (Tauri adds
  a hash for each bundled script and for the inline theme script in
  `index.html`); the TinyCloud SDK instantiates its inlined WASM, which needs
  `'wasm-unsafe-eval'`. No `eval`, no remote scripts.
- `style-src 'self' 'unsafe-inline'`: the OpenKey SDK and UI libraries insert
  `<style>` elements at runtime.
- `connect-src` lists every origin the bundled frontend fetches: Tauri IPC
  (`ipc:`, `http://ipc.localhost`), the backend (`api.tinycloud.chat`), the
  TinyCloud node, fallback node and location registry, OpenKey
  (`openkey.so`, `api.openkey.so`), model verification (`api.redpill.ai`,
  `rpc.ata.network`, `search.sigstore.dev`, Tinfoil's two GitHub proxies), and
  the browser-side connectors (Fireflies GraphQL; Google Drive, Docs and Meet
  APIs), and AssemblyAI (`api.assemblyai.com`), which Upload audio calls
  directly with the user's own key when they choose that engine (deleting the
  finished transcript goes through the backend, as AssemblyAI's CORS allows no
  DELETE). Local
  recording talks to its plugins over IPC only. The frontend's Private engine
  PUTs audio to the production ptx-batch origin (`VITE_EXO_PTX_UPLOAD_ORIGIN`).
- `frame-src https://openkey.so`: the OpenKey sign-in/approval iframe.
- `img-src` allows `https:`, `data:` and `blob:` (chat markdown and avatars);
  `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`.

A feature that fetches a new origin from the webview must add it to
`connect-src`; a build pointed at a different backend, node or OpenKey host
(other `VITE_*` values) must change the policy to match. Blocked requests show
up as `securitypolicyviolation` events and console errors in Web Inspector
(debug builds).

## Releases and signing

Releases come from `Desktop release (Exo)` (`.github/workflows/desktop-release.yml`),
dispatched from `main` for every `exo-desktop@<version>` tag; versions, channels,
the `EXO_DESKTOP_SIGNING` switch and the secrets are in the root
[README](../README.md) ("Desktop releases", "Signing mode", "Signing"). The build
and the signing are `.github/workflows/desktop-build.yml`, in three jobs, so the
Developer ID certificate and the App Store Connect key are never on a runner that
runs project or third-party build code:

```
preflight  [desktop-release; sign: true only; ubuntu]   checkout scripts/release @ workflow_sha only
             desktop-signing.sh provenance (main's desktop-release.yml, workflow + release commit on main, exo-desktop tag)
             desktop-signing.sh check (all 7 secrets present) -> fails in seconds, before any macOS minute
  └─ build  [no environment, no secret, every mode]     bun install, Vite, cargo + every build script, tauri build --no-bundle,
             tauri bundle (ad-hoc sealed, hardened runtime, Entitlements.plist) -> Info.plist + seal checked
             -> artifact: DMG + ditto-zipped Exo.app
       └─ sign  [desktop-release when sign: true; dry run otherwise]
             checkout scripts/release + desktop/src-tauri/Entitlements.plist @ workflow_sha only; no bun, cargo, tauri, node
             provenance + secrets again -> unpack (archive digest, bundle id, versions, exec bit, no symlink out of the app)
             -> temporary keychain -> codesign inside-out (no --deep) -> notarytool + stapler (app)
             -> hdiutil DMG -> codesign -> notarytool + stapler (DMG) -> verify-desktop-signing.sh
             -> keychain and key deleted -> upload the verified DMG + app
```

| Job | Environment | Secrets | Runs project code? |
|---|---|---|---|
| `preflight` | `desktop-release` (signed releases only) | all 7, presence and shape only | no (`scripts/release` at the workflow commit) |
| `build` | none | none | yes |
| `sign` | `desktop-release` when signing | step-scoped: certificate + password and identity (keychain, codesign), API key (notarytool), team (verify) | no (`scripts/release` and `Entitlements.plist` at the workflow commit; Apple's tools) |

Every secret reference is `${{ inputs.sign && secrets.<NAME> || '' }}`, so CI
and unsigned releases never resolve one. The entitlements the app is signed with
come from the workflow commit, not from the built tree.

**Dry run.** CI (`desktop.yml`, on every desktop change and every change to
`scripts/release/desktop-*` or `verify-desktop-signing.sh`) and
`EXO_DESKTOP_SIGNING=unsigned` releases run the sign job with no environment and
no secret: it unpacks the build's app, re-seals it ad-hoc through the same
inside-out `codesign` path, and builds and mounts the DMG with `hdiutil`. It
uploads nothing; unsigned releases publish the build job's artifact.

### Before adding any signing secret: restrict `desktop-release` to main

The `desktop-release` environment must be deployable from `main` only **before**
any secret is added. Otherwise a workflow pushed on any branch could name
`environment: desktop-release` and read the Developer ID certificate. On
2026-10-04 it had no deployment-branch policy (`deployment_branch_policy: null`)
and no secrets. Restrict it (repo admin), the same way as `android-release` in
[mobile/README.md](../mobile/README.md):

```sh
repo=TinyCloudLabs/tinychat
gh api -X PUT repos/$repo/environments/desktop-release \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/$repo/environments/desktop-release/deployment-branch-policies \
  -f name=main -f type=branch
```

Check it before adding the secrets:

```sh
gh api repos/$repo/environments/desktop-release --jq .deployment_branch_policy
# {"custom_branch_policies":true,"protected_branches":false}
gh api repos/$repo/environments/desktop-release/deployment-branch-policies --jq '[.branch_policies[].name]'
# ["main"]
```

Then add the 7 secrets (root README, "Signing", one-time setup) and set
`EXO_DESKTOP_SIGNING` to `required`.

## Known constraints

- **Sign-in:** OpenKey **email** sign-in (one-time code) works inside Exo's
  webview, including the capability consent, and the session survives
  relaunch. Passkeys inside the ad-hoc-signed app are not expected to work
  (WebAuthn in a third-party WKWebView needs an associated domain). Local
  recording is shown only with a signed-in space so a finished transcript can
  be saved; offline save/export is not implemented.
- **Web deploy rename** (tinycloud.chat → exo.tinycloud.xyz) is intentionally
  not part of this scaffold: it touches the Cloudflare Pages project,
  production env vars, and the backend CORS/hostname config.
- **Licensing:** only anarlog's MIT layer is used (`plugins/**`, `crates/**`).
  Nothing under anarlog's `enterprise/` (commercially licensed) is vendored or
  depended on.
