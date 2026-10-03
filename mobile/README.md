# Exo mobile

iOS and Android app for **Exo**, wrapped in [Capacitor 8](https://capacitorjs.com)
around the existing `frontend/` React app (the same SPA that ships to the web and
to the Tauri desktop app), plus native plugins for what a web view cannot do.

## Layout

- `capacitor.config.ts`: app id `xyz.tinycloud.exo`, name `Exo`, `webDir`
  `../frontend/dist`. `EXO_DEV_SERVER_URL` switches it to live reload.
- `android/`: Gradle project. App-local plugin code lives in
  `app/src/main/java/xyz/tinycloud/exo/`.
- `ios/`: Xcode project (Swift Package Manager). App-local plugin code lives in
  `App/App/`, registered by `ExoBridgeViewController`.

## Voice notes

Record on the phone, save to the user's TinyCloud space, play back from it.

- Native plugin `VoiceNotes`: `VoiceNotesPlugin.java` / `VoiceRecorder.java` /
  `VoiceNoteService.java` on Android, `VoiceNotesPlugin.swift` on iOS. The JS
  contract is `frontend/src/lib/voiceNotes/nativeVoiceNotes.ts`.
- Audio: AAC in MPEG-4 (`.m4a`), 44.1 kHz mono, 64 kbps.
- Mic state comes from the OS. `silenced` means the OS is feeding the app
  silence: a call or another app took the mic, or the privacy toggle is off.
  Android reports this with the recorder's `AudioRecordingCallback`
  (`isClientSilenced`), iOS with audio-session interruptions and input mute.
  `no_signal` means the app is live but the input level is zero. Both are
  recorded in the note's metadata (`capture.silenced_ms`,
  `silenced_events`, `no_signal_ms`).
- Background: Android holds a `microphone` foreground service with a
  notification. iOS uses the `audio` background mode. Both OSes show their own
  mic indicator, and the app cannot hide it.
- Storage (`frontend/src/lib/voiceNotes/voiceNoteStore.ts`): one
  `connector_meeting` row with source `exo-voice-note`, plus the audio in KV at
  `{APP_ID}/connectors/exo-voice-note/audio/{id}`. That is inside the existing
  `connectors/` grant, so no manifest change is needed. Notes show up in
  Library.
- UI: the Voice notes card at the top of Connectors → Sources. It renders only
  inside the native app.

## Google connectors (OAuth)

Google refuses OAuth inside an embedded WebView (`disallowed_useragent`), and
the web flow's popup + `postMessage` does not exist in a Capacitor WebView. In
the app, "Continue with Google" runs the same authorization-code + PKCE flow in
the system browser instead (`@capacitor/browser`: Custom Tabs on Android,
SFSafariViewController on iOS):

1. The app mints `state = native.<nonce>` and a PKCE verifier (kept in memory),
   and opens `<backend>/api/connectors/google/oauth/start` (or the autojoin
   authorization URL) in the system browser.
2. Google redirects to the backend's registered `/callback`, unchanged. For a
   `native.` state only, the callback 302s to the fixed deep link
   `xyz.tinycloud.exo://oauth/google?code=…&state=…` instead of rendering the
   web postMessage page. An unknown state tag is refused.
3. `@capacitor/app` delivers the link as `appUrlOpen`. The app accepts only that
   exact link with its own `state`, dismisses the browser, and runs the usual
   authenticated exchange (`frontend/src/lib/connectors/googleOAuthNative.ts`).

The scheme is registered by an intent-filter on `MainActivity` (Android,
`singleTask`) and `CFBundleURLTypes` (iOS). It is a private-use scheme because
App Links / Universal Links need `assetlinks.json` / AASA published for the
app's signing identity, which does not exist yet. An app that claims the same
scheme can receive a code, but it cannot redeem one this app started: the PKCE
verifier never leaves the app and the exchange needs the user's session and the
backend's client secret. Moving to a verified https return closes the remaining
gap (a phishing flow started by the other app itself) and only changes the
backend's `NATIVE_OAUTH_RETURN_URL` and the two registrations.

