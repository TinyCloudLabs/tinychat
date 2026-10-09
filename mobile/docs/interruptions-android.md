# Android capture transitions and inputs (T14)

`CaptureService` stays a microphone foreground service while a note is paused.
Pause stops and releases `AudioRecord`, drains AAC, closes the segment, and
shows `Paused · m:ss recorded` with Resume and Stop. The `m:ss` value uses
recorded audio time, so it does not advance while paused. Resume makes a new
`AudioRecord` inside the running service and opens a new segment. A pause does
not make a missing-audio span. The three-hour limit excludes paused time.

Notification actions carry a recording `id` and an `epoch`. Pause and Resume
check both; Stop and Discard check the id so a tap still works while a resumed
notification is being refreshed. The epoch changes on Pause, Stop, Discard,
and a successful start; automatic retries keep it. `gen` changes for every
start attempt and also on Pause, Stop, and Discard. A start that finishes after one of those
actions releases only its own input, without attaching it or opening a segment.
The `start.beforeAttach` instrumented gate checks this for Pause, Stop, and
Discard.

Android 29+ uses `AudioRecordingCallback.isClientSilenced` for a silenced span.
An `AudioRecord` read error closes the segment, opens a `read_error` omitted
span, and retries. On Android 31+, audio-mode changes label a call interruption
and trigger a restart when normal mode returns. Device additions/removals
update the input list; a route rebuild opens a new segment and a short
`route_change` omitted span. Other apps playing media do not cause audio focus
changes because Exo does not request focus.

Input ids are `<type>:<productName>` and the preference is durable. Duplicate
ids are shown once. The active id comes from the actual
`AudioRecord.getRoutedDevice()`, is journaled in the saved note, and appears in
the recorder UI. If a saved input is disconnected, recording uses the system
route while retaining the preference for when that input returns. Selecting an
absent input directly is rejected. Bluetooth selection on Android 31+ requests
`BLUETOOTH_CONNECT` and calls `setCommunicationDevice`; all explicit choices
also call `setPreferredDevice`. Unplugging the chosen input during recording
opens a short route-change span and restarts on the available route.

If Android denies a resumed mic start with `SecurityException`, the state is
`needs_user` / `resume_not_allowed`. A start that does not reach the recording
state reports `needs_user` / `mic_unavailable`. The high-priority “Tap to
resume recording” alert opens Exo and has a validated Resume action. The
paused foreground notification remains the route for locked-screen Resume.
Automatic restart failures stay `interrupted` with the omitted span open.
Retries use 0.5, 1, 2, 5, 10, then 30-second intervals for at most 10 minutes;
only a manual failure or exhaustion moves to `needs_user` and posts the alert.
Opening Exo attempts one restart if the session needs attention.

## Emulator verification

- API 28: the pre-review full emulator connected suite ran 20 tests with 4 skipped,
  0 failed, and `BUILD SUCCESSFUL` after disabling Play Services in the
  private AVD. A preceding run had two startup failures because the guest's
  `c2.android.aac.encoder` allocator timed out; both passed on rerun. The
  synthetic AAC test exposed a real encoder bug: on this API, one 8 KiB input
  queued to `MediaCodec` produced only one 1024-sample AAC packet. Limiting
  each input to one complete AAC access unit fixed the loss. A 44,100-sample
  probe contains 43 complete frames and a 68-sample tail. The final short
  tail is not queued because some codecs pad it with silence; the test requires
  all 43 complete packets. The maximum dropped tail is 1,023 samples (23 ms).
  The round-two guarded full suite later ran 25 tests: 21 passed, 4 skipped,
  0 failed (`review-r1-api28-full-guard-9b60938.txt`).
- API 34: the pre-review full emulator connected suite ran 20 tests with 3 skipped,
  0 failed, and `BUILD SUCCESSFUL`, including the five-minute background
  Resume. A separate pre-review five-minute run saved a 13.862313 s AAC note
  after notification Resume. The pulled file is
  `/tmp/exo-capture/evidence/T14/api34-background-note-8688aa1-audible.m4a`;
  `ffprobe` reports mono 44.1 kHz AAC. The post-pause signal is non-zero
  (about −39 dB RMS in half-second windows), which rules out digital silence,
  but the test did not establish intelligible speech. Instrumentation sent
  the notification action directly; G2 checks the locked-screen SystemUI tap.
  The round-two guarded full suite later ran 25 tests: 22 passed, 3 skipped,
  0 failed, including the five-minute background Resume
  (`review-r1-api34-full-guard-9b60938.txt`). The pulled AAC note is
  `review-r1-api34-background-note-guard-9b60938.m4a`; its post-pause volume
  averaged −77.5 dB (maximum −68 dB). The required `-no-audio` emulator guard
  prevents this run from establishing intelligible recorded speech.
- API 36: an earlier five-minute retry lost `adb shell` during the pause
  (`api36-five-minute-36d33ec.txt`, `api36-adb-probe-36d33ec.txt`). The later
  guarded retry completed in 318 seconds with `OK (1 test)`, no app crashes,
  and a committed 13.862-second note
  (`review-r1-api36-five-minute-guard-9b60938.txt`). Its audio-level check
  remains limited by the required `-no-audio` launch.
- API 24: the round-two guarded full suite ran 25 tests: 19 passed, 6 skipped,
  0 failed (`review-r1-api24-full-guard-9b60938.txt`).
- Unit tests, debug APK, unsigned release AAB/APK, and the throwaway-key
  release signing rehearsal passed. The physical Moto gate G2 remains open.

## Moto G Power gate G2 (pending device release)

The physical Moto is reserved. Run each with the screen off: placed/received
calls, “Hey Google,” a WhatsApp call, YouTube playback, wired and Bluetooth
headset insertion/removal, explicit input switching, and the mic privacy
toggle. Record the state, span reason, `activeId`, notification, and pulled
audio for each. While paused, check that the privacy indicator turns off
within one second and the paused notification stays; take and end a call and
confirm it remains paused. After ten minutes paused and locked, Resume from
the notification, pull the note, and check the new segment's `mean_volume`.
With the system recorder holding the mic, record which outcome occurs: genuine
start failure → `mic_unavailable`; successful but silenced start → an
`isClientSilenced` span; or Exo receives normal input. Also check Stop during
a route rebuild and that interruption → Pause makes an old alert action stale.
The `start.beforeAttach` case passed on an emulator. Do not run instrumented
tests on the physical phone; the plan's Moto-specific case remains an explicit
deviation under the phone restriction. Check a saved headset preference while unplugged at
start and unplug the headset mid-recording; both should keep recording on the
system route while preserving the choice. Check the `BLUETOOTH_CONNECT` prompt
and denial, the built-in mic list for duplicate ids, and saved duration against
wall recording time minus user pauses within a few percent.

Do not run connected tests on this phone. Install over the existing app only
after it is released for the gate.
