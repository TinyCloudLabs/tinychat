# Android capture durability (T15)

`voice-notes/account-state.json` is the ownership authority for a new recording.
The first read migrates existing SharedPreferences as `transitioning`; a fresh
install starts `signed_out`. A cold shortcut after an upgrade is unowned until
ready reasserts the account. Both
`setAccountState` and `setCaptureDefaults` write and sync a temporary file,
rename it, and sync the directory before acknowledging.

`beginRemoteOp` persists an open receipt before dispatch. A result updates the
owned note's ledger or the outbox entry `<id>:<opId>`; deletion transfers all
receipts before removing the sidecar. The outbox is not removed by age.

Recovery adopts a journal whose last intent is `paused` within 60 minutes.
The process starts one recovery scan before the WebView is needed. `listPending`
waits for that scan if it is in flight, then reads committed sidecars without
rescanning. `retryRecovery` explicitly runs another scan. This matches iOS's
launch recovery and `awaitRecovery` behavior and keeps receipt reads prompt
as the recording library grows.
The microphone stays off until the user opens Exo and resumes. An expired
paused session is committed with `pause_timeout`. The still-running process
checks the same limit every second. An attempt marker is synced before journal
parsing or muxing, so a process crash counts toward the limit. Three failed
or interrupted attempts quarantine the original session directory and expose
it in `listQuarantine`; `retryRecovery` restores it for one more attempt and
`discardFailedRecording` deletes it.

The journal records `first_audio` at the first delivered PCM buffer and
`capture_stopped` after `AudioRecord.stop()`. The sidecar exposes these as
`firstAudioAt` and `captureStoppedAt`. They bound the capture interval more
accurately than `wallMs`, which includes mic-open latency and drain work.
At ≤5% while discharging, the service journal records one `low_battery`
event with the measured integer percent. A failed journal write is logged and
surfaced as `writeFailure`, and the service retries on the next limit tick.

The Debug failure hook is the `exo.debug.failAccountState` string in the
`exo.debug` preferences (or a Java system property of that name): `1` fails
the `transitioning` write, `3` fails `signed_out`, and `compensation` fails
both `signed_out` and the return to `signed_in` from `transitioning`. The
last case leaves the durable account status `transitioning`.

The Moto G Power is checked out and locked. Its real noise floor and pause
loss cannot be measured in this task. The `no_signal` check therefore keeps
the exact-zero threshold until a Moto measurement can choose a safe windowed
threshold. The recovery-only `START_STICKY` trial is also deferred until the
Moto can verify that no foreground-service deadline exception occurs.

## Follow-ups

- Recovery still holds the engine control lock while muxing another orphaned
  session, so a paused note's controls can wait behind a large recovery.
- Only one parked session is adopted per launch. Additional parked sessions
  need a visible resolution policy and a `pause_timeout` notification.
- Explicit retry reports a coarse `recovery_failed` error; map its durable
  failure reason to a documented code.
- Move first-audio and low-battery journal fsyncs off the engine/audio callback
  path after measuring their effect on recorder controls.
- Native STT still marks private-cloud notes `waiting_for_model`; align that
  state with the selected transcriber.
- Refresh the T14 interruption test counts on a physical device; the current
  T14 doc points at the rebased log but the counts were not rerun.
