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

Whisper models download on first use from `hyprnote.s3.us-east-1.amazonaws.com`
(size + checksum validated by anarlog's `model-downloader`) into
`models/stt/` under the app-data dir. Recordings land in `sessions/<id>/`.

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

### Private cloud engine (hidden)

Local recording has a second engine, **Private cloud**: after Stop, the
recording is uploaded to TinyCloud Private Transcription (a dedicated
confidential VM that sends speech segments to Tinfoil) and the transcript is
saved as the same Exo Local meeting, with `transcription_engine:
"private-cloud"` in its metadata. It is **hidden in this build**:
`src-tauri/src/cloud/origins.rs` compiles in no PTX origin
(`PTX_UPLOAD_ORIGIN = None`), so `cloud_transcription_status` reports
`configured: false`, the capture registry never opens a file, and the picker
never appears. The engine shows only when a build sets that origin *and* the
backend answers `GET /api/transcriber/private-cloud/capabilities` with 200
(flag on, account in the cohort).

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
  APIs). Local recording talks to its plugins over IPC only.
- `frame-src https://openkey.so`: the OpenKey sign-in/approval iframe.
- `img-src` allows `https:`, `data:` and `blob:` (chat markdown and avatars);
  `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`.

A feature that fetches a new origin from the webview must add it to
`connect-src`; a build pointed at a different backend, node or OpenKey host
(other `VITE_*` values) must change the policy to match. Blocked requests show
up as `securitypolicyviolation` events and console errors in Web Inspector
(debug builds).

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
