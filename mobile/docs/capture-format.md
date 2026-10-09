# Exo capture format and bridge contract

## Contract changes since aa9ae19

T4 and T5 should apply these changes to their in-progress engines and tests:

- ADTS golden bytes now encode AAC-LC mono at index 3 (48 kHz) or 4 (44.1 kHz); the fixture checker decodes every header field.
- Journal, v2 sidecar, outbox and quarantine JSON now have canonical UTF-8 bytes: sorted keys, compact encoding, exact null keys, unescaped `/` and one LF per record. Legacy v1 files remain parsed leniently.
- Journal `a`, v2 `durationMs` and status `audioMs` count durable complete AAC access units × 1024 samples, floored to milliseconds; priming and padding access units count. `segBytes` is the sum of complete ADTS frame lengths in that segment.
- Each segment re-arms the 2 s heartbeat timer; a close at the due instant writes only its final heartbeat. Every close heartbeat records `recording/available`. Pause stops input first, accepts all pre-stop buffers, drains and syncs the segment, journals the final heartbeat and `intent paused`, syncs the journal, then deactivates/releases input. A failed stop restores recording and rejects; a failed post-stop release still resolves paused. Resume uses a new generation and segment.
- Recovery clips `wallMs` and any open pause to the last complete durable journal event; `elapsedMs` and the 3-hour limit use wall time minus paused time. The limit still runs while interrupted or blocked, emits retained `autoStopped`, and uses the explicit Swift/Kotlin constants in §1.7.
- A failed paused or manual Resume emits `needs_user/resume_blocked` and rejects `resume_failed`; a failed Pause never reports the mic off. Notification `{gen}` is diagnostic and does not block a valid tap after automatic retries.
- `CaptureStatus` fields for intent, availability, timing, spans and `transitionGen` are required. `claim(space_row)` now requires the existing Library `rowId`.
- Hosted AssemblyAI cleanup enqueues both transcript and upload handles; an unknown own-key submit uses `own_upload_lookup`. Retained events queue until consumed. `putTranscript` alone does not increment the sidecar `rev`.
- Plugin results are snapshots of native state. OS silencing during Pause is remembered for Resume; automatic retries preserve the interruption reason until blocked. A paused session has no restart backoff.
- Initial input is journaled; Pause during interruption closes the open omitted span. `avail.reason` and integer low-battery percent are defined below. Duration arithmetic uses 64-bit integers, while live `audioMs` advances at durability checkpoints. The checked-in `*-input.json` files contain expected journal events, not core stimuli.
- Claim evidence is checked even for an already-owned note: `space_row` is valid only for legacy notes and a v2 note rejects it without changing its ledger.

These sections incorporate user decision P5: Pause releases the microphone, and the three-hour limit excludes paused time.

### 1.3 Capture format v1, persistence and the library

Both platforms implement the encoding below against the golden files in `mobile/fixtures/capture/`. Run `python3 mobile/fixtures/capture/generate.py` to validate them; `--write` regenerates them from the checked-in expected-output event scripts (`ios-input.json` and `android-input.json`). Those files list expected journal events and frame totals; they are not stimuli. Core tests drive the matching start, frame-delivery, clock, interruption, Pause, Resume and Stop stimuli, then compare the resulting canonical journal and sidecar to the golden bytes.

**Layout** (iOS `Application Support/voice-notes/`, Android `files/voice-notes/`; locations and backup behaviour unchanged, Q9):
```
voice-notes/
  <id>.m4a                     final audio (AAC-LC in MPEG-4)                      [unchanged contract]
  <id>.json                    sidecar v2 incl. ledger; its presence = committed   [v1 files still read]
  <id>.transcript.json         local transcript (§2.4)
  <id>.stt-progress.jsonl      ASR checkpoints (§2.5)
  <id>.diar-progress.json      diarization checkpoints (§2.10)
  sessions/<id>/journal.jsonl, sessions/<id>/seg-00000.aac …   ADTS AAC
  staging/<id>.<opGen>.*       staged outputs of long operations, published by rename
  tombstones/<id>              empty marker: the id is deleted
  outbox/<entryId>.json        remote cleanup still owed (account-scoped)
  quarantine/<id>.m4a|.json    legacy files that couldn't be imported (§1.9)
```
`<id>` is a lowercase UUID. Models live in `Application Support/models/` and `files/models/`, excluded from backup.

**ADTS.** MPEG-4 (ID=0), layer 0, no CRC, profile LC; sampling-frequency index 3 (48 000, iOS) or 4 (44 100, Android); channel configuration 1; `frame_length` = 7 + payload; buffer fullness 0x7FF; one raw data block per frame.

**Canonical encoding.** Journal records, v2 sidecars, outbox entries and quarantine records are UTF-8 without a BOM. Every JSON object has keys in ascending ASCII order at every nesting level; all contract keys are ASCII. There is no insignificant whitespace. Strings use `\"` and `\\` for quote and backslash, the short JSON escapes for backspace, tab, newline, form feed and carriage return, and lowercase `\u00xx` for other U+0000–U+001F controls. `/` is never escaped. Valid non-ASCII Unicode is written directly as UTF-8 without normalization; invalid surrogate sequences are rejected. Numbers are finite base-10 integers without leading zeros, `+`, exponent or `.0`; booleans and `null` are lowercase. Arrays preserve chronological order. Every journal object ends in exactly one LF (`\n`), including the last complete line. Every canonical single-object file also ends in one LF. Writers emit exactly the event fields in the table and the full key set shown by the v2 golden sidecar; a nullable field is written as `null`, not omitted. New fields require a format version change; readers distinguish absent from explicit `null` in older files. V1 sidecars are parsed as legacy JSON regardless of key order or spacing. A torn final journal line is ignored; an invalid complete line is an error. Byte comparison applies to canonical JSON and ADTS fixtures.

