# iOS capture engine

The native engine lives in `Packages/ExoCapture` and starts at application launch, before a scene or WebView exists. `VoiceNotesPlugin` forwards the bridge methods to the process-wide engine. A home-screen quick action calls the same engine before the scene creates its WebView.

## Recording path

`AVAudioEngine` delivers PCM to a bounded 10-second writer queue. The writer encodes AAC-LC at 48 kHz mono and writes ADTS segments under `Application Support/voice-notes/sessions/<id>/`. Every two seconds it syncs the current segment and appends a heartbeat with the durable byte count. Every ten seconds it fully syncs the segment. Each restart opens a new segment. Stop converts the segments to a 48 kHz mono M4A in `staging/`, then publishes the audio and v2 sidecar in a short library transaction. The sidecar rename is the commit point.

The iOS 18 and iOS 27 simulator probes use a generated 440 Hz sine wave through the production encoder, Pause, Resume, finalizer and library. The ADTS header has sampling index 3, and the committed file is 48 kHz mono. AVFoundation's export presets changed the rate to 44.1 kHz, so finalization uses `AVAssetReader` and `AVAssetWriter` with explicit 48 kHz settings. The iOS 18 packet passthrough writer failed with OSStatus `-12735`; the explicit writer is the compatible path. Segments are joined as one ADTS stream before decoding, preserving their duration across pauses.

## Pause and recovery

Pause removes the tap and stops the engine, keeping buffers delivered before the stop. It then drains queued frames, fully syncs the segment, writes a final heartbeat with the byte count, writes and syncs the `paused` intent, and deactivates the audio session. If deactivation fails after the engine stops, Pause still resolves as paused. Resume reacquires the microphone and opens a new segment. The three-hour limit excludes pauses. Recovery is launched once per process; a session with no committed sidecar is remuxed from its ADTS segments, while a session with a sidecar is cleaned up. Tombstones prevent staged work from republishing a deleted note.

## Verification

Run `swift test --package-path mobile/ios/Packages/CaptureCore`, then build and smoke both the newest simulator and an iOS 18 simulator with `mobile/scripts/ios-simulator-smoke.sh`. The `EXO_CAPTURE_SMOKE` child environment switch enables the synthetic production-writer probe. The script accepts `EXO_SMOKE_RUNTIME` and `EXO_SMOKE_DEVICE_TYPE` for runtime selection. The native-file check uses `ffprobe -show_entries format=duration:stream=codec_name,sample_rate,channels` and `afplay` on an audio file copied from the app container.

An iOS 18 simulator microphone run using the launch-time diagnostic recorded 5,248 ms of AAC audio. `ffprobe` reported AAC at 48 kHz mono with a 5.312 s container duration, `afplay` returned success, and the session directory was removed after commit. Evidence is in `/tmp/exo-capture/evidence/T4/sim-mic/`.

`RecordingLibrary.syncMetrics()` records counts, mean and maximum latency for `F_FULLFSYNC`, `F_BARRIERFSYNC` and any `fsync` fallback. The engine logs these numbers after a successful stop. Synthetic capture measured mean `F_FULLFSYNC` / `F_BARRIERFSYNC` of 7.87 / 1.75 ms on the iOS 18.0 simulator and 8.90 / 0.52 ms on the iOS 27.0 simulator (verified smoke output in `/tmp/exo-capture/evidence/T4/`). Vonnegut was unavailable, so physical-device latency and microphone checks remain pending; simulator latency is not a device estimate.
