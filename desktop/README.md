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
bun run dev:desktop         # = tauri dev (starts frontend dev server itself)
```

Prereqs: Rust stable, plus on Linux `webkit2gtk-4.1`, `libgtk-3-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev` (standard Tauri 2 deps).

`bun run build:desktop` produces installers via `tauri build`
(builds the frontend first with production env: `VITE_BACKEND_URL=https://api.tinycloud.chat`).

## Local transcription (anarlog MIT layer)

Local recording is the second Transcriber mode: **Meeting bot** (backend bot)
and **Local recording** (this Mac) live side by side in Connectors → Sources.
Local mode captures microphone + system audio, transcribes on-device with
whisper.cpp after you stop, and saves into the same Meetings store as a meeting
with source `exo-local` (label "Exo Local") — so it shows up in Meetings,
meeting chat, and retrieval like any other connector.

### Enable

```sh
bun run --cwd desktop dev:transcription   # tauri dev --features transcription
```

The `transcription` Cargo feature (default off — it compiles whisper.cpp and a
large crate graph, currently macOS/Metal only via `local-stt`'s `metal` feature)
wires up:

- `audio-actual` → a managed `Arc<dyn AudioProvider>` (the transcription plugin's
  setup panics without it);
- `tauri-plugin-settings` → provides `vault_base()`/`global_base()` (sessions and
  model directories);
- `tauri-plugin-transcription` → mic/system-audio capture;
- `tauri-plugin-local-stt` → in-process whisper.cpp server + model downloads.

Permissions are injected at runtime from
`src-tauri/capabilities-transcription/transcription.json` (kept outside
`capabilities/` so feature-off builds never validate commands they don't have).

### What works at the pinned rev (864ddc1)

| Engine | Mode | Status |
|---|---|---|
| Whisper via whisper.cpp | Batch, after Stop | Shipped happy path (`metal` feature + downloaded model) |
| Apple Speech | Live, macOS 26+ | Follow-up; needs locale-asset download + availability gate |
| Soniqo Parakeet | Live or batch | Built but not exposed: third-party speech-swift + model weights unreviewed |
| AM / Argmax | Requires proprietary sidecar + `AM_API_KEY` | Out of scope |

Whisper models download on first use from `hyprnote.s3.us-east-1.amazonaws.com`
(size + checksum validated by anarlog's `model-downloader`) into
`models/stt/` under the app-data dir. Recordings land in `sessions/<id>/`.

### Storage paths

`~/Library/Application Support/xyz.tinycloud.exo` in **every** build. Upstream
anarlog hardcodes `anarlog`/`hyprnote` folders for release builds; the vendored
`storage` crate (`desktop/vendor/anarlog-storage`, MIT — see its
`PROVENANCE.md`) is patched via `[patch]` to use the host bundle identifier, so
Exo never shares or follows another app's vault redirect.

macOS prompts: Microphone (`NSMicrophoneUsageDescription`) and system-audio
capture (`NSAudioCaptureUsageDescription`, process tap — macOS 14.2+). Dev
builds attribute these to the launching terminal. `Entitlements.plist` adds
`com.apple.security.device.audio-input` for signed/hardened-runtime bundles.

### Known gaps

- Speaker labels are channel-numbered (`Speaker 1`, `Speaker 2`) because the
  channel → mic/system order isn't yet confirmed by a real capture.
- One capture at a time: the shared RootActor rejects a second `start_capture`.
- `update_capture_config` / `soniqo_model_dir` are missing from the plugins'
  default permission sets at this rev — don't call them.

## Known constraints

- **Sign-in:** tinycloud.chat is OpenKey-passkey-only in the browser; WebAuthn
  inside Tauri webviews is unreliable. Options: SIWE session against the
  backend (`GET /api/auth/nonce` → `POST /api/auth/verify`, needs
  `X-Requested-With`), or a deep-link browser handoff. Decide before shipping.
  Local recording itself doesn't need sign-in; saving the transcript to the
  space does.
- **Web deploy rename** (tinycloud.chat → exo.tinycloud.xyz) is intentionally
  not part of this scaffold: it touches the Cloudflare Pages project,
  production env vars, and the backend CORS/hostname config.
- **Licensing:** only anarlog's MIT layer is used (`plugins/**`, `crates/**`).
  Nothing under anarlog's `enterprise/` (commercially licensed) is vendored or
  depended on.