Swift can use `JSONEncoder` with `.sortedKeys` and `.withoutEscapingSlashes`, but must encode required nulls explicitly with `encodeNil`; a hand writer is also valid. Android must sort keys and leave `/` unescaped with a canonical writer. Swift `JSONSerialization` sorting and Android `org.json` output are not suitable as-is.

**Journal time and bytes.** `t` is Unix wall time in integer milliseconds. `a = floor(N × 1024 × 1000 / rate)`, computed with 64-bit integer arithmetic (Kotlin `Long`), where `N` is the cumulative number of **complete ADTS AAC access units durably checkpointed** across all segments; `rate` is the session sample rate (48 000 iOS, 44 100 Android). AAC encoder priming and trailing padding access units count if written; there is no subtraction or negative offset. Incomplete ADTS frames are discarded before a checkpoint or recovery. `a` never decreases and is repeated on events with no newly durable frame. V2 sidecar `durationMs` and status `audioMs` use the same formula. Live `audioMs` advances at durability checkpoints, including the final checkpoint at segment close; the live elapsed timer uses `elapsedMs`, not `audioMs`. `segBytes` is the sum of the `frame_length` values of complete durable ADTS frames in that segment, including each 7-byte header; it is never an estimated bitrate or a file length containing a torn frame. The fixture scripts use 107-byte frames, so every `segBytes` is `frames × 107`.

**Journal** (UTF-8 JSON Lines; a torn last line is ignored). Common fields: `e` (event), `t` (wall ms), `a` (audio ms as defined above).

| `e` | Extra fields | When |
|---|---|---|
| `session` | `v:1, id, platform, codec:"aac-lc", container:"adts", rate, channels:1, bitrate, maxDurationMs, source, owner, transitionGen, options:{transcriber, identifySpeakers}` | first line |
| `segment` | `index, file` | a segment opens |
| `hb` | `seg, segBytes` (bytes durable after this checkpoint), `intent`, `availability` | periodic every 2 s from this segment's `segment` event while capturing; final at segment close, Pause or Stop if a segment is open |
| `intent` | `value` (`recording`/`paused`/`stopped`), `by` (`user`, `limit`, `disk`, `write_failed`, `discard`) | intent changes |
| `avail` | `value` (`available`/`interrupted`/`blocked`), `reason`, `gen` | availability changes or a start attempt completes (even if still `available`) |
| `span_open` / `span_close` | `kind`, `reason` | missing audio starts/ends |
| `input` | `id, name, kind` | the input in use changes |
| `options` | `transcriber, identifySpeakers` | per-recording options change |
| `owner` | `did` | the live session is claimed |
| `low_battery` | `level` (integer percent, 0–5) | ≤ 5 % and discharging |
| `stop` | `reason` (`user`, `max_duration`, `disk_full`, `write_failed`, `discard`, `permission_revoked`) | before commit |

`avail.reason` is `null` when `value=available`. For `interrupted`, it is one of `call`, `interruption`, `route_change`, `media_services_reset`, `read_error`, `stalled` or `app_suspended`; for `blocked`, it is `resume_blocked` or `permission_revoked`. An iOS `AVAudioSession` interruption alone maps to `interruption`, and maps to `call` only if `CXCallObserver` confirms a call. Android maps an ordinary focus/input interruption to `interruption`, and maps to `call` only with a positive telephony signal. Route, media-reset, read-error, stall and suspension events use their named reasons.

**Missing-audio spans**, durable in the journal and sidecar, in live status, and in the space row's `capture.spans`:
```ts
interface MissingAudioSpan {
  kind: "omitted" | "silenced";   // omitted: no frames written; silenced: frames written, but the OS fed silence
  reason: string;                 // interruption, route_change, media_services_reset, read_error, stalled, app_suspended, writer_stalled, os_silenced, input_muted, call
  startedAt: number; endedAt: number | null;   // wall ms
  atAudioMs: number;              // position in the audio
  audioMs: number;                // omitted: 0; silenced: length in the audio
}
```
A user pause is not a missing span; it is counted in `pausedMs` and the `intent` events.

