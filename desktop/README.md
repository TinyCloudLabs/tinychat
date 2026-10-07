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

## Local transcription (anarlog MIT layer)

Local recording is the second Transcriber mode: **Meeting bot** (backend bot)
and **Local recording** (this Mac) live side by side in Connectors → Sources.
Local mode captures microphone + system audio, transcribes on-device with
whisper.cpp after you stop, and saves into the same Meetings store as a meeting
with source `exo-local` (label "Exo Local") — so it shows up in Meetings,
meeting chat, and retrieval like any other connector.

The `transcription` Cargo feature is enabled by default in desktop dev and
release builds. The feature wires up:

- `audio-actual` → a managed `Arc<dyn AudioProvider>` (the transcription plugin's
  setup panics without it);
- `tauri-plugin-settings` → provides `vault_base()`/`global_base()` (sessions and
  model directories);
- `tauri-plugin-transcription` → mic/system-audio capture;
- `tauri-plugin-local-stt` → in-process whisper.cpp server + model downloads.

Permissions are injected at runtime from
`src-tauri/capabilities-transcription/transcription.json` (kept outside
`capabilities/` so feature-off builds never validate commands they don't have).
It grants exactly the eight plugin commands the Local recording UI invokes —
not the plugins' `default` sets, which include model deletion, mic mute,
voiceprint and export commands Exo doesn't use.

### What works at the pinned rev (864ddc1)

| Engine | Mode | Status |
|---|---|---|
| Whisper via whisper.cpp | Batch, after Stop | Shipped. Verified on-Mac in the release app: record → transcribe → save as Exo Local → relaunch |
| Apple Speech | Live, macOS 26+ | Follow-up; needs locale-asset download + availability gate |
| Soniqo Parakeet | Live or batch | Built but not exposed: third-party speech-swift + model weights unreviewed |
| AM / Argmax | Requires proprietary sidecar + `AM_API_KEY` | Out of scope |

Whisper models download on first use from Hugging Face
(`huggingface.co/ggerganov/whisper.cpp`, set in the vendored
`whisper-local-model`; size + checksum validated by anarlog's
`model-downloader`) into
`models/stt/` under the app-data dir. Recordings land in `sessions/<id>/`.

Model downloads are resumable (vendored `model-downloader`, `file` and
`local-model`; see `vendor/anarlog-model-downloader/PROVENANCE.md`):

- A failed ranged chunk is retried on its own. A failed or stalled attempt
  (no data for 60 s) is retried with exponential backoff, resuming from the
  partial file `models/stt/<file>.part`.
- When Hugging Face refuses the file (403, 404) or keeps failing, the
  download continues from the same partial file on
  `models.anarlog.so/v0/ggerganov/whisper.cpp/main/<file>`, which serves
  byte-identical files. The file's size and CRC32 checksum gate
  installation. If either is wrong, the partial file is deleted and the model
  is downloaded once more from scratch from `models.anarlog.so`; a second
  mismatch fails the download.
- A download that still fails keeps its partial file, so **Download** resumes
  it. Clicking **Download** while one is running joins it rather than
  restarting it.
- The Local recording panel fails a download only when it reports no progress
  for 15 minutes, never because it is slow; the native download keeps running
  if the panel gives up.

Long recordings: the vendored `transcribe-whisper-local`
(`desktop/vendor/anarlog-transcribe-whisper-local`, see its `PROVENANCE.md`,
with small progress hooks in the vendored `audio-chunking` and
`whisper-local`) reports progress while it receives, decodes, VAD-scans and
transcribes audio, so long, mostly quiet recordings and slow machines don't
trip the 30 s / 60 s stream-idle timeouts, while a stalled server still does.
Supported maximum: **8 hours** (stereo). Longer recordings, or a temp volume
without room for the decoded audio (~0.5 GB per stereo hour + 0.5 GB), are
rejected before decoding with a clear error. `NSAppSleepDisabled` keeps App
Nap from starving background transcription. If transcription still fails, the panel keeps the
recording: **Retry transcription** re-runs Whisper on the same audio.

### Storage paths

`~/Library/Application Support/xyz.tinycloud.exo` in **every** build. Upstream
anarlog hardcodes `anarlog`/`hyprnote` folders for release builds; the vendored
`storage` crate (`desktop/vendor/anarlog-storage`, MIT — see its
`PROVENANCE.md`) is patched via `[patch]` to use the host bundle identifier, so
Exo never shares or follows another app's vault redirect. The only remaining
redirects are explicit: a `vault_path` in Exo's own
`xyz.tinycloud.exo/global.json` (Exo never writes one) or the
`CHAR_VAULT_BASE` environment variable (developer override).

macOS prompts: Microphone (`NSMicrophoneUsageDescription`) and system-audio
capture (`NSAudioCaptureUsageDescription`, process tap — macOS 14.2+). Dev
builds attribute these to the launching terminal. `Entitlements.plist` adds
`com.apple.security.device.audio-input` for signed/hardened-runtime bundles.

### Private cloud engine

Local recording has a second engine, **Private cloud**: after Stop, the
recording is uploaded to TinyCloud Private Transcription (a dedicated
confidential VM that sends speech segments to Tinfoil) and the transcript is
saved as the same Exo Local meeting, with `transcription_engine:
"private-cloud"` in its metadata. `src-tauri/src/cloud/origins.rs` compiles in
the production `ptx-batch` origin (`PTX_UPLOAD_ORIGIN`), so
`cloud_transcription_status` reports `configured: true`. The picker shows the
engine when the backend also answers
`GET /api/transcriber/private-cloud/capabilities` with 200 (flag on, account
in the cohort); with no explicit choice stored, Private cloud is the default
until an on-device model is downloaded.

Local recording's upload is native (`reqwest` in `cloud/client.rs`), not a
webview fetch; for it the webview reaches only the backend's
`/api/transcriber/private-cloud/*` routes. The PTX origin is still in the CSP
`connect-src` because Upload audio's Private engine PUTs a picked file from the
webview (see Content-Security-Policy below).

Native side (`src-tauri/src/cloud/`):

- `registry.rs`: on the transcription plugin's `stopped` event for a
  cloud-bound capture (the webview gives those `cloud-<uuid>` session ids;
  on-device captures are never opened), opens
  `vault/sessions/<session>/audio.{mp3,wav,ogg}` with `openat` + `O_NOFOLLOW`
  at each step, requires a regular file ≤ 120,960,000 bytes (2 h), keeps the
  descriptor, and emits `exo://capture-ready` with a random 128-bit handle.
  The webview never passes a path.
- `commands.rs`: `cloud_transcription_submit` hashes the descriptor, creates
  the job at the compiled backend origin (bearer + `Idempotency-Key`), and PUTs
  the same descriptor to `PTX_UPLOAD_ORIGIN` + the backend's relative
  `/uploads/trn_…` path, with an exact `Content-Length` and no redirects.
  After acceptance, recovery goes through job status only: PTX deletes a job's
  upload capabilities when it accepts the upload, so a replayed PUT gets 401.
  `cloud_transcription_cancel` aborts an upload and releases the handle.
  `cloud_transcription_reopen` issues a new handle for a stopped recording
  that native no longer holds (after a relaunch, or once a handle was
  released). The webview passes only the session id, which must be a
  `cloud-` session. Native opens `vault/sessions/<session>/audio.{mp3,wav,ogg}`
  (the first that exists, in the plugin's order), with the same `openat` +
  `O_NOFOLLOW` walk and checks. A symlinked candidate is refused, not skipped.
  On-device recordings can't be read this way.
- Webview side (`frontend/src/lib/localTranscriber.ts`): each account has
  its own pending record, `exo.transcriber.privateCloudPending:<DID>`. It holds
  the attempt id, the job id once known, the session, and the audio path. It is
  written at Stop, or when the view closes mid-recording, before any upload,
  and cleared once the transcript is saved (and deleted from PTX) or
  discarded. The record belongs to the account that started the recording,
  even if another signs in before it stops. A recording that was never
  uploaded is offered again (Transcribe in private cloud / Transcribe on this
  Mac / Discard). A job that already has an id resumes by itself, and an
  upload that never completed is re-sent from the re-opened recording. While
  private cloud is hidden (404) or unreachable, a recording with a job is kept
  and offered the same way. While it is hidden, Exo doesn't contact it for
  that recording (a dark 404 would look like a deleted job and start a second
  one): only Transcribe on this Mac or Discard. No new recording starts while
  a record waits. Every upload of a recording reuses its attempt id, the create
  call's `Idempotency-Key`, so a replay re-joins the same job. While a record
  whose upload began has no job id yet, tenant-list recovery waits, so it can't
  save that job's transcript a second time. A record under the old shared key (before TC-772) is
  adopted only by the account whose tenant-scoped `GET` can read its job. It is
  dropped after 48 h, or straight away if it names no job.
- The commands are declared in `build.rs` (app ACL manifest) and granted only
  by `capabilities-transcription/transcription.json`, which also denies the
  webview `event:emit`, so it cannot forge the plugin's `stopped` event.
- Debug builds only: `EXO_DEBUG_PTX_ORIGIN=http://127.0.0.1:<port>` points
  the uploader at a local PTX stand-in.

### Known gaps

- Speakers are labelled by channel: **You** = microphone, **Others** = system
  audio (the remote side of a call); a real capture confirmed the order.
  Without headphones the mic also hears the speakers; the saved transcript
  drops mic phrases that clearly echo system audio and merges consecutive
  segments per speaker (`frontend/src/lib/localTranscriptTurns.ts`).
- One capture at a time: the shared RootActor rejects a second `start_capture`.
- Calling any other plugin command needs an explicit grant in
  `capabilities-transcription/transcription.json`.

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
  recording talks to its plugins over IPC only. Upload audio's Private engine
  PUTs the file to the production ptx-batch origin (`VITE_EXO_PTX_UPLOAD_ORIGIN`,
  the same CVM as `PTX_UPLOAD_ORIGIN` in `src-tauri/src/cloud/origins.rs`).
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
