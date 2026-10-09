# On-device transcription: vertical slice (TC-836)

This is the thinnest working version of on-device transcription, pulled forward from the planned
T13 (iOS model downloads), T17 (Android model downloads), T23 (iOS on-device engine), T24 (Android
on-device engine), T26 (adapter) and T28 (choice UI) so the feature is visible and usable now.
Those tasks still land to harden it; see "Deviations and what's deferred" below for exactly what
they need to add. This file replaces the six separate per-task docs the full plan calls for
(`models-ios.md`, `models-android.md`, `stt-ios.md`, `stt-android.md`) until those tasks exist.

## What ships

- **Choice**: "Off · On this phone · Private cloud" in the recorder's transcription control
  (`capture/recorder/TranscriptionRouteControl.tsx`) and a "Voice notes" card in Settings
  (`chat/VoiceNotesTranscriberSettings.tsx`). On this phone is the default (decision 6) and is the
  only option a signed-out session actually uses: native `CaptureDefaults.options` and
  `CaptureEngine.setRecordingOptions` already force `transcriber = "on-device"` whenever the live
  session has no owner (`CaptureModels.swift:64`, `CaptureEngine.swift:607-616`,
  `CaptureEngine.kt:139-146`) — that guard predates this slice (T1/T4/T5) and needed no change.
- **Model**: Parakeet TDT 0.6B v3 int8 + Silero VAD, the same manifest T7/T8 pinned
  (`mobile/stt-fixtures.lock`), downloaded over Wi-Fi only with per-file sha256 verification
  (`ExoStt/ModelManifest.swift`+`ModelStore.swift`+`ModelDownloads.swift`;
  `stt/ModelManifest.kt`+`ModelStore.kt`+`ModelDownloads.kt`). `OnDeviceStt.status()` reports real
  state now instead of the T7 stub.
- **Transcription**: after Stop, `TranscriptionQueue` (`ExoStt/TranscriptionQueue.swift`,
  `stt/TranscriptionQueue.kt`) decodes the committed note's audio, runs Silero VAD (25 s soft cap)
  and the Parakeet recognizer with **greedy search, blankPenalty 1.0, zero chunk padding** — the
  TC-819 recommendation in stt-bench-ios.md — and writes the result through the existing local
  transcript store (`VoiceNotes.putTranscript`/`getTranscript`, already built in T1/T4/T5). It
  checks `CaptureEngine.isCapturing` before loading the model and before every VAD segment, and
  never runs while a capture session is live.
- **Sync to the space**: `lib/voiceNotes/onDeviceTranscriber.ts` reads the local transcript and
  writes it onto the note's space row through the **existing** transcript path
  (`saveVoiceNoteTranscript`/`VoiceNoteTranscriptSave`, the same function the private-cloud path
  uses) once the note has a space row and the account is signed in. It works signed out and
  offline because the native transcription and the local read/write never need a space or an
  account; only this last sync step does.
- **Errors**: a missing/corrupt model, an out-of-memory decode, or a decode failure sets
  `stt.state = "failed"` with `stt.error` and is surfaced with Retry
  (`OnDeviceStt.enqueue({id})` re-queues).
- **Catch-up**: a note whose on-device transcription did not finish (app killed, or the model
  was not ready yet) is re-queued automatically: `TranscriptionQueue.reconcile()` runs at process
  start and on every `committed`/`recovered` event, scanning for notes with
  `options.transcriber === "on-device"` and `stt.state` not in `{done, cancelled, failed}`.

## Deviations and what's deferred

Per the scoping discussion before this slice was built:

- **No auto-download.** The model downloads only when the user taps Download (recorder or
  Settings). T13/T17 add the "10 s after first foreground, Wi-Fi, toggle on by default" behaviour
  (decision 12).
- **No background execution.** There is no `BGProcessingTask` (iOS) or `SttWorker`/WorkManager
  (Android): the queue only runs while the app process is alive. T23/T24 add background
  continuation. A note interrupted mid-decode (app killed) restarts its decode from the beginning
  next time the queue runs, rather than resuming mid-file.
- **No model card or licences screen.** `OnDeviceStt.status()` is shown as one line with a
  Download/Cancel action, not the full model card, queue display and licences T27 adds.
  `deleteModels()` is implemented but not yet exposed in the UI.
