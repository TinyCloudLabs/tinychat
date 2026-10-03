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

No Mac is needed to edit the project, but building requires Xcode. There is
no Mac in the loop: everything iOS runs in GitHub Actions on `macos-26` with
Xcode 26.6.

- App-local plugins register in `ExoBridgeViewController.capacitorDidLoad`.
  `SceneDelegate` makes that class the window's root. Capacitor 8's template
  builds the window in code with a plain `CAPBridgeViewController`, which
  silently skipped the registration until the smoke test caught it.
- **Simulator smoke test** (`Mobile (Exo)` → *iOS (simulator build and smoke
  test)*): a Debug build for the simulator, then
  `mobile/scripts/ios-simulator-smoke.sh`. It boots the newest iPhone
  simulator, installs the app, grants the microphone and launches it. The job
  fails unless the Debug-only probe in `ExoBridgeViewController` logs
  `EXO_SMOKE {…}` reporting:
  - the bundled web app at `capacitor://localhost`, platform `ios`, and React
    mounted;
  - `VoiceNotes` registered, visible to JS, and answering `status()` over the
    bridge.

  The app must also still be running 10 s later, with no crash report. The
  `exo-ios-smoke-<sha>` artifact has `screenshot.png`, `console.log`
  (Capacitor's `⚡️` lines and the WebView console), `unified.log` and
  `summary.md`. To run it on a Mac:
  `mobile/scripts/ios-simulator-smoke.sh run <path/to/App.app> /tmp/exo-smoke`.
- **Release dry run** (`Mobile (Exo)` → *iOS release*): the TestFlight build
  (`.github/workflows/ios-build.yml`) without signing. It produces a Release
  archive of the production frontend and checks:
  - versions and the bundle id;
  - `PrivacyInfo.xcprivacy`, the microphone string and the `audio` background
    mode;
  - that `capacitor.config.json` has no dev-server `server.url`;
  - that the Release binary does not contain the smoke probe.

### Privacy manifest

`App/App/PrivacyInfo.xcprivacy` covers Exo's own code: the App target and the
bundled web app. Capacitor and Cordova ship their own manifests, and neither
uses a required-reason API.

| Entry | Why |
|---|---|
| `NSPrivacyTracking` false, no tracking domains | Exo does no tracking and has no analytics SDK. |
| System boot time, reason `35F9.1` | `VoiceNotesPlugin` times recordings with `ProcessInfo.systemUptime`. Only in-app elapsed times (duration, silenced and no-signal spans) leave the device. `35F9.1` allows exactly that. |
| No file-timestamp entry | The plugin reads a recording's size with `URLResourceValues.fileSize`, not `FileManager.attributesOfItem`, which is a file-timestamp API. Keep it that way, or declare `C617.1`. |
| Audio Data: linked, not tracking, App Functionality | Voice notes are uploaded to the user's TinyCloud space. The upload is not end-to-end encrypted, so Apple counts it as collected even though the space belongs to the user. |
| Other User Content: same | Chats, notes, meeting transcripts and voice-note metadata go to the Exo backend and the user's space. |
| Email Address: same | Sign-in with OpenKey uses email + code. |
| User ID: same | The account's DID/address that owns the space. |

The App Store Connect *App Privacy* answers must say the same. Update both
whenever a feature sends new data off the device, for example crash reporting
or analytics.

### iOS release (TestFlight)

`.github/workflows/ios-testflight.yml` stays dormant until the Apple account
exists. Dispatch it from `main` only:

```sh
gh workflow run ios-testflight.yml --ref main -f mode=validate  # sign; App Store Connect validates, no upload
gh workflow run ios-testflight.yml --ref main                   # sign and upload to TestFlight
```

If an `ios-release` secret is missing, the plan job fails within seconds and
names it. No macOS runner starts and nothing is built.

Otherwise the run is `ios-build.yml` with `sign: true`, the same job CI runs
unsigned:

1. It archives without signing, with no secret in reach.
2. It writes the API key.
3. `xcodebuild -exportArchive -allowProvisioningUpdates` signs the app and its
   frameworks with Xcode's cloud-managed Apple Distribution certificate and an
   App Store profile, creating both on first use.
4. `scripts/release/ios-signing.sh verify-ipa` requires:
   - an Apple Distribution signature from `APPLE_TEAM_ID`;
   - an App Store profile for `xyz.tinycloud.exo` (no devices, no
     `get-task-allow`).
5. Only then does `upload` mode export again with destination `upload` (the
   uploader Xcode's Organizer uses). `validate` mode instead runs
   `altool --validate-app`.

The archive is never signed. Automatic signing at archive time would need an
Apple Development certificate whose private key a fresh runner never has, so
every run would mint a new one until Apple's limit. It would also need a
registered device.

Versions: `CFBundleShortVersionString` is `frontend/package.json`'s product
version without the beta suffix (`0.2.0-beta.2` → `0.2.0`).
`CFBundleVersion` is the workflow run number, so every upload is a new build.

Environment `ios-release` (deployment branches: `main` only, no required
reviewer), secrets:

| Secret | Value |
|---|---|
| `APPLE_TEAM_ID` | the 10-character Team ID |
| `APPLE_API_KEY` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID (UUID) |
| `APPLE_API_PRIVATE_KEY` | the `AuthKey_<key id>.p8` file. It may arrive as is, collapsed onto one line (a masked single-line prompt), or base64; the workflow rebuilds the PEM and checks it with `openssl` |

#### After enrollment completes (Sam)

1. **Team ID**: developer.apple.com → Account → Membership details.
2. **App ID**: Certificates, Identifiers & Profiles → Identifiers → **+** →
   App IDs → App. Use description `Exo` and the explicit bundle ID
   `xyz.tinycloud.exo`. Enable no capabilities for now:
   - microphone and background audio come from Info.plist (`UIBackgroundModes:
     audio`), not from capabilities;
   - **Associated Domains** comes later with the passkey work
     (`webcredentials:openkey.so`, plus an `apple-app-site-association` on
     openkey.so).

   Leave certificates and profiles alone: the export creates them.
3. **App record**: App Store Connect → Apps → **+** → New App. Platform iOS,
   name `Exo` (if the name is taken, pick another display name; the bundle id
   is what matters), primary language English, bundle ID `xyz.tinycloud.exo`,
   SKU `exo-ios`.
4. **API key**: App Store Connect → Users and Access → Integrations → App Store
   Connect API → Team Keys → **+**. Name it `GitHub TestFlight (tinychat)`
   with access **Admin**. An App Manager key is not enough: xcodebuild's cloud
   signing then fails with *Cloud signing permission error* (no access to
   cloud-managed distribution certificates). Download `AuthKey_<KEYID>.p8`; it
   can only be downloaded once. Note the Key ID and the Issuer ID shown above
   the list.
5. **Environment and secrets**: an agent creates the environment, then
   delivers each value via the Secret Bridge flow, so no value is printed or
   kept in a chat. Sam pastes each value into the masked prompt.

   ```sh
   gh api -X PUT repos/TinyCloudLabs/tinychat/environments/ios-release \
     -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/TinyCloudLabs/tinychat/environments/ios-release/deployment-branch-policies -f name=main -f type=branch
   for name in APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_PRIVATE_KEY; do
     secret-bridge request "$name" --reason "Exo TestFlight: ios-release environment secret"
   done
   # once each request is fulfilled:
   for name in APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_PRIVATE_KEY; do
     secret-bridge pipe "$name" -- gh secret set "$name" --env ios-release --repo TinyCloudLabs/tinychat
   done
   ```

6. **Run**: first `gh workflow run ios-testflight.yml --ref main -f
   mode=validate`, then without `-f mode=validate` to upload. The run summary
   names the version and build.
7. **TestFlight**: App Store Connect → Exo → TestFlight. The build appears
   after Apple processes it (usually 5 to 30 minutes). Answer the export
   compliance question once. To skip it on later builds, add
   `ITSAppUsesNonExemptEncryption` to Info.plist, which is a legal call.
   Add yourself under Internal Testing, install **TestFlight** from the App
   Store on the iPhone, and install Exo from it.

#### On-device voice-note smoke test (TC-518)

Use the TestFlight build on a real iPhone. A simulator cannot check any of
this.

- [ ] Sign in (OpenKey email + code). Connectors → Sources shows the **Voice
      notes** card, which appears only when the native plugin is registered.
- [ ] Start a note. iOS asks for the microphone once, the orange mic indicator
      shows, and the level meter moves when you speak.
- [ ] Stop and save. The note appears in the list and in Library. Play it
      back and hear the recording.
- [ ] Start a note, then take a phone call or trigger Siri. The card shows
      `silenced` during the interruption and goes back to recording after it.
      Stop and save. The note's metadata has `capture.silenced_ms` > 0 and
      `silenced_events` ≥ 1.
- [ ] iOS 17+: mute the input from Control Center's mic mode while recording.
      The card shows `silenced`, then recording again after unmuting.
- [ ] Start a note, lock the screen for about a minute while speaking, then
      unlock, stop and save. The playback includes the locked stretch.
- [ ] Turn on airplane mode, record and stop. The save fails but the note
      stays pending. Turn airplane mode off and reopen the app; the note
      retries and saves.

## Sign-in on mobile

Tested on Android: OpenKey's embedded widget works inside the WebView with
**email + code**. The virtual-passkey test harness does not apply (Android
WebView DevTools has no `WebAuthn` domain). Passkeys inside the WebView need
androidx.webkit WebAuthn support and Digital Asset Links on openkey.so, and
this is untested. Google sign-in inside a WebView is blocked by Google
(`disallowed_useragent`); it needs a system-browser handoff.
