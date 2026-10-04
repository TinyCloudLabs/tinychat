# Android emulator dev + smoke harness

Run Exo on a headless Android emulator on a Linux host, with a working microphone, drive its
WebView over DevTools, and run a real end-to-end voice-note smoke test against production
services. Written for agents and CI-like use; everything is a shell script.

## One-time host setup

- JDK 21 and the Android SDK command-line tools in `$ANDROID_HOME` (default `~/Android/Sdk`).
- KVM: `sudo usermod -aG kvm $USER` (new logins). `start-emulator.sh` falls back to `sg kvm` in
  the current one.
- Audio and tools: `sudo apt install pulseaudio pulseaudio-utils libxkbfile1 ffmpeg espeak-ng`.
- `./create-avd.sh`: SDK packages and the `exo` AVD (Pixel 7, API 36, x86_64, mic enabled).

## Loop

```sh
H=mobile/scripts/android-dev
$H/start-emulator.sh                       # background, idempotent; log in $EXO_STATE/emulator.log
# Frontend dev server against production services, on any free port (5186 may be taken):
(cd frontend && bunx vite --mode production --host 127.0.0.1 --port 5391 --strictPort) &
# Debug shell that loads http://localhost:5186 (an allowed backend CORS origin):
(cd mobile && EXO_DEV_SERVER_URL=http://localhost:5186 bunx cap sync android \
  && cd android && ./gradlew assembleDebug \
  && $ANDROID_HOME/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk)
$H/launch-app.sh                           # adb reverse 5186→$EXO_VITE_PORT, start app, DevTools on :9333
$H/cdp.sh start                            # long-lived DevTools controller (one session)
$H/cdp.sh eval 'document.title'            # evaluate in the WebView
EXO_TEST_EMAIL=<throwaway>@mailinator.com $H/signin-email.sh   # OpenKey email-code sign-in
$H/smoke-voice-note.sh                     # PASS/FAIL voice-note round trip
```

`smoke-voice-note.sh` grants the mic permission. It records through the app, plays a speech clip
into the emulator mic (`inject-audio.sh`) and stops. Then it waits for the note to be saved to
TinyCloud and listed, reads the stored audio back through the app's player, and checks it contains
speech (duration > 2 s, mean > -45 dB).

All settings live in `env.sh` and can be overridden from the environment: `EXO_AVD`,
`EXO_EMULATOR_PORT`, `EXO_VITE_PORT`, `EXO_DEVTOOLS_PORT`, and `EXO_STATE` (default
`/tmp/exo-android-dev`).

## Gotchas

- **`-no-window` kills the mic.** It runs the headless qemu build, which has no PulseAudio
  backend ("Could not init `pa' audio driver"). `start-emulator.sh` uses `-qt-hide-window` with
  `QT_QPA_PLATFORM=offscreen` instead (needs `libxkbfile1`).
- **The mic is live.** Audio injected while nothing in the guest records is lost: start recording
  first. Mono recordings sum the emulator's two capture channels, hence `GAIN_DB=-6`.
- **One DevTools session.** Android WebView DevTools has no `WebAuthn` domain, so passkeys can't
  be virtualized. Sign in with the email code (`signin-email.sh`) using a throwaway mailinator
  account only (public inboxes). Its taps are Pixel 7 coordinates, because the OpenKey sheet is a
  cross-origin iframe.
- **`navigator.onLine` stays `true`** in the WebView with Wi-Fi and data off. Test offline paths by
  their network errors.
- **DNS history (TC-513).** Android's resolver rejects a CNAME target whose label is `_`. The
  production API hosts were moved to `gateway.dstack-pha-prod5.phala.network`. If a host regresses,
  the app fails with `net::ERR_NAME_NOT_RESOLVED`; check with
  `adb shell ping -c1 <host>`.
- **Don't kill processes with `pkill -f <pattern>`** when the pattern appears in your own command
  line: it kills your shell.
