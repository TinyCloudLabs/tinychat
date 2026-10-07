# Exo capture format and bridge contract

Normative sections from TC-781 plan revision 3. User decision P5 is incorporated: Pause releases the microphone and the three-hour limit counts recorded time only.

### 1.3 Capture format v1, persistence and the library

T1 writes this section as `mobile/docs/capture-format.md`. Both platforms implement it byte for byte, against T1's golden files in `mobile/fixtures/capture/`.

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

**Journal** (UTF-8 JSON Lines; a torn last line is ignored). Common fields: `e` (event), `t` (wall ms), `a` (audio ms = frames × 1000 / rate).

| `e` | Extra fields | When |
|---|---|---|
| `session` | `v:1, id, platform, codec:"aac-lc", container:"adts", rate, channels:1, bitrate, maxDurationMs, source, owner, transitionGen, options:{transcriber, identifySpeakers}` | first line |
| `segment` | `index, file` | a segment opens |
| `hb` | `seg, segBytes` (bytes durable after this checkpoint), `intent`, `availability` | **every 2 s, right after each data checkpoint**, while not stopped |
| `intent` | `value` (`recording`/`paused`/`stopped`), `by` (`user`, `limit`, `disk`, `write_failed`, `discard`) | intent changes |
| `avail` | `value` (`available`/`interrupted`/`blocked`), `reason`, `gen` | availability changes |
| `span_open` / `span_close` | `kind`, `reason` | missing audio starts/ends |
| `input` | `id, name, kind` | the input in use changes |
| `options` | `transcriber, identifySpeakers` | per-recording options change |
| `owner` | `did` | the live session is claimed |
| `low_battery` | `level` | ≤ 5 % and discharging |
| `stop` | `reason` (`user`, `max_duration`, `disk_full`, `write_failed`, `discard`, `permission_revoked`) | before commit |

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
1. Start (in a library transaction): `mkdir sessions/<id>` → `dsync(sessions)`; `journal.jsonl` with `session` → `fsync` → `dsync(session dir)`; `seg-00000.aac` → `dsync(session dir)`; journal `segment` → `fsync`. Capture starts only after this (start-latency budget ≤ 150 ms, measured on both phones).
2. Data checkpoint every 2 s: frames appended with `write()` in batches of ≤ 250 ms; then `bsync(segment)`, then journal `hb` with the synced byte count → `bsync(journal)`. Every 10 s and at every segment close: `fsync(segment)` + `fsync(journal)` on iOS (Android's `force(false)` already flushes the device on ext4/f2fs). T4 measures `F_FULLFSYNC`/`F_BARRIERFSYNC` latency on Vonnegut; T11 may shorten the 10 s with that data.
3. Segment roll (≥ 60 s of audio at a frame boundary, and at every capture restart): `fsync(old)`; create → `dsync`; journal `segment` → `fsync`.
4. Stop: intent `stopped`; drain the ring and encoder; `fsync(segment)`; journal `stop` → `fsync`; then commit.
5. Commit = *stage* (outside the lock: mux to `staging/<id>.<opGen>.m4a` → `fsync`) + *publish* (a library transaction): revalidate (no tombstone, op generation unchanged); `rename` → `<id>.m4a` → `dsync(voice-notes)`; write `<id>.json.tmp` → `fsync` → `rename` → `dsync` ← **commit point**; then delete the session files, `rmdir`, `dsync(sessions)`.

**Guarantees.** *Process death*: what `write()` received survives; the loss is what was still in the ring/encoder, normally ≤ 0.5 s and at most the 10 s ring plus one batch. This is guaranteed, and the failpoint tests check it. *Power loss / forced restart*: best effort, target ≤ 10 s on iOS (the full-flush interval) and ≤ 2 s on Android, measured in T11/T15/G2 and reported as measured. *Writer stall*: when the ring fills, new buffers are dropped and an `omitted` span (`writer_stalled`) opens; memory stays bounded. *Write or flush failure*: intent `stopped` (`by: write_failed`), commit what is durable, `autoStopped { reason: "write_failed" }`, notification. *Disk* below 100 MB: stop with `disk_full`; `start()` is refused below 300 MB (`insufficient_storage`).

**Library transactions** (round-2 finding 1).
- **One synchronous lock per process.** iOS: a private serial `DispatchQueue` entered with `sync`; Android: a `ReentrantLock`. Transaction bodies are synchronous file operations only: **no `await`, no completion handler, no callback, and no blocking on another queue inside a transaction**. Not a Swift actor (actors are re-entrant at suspension points). The app is single-process (no `android:process`; the iOS widget extension has no App Group and never touches these files).
- **Per-id operation generation.** In memory: `opGen[id]` plus `active[id]` (a count of staged operations in flight). Starting a long operation (commit mux, legacy probe, transcript write prep, STT/diar progress) is a transaction that reads `opGen[id]` and increments `active[id]`. The long work then runs **outside** the lock into `staging/`. Its publish transaction checks that `tombstones/<id>` is absent and that `opGen[id]` is unchanged, then renames and syncs. If the check fails, it deletes its staged files and publishes nothing. Either way it decrements `active[id]`.
- **Delete and discard** run in one transaction: `opGen[id] += 1` (invalidating every staged operation) → create `tombstones/<id>` → `dsync(tombstones)` → move unfinished remote cleanup into the **outbox** (below) → unlink `<id>.*`, `sessions/<id>/`, `staging/<id>.*`, the progress files → `dsync` the directories. A live recording's `discard()` writes the tombstone **before** stopping capture.
- **Every publication refuses tombstoned ids**: sidecar, ledger CAS, `putTranscript`, STT progress, diar progress, legacy import, claim. The error is `tombstoned`.
- **Committed = the sidecar exists**, and it is never regenerated from a journal. Recovery that finds `sessions/<id>/` and `<id>.json` only garbage-collects the session. With `sessions/<id>/` and no sidecar, it re-stages and publishes from the segments (owner = the journal's last `owner`/`session`).
- **Tombstone retirement** happens during recovery/GC only, when a transaction confirms that: `active[id] == 0`; a fresh listing shows no `<id>.*`, `sessions/<id>`, `staging/<id>.*` or progress file; and the deletions it performed were followed by `dsync`. Age is never a criterion. A failed unlink keeps the tombstone forever, and GC retries it at each recovery.
- **Sidecar mutations** (claim, ledger, STT state) are transactions with `tmp → fsync → rename → dsync` and a monotonic `rev` (CAS for JS).
- **Recovery runs once per process** (`recoverOnce()`, idempotent): started by `ExoCaptureBootstrap.start()` / `CaptureBootstrap.onProcessStart()`. The plugin's `load()` and `listPending()` await it. Sessions owned by the live engine are skipped. A session with zero full frames is deleted silently. Recovered notes get `recovered: true`, `endedUnexpectedly: !journal.has("stop")`, `lastHeartbeatAt`, `exitReason` (Android API 30+, else null), a retained `recovered` event and a notification (T11/T15).
- **Cleanup outbox**: an entry is `{ entryId, did, provider: "assemblyai" | "ptx", mode: "hosted" | "own" | null, kind: "transcript" | "hosted_upload" | "ptx_job" | "own_upload_lookup", handle, createdAt, attempts }`. It is written inside the delete/cleanup transaction for every `ledger.remote` resource whose `cleanup` isn't `done`, and also for an own-key upload URL whose transcript creation is unknown. It is listed and completed through the plugin (§1.8). Tombstones never carry cleanup state.

**Failpoints and suspension gates.** `FileOps` wraps create/write/sync/rename/unlink/rmdir with named failpoints: `start.mkdir`, `start.journal`, `seg.write`, `seg.sync`, `roll.create`, `stop.journal`, `stage.write`, `publish.m4aRename`, `publish.sidecarTmp`, `publish.sidecarRename`, `publish.gc`, `claim.write`, `ledger.write`, `delete.tombstone`, `delete.outbox`, `delete.unlink`, `import.sidecar`, `tombstone.retire`. A failpoint crash drops unsynced data from the in-memory FS, modelling power loss. **Suspension gates** pause a long operation at `stage.begin`, `stage.afterMux`, `probe.afterLoad` and `stt.beforePublish`, so tests can interleave delete, discard, claim, recovery or another commit there. After every scenario, recovery runs twice. The invariants: (I1) no committed note is lost; (I2) no tombstoned id reappears or gets any published artifact; (I3) no sidecar is regenerated over a newer `rev`; (I4) recovery is idempotent; (I5) unsynced loss stays within the policy bound; (I6) every remote resource is either in a sidecar ledger or in the outbox. Extra scenarios: a failed unlink followed by a clock advanced 8 days and a relaunch (the tombstone stays, nothing resurrects); delete during a gated commit; discard during a gated legacy probe.

**Sidecar v2, ledger and STT state** (`<id>.json`; v1 fields unchanged, the rest optional for readers):
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
    "audio":      { "state": "pending" | "saved", "rowId": "vn-<id>" | "<legacy row id>", "at": 0 },
    "transcript": { "state": "pending" | "running" | "retrying" | "blocked" | "needs_attention" | "cancelled" | "failed" | "done",
                    "outcome": "transcribed" | "no_speech" | null, "reason": null, "attempts": 0, "nextAttemptAt": null },
    "transcriptSync": { "state": "pending" | "saved", "rev": 0, "at": 0 },
    "landed":     { "state": "none" | "pending" | "emitted", "eventId": "<id>:<rev>" },
    "remote":     [ { "provider": "assemblyai" | "ptx", "mode": "hosted" | "own" | null,
                      "stage": "create_unknown" | "uploading" | "uploaded" | "submit_unknown" | "submitted" | "done",
                      "uploadId": null, "uploadUrl": null, "jobId": null,
                      "cleanup": "none" | "pending" | "done" } ]
  },
  "stt": { "state": "waiting_for_model" | "queued" | "running" | "done" | "failed" | "cancelled", "pack": null, "engine": null, "segmentsDone": 0, "windowsDone": 0, "error": null }
}
```
`durationMs` in v2 is audio time (frames); `wallMs` is start→stop. v1 sidecars keep their wall-clock `durationMs`.

### 1.4 Transition contract

Three journaled dimensions: **intent** (`recording` | `paused` | `stopped`), **availability** (`available` | `interrupted(reason)` | `blocked`), and **service** (iOS session active + engine running while recording; Android FGS throughout, with `AudioRecord` released while paused). `MicState` is derived: `stopped` → `idle`; `paused` → `paused`; `recording` + `available` → `recording`, or `silenced` while a `silenced` span is open; `recording` + `interrupted` → `interrupted`; `recording` + `blocked` → `needs_user`.

**Restart generations.** Every (re)start attempt carries `gen = ++counter`. Pause, Stop, Discard and every new attempt increment the counter. A completion with a stale `gen` tears down what it started and changes nothing else.

**Events × intent** (the graph runs only while intent is `recording`; pause writes nothing and releases the microphone; user decision P5):

| Event | intent `recording` | intent `paused` | intent `stopped` |
|---|---|---|---|
| OS interruption begins (call, FaceTime, Siri, alarm, another app recording) | close segment; `span_open(omitted, interruption)`; availability `interrupted`; iOS schedules the resume notification | availability `interrupted`; no span; no notification | ignored |
| Interruption ends | automatic restart (new `gen`): ok → `span_close`, `available`, remove the notification; fail → backoff 0.5, 1, 2, 5, 10, 30 s… | remain paused with the microphone off; Resume reacquires input as a new start attempt | ignored |
| Backoff exhausted (10 min) or background restart refused | `blocked` (= `needs_user`); the notification is already scheduled or delivered | `blocked` | – |
| Route/config change, input switch | rebuild, new segment, `span(omitted, route_change)` < 300 ms, `input` | remember the input; keep the microphone off; `input` | ignored |
| Media services reset / `ERROR_DEAD_OBJECT` | rebuild session/engine/encoder, new segment, `span(omitted, media_services_reset / read_error)`; iOS posts "Recording restarted after an audio system reset" | keep the microphone off | ignored |
| Stall (no buffers for 3 s) | `span(omitted, stalled)`; automatic restart with backoff | keep the microphone off | – |
| OS silencing (Android `isClientSilenced`, iOS input mute, privacy toggle) | `span_open(silenced, …)`; frames keep flowing | no span; remembered so Resume opens one | – |
| **User Resume** (in app, Live Activity, notification action, widget) | if `interrupted` or `blocked`: **manual restart now** (new `gen`, backoff reset): ok → `available`, `span_close`, remove notifications; fail → `blocked` with the error shown. If `available`: no-op | intent `recording`; reacquire the microphone as a new start attempt (`gen`), opening a new segment | – |
| User Pause | intent `paused`; **stop and release capture input** (iOS: stop AVAudioEngine, deactivate AVAudioSession; Android: stop and release AudioRecord while CaptureService stays foreground with paused notification); remove pending and delivered resume notifications; any automatic restart in flight is invalidated by the new `gen` | – | – |
| User Stop / limit / disk / write failure | intent `stopped`; remove notifications; commit | same | – |
| Discard | remove notifications; tombstone, `stop(discard)`, delete | same | – |
| App becomes active (`didBecomeActive` / `onResume`) | if `interrupted`/`blocked`: one automatic restart attempt | **nothing** (a pause is never undone automatically) | – |
| App suspended (iOS `wasSuspended`, `.appWasSuspended`) | span from the last `hb`; restart on foreground | nothing until the user resumes | – |
| Permission revoked / process death | recovery at next process start; Android posts "Recovered … Record again" (opens `MainActivity` RECORD) | same | – |

**Resume notifications.** iOS: when an interruption begins with intent `recording`, schedule `capture.resume.<id>` with `UNTimeIntervalNotificationTrigger(timeInterval: 45)`, `userInfo = { id, gen }`: "Recording paused by a call or Siri. Tap to resume." A successful restart, Pause, Stop and Discard remove it (pending and delivered). On delivery in the foreground (`willPresent`) and on tap (`didReceive`), the app acts **only if** the current session id equals `id`, intent is `recording` and availability isn't `available`. Then it performs a manual Resume; otherwise it just opens the app. Android: `needs_user` posts "Tap to resume" on channel `capture-alerts` (IMPORTANCE_HIGH) with a **Resume** action carrying `{id, gen}` (`getForegroundService`/`getService` by API), validated by `CaptureService` the same way; Pause/Stop/Discard cancel it. The Live Activity (T12) shows the same state and Resume.

**Notification permission.** It is requested at the first recording (iOS in T10; Android's existing POST_NOTIFICATIONS ask). If notifications are denied, iOS relies on the Live Activity; if that is also off, only the in-app state remains. The recording view says once: "Turn on notifications so Exo can tell you when recording pauses."

**Table tests** (CaptureCore / capture/core): every cell above, plus: failed automatic restart → manual Resume succeeds; interruption → user Pause → the delayed notification fires → tap → still paused; interruption → Stop → the notification is removed; Stop during backoff → no microphone reactivation (iOS session inactive, Android `AudioRecord` released).

### 1.7 The three-hour limit (user decision P5)

`VOICE_NOTE_MAX_DURATION_MS = 3 * 60 * 60 * 1000`. The limit counts recorded time as `wallMs - pausedMs`; a user pause is excluded, while an interruption remains part of the elapsed attempt. The test override only lowers the limit. Resume reacquires the microphone and opens a new segment. In wave 1, iOS Resume is available inside the app; the outside-app AudioRecordingIntent and Live Activity path is wave 2.

### 1.8 Plugin API: `VoiceNotes` v2

Same plugin name and JS module (`frontend/src/lib/voiceNotes/nativeVoiceNotes.ts`). v1 shapes are kept; new fields are optional.
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
  claim(o: { id: string; did: string; evidence: "signed_out_v2" | "space_row" | "user_choice" }): Promise<{ owner: string | null }>;
  updateLedger(o: { id: string; did: string; rev: number; patch: Partial<NoteLedger> }): Promise<{ rev: number }>;  // owner_mismatch | rev_conflict | tombstoned
  localAudioUrl(o: { id: string }): Promise<{ url: string }>;
  putTranscript(o: { id: string; transcript: LocalTranscript }): Promise<void>;          // tombstoned → rejects
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
- `VoiceNoteRecording` = the sidecar fields of §1.3. `LocalTranscript`, `NoteLedger`, `NoteSttState`, `MissingAudioSpan` and the `OnDeviceStt` contract (§2.5) are defined in T1. The fakes (`fakeVoiceNotes.ts`, `fakeOnDeviceStt.ts`) implement all of it, including tombstones, the outbox, `transitionGen` and claim evidence.

### 1.9 Legacy notes (from the old plugin)

- Same directory and file names. Old pairs (`<id>.m4a` + v1 `<id>.json`) are listed.
- **Legacy import** (inside `recoverOnce()`), for every `<id>.m4a` with no sidecar, no session directory and no tombstone. The old plugins stop the recorder before writing the sidecar, so such a file may be complete.
  - Probe it: iOS `AVURLAsset` `load(.tracks, .duration)`, staged outside the lock and published via revalidation; Android `MediaExtractor` (one audio track, `KEY_DURATION` > 0). Playable = an audio track and ≥ 0.5 s.
  - Playable → a v2 sidecar with `legacyImport: true`, `recovered: true`, `ownerUnknown: true`, `owner: null`, the probed duration, and `startedAt` from the file's creation date (iOS `creationDate`, declared as `NSPrivacyAccessedAPICategoryFileTimestamp` `C617.1`; Android `lastModified()`).
  - Not playable → `quarantine/<id>.m4a` + `quarantine/<id>.json { reason }`, shown in Settings as "Recordings Exo couldn't recover" with Delete.
  - A malformed v1 sidecar moves to `quarantine/<id>.sidecar.json`, and its audio is probed.
- **Every legacy note is `ownerUnknown`** (v1 sidecars get `ownerUnknown: true` on first read). A legacy note is never auto-claimed, never uploaded and never deleted automatically. Its owner is established only by (a) a row with the same `source_id` in the signing-in account's space (`claim(…, evidence: "space_row")`, which sets `ledger.audio = saved` with that row's id and uploads nothing), or (b) the user choosing **Save to this account** (`evidence: "user_choice"`) under "Notes from an earlier version" (local home and Settings), which also offers **Delete from this phone** *(conditional on Q10)*. The old global `exo.voiceNotes.cloudSaved` marker is never used as evidence.
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
