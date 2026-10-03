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
- `assets/`, `scripts/brand-assets.py`: the brand mark and the generator for
  every app icon and splash image (see Branding).

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
app's signing identity, which does not exist yet.

**This flow is OFF until that exists.** Any app can claim a private-use scheme,
and `/exchange` accepts any signed-in session. So an app that starts its *own*
flow, gets a victim to consent on Google's real screen and captures the return
can redeem the code into its own account (RFC 8252 §8.6). PKCE only protects
flows Exo started. Two switches, both off by default:

- backend `GOOGLE_OAUTH_NATIVE_RETURN=true`: accept `native.` states at `/start`
  and `/autojoin/begin`, and let `/callback` redirect them to the deep link.
  While it's off, `/callback` never sends a code to the app.
- app build `VITE_EXO_NATIVE_GOOGLE_OAUTH=true`: offer the flow in the app. While
  it's off, "Continue with Google" in the app explains that Google isn't
  available in the app yet and that a connection made on the web works here too.

Turn both on only once the return is a verified https link. That changes the
backend's `NATIVE_OAUTH_RETURN_URL`, the Android intent-filter (with
`autoVerify`) and the iOS associated domain. It needs the release signing
certificate (TC-519) and the Apple Team ID (TC-518).

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

## Android release

A release build bundles the production web app and is signed with the Play
upload key. It never loads a dev server.

- **Web app.** `bun run build:frontend` is a production `vite build`
  (`frontend/.env.production`), and `cap sync android` copies `frontend/dist` into
  the app. Without `EXO_DEV_SERVER_URL`, `capacitor.config.json` has no
  `server.url`, so the WebView origin is `https://localhost`. The backend
  allows that origin.
- **Gate.** `app/build.gradle` runs `verifyExoRelease` before every release
  task (`assembleRelease`, `bundleRelease`). It fails the build if any signing
  input is missing, if the web app is not bundled, or if
  `capacitor.config.json` has a `server.url`. AGP would otherwise produce an
  unsigned "release" without complaint. Debug builds need none of this.
- **Signing inputs.** Set each one as a Gradle property or an environment variable
  of the same name: `ANDROID_KEYSTORE_FILE` (path to the upload `.jks`),
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
  The release `signingConfig` is applied only when all four are set.
- **Versions.** `versionName` comes from `frontend/package.json`. Web, desktop
  and mobile share one product version, e.g. `0.2.0-beta.2`. `versionCode` is
  `EXO_VERSION_CODE`, which defaults to 1 locally. CI sets it to the release
  workflow's run number. Play needs a strictly greater code for every upload. A
  beta version often stays the same across many merges, so the code can't be
  derived from the version alone. The run number grows on every run. If mobile
  later becomes a Changesets release unit, desktop's `XYYZZSSS` build number
  (e.g. `200003` for `0.2.0-beta.3`) keeps codes increasing, as long as the run
  number is still below it at the switch.
- **R8 is off** (`minifyEnabled false`). Capacitor ships keep rules for its
  plugins, but no minified build of the app-local VoiceNotes plugin and the
  WebView bridge has been run on a device yet. Turn it on only after one has.

Build one locally. Use a throwaway key from `/tmp` to try the pipeline:

```sh
bun install && bun run build:packages && bun run build:frontend
cd mobile && bunx cap sync android && cd android
export ANDROID_KEYSTORE_FILE=/abs/path/upload.jks ANDROID_KEY_ALIAS=exo-upload EXO_VERSION_CODE=1
read -rs ANDROID_KEYSTORE_PASSWORD && export ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
./gradlew bundleRelease assembleRelease
# APK signer, version, icon, not debuggable, bundled web app without server.url, AAB signer:
../../scripts/release/verify-android-release.sh app/build/outputs/apk/release/app-release.apk \
  app/build/outputs/bundle/release/app-release.aab "$(node -p 'require("../../frontend/package.json").version')" 1 \
  "$(keytool -list -v -keystore "$ANDROID_KEYSTORE_FILE" -storepass:env ANDROID_KEYSTORE_PASSWORD -alias "$ANDROID_KEY_ALIAS" | sed -n 's/^[[:space:]]*SHA256: //p')"
```