**Persistence order.** `dsync(dir)` = `fsync` of the directory fd (iOS: `fcntl(F_FULLFSYNC)` on it). `bsync(f)` = iOS `fcntl(F_BARRIERFSYNC)` / Android `FileChannel.force(false)`. `fsync(f)` = iOS `fcntl(F_FULLFSYNC)` / Android `FileChannel.force(true)`.
1. Start (in a library transaction): `mkdir sessions/<id>` → `dsync(sessions)`; `journal.jsonl` with `session` → `fsync` → `dsync(session dir)`; first successful input acquisition journals `avail available` with `reason:null` and its `gen`, then an `input` event identifying the acquired microphone; `seg-00000.aac` → `dsync(session dir)`; journal `segment` → `fsync`. Capture starts only after this (start-latency budget ≤ 150 ms, measured on both phones).
2. While `intent=recording` and `availability=available`, frames are appended with `write()` in batches of ≤ 250 ms. Journaling a `segment` re-arms that segment's periodic timer: its first `hb` is due 2000 ms later, then every 2000 ms while that segment captures. At a due instant: `bsync(segment)` → journal `hb` with the durable complete-frame byte count → `bsync(journal)`. A timer due at or after a segment close, Pause or Stop instant is suppressed; only the final close `hb` is written. No periodic `hb` is written while interrupted, blocked or paused. Every 10 s and at every segment close: `fsync(segment)` + `fsync(journal)` on iOS (Android's `force(false)` already flushes the device on ext4/f2fs). T4 measures `F_FULLFSYNC`/`F_BARRIERFSYNC` latency on Vonnegut; T11 may shorten the 10 s with that data.
3. Segment close, including interruption or a ≥ 60 s roll: drain any encoder output that belongs to this segment → `fsync(segment)` → journal exactly one final `hb` with the last complete-frame `segBytes` and `intent:"recording",availability:"available"` → `fsync(journal)`. These fields describe the state in which this segment's audio was captured, even if a transition to `interrupted` or `stopped` is pending in memory. Then create the next segment when capture restarts → `dsync(session dir)` → journal `segment` → `fsync(journal)` before accepting audio.
4. Pause (P5): set intent `paused` in memory and invalidate any in-flight restart generation → stop the capture input first, accepting every buffer captured before that stop even if delivered afterwards (iOS: stop the engine/remove the tap after its pending callback; Android: complete the in-flight read and read through the Pause capture position before `AudioRecord.stop()`) → drain the ring and encoder → `fsync(segment)` → journal one final `hb` with final `segBytes` and `intent:"recording",availability:"available"` → journal `intent` `{value:"paused",by:"user"}` at the same `t` and `a` → `fsync(journal)` → deactivate AVAudioSession on iOS, or release AudioRecord while CaptureService stays foreground on Android → emit `micState paused` and resolve `pause()`. If stopping input fails, restore in-memory intent `recording`, keep the same segment and its pending buffers, write no pause event, and reject with `pause_failed`. If deactivation or release fails after the input stopped, log the failure and still resolve as `paused`; never report `recording` after input stopped. If an interruption already closed the segment, close its open omitted span with `span_close` at the Pause `t`; there is no segment to sync or final `hb` to repeat, so journal and sync `intent paused`, then release any remaining input. Cancel pending and delivered resume notifications. A user pause opens no missing-audio span. A write/flush failure follows the `write_failed` auto-stop path.
5. Resume from Pause: close the pause at the attempt's wall time, set intent `recording` and journal `intent recording`; increment `gen` and reacquire input. On success, journal `avail available` with `reason:null` and the new `gen` (even if it was already available), create and directory-sync a **new** segment, then journal `segment` and `fsync(journal)` before accepting buffers. On failure, create no segment; journal `avail blocked` with `reason:"resume_blocked"` and the new `gen`, `fsync(journal)`, emit `micState needs_user`, and reject `resume()` with `resume_failed`. Time after this attempt counts toward `elapsedMs` because intent is `recording`.
6. Stop: set intent `stopped` in memory, drain the ring and encoder if running, `fsync(segment)` if open, journal exactly one final `hb` with `intent:"recording",availability:"available"` if open, then `intent stopped` and `stop` at the same `t` and `a` → `fsync(journal)`; then commit. Stop from Pause has no open segment and writes no new `hb`.
7. Commit = *stage* (outside the lock: mux to `staging/<id>.<opGen>.m4a` → `fsync`) + *publish* (a library transaction): revalidate (no tombstone, op generation unchanged); `rename` → `<id>.m4a` → `dsync(voice-notes)`; write canonical `<id>.json.tmp` → `fsync` → `rename` → `dsync` ← **commit point**; then delete the session files, `rmdir`, `dsync(sessions)`.

**Guarantees.** *Process death*: what `write()` received survives; the loss is what was still in the ring/encoder, normally ≤ 0.5 s and at most the 10 s ring plus one batch. This is guaranteed, and the failpoint tests check it. *Power loss / forced restart*: best effort, target ≤ 10 s on iOS (the full-flush interval) and ≤ 2 s on Android, measured in T11/T15/G2 and reported as measured. *Writer stall*: when the ring fills, new buffers are dropped and an `omitted` span (`writer_stalled`) opens; memory stays bounded. *Write or flush failure*: intent `stopped` (`by: write_failed`), commit what is durable, `autoStopped { reason: "write_failed" }`, notification. *Disk* below 100 MB: stop with `disk_full`; `start()` is refused below 300 MB (`insufficient_storage`).

