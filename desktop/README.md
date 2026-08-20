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

## Transcription (anarlog MIT layer)

Two Tauri plugins from the anarlog monorepo are declared in
`src-tauri/Cargo.toml` behind the **`transcription`** Cargo feature
(pinned to rev `864ddc1`), default **off** because they compile whisper.cpp
and a large crate graph:

- `tauri-plugin-transcription` — mic/system-audio capture
  (`startCapture`/`stopCapture`, device list, mute, live transcript events).
- `tauri-plugin-local-stt` — on-device Whisper model management + local STT
  server. GPU backends are features on the plugin: `metal`/`coreml` (macOS),
  `cuda`/`directml`/`vulkan`/`openblas` (Windows/Linux).

To enable:

1. `cargo tauri dev --features transcription` (or add to `default`).
2. Add `"transcription:default"` and `"local-stt:default"` to
   `src-tauri/capabilities/default.json`.
3. Vendor the typed JS bindings from anarlog (`plugins/transcription/js`,
   `plugins/local-stt/js` — MIT; keep their license notice) into a small
   frontend package and gate calls on running inside Tauri
   (`"__TAURI_INTERNALS__" in window`).
4. Feed finished transcripts through the existing connector save path
   (`frontend/src/lib/transcriberSave.ts`, connector source
   `tinycloud-transcriber`) so desktop-local capture lands in the user's
   space exactly like the Private Notetaker bot output.

Licensing: only anarlog's MIT layer is used. Do not depend on anything under
anarlog's `enterprise/` directory (commercially licensed).

## Known constraints

- **Sign-in:** tinycloud.chat is OpenKey-passkey-only in the browser; WebAuthn
  inside Tauri webviews is unreliable. Options: SIWE session against the
  backend (`GET /api/auth/nonce` → `POST /api/auth/verify`, needs
  `X-Requested-With`), or a deep-link browser handoff. Decide before shipping.
- **Web deploy rename** (tinycloud.chat → exo.tinycloud.xyz) is intentionally
  not part of this scaffold: it touches the Cloudflare Pages project,
  production env vars, and the backend CORS/hostname config.
