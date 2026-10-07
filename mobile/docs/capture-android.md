# Android native capture v1

`CaptureService` enters a microphone foreground service before `CaptureEngine`
opens `AudioRecord`. Audio is 44,100 Hz mono PCM16, encoded as AAC-LC 64 kbps.
Each AAC access unit is wrapped in ADTS and appended to a session segment.
The journal and segment checkpoint every two seconds from each segment start
while capturing. A final heartbeat closes each segment and replaces a periodic
heartbeat due at the same instant; journal and sidecar JSON use canonical UTF-8
with sorted keys and one trailing newline. `RecordingFinalizer`
combines ADTS segments into a staged MPEG-4 file and publishes the sidecar last.
A sidecar is the commit marker. `CaptureBootstrap` recovers sessions on process
start without waiting for Capacitor or the WebView.

Pause first stops `AudioRecord`, collects any buffered input, drains the writer
and encoder, syncs the segment, then journals the final heartbeat and paused
intent before releasing the input. The service and its paused notification
remain. Resume starts a new segment and reacquires the mic. The
three-hour limit counts wall time minus user pauses, including interrupted time.
A user Stop from the
notification finalizes into `files/voice-notes/<id>.m4a` and `<id>.json`.

`RecordingLibrary` holds a process-wide synchronous lock for publications and
uses staged work with per-note generations. Deletion first writes a tombstone,
then moves remote cleanup into the outbox and removes local artifacts. Legacy
orphan audio is probed with `MediaExtractor`; playable orphans are imported as
`ownerUnknown`, and unplayable ones move to quarantine.

## Device checks

Build with `bun run --cwd mobile sync android` and `cd mobile/android &&
./gradlew :app:assembleDebug`. Before installing on the Moto G Power, check for
another install process. Install with `adb -s ZY22KKZ2GB install -r
mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Record with the
screen off, Stop from the notification, pull the private file with `run-as`,
and inspect it with `ffprobe` and `ffmpeg -af volumedetect`. For recovery,
SIGKILL the app while recording and relaunch; do not use `force-stop` as an
approximation of a process death.

## Shortcut permission tests on an emulator

The first-use and denied tests require a fresh microphone permission state.
Granting `RECORD_AUDIO` when installing the APK, or running them after another
capture test grants it, causes their `assumeTrue` precondition to skip them.
Install both APKs on the emulator without `-g`, then revoke and clear the
permission flags before **each** test:

```bash
adb -s emulator-5574 install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5574 install -r -t mobile/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

for test in shortcutFirstUsePermissionGrantStartsRecording shortcutDeniedPermissionClearsCommandWithoutReprompting; do
  adb -s emulator-5574 shell pm revoke xyz.tinycloud.exo android.permission.RECORD_AUDIO
  adb -s emulator-5574 shell pm clear-permission-flags xyz.tinycloud.exo android.permission.RECORD_AUDIO user-set user-fixed
  adb -s emulator-5574 shell am instrument -w -r \
    -e class "xyz.tinycloud.exo.capture.CaptureInstrumentedTest#$test" \
    xyz.tinycloud.exo.test/androidx.test.runner.AndroidJUnitRunner
done
```

Confirm each run says `OK (1 test)` and reports status code `0`; status code
`-4` means the test skipped. Use an emulator only: connected tests uninstall the
app when Gradle finishes, so they must never run on the Moto.
