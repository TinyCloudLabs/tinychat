# Android capture transitions and inputs (T14)

`CaptureService` stays a microphone foreground service while a note is paused.
Pause stops and releases `AudioRecord`, drains AAC, closes the segment, and
shows `Paused · m:ss recorded` with Resume and Stop. The `m:ss` value uses
recorded audio time, so it does not advance while paused. Resume makes a new
`AudioRecord` inside the running service and opens a new segment. A pause does
not make a missing-audio span. The three-hour limit excludes paused time.

Notification actions carry a recording `id` and an `epoch`. The service checks
both before acting. The epoch changes on Pause, Stop, Discard, and a successful
start; automatic retries keep it. `gen` changes for every start attempt and
also on Pause, Stop, and Discard. A start that finishes after one of those
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

Input ids are `<type>:<productName>` and the preference is durable. The active
id comes from the actual `AudioRecord.getRoutedDevice()`, and can differ from
the preference. Bluetooth selection on Android 31+ requests
`BLUETOOTH_CONNECT` and calls `setCommunicationDevice`; all explicit choices
also call `setPreferredDevice`. A disconnected chosen input produces
`input_unavailable` at Resume instead of silently switching microphones.

If Android denies a resumed mic start with `SecurityException`, the state is
`needs_user` / `resume_not_allowed`. A start that does not reach the recording
state reports `needs_user` / `mic_unavailable`. The high-priority “Tap to
resume recording” alert opens Exo and has a validated Resume action. The
paused foreground notification remains the route for locked-screen Resume.

## Emulator verification

- API 28: the full emulator connected suite finished 24 tests with 4 skipped,
  0 failed, and `BUILD SUCCESSFUL` after disabling Play Services in the
  private AVD. A preceding run had two startup failures because the guest's
  `c2.android.aac.encoder` allocator timed out; both passed on rerun. The
  synthetic AAC test exposed a real encoder bug: on this API, one 8 KiB input
  queued to `MediaCodec` produced only one 1024-sample AAC packet. Limiting
  each input to one AAC access unit fixed the packet count without relaxing
  the assertion.
- API 34: the full emulator connected suite finished 23 tests with 3 skipped,
  0 failed, and `BUILD SUCCESSFUL`, including the five-minute background
  Resume. A separate final-build five-minute run saved a 13.699773 s AAC note
  after notification Resume. The pulled file is
  `/tmp/exo-capture/evidence/T14/api34-background-note-36d33ec-audible.m4a`;
  `ffprobe` reports mono 44.1 kHz AAC. Post-pause `volumedetect` reports
  `mean_volume: -3.0 dB` and `max_volume: 0.0 dB` with BlackHole host-audio
  loopback. The waveform is non-silent, though that source was loud enough
  to reach the peak limit.
- API 36: stale action and injected read error tests passed (2/2). On the
  requested five-minute retry, the guest again stopped answering `adb shell`
  during the paused interval; the runner could not reach Resume. Evidence is
  in `/tmp/exo-capture/evidence/T14/api36-five-minute-36d33ec.txt` and
  `api36-adb-probe-36d33ec.txt`. The API 36 background and audio-level gate
  remains open due to emulator infrastructure.
- API 24: stale notification, in-flight Resume invalidation, and injected
  read-error tests passed (3/3). Direct-start buffer and blocked-Resume
  regression cases passed after fixes. A full connected suite attempt lost
  the emulator mid-run.
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

Do not run connected tests on this phone. Install over the existing app only
after it is released for the gate.