**Library transactions** (round-2 finding 1).
- **One synchronous lock per process.** iOS: a private serial `DispatchQueue` entered with `sync`; Android: a `ReentrantLock`. Transaction bodies are synchronous file operations only: **no `await`, no completion handler, no callback, and no blocking on another queue inside a transaction**. Not a Swift actor (actors are re-entrant at suspension points). The app is single-process (no `android:process`; the iOS widget extension has no App Group and never touches these files).
- **Per-id operation generation.** In memory: `opGen[id]` plus `active[id]` (a count of staged operations in flight). Starting a long operation (commit mux, legacy probe, transcript write prep, STT/diar progress) is a transaction that reads `opGen[id]` and increments `active[id]`. The long work then runs **outside** the lock into `staging/`. Its publish transaction checks that `tombstones/<id>` is absent and that `opGen[id]` is unchanged, then renames and syncs. If the check fails, it deletes its staged files and publishes nothing. Either way it decrements `active[id]`.
- **Delete and discard** run in one transaction: `opGen[id] += 1` (invalidating every staged operation) → create `tombstones/<id>` → `dsync(tombstones)` → move unfinished remote cleanup into the **outbox** (below) → unlink `<id>.*`, `sessions/<id>/`, `staging/<id>.*`, the progress files → `dsync` the directories. A live recording's `discard()` writes the tombstone **before** stopping capture.
- **Every publication refuses tombstoned ids**: sidecar, ledger CAS, `putTranscript`, STT progress, diar progress, legacy import, claim. The error is `tombstoned`.
- **Committed = the sidecar exists**, and it is never regenerated from a journal. Recovery that finds `sessions/<id>/` and `<id>.json` only garbage-collects the session. With `sessions/<id>/` and no sidecar, it re-stages and publishes from the segments (owner = the journal's last `owner`/`session`).
- **Tombstone retirement** happens during recovery/GC only, when a transaction confirms that: `active[id] == 0`; a fresh listing shows no `<id>.*`, `sessions/<id>`, `staging/<id>.*` or progress file; and the deletions it performed were followed by `dsync`. Age is never a criterion. A failed unlink keeps the tombstone forever, and GC retries it at each recovery.
- **Sidecar mutations** (claim, ledger, STT state) are transactions with `tmp → fsync → rename → dsync` and a monotonic `rev` (CAS for JS). `putTranscript()` publishes `<id>.transcript.json` only; it does **not** bump the sidecar `rev` by itself. Any accompanying `stt`/ledger change is a separate sidecar mutation and does bump `rev`.
- **Recovery runs once per process** (`recoverOnce()`, idempotent): started by `ExoCaptureBootstrap.start()` / `CaptureBootstrap.onProcessStart()`. The plugin's `load()` and `listPending()` await it. Sessions owned by the live engine are skipped. A session with zero full frames is deleted silently. A recovered session's `wallMs` ends at the `t` of its last complete durable journal event, not the relaunch time. `pausedMs` sums closed pause intervals; if the last intent is `paused`, the open pause is clipped to that same last `t` (so an `intent paused` that is the last line adds zero after its timestamp). `durationMs` comes from the durable AAC frames. Recovered notes get `recovered: true`, `endedUnexpectedly: !journal.has("stop")`, `lastHeartbeatAt`, `exitReason` (Android API 30+, else null), a retained `recovered` event and a notification (T11/T15). A paused iOS session may be killed because its audio session is inactive; recovery commits it as an unexpectedly ended note.
- **Cleanup outbox**: an entry is `{ entryId, did, provider: "assemblyai" | "ptx", mode: "hosted" | "own" | null, kind: "transcript" | "hosted_upload" | "ptx_job" | "own_upload_lookup", handle, createdAt, attempts }`. It is written inside the delete/cleanup transaction for every `ledger.remote` resource whose `cleanup` isn't `done`. A known AssemblyAI transcript `jobId` makes a `transcript` entry; a hosted `uploadId` makes a separate `hosted_upload` entry even when a transcript also exists. An own-key `submit_unknown` with a known `uploadUrl` and no `jobId` makes `own_upload_lookup` keyed by that URL; `create_unknown` with no handle makes no invented outbox entry. A known PTX `jobId` makes `ptx_job`. Entries are listed and completed through the plugin (§1.8). Tombstones never carry cleanup state.

**Failpoints and suspension gates.** `FileOps` wraps create/write/sync/rename/unlink/rmdir with named failpoints: `start.mkdir`, `start.journal`, `seg.write`, `seg.sync`, `roll.create`, `stop.journal`, `stage.write`, `publish.m4aRename`, `publish.sidecarTmp`, `publish.sidecarRename`, `publish.gc`, `claim.write`, `ledger.write`, `delete.tombstone`, `delete.outbox`, `delete.unlink`, `import.sidecar`, `tombstone.retire`. A failpoint crash drops unsynced data from the in-memory FS, modelling power loss. **Suspension gates** pause a long operation at `stage.begin`, `stage.afterMux`, `probe.afterLoad` and `stt.beforePublish`, so tests can interleave delete, discard, claim, recovery or another commit there. After every scenario, recovery runs twice. The invariants: (I1) no committed note is lost; (I2) no tombstoned id reappears or gets any published artifact; (I3) no sidecar is regenerated over a newer `rev`; (I4) recovery is idempotent; (I5) unsynced loss stays within the policy bound; (I6) every remote resource is either in a sidecar ledger or in the outbox. Extra scenarios: a failed unlink followed by a clock advanced 8 days and a relaunch (the tombstone stays, nothing resurrects); delete during a gated commit; discard during a gated legacy probe.

**Sidecar v2, ledger and STT state** (illustrative JSONC schema, not canonical fixture bytes; `<id>.json`; v1 fields unchanged, the rest optional for readers):
```jsonc
{
  "id": "…", "startedAt": 1759800000000, "durationMs": 2531000, "mimeType": "audio/mp4", "sizeBytes": 20250000,
  "silencedMs": 0, "silencedEvents": 0, "noSignalMs": 0,
  "version": 2, "rev": 7,
  "wallMs": 2600000, "pausedMs": 60000, "spans": [ /* MissingAudioSpan */ ],
  "recovered": false, "endedUnexpectedly": false, "lastHeartbeatAt": null, "exitReason": null,
  "legacyImport": false, "ownerUnknown": false,          // true for every legacy note (§1.9)
  "source": "in_app", "owner": "did:pkh:eip155:1:0x…",   // null = recorded signed out, not claimed yet
  "transitionGen": 12,                                    // the account-transition generation at start (§2.1)
  "options": { "transcriber": "on-device", "identifySpeakers": false },
  "input": { "id": "…", "name": "iPhone Microphone", "kind": "built_in" }, "sampleRate": 48000, "bitrate": 64000,
  "ledger": {
    "spaceId": "…",
    "audio":      { "state": "pending" | "saved", "rowId": null, "at": null }, // saved uses the actual Library row id and a wall timestamp
    "transcript": { "state": "pending" | "running" | "retrying" | "blocked" | "needs_attention" | "cancelled" | "failed" | "done",
                    "outcome": "transcribed" | "no_speech" | null, "reason": null, "attempts": 0, "nextAttemptAt": null },
    "transcriptSync": { "state": "pending" | "saved", "rev": 0, "at": null },
    "landed":     { "state": "none" | "pending" | "emitted", "eventId": null },
    "remote":     [ { "provider": "assemblyai" | "ptx", "mode": "hosted" | "own" | null,
                      "stage": "create_unknown" | "uploading" | "uploaded" | "submit_unknown" | "submitted" | "done",
                      "uploadId": null, "uploadUrl": null, "jobId": null,
                      "cleanup": "none" | "pending" | "done" } ]
  },
  "stt": { "state": "waiting_for_model" | "queued" | "running" | "done" | "failed" | "cancelled", "pack": null, "engine": null, "segmentsDone": 0, "windowsDone": 0, "error": null }
  // "attempts" (Int, TC-836) is added once a note first enters "running": a crash-loop guard
  // persisted before each decode attempt, absent until then; readers default a missing value to 0.
}
```
`durationMs` in v2 is `a` at the final durable frame, including any written priming or padding access units; `wallMs` is start→stop (or the last durable event in recovery). `pausedMs` is the sum of user-pause intervals within `wallMs`. V1 sidecars keep their wall-clock `durationMs`. A v2 writer emits the full exact key set of `sidecar-v2-ios.json` or `sidecar-v2-android.json` (with platform-specific values), including explicit `null` for unknown nullable fields and empty arrays for no spans or remote handles. Readers remain tolerant of older v2 files that omit newly added fields.

### 1.4 Transition contract

Three journaled dimensions: **intent** (`recording` | `paused` | `stopped`), **availability** (`available` | `interrupted(reason)` | `blocked`), and **service** (iOS session active + engine running while recording; Android FGS throughout, with `AudioRecord` released while paused). `MicState` is derived: `stopped` → `idle`; `paused` → `paused`; `recording` + `available` → `recording`, or `silenced` while a `silenced` span is open; `recording` + `interrupted` → `interrupted`; `recording` + `blocked` → `needs_user`.

The in-memory `paused` value at the start of a Pause call is a private transition flag. Until input stop succeeds, public `status()` and `micState` retain the prior live state. A successful call publishes `paused` only after the final journal sync; a failed input stop restores `recording` without a public `paused` state.

**Restart generations.** The initial start attempt carries `gen = ++counter`. An interruption begins by incrementing the counter to invalidate any in-flight attempt; every automatic or manual restart attempt increments it again. Pause, Stop and Discard also increment it. A completion with a stale `gen` tears down what it started and changes nothing else. The golden journals show initial acquisition at `gen:1`, interruption at `gen:2`, successful automatic restart at `gen:3`, Pause invalidating `gen:4` (not journaled as an availability change), and Resume acquisition at `gen:5`. `transitionGen` is the independent account-transition generation, not this restart counter.

**Events × intent** (the graph runs only while intent is `recording`; pause writes nothing and releases the microphone; user decision P5):

| Event | intent `recording` | intent `paused` | intent `stopped` |
|---|---|---|---|
| OS interruption begins (call, FaceTime, Siri, alarm, another app recording) | close segment; `span_open(omitted, interruption)`; availability `interrupted`; iOS schedules the resume notification | availability `interrupted`; no span; no notification | ignored |
| Interruption ends | automatic restart (new `gen`): ok → `span_close`, `available`, remove the notification; fail → backoff 0.5, 1, 2, 5, 10, 30 s… | remain paused with the microphone off; Resume reacquires input as a new start attempt | ignored |
| Backoff exhausted (10 min) or background restart refused | `blocked` (= `needs_user`); the notification is already scheduled or delivered | –; a paused session has no graph or restart backoff | – |
| Route/config change, input switch | rebuild, new segment, `span(omitted, route_change)` < 300 ms, `input` | remember the input; keep the microphone off; `input` | ignored |
| Media services reset / `ERROR_DEAD_OBJECT` | rebuild session/engine/encoder, new segment, `span(omitted, media_services_reset / read_error)`; iOS posts "Recording restarted after an audio system reset" | keep the microphone off | ignored |
| Stall (no buffers for 3 s) | `span(omitted, stalled)`; automatic restart with backoff | keep the microphone off | – |
| OS silencing (Android `isClientSilenced`, iOS input mute, privacy toggle) | `span_open(silenced, …)`; frames keep flowing | no span; remembered so Resume opens one | – |
| **User Resume** (in app, Live Activity, notification action, widget) | if `interrupted` or `blocked`: **manual restart now** (new `gen`, backoff reset): ok → `available`, `span_close`, remove notifications; fail → `blocked`, `reason:resume_blocked`, emit `micState needs_user`, and reject `resume()` with `{code:"resume_failed"}`. If `available`: no-op | intent `recording`; reacquire the microphone as a new start attempt (`gen`), opening a new segment; ok → `available`, and open a silenced span if OS silencing was remembered; fail → `blocked`, `reason:resume_blocked`, emit `micState needs_user`, reject `resume()` with `{code:"resume_failed"}` | – |
| User Pause | follow the durable Pause sequence in §1.3; stop input first and retain every pre-stop buffer, then drain, sync, journal and deactivate/release. Remove resume notifications and invalidate automatic restart. If input stop fails, restore `recording` on the same segment and reject `{code:"pause_failed"}`; if post-stop deactivation/release fails, log it and resolve `paused` because capture has stopped | – | – |
| User Stop / limit / disk / write failure | intent `stopped`; remove notifications; commit | same | – |
| Discard | remove notifications; tombstone, `stop(discard)`, delete | same | – |
| App becomes active (`didBecomeActive` / `onResume`) | if `interrupted`/`blocked`: one automatic restart attempt | **nothing** (a pause is never undone automatically) | – |
| App suspended (iOS `wasSuspended`, `.appWasSuspended`) | span from the last `hb`; restart on foreground | nothing until the user resumes | – |
| Permission revoked / process death | recovery at next process start; Android posts "Recovered … Record again" (opens `MainActivity` RECORD) | same | – |

**Resume notifications.** iOS: when an interruption begins with intent `recording`, schedule `capture.resume.<id>` with `UNTimeIntervalNotificationTrigger(timeInterval: 45)`, `userInfo = { id, gen }`: "Recording paused by a call or Siri. Tap to resume." A successful restart, Pause, Stop and Discard remove it (pending and delivered). On delivery in the foreground (`willPresent`) and on tap (`didReceive`), the app acts **only if** the current session id equals `id`, intent is `recording` and availability isn't `available`. The `gen` in the payload is diagnostic; it is **not** an equality gate because automatic attempts increment it while the same notification remains. A valid tap performs manual Resume; otherwise it just opens the app. Android: `needs_user` posts "Tap to resume" on channel `capture-alerts` (IMPORTANCE_HIGH) with a **Resume** action carrying `{id, gen}` (`getForegroundService`/`getService` by API), validated by `CaptureService` by the same id/intent/availability rule. Pause/Stop/Discard cancel it. The Live Activity (T12) shows the same state and Resume.

**Notification permission.** It is requested at the first recording (iOS in T10; Android's existing POST_NOTIFICATIONS ask). If notifications are denied, iOS relies on the Live Activity; if that is also off, only the in-app state remains. The recording view says once: "Turn on notifications so Exo can tell you when recording pauses."

**Table tests** (CaptureCore / capture/core): every cell above, plus: buffers captured before Pause but delivered during input stop are retained in the segment; input-stop failure keeps recording on that segment; post-stop release failure resolves paused; a periodic heartbeat due at Stop yields only the final heartbeat; failed automatic restart → manual Resume succeeds; interruption → user Pause → the delayed notification fires → tap → still paused; interruption → Stop → the notification is removed; Stop during backoff → no microphone reactivation (iOS session inactive, Android `AudioRecord` released).

### 1.7 The three-hour limit (user decision P5)

`VOICE_NOTE_MAX_DURATION_MS = 3 * 60 * 60 * 1000` (TS), `3 * 3600` seconds (Swift), `3L * 3_600_000` milliseconds (Kotlin). The limit and live status `elapsedMs` count `now - startedAt - pausedMs`, subtracting an open pause up to `now`. A user pause is excluded; interruption and blocked time count. A timer must enforce the limit even with no arriving audio buffers or heartbeats. At the limit, write `stop(max_duration)` and emit a retained `autoStopped`. The `exo.voiceNotes.maxDurationMs` test override can only lower the limit. Three hours at 64 kbps is about 86 MB, below the 120.96 MB hosted AssemblyAI and PTX limits. Copy: "3-hour"; display `h:mm:ss` from one hour. Resume reacquires the microphone and opens a new segment. In wave 1, iOS Resume is available inside the app; the outside-app AudioRecordingIntent and Live Activity path is wave 2.

### 1.8 Plugin API: `VoiceNotes` v2

Same plugin name and JS module (`frontend/src/lib/voiceNotes/nativeVoiceNotes.ts`). V1 `VoiceNoteRecording` fields are kept and its v2 additions are optional for legacy readers. All `CaptureStatus` timing, intent, availability, span and generation fields are required from a v2 shell.
```ts
export type MicState = "idle" | "recording" | "silenced" | "paused" | "interrupted" | "needs_user";
export type MicStateReason = null | "no_signal" | "os_silenced" | "input_muted" | "call" | "user" | "interruption"
  | "route_change" | "media_services_reset" | "read_error" | "stalled" | "app_suspended" | "writer_stalled"
  | "resume_blocked" | "max_duration" | "disk_full" | "write_failed" | "permission_revoked";
export type TranscriberId = "on-device" | "private-cloud" | "assemblyai";
export type CaptureSource = "in_app" | "quick_action" | "app_shortcut" | "intent" | "control" | "tile" | "widget" | "notification";
export interface CaptureOptions { transcriber: TranscriberId; identifySpeakers: boolean }
export interface CaptureDefaults extends CaptureOptions { accountDid: string | null; transitionGen: number }
export interface AudioInput { id: string; name: string; kind: "built_in" | "wired" | "bluetooth" | "usb" | "car" | "other" }
export interface OutboxEntry { entryId: string; did: string; provider: "assemblyai" | "ptx"; mode: "hosted" | "own" | null;
  kind: "transcript" | "hosted_upload" | "ptx_job" | "own_upload_lookup"; handle: string; createdAt: number; attempts: number }
export type ClaimOptions =
  | { id: string; did: string; evidence: "signed_out_v2" | "user_choice" }
  | { id: string; did: string; evidence: "space_row"; rowId: string };
export interface VoiceNoteRecording {        // v1 fields unchanged; the rest mirror the sidecar (§1.3)
  id: string; startedAt: number; durationMs: number; mimeType: string; sizeBytes: number;
  silencedMs: number; silencedEvents: number; noSignalMs: number;
  version?: 2; rev?: number; wallMs?: number; pausedMs?: number; spans?: MissingAudioSpan[];
  recovered?: boolean; endedUnexpectedly?: boolean; lastHeartbeatAt?: number | null; exitReason?: string | null;
  legacyImport?: boolean; ownerUnknown?: boolean;            // native reports ownerUnknown: true for every v1 sidecar and legacy import
  source?: CaptureSource; owner?: string | null; transitionGen?: number;
  options?: CaptureOptions; input?: AudioInput | null; sampleRate?: number; bitrate?: number;
  ledger?: NoteLedger; stt?: NoteSttState;
}
export interface CaptureStatus {
  state: MicState; reason: MicStateReason; id: string | null;
  intent: "recording" | "paused" | "stopped"; availability: "available" | "interrupted" | "blocked";
  startedAt: number | null; elapsedMs: number; audioMs: number; pausedMs: number; maxDurationMs: number;
  spans: MissingAudioSpan[]; openSpan: MissingAudioSpan | null;
  source?: CaptureSource; options?: CaptureOptions; input?: AudioInput | null; owner?: string | null;
  transitionGen: number; androidSdkInt?: number;
}

export interface VoiceNotesPlugin {
  // v1 (signatures unchanged)
  start(o?: { maxDurationMs?: number } & Partial<CaptureOptions>): Promise<{ id: string; startedAt: number; maxDurationMs?: number }>;
  stop(): Promise<VoiceNoteRecording>;
  status(): Promise<CaptureStatus>;
  readAudioChunk(o: { id: string; offset: number; length: number }): Promise<VoiceNoteAudioChunk>;
  deleteAudio(o: { id: string }): Promise<void>;          // tombstone + outbox + delete; rejects `recording_in_progress` for the live id
  listPending(): Promise<{ recordings: VoiceNoteRecording[] }>;   // all committed notes (v1 + v2); awaits recoverOnce
  // v2
  pause(): Promise<void>; resume(): Promise<void>; discard(): Promise<{ id: string | null }>;
  setRecordingOptions(o: Partial<CaptureOptions>): Promise<void>;
  getCaptureDefaults(): Promise<CaptureDefaults>;
  setCaptureDefaults(o: CaptureDefaults): Promise<{ claimed: string[] }>;   // rejects `stale_transition` if o.transitionGen < stored; with accountDid non-null, claims the live unowned session and unowned v2 notes (never legacy notes)
  claim(o: ClaimOptions): Promise<{ owner: string | null }>;  // row_id_required | claim_evidence_required | claim_evidence_invalid | owner_mismatch | tombstoned
  updateLedger(o: { id: string; did: string; rev: number; patch: Partial<NoteLedger> }): Promise<{ rev: number }>;  // owner_mismatch | rev_conflict | tombstoned
  localAudioUrl(o: { id: string }): Promise<{ url: string }>;
  putTranscript(o: { id: string; transcript: LocalTranscript }): Promise<void>;          // tombstoned → rejects; does not bump sidecar rev alone
  getTranscript(o: { id: string }): Promise<{ transcript: LocalTranscript | null }>;
  listInputs(): Promise<{ inputs: AudioInput[]; selectedId: string | null; activeId: string | null }>;   // T10/T14
  selectInput(o: { id: string | null }): Promise<void>;                                                    // T10/T14
  listQuarantine(): Promise<{ items: { id: string; reason: string; sizeBytes: number }[] }>;
  deleteQuarantined(o: { id: string }): Promise<void>;
  listOutbox(o: { did: string }): Promise<{ entries: OutboxEntry[] }>;
  completeOutbox(o: { entryId: string; result: "done" | "retry" }): Promise<void>;
  // events: micState (retained; includes id, audioMs, openSpan), level, autoStopped (retained), presentRecorder (retained),
  //         recovered (retained), committed (retained; every commit incl. native-only stops), inputs
}
```
- `start()` without options uses the persisted native defaults. With `accountDid: null`, the transcriber is forced to `on-device` (decision 6).
- `presentRecorder` is emitted for every start that didn't come from `start()`.
- Retained `micState`, `autoStopped`, `presentRecorder`, `recovered` and `committed` events are queued in order until delivered to a listener, then consumed; multiple commits are never coalesced into the last one.
- Plugin method results and event payloads are value snapshots; later native mutations do not change an earlier JS object.
- `VoiceNoteRecording` = the sidecar fields of §1.3. `LocalTranscript`, `NoteLedger`, `NoteSttState`, `MissingAudioSpan` and the `OnDeviceStt` contract (§2.5) are defined in T1. The fakes (`fakeVoiceNotes.ts`, `fakeOnDeviceStt.ts`) implement all of it, including tombstones, the outbox, `transitionGen` and claim evidence.

### 1.9 Legacy notes (from the old plugin)

- Same directory and file names. Old pairs (`<id>.m4a` + v1 `<id>.json`) are listed.
- **Legacy import** (inside `recoverOnce()`), for every `<id>.m4a` with no sidecar, no session directory and no tombstone. The old plugins stop the recorder before writing the sidecar, so such a file may be complete.
  - Probe it: iOS `AVURLAsset` `load(.tracks, .duration)`, staged outside the lock and published via revalidation; Android `MediaExtractor` (one audio track, `KEY_DURATION` > 0). Playable = an audio track and ≥ 0.5 s.
  - Playable → a v2 sidecar with `legacyImport: true`, `recovered: true`, `ownerUnknown: true`, `owner: null`, the probed duration, and `startedAt` from the file's creation date (iOS `creationDate`, declared as `NSPrivacyAccessedAPICategoryFileTimestamp` `C617.1`; Android `lastModified()`).
  - Not playable → `quarantine/<id>.m4a` + `quarantine/<id>.json { reason }`, shown in Settings as "Recordings Exo couldn't recover" with Delete.
  - A malformed v1 sidecar moves to `quarantine/<id>.sidecar.json`, and its audio is probed.
- **Every legacy note is `ownerUnknown`** (v1 sidecars get `ownerUnknown: true` on first read). A legacy note is never auto-claimed, never uploaded and never deleted automatically. Its owner is established only by (a) a row with the same `source_id` in the signing-in account's space (`claim({…, evidence: "space_row", rowId: existingRow.id})`, which sets `ledger.audio = saved` with that exact row id and uploads nothing), or (b) the user choosing **Save to this account** (`evidence: "user_choice"`) under "Notes from an earlier version" (local home and Settings), which also offers **Delete from this phone** *(conditional on Q10)*. The old global `exo.voiceNotes.cloudSaved` marker is never used as evidence.
- Claim evidence is validated before the same-owner shortcut. `space_row` is valid only for a legacy note, even if that note is already owned by the same DID; a v2 note rejects it with `claim_evidence_invalid` and leaves its ledger and `rev` unchanged. An empty `rowId` rejects with `row_id_required`.
- **The old discard ledger** `exo.voiceNotes.discarded` (`recorderSaves.ts:83-125`) is honoured until T18. T18 migrates it once: each id still on the phone → `deleteAudio` (tombstone), then the key is cleared after all succeed. If localStorage is lost, those notes appear under "Notes from an earlier version", where the user can delete them; they are never uploaded.
- **From T6 on, legacy notes are not uploaded** (the old auto-save is removed for them). They stay on the phone untouched until T18/T19 provide the association check and the choice UI.
- Upgrade fixtures (pure core + instrumented/smoke): valid orphan; invalid orphan (no `moov`); v1 pair; malformed sidecar; a v1 note uploaded to A whose marker was never written (association when A signs in, held when B does); lost localStorage (all legacy notes held); an old discard interrupted before native deletion (deleted by T18's migration).

### 1.10 Android launch commands

- `LaunchCommandStore` (SharedPreferences, **one slot**): `{ commandId, action: RECORD | SHOW_RECORDER, source, createdAt }`.
- `MainActivity` and `RecordLauncherActivity` store the command from the intent in `onCreate`/`onNewIntent`, then clear the intent's action (`setIntent(Intent(intent).setAction(null))`); the consumed `commandId` goes into `savedInstanceState`.
- **`MainActivity.onResume`** (visible), for a pending RECORD < 30 s old:
  1. if `RECORD_AUDIO` isn't granted, request it via the ActivityResult API (the command stays pending);
  2. when granted, or on the next `onResume`, check `lifecycle.currentState.isAtLeast(RESUMED)`, then call `CaptureService.startFromVisibleActivity(context, commandId, source)`. The service runs `startForeground(microphone)`, then `AudioRecord`, then acknowledges through the `CaptureEngine` listener `started(commandId)`;
  3. clear the slot and emit `presentRecorder`.
- **`RecordLauncherActivity`** (tile trampoline; translucent, `excludeFromRecents`, `taskAffinity=""`, **not** `noHistory`) never requests permissions. If the mic is granted, it runs the same visible-start handshake itself, waits for the acknowledgement (≤ 3 s), starts `MainActivity` with SHOW_RECORDER and calls `finish()`. If not, it keeps the command in the store, starts `MainActivity` (which runs the steps above) and calls `finish()`.
- **Widget**: Record → `PendingIntent.getActivity(MainActivity, RECORD)` (the permission-ready path). Pause/Resume/Stop → the service PendingIntent factory chosen by API (§1.2). **Notifications**: Pause/Resume/Stop and needs_user Resume → the service (validated `{id, gen}`); "Record again" after a recovery → `MainActivity` RECORD.
- Refusal or revocation: the full page opens with "Microphone access is off" and **Open Settings**. A command older than 30 s is dropped and logged.
- Tests (T5 app shortcut; T16 tile/widget): cold, warm, locked, first use (permission undetermined), denied, activity recreated mid-flow (rotation; `am kill`), on the Moto (API 35) and the API 34/36 emulators.

---

## 2. Transcription pipeline
