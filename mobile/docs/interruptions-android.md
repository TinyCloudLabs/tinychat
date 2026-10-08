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

- API 34: stale notification action, injected read error with restart, and
  in-flight Resume invalidation by Pause/Stop/Discard passed in separate
  instrumented runs. A five-minute background run reached its assertion, but
  the test had not granted `POST_NOTIFICATIONS`, so the paused notification was
  absent and Resume was not invoked. The test now grants that permission;
  subsequent emulator boot attempts did not reach a usable guest. No resumed
  audio result can be claimed from those attempts.
- API 36: stale action and injected read error tests passed (2/2). During the
  subsequent five-minute test launch, the emulator stopped answering guest
  shell commands before the runner reported test startup. The test did not
  reach Pause.
- API 24 booted, but installation stalled in `dex2oat` on the emulator, so
  no app assertion completed. The API 28 image was unavailable locally.
- Unit tests, debug APK, unsigned release AAB/APK, and the throwaway-key
  release signing rehearsal passed. The API 34/36 five-minute background
  checks and host-audio `mean_volume` evidence remain open.

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