### CI: `Mobile release (Android)`

`.github/workflows/mobile-release-android.yml` builds the signed AAB (for Play)
and APK (for sideloading):

```sh
gh workflow run mobile-release-android.yml --ref main
```

- It runs only from `main`, in the `android-release` environment, which is the
  only place the upload key lives. It refuses any other ref, and it fails before
  building if a secret is missing. There is no unsigned fallback.
- `scripts/release/verify-android-release.sh` checks the result before any
  upload. Both files must be signed with the keystore's certificate (never the
  debug key). The APK must be `xyz.tinycloud.exo` at the expected
  versionName/versionCode, not debuggable, with an icon. Both must bundle the web
  app without `server.url`.
- The artifact is `exo-android-<versionName>-<versionCode>`, containing
  `Exo-<versionName>-<versionCode>.aab`, the matching `.apk` and
  `SHA256SUMS.txt`. A re-run keeps its run number, and with it the versionCode.
  Dispatch a new run when you need a new upload.
- PRs that touch the Android project or this workflow run a **rehearsal**. It is
  the same build, signed with a throwaway key generated on the runner and
  verified the same way. It uses no secret and uploads nothing.
- Play upload is not wired yet. Until the Play app exists, upload the `.aab` by
  hand. The workflow header has a TODO for an internal-track upload step with a
  pinned `r0adkll/upload-google-play` and a `PLAY_SERVICE_ACCOUNT_JSON` secret.