OpenKey's own "Continue with Google" inside its sign-in widget is OpenKey's
flow, not this one; OpenKey sign-in inside the app is tracked in TC-520.

## Develop (Android, on Linux)

Prereqs: JDK 21 and the Android SDK (platform 36, build-tools 36, emulator,
`system-images;android-36;google_apis;x86_64`). KVM access is needed for a fast
emulator.

```sh
bun install && bun run build:packages
# Frontend dev server against production services:
bun run --cwd frontend dev -- --mode production --port 5391 --strictPort
# Build and install a live-reload shell; the WebView loads http://localhost:5186:
cd mobile && EXO_DEV_SERVER_URL=http://localhost:5186 bunx cap sync android
cd android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:5186 tcp:5391   # device :5186 → host dev server
```

The WebView origin must be exactly `http://localhost:5186`, one of the
backend's allowed CORS origins. `adb reverse` lets the host server run on any
free port. Release builds use Capacitor's fixed origins, `https://localhost`
(Android) and `capacitor://localhost` (iOS), which are allowed in
`backend/src/cors-origins.ts`.

Debug the WebView over CDP:
`adb forward tcp:9333 localabstract:$(adb shell cat /proc/net/unix | grep -o 'webview_devtools_remote_[0-9]*' | head -1)`.
Then connect a DevTools client to `http://127.0.0.1:9333`.

### Known issue: Android cannot resolve Phala-gateway hostnames

`api.openkey.so`, `api.tinycloud.chat` and `tee.node.tinycloud.xyz` are CNAMEs
to `_.dstack-pha-prod5.phala.network`. Android's system resolver rejects a
CNAME target whose label is `_`, so inside the WebView these hosts fail with
`net::ERR_NAME_NOT_RESOLVED`. This happens even over Private DNS (DoT)
straight to Cloudflare, so it is not an emulator artifact. Sign-in, the backend
and the TinyCloud node are all unreachable until it is fixed.

- **Fix (DNS):** point each CNAME at an underscore-free name under the same
  gateway. For example `<app-id>-443.dstack-pha-prod5.phala.network`: the
  gateway's wildcard resolves it, and routing still comes from the
  `_dstack-app-address` TXT record.
- **Dev workaround:** run a local forwarder that answers those hosts with the
  gateway IP, e.g. `dnsmasq` with `address=/api.openkey.so/<ip>` on
  `127.0.0.2`. Then start the emulator with `-dns-server 127.0.0.2` and set
  Private DNS off.

### Emulator microphone

`-no-window` runs a headless qemu build without PulseAudio, so the guest mic is
silent. Use `-qt-hide-window` with `QT_QPA_PLATFORM=offscreen`, and route a
PulseAudio null sink's monitor to the guest mic (`PULSE_SOURCE=<sink>.monitor`).
Then play a clip into that sink while the app records.

## iOS

No Mac is needed to edit the project, but building requires Xcode. CI
(`.github/workflows/mobile.yml`) builds an unsigned iOS Simulator app on
`macos-latest`. Device builds and TestFlight need an App Store Connect API key
and signing, which are not wired yet.

## Sign-in on mobile

Tested on Android: OpenKey's embedded widget works inside the WebView with
**email + code**. The virtual-passkey test harness does not apply (Android
WebView DevTools has no `WebAuthn` domain). Passkeys inside the WebView need
androidx.webkit WebAuthn support and Digital Asset Links on openkey.so, and
this is untested. Google sign-in inside a WebView is blocked by Google
(`disallowed_useragent`), so OpenKey's "Continue with Google" needs its own
system-browser handoff on OpenKey's side (TC-520 territory). The Google
connectors have one already (see "Google connectors (OAuth)").
