# Android native capture v1

`CaptureService` enters a microphone foreground service before `CaptureEngine`
opens `AudioRecord`. Audio is 44,100 Hz mono PCM16, encoded as AAC-LC 64 kbps.
Each AAC access unit is wrapped in ADTS and appended to a session segment.
The journal and segment checkpoint every two seconds while capturing. A final
heartbeat closes each segment; journal and sidecar JSON use canonical UTF-8
with sorted keys and one trailing newline. `RecordingFinalizer`
combines ADTS segments into a staged MPEG-4 file and publishes the sidecar last.
A sidecar is the commit marker. `CaptureBootstrap` recovers sessions on process
start without waiting for Capacitor or the WebView.

Pause stops and releases `AudioRecord` while the service and its paused
notification remain. Resume starts a new segment and reacquires the mic. The
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
