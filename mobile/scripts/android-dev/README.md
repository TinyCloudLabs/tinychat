# Android capture emulator harness

The API 24 and 34 AVDs exercise the minimum Android level and a recent level.
The scripts select `arm64-v8a` on Apple Silicon and `x86_64` on x86_64 hosts.
They use `~/Library/Android/sdk` on macOS and `~/Android/Sdk` on Linux unless
`ANDROID_HOME` is set. A visible emulator window and `-allow-host-audio` are
required for a usable microphone; do not run with `-no-window`.

```sh
EXO_AVD_API=24 mobile/scripts/android-dev/create-avd.sh
EXO_AVD_API=34 mobile/scripts/android-dev/create-avd.sh
EXO_AVD_API=34 mobile/scripts/android-dev/start-emulator.sh
ANDROID_SERIAL=emulator-5574 bash -c 'cd mobile/android && ./gradlew --no-daemon :app:connectedDebugAndroidTest'
EXO_AVD_API=24 mobile/scripts/android-dev/start-emulator.sh
ANDROID_SERIAL=emulator-5554 bash -c 'cd mobile/android && ./gradlew --no-daemon :app:connectedDebugAndroidTest'
```

Run one AVD at a time on a memory-constrained host. The `EXO_AVD_API` default is
34; `EXO_EMULATOR_ARGS` passes extra emulator flags. A boot can take several
minutes. The process is detached from the launching shell.

## Linux voice-note smoke loop

Install JDK 21, Android SDK tools, PulseAudio, `pulseaudio-utils`, `libxkbfile1`,
`ffmpeg`, and `espeak-ng`. KVM group membership is preferred; the starter falls
back to `sg kvm`. On Linux it runs `pulse-setup.sh` and starts the full emulator
with `PULSE_SOURCE=vmic.monitor`, `QEMU_AUDIO_DRV=pa`, `-qt-hide-window`, and
`QT_QPA_PLATFORM=offscreen`. Keep `PULSE_SERVER` and `XDG_RUNTIME_DIR` available
to `inject-audio.sh` and `smoke-voice-note.sh` through `env.sh`.

```sh
H=mobile/scripts/android-dev
$H/start-emulator.sh
bun install && bun run build:packages && bun run build:frontend
(cd frontend && bunx vite --mode production --host 127.0.0.1 --port 5391 --strictPort) &
(cd mobile && EXO_DEV_SERVER_URL=http://localhost:5186 bunx cap sync android)
(cd mobile/android && ./gradlew assembleDebug && "$ANDROID_HOME/platform-tools/adb" -s "$EXO_SERIAL" install -r app/build/outputs/apk/debug/app-debug.apk)
$H/launch-app.sh
$H/cdp.sh start
EXO_TEST_EMAIL=<throwaway>@mailinator.com $H/signin-email.sh
$H/smoke-voice-note.sh
```

The smoke test grants mic permission, injects a speech clip after recording
starts, and checks the saved audio's duration and level. Use
`SMOKE_LIMIT_MS=15000` to exercise the lower-only duration override.

## Gotchas

- On Linux, `-no-window` uses a headless QEMU build without the PulseAudio mic
  backend. The starter uses `-qt-hide-window` instead. On macOS, use a visible
  window for host mic audio.
- Keep one DevTools session: Android WebView lacks virtual passkey support, so
  sign in with an email code and a throwaway account.
- The mic is live; audio injected before capture starts is lost. Mono capture
  sums the emulator channels, so `GAIN_DB=-6` is the usual starting point.
- Android's resolver rejects DNS CNAME targets with an `_` label (TC-513). A
  regression can appear as `net::ERR_NAME_NOT_RESOLVED` in the WebView.
- Install the APK built from the same commit as the dev server; mismatched
  native methods leave a save pending on the device.

The Vite, DevTools, and audio injection scripts all source `env.sh`.