Environment secrets (`android-release`):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | `base64 < exo-upload.jks \| tr -d '\n'` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | the key alias, e.g. `exo-upload` |
| `ANDROID_KEY_PASSWORD` | the key password; for a PKCS12 keystore (keytool's default) it equals the keystore password |

### One-time setup (Sam / repo admin)

1. **Environment**, deployable from `main` only, with no reviewers (the same as
   `desktop-release`):

   ```sh
   repo=TinyCloudLabs/tinychat
   gh api -X PUT repos/$repo/environments/android-release \
     -F 'deployment_branch_policy[protected_branches]=false' \
     -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/$repo/environments/android-release/deployment-branch-policies \
     -f name=main -f type=branch
   ```

2. **Upload key.** Create it once, on your own machine, outside any repo.
   keytool prompts for the password:

   ```sh
   keytool -genkeypair -v -keystore exo-upload.jks -storetype PKCS12 -alias exo-upload \
     -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Exo upload key, O=TinyCloud Labs"
   ```

   Keep the `.jks` and its password in the team password manager. Never commit
   it: `*.jks` and `*.keystore` are gitignored. With **Play App Signing** (the
   default for new apps), Google holds the app signing key, and this key only
   authenticates uploads. If it leaks or is lost, Play Console can reset it, so
   it can be replaced. The app signing key never can.

3. **Secrets.** Store them as environment secrets, never repository secrets
   (any branch's workflow can read those), and never paste them into a chat.
   From your own machine, `gh` prompts with hidden input:

   ```sh
   base64 < exo-upload.jks | tr -d '\n' | gh secret set ANDROID_KEYSTORE_B64 --env android-release --repo $repo
   gh secret set ANDROID_KEYSTORE_PASSWORD --env android-release --repo $repo
   gh secret set ANDROID_KEY_PASSWORD --env android-release --repo $repo
   gh secret set ANDROID_KEY_ALIAS --env android-release --repo $repo --body exo-upload
   ```

   If an agent on the dev host does it instead, use **Secret Bridge** so the agent
   never sees a value. The agent runs
   `secret-bridge request ANDROID_KEYSTORE_PASSWORD --reason "Exo Android upload key"`,
   you type the value into the Paseo input card, and the agent delivers it with
   `secret-bridge pipe ANDROID_KEYSTORE_PASSWORD -- gh secret set ANDROID_KEYSTORE_PASSWORD --env android-release --repo TinyCloudLabs/tinychat`.
   Repeat for each secret. Bridge the keystore as its base64 text.

4. Run `gh workflow run mobile-release-android.yml --ref main` and download the
   artifact.

### Play Console checklist (internal testing)

- [ ] Google Play developer account (organization; D-U-N-S number needed) and
  the app: name **Exo**, package `xyz.tinycloud.exo` (permanent once uploaded),
  app, free.
- [ ] Play App Signing: accept Google-managed signing on the first upload. The
  CI artifact's `.aab` is signed with the upload key above. Record Play's
  app-signing certificate SHA-256 (App integrity) for later Digital Asset Links
  (passkeys, app links).
- [ ] **Internal testing** track: create a release, upload the first `.aab` by
  hand (the Play API cannot create an app's first release), add a tester list
  (emails or a Google Group), share the opt-in link.
- [ ] **Privacy policy URL.** Required for an app that records audio. Exo has no
  privacy policy page yet.
- [ ] **Data safety.** Answer for the whole app, web view included:
  - Audio, voice or sound recordings: collected, not shared, for app
    functionality. Recording starts only when the user taps Record, and the
    note is stored in the user's own TinyCloud space (KV and SQL in their
    space on the TinyCloud node, written by the app through the TinyCloud
    SDK, not by the Exo backend). Encrypted in transit (HTTPS).
  - Also declare the account data used for OpenKey sign-in (email) and the
    chat/meeting content the app stores in the user's space. Check current
    behavior before answering, including what can be deleted and how.
- [ ] **Foreground service permissions** (App content). Declare
  `FOREGROUND_SERVICE_MICROPHONE`: the `microphone` foreground service
  (`VoiceNoteService`) keeps a recording the user started running while the
  screen is off or the app is in the background, with an ongoing notification.
  Play asks for a short video of that flow.
- [ ] **`RECORD_AUDIO` justification.** It has no Play declaration form;
  Data safety and the store listing cover it. Use: "Records voice notes only
  after the user taps Record; the system mic indicator and Exo's notification
  are shown while recording." The OS permission prompt comes from the
  VoiceNotes plugin on first record.
- [ ] **`POST_NOTIFICATIONS`** (Android 13+) is declared for the recording
  notification, but the app does not request it at runtime yet, so on 13+
  that notification stays hidden until the user allows it in Settings. Request
  it before recording, or say so in the review notes.
- [ ] Content rating questionnaire, target audience (not children), ads (none),
  app access instructions for review: email + code sign-in with a test inbox.
- [ ] Store listing: `mobile/assets/play-store-icon.png` (512 px), a 1024x500
  feature graphic and phone screenshots (neither exists yet).
- [ ] **TC-513 first.** Real phones cannot resolve `api.openkey.so`,
  `api.tinycloud.chat` and `tee.node.tinycloud.xyz` (see the known issue
  above), so sign-in, sync and voice-note upload fail outside the emulator
  harness. Do not invite testers before the DNS fix ships.

## Branding

`python3 mobile/scripts/brand-assets.py` (needs Pillow) generates every icon
and splash from one source, `mobile/assets/tinycloud-mark.png`, placed on the
TinyCloud brand blue `#4473B9`:

- Android adaptive icon foreground (`mipmap-*/ic_launcher_foreground.png`,
  wired by `mipmap-anydpi-v26/ic_launcher*.xml` with
  `@color/ic_launcher_background`), legacy and round icons, and the pre-12
  `splash.png`s. Android 12+ draws its system splash from `styles.xml`
  (`windowSplashScreenBackground` and `windowSplashScreenAnimatedIcon`).
- iOS `AppIcon.appiconset/AppIcon-512@2x.png` (1024 px, opaque) and the
  `Splash.imageset` images used by `LaunchScreen.storyboard`.
- The 512 px Play listing icon.

**Exo has no designed mark yet.** The source is the TinyCloud cloud mark
(`logo/tinycloud-icon.png` in TinyCloudLabs/docs; the desktop icons are
still placeholders). For a real Exo icon, replace `tinycloud-mark.png` with
the designed mark (transparent background, about 3:2) and rerun the script.
Raster sources up to roughly 500 px wide, like this one, are slightly soft at
the iOS 1024 px size. A vector or 2048 px export avoids that.

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
(`disallowed_useragent`), so OpenKey's "Continue with Google" needs its own
system-browser handoff on OpenKey's side (TC-520 territory). The Google
connectors have one already (see "Google connectors (OAuth)").