- **The small (110M, <6 GB RAM) pack downloads its `.tar.bz2` release asset and extracts it
  on-device** (no individual-file hosting exists for it, confirmed against both the GitHub
  release and Hugging Face). Android uses Apache Commons Compress
  (`BZip2CompressorInputStream` + `TarArchiveInputStream`, factored into the pure, unit-tested
  `stt/core/ArchiveExtractor.kt`); iOS links the system `libbz2` through a small `CBZip2`
  system-library target and a minimal streaming USTAR reader (`Bzip2.swift`/`TarReader.swift`,
  ~90 lines together). The whole archive is sha256-verified before extraction, and each extracted
  file is sha256-verified again against its own pinned hash before it replaces anything in the
  model directory. Verified directly against the real published asset — on iOS, standalone
  (all four extracted files' sha256 matched `mobile/stt-fixtures.lock` exactly); on Android, via
  a real emulator download-and-extract run that caught and fixed two real bugs before the host
  was reclaimed for another task (see the TC-836 report): a missing `ACCESS_NETWORK_STATE`
  permission that crashed the app as soon as a download started, and a missing
  `BufferedInputStream` around the bzip2 stream that made extraction pathologically slow (bzip2
  decoders read their input almost a byte at a time). Both verification devices (Vonnegut,
  7.4 GiB; the Moto, 7.4 GiB) use the full pack regardless, so the full pack's path is the one
  that matters for G2; this path still needs a clean end-to-end emulator run once one is free.
- **Decode holds the whole note in memory.** `AudioDecoder.decode16kMono` (both platforms) decodes
  the full note before VAD/ASR, matching the existing T7/T8 benchmark harness's approach. A
  multi-hour note can use several hundred MB doing this. T23/T24's blockwise decode bounds it.
- **No capture-priority release-time budget.** The queue checks `isCapturing` before each VAD
  segment (so it still never transcribes while recording), but there is no measured ≤ 5 s release
  guarantee or diarization-case handling — those are T23/T24's capture-priority work, and there is
  no diarization in this slice at all (speaker separation is out of scope, per the task).
- **The per-recording control does not visually lock to "On this phone" when signed out.** The
  underlying behaviour is already fail-closed (native forces `on-device` regardless of what the
  control shows, verified in `CaptureEngine.setRecordingOptions`/`.kt`), so this is a cosmetic gap:
  a signed-out user could see "Private cloud" selectable, tap it, and nothing unsafe happens
  (native keeps the live session on-device) — but the control should grey the other options out.
  T28 is the planned owner of this polish.
- **`setAutoDownload()` is stored but inert.** It exists so the TS contract's shape is complete,
  but nothing reads it yet (see "no auto-download" above).

## Decode configuration (TC-819)

Both platforms use the same recognizer configuration, matching the Mac sweep in
`mobile/docs/stt-bench-ios.md` §"T7b decode sweep (TC-819)":

- Silero VAD, `minSilenceDuration 0.4`, `minSpeechDuration 0.1`, `maxSpeechDuration 25` (soft cap).
- `nemo_transducer`, greedy search, `blankPenalty = 1.0`, zero chunk padding, 4 threads, CPU
  provider.
- One `LocalTranscript` segment per VAD speech region (no hard-split, no diarization); `speaker`
  is always `null` in this slice.

## On-device checks (pending: both phones are reserved for another team)

Verified so far on simulator/emulator and Mac-native builds (see the TC-836 report for exact
commands and output). The following still need a real device, in this order, once either phone is
free:

1. **Happy path (either phone)**: sign out, pick "On this phone" in the recorder, record ~20 s of
   speech, Stop. Confirm the model downloads over Wi-Fi (or is already downloaded), confirm the
   transcript appears on the saved note's receipt within a few seconds, confirm it works with
   airplane mode on throughout.
2. **Sign-in sync**: repeat signed in; confirm the transcript lands on the space row (open the note
   from another session/device) via `saveVoiceNoteTranscript`, not just locally.
3. **Catch-up after kill**: start a long-enough recording that decode is still running, `kill -9`
   the app, relaunch; confirm the note's transcript still completes (queue reconcile catches it).
4. **Capture-priority**: start an on-device transcription job (a note with a few minutes of audio
   queued), then start a new recording while it is decoding; confirm recording starts immediately
   (no stutter/delay) and the queued job resumes once that recording stops.
5. **Model errors**: delete the model files directly (ADB/`xcrun devicectl`) after download, then
   Retry a `failed` note; confirm "Couldn't transcribe on this phone" with Retry appears, and that
   Retry re-downloads/re-decodes correctly once the model is restored.
6. **RAM tier**: confirm `OnDeviceStt.status().pack` reads `"full"` on both Vonnegut and the Moto
   (both well over 6 GB); there is no small-pack device available to test the
   `small_pack_unsupported` path on-device (see "Deviations" above).
7. Screenshots: "On this phone" selected in the recorder, and a transcript showing on a saved
   note, per the task's evidence requirement — pending the same device access.
