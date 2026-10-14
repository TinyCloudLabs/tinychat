# 0.8.0 Integration Train

Integration branch: `dev/0.8.0`

## PR Merge Order
1. #374 ✓
2. #375 ✓
3. #369 ✓
4. #348 ✓ (P8 - must land before #350)
5. #351 ✓ (must land before #350, privacy invariant verified)
6. #368 ✓ (TimestampedTranscript + T1 fixes)
7. #364 ✓ (iOS test fix)
7. #367 (HOLD - awaiting fixes)
8. #372 (HOLD - depends on #367)
9. #364 (HOLD - awaiting fixes)
10. #373 (HOLD - review changes open)
11. #350 (TC-947 P9+P10: Mac Me/Them stereo notes - LAST)

## Merge Log

| PR | Head SHA | Merge Commit | Conflicts | Resolution |
|----|----------|--------------|-----------|------------|
| #374 | f475230b | d8822e56 | Yes | hostedVoiceNotes.test.ts: merged harness() signature (main's durationMs/transcriptResponses + #374's readGate); merged readCommit with readGate await + main's clock. voiceNoteStore.ts: combined imports (VoiceNoteRow + VoiceNoteTranscriptionStatsMetadata) |
| #375 | a4365377 | 013ba68a | Yes | hostedVoiceNotes.test.ts: merged harness() params + return helpers; kept both test sets. hostedVoiceNotes.ts: added constants + service params. assemblyai-hosted.test.ts: took #375's rate limit imports + reconcileHostedJobs |
| #369 | b2316c0a | fc7b183a | Yes | recorder/mod.rs: added finishing quit lock+fn. lib.rs: kept main's modules. recorder/files.rs: took stopped journal handling. recorder/engine.rs: added stopped source fns, recorder_stopped_list cmd, stopped journal handling, recover_stopped_segment fn, quarantined_journal field. desktopVoiceNotes.test.ts: added background finishing tests |
| #348 | a579c5fa | a7324efb | No | Clean merge - TC-947 P8: separate Mac mic and system levels |
| #351 | 760a64fa | 92ff5241 | Yes | **PRIVACY INVARIANT**: voiceNoteStore.ts local-only early return (line ~424) precedes ALL audio upload code. When uploadAudio=false: (1) empty transcript key, (2) patchVoiceNoteLocalOnly, (3) note sync, (4) return - NO putVoiceNoteAudio reached. Conflicts in 5 files resolved. |
| #368 | 52d8380a | e5937afe | Yes | TimestampedTranscript + T1 fixes. #363 deduped. Kept HEAD's isPrivateCloud/MAX_TURN_SECONDS timing throughout. Phone baselines will change (TimestampedTranscript). |
| #364 | dbf87049 | b8a3daf2 | No | Clean merge - iOS test fix (CaptureEngineTests.swift async stop event) |
| Integration fix | 41159ec4 | - | N/A | **P1 PRIVACY FIX** (reviewer 29b814e5): crash-recovered sessions uploaded audio even when preference was off. Changed uploadAudio !== false to uploadAudio === true (fail closed), added uploadAudio: false to recovery sites. |
| #367 | 348f68fd | 0d938ed8 | Yes (12) | Transcript failure reason + activity panel. Combined logic from HEAD + #367 for NoteDetailView, SavedNote, LibraryRow, notePipeline. **Merge bug**: spaceAfterUploads referenced undefined laneDepth. |
| #372 | f1bff349 | 4bd423b8 | Yes | Fix sync failure notification re-arming during transcript sync. |
| #396 | c40651fc | b98f50ce | No | CI-only: added the reviewed `Test ExoStt` step to the iOS job and an empty changeset. The step covers 11 ExoStt tests. |
| `origin/main` | b9c538ee | e4389b77 | No | Refreshed the floor through #391, #398, and #397. #397 reverts #394 on main. |
| #394 re-land | f4a21845 | 167d4786 | No | Reverted #397's revert as required for 0.8.0, restoring TC-760 transcript gaps and recovery provenance without weakening newer main behavior. |
| #400 | a988c05d | 4c7a34f7 | No | Clean merge of TC-1135 stranded Private-note recovery after the CI repairs; preserves the existing privacy gate and #394 recovery provenance. |

## Test Fixes (2026-10-14)

After merging origin/main (TC-1128, #387, #392, 45d16e58) and PR #386 (TC-1108 progress copy):

| Test File/Area | Fix Commit | Issue | Resolution |
|----------------|------------|-------|------------|
| useNotePipeline.ts:902 | 924ce065 | `spaceAfterUploads: laneDepth > 0` referenced undefined `laneDepth` after #367's lane refactor | Restored #367's intended logic: `pending.notes?.some((note) => note.upload !== undefined)` |
| hostedVoiceNotes.ts | 924ce065 | Missing `AssemblyAiTranscript` type import | Added to imports |
| hostedVoiceNotes.ts:72 | 924ce065 | `sleep?: typeof pause` referenced undefined `pause` | Changed to `sleep?: (ms: number) => Promise<void>` |
| hostedVoiceNotes.ts:391 | 924ce065 | `!local.transcript || local.transcript.rev < rev` could fail on null | Changed to `(local.transcript?.rev ?? 0) < rev` |
| notePipeline.test.ts:222 | 924ce065 | Regex `/Trying again in \d+s/` didn't match copy | Updated to `/trying again in \d+ s/` |
| notePipeline.ts:349 | c7e0c115 | #386's `PRIVATE_COPY.inQueue` lost in merge (used old "Queued for" strings) | Restored `PRIVATE_COPY.inQueue(status.position)` |
| NoteDetailView.tsx | ed1e7a20 | `transcriptStepLine` didn't recognize "In the queue" prefix | Added check for "In the queue" prefix |
| NoteDetailView.test.tsx | ed1e7a20 | PTX queued copy test expected old "Queued for Private transcription" | Updated to expect "In the queue · #3" |
| NoteDetailView.test.tsx | ed1e7a20 | Progress copy assertions included provider-specific prefix | Changed to partial matches (e.g., "1 of 3 parts done") |

## 0.8.0 Integration Repair Causes (2026-10-14)

| Test / CI group | Introducing merge | Cause | Fix | Approved source |
|-----------------|-------------------|-------|-----|-----------------|
| On-device `no_speech` transcript sync | #374 (`d8822e56`) | The merge omitted optional chaining for a legal ledger without `transcriptSync`; the retry was silently lost. | Read `current.ledger?.transcriptSync?.state`. | #374 `f475230b` |
| Real Tauri `useNotePipeline` hook | #369 (`fc7b183a`) | #369's finishing-quit guard began using the Tauri window/event API, but the integration fixture still installed empty Tauri internals. | Give the fixture current-window, callback, invoke, and event-unregister functions. | #369 `b2316c0a` |
| Recorder/capture/web option defaults; transcription and row-upload fixtures | #351 (`92ff5241`) | Audio became opt-in, but fixtures that intentionally exercise uploads omitted the new option and therefore exercised the local-only path or timed out. | Set `uploadAudio: true` only on fixtures intended to upload; assert `false` defaults where no upload is intended. | #351 `760a64fa`; fail-closed privacy fix `41159ec4` |
| Android capture contract bytes | #351 (`92ff5241`) | Native capture options now serialize the intended `uploadAudio: false` default, but the Android journal and sidecar goldens predated the field. | Add the default field to both Android golden files. | #351 `760a64fa` |
| Library-row completed state | #367 (`0d938ed8`) | Conflict resolution added a stale `Saving…` badge absent from main and the approved #367 head. | Restore the approved `null` completed state while retaining #351's local-device labels. | #367 `348f68fd` |
| Space read queued behind uploads | #367 (`0d938ed8`) | The merge lost #374/#367's text-lane snapshot and a later repair substituted note-state heuristics, which cannot identify actual text-lane work. | Restore `spaceLaneSnapshot("text")` busy/depth tracking and use text depth for `spaceAfterUploads`. | #374 `f475230b`; #367 `348f68fd` |
| Transcript completion copy | #367 (`0d938ed8`) | Conflict resolution replaced #386's completed copy with the in-progress `Saving transcript…` wording. | Restore `Transcript saved.` for the completed state. | #386 `d337c7d4` |
| Timestamped voice-note and VAD text assertions | #368 (`e5937afe`) | Tests retained pre-segment single-sentence/space-joined expectations after #368 began preserving engine timing, channels, and sentence boundaries. | Assert two timed channel segments and newline-joined transcript text; use selector wording that does not treat `you` as a participant after single-channel speakers became anonymous. | #368 `52d8380a` |
| Recording-only mode captions | #351 (`92ff5241`) | Stale captions and the phone browser assertion omitted that recording-only audio follows the TinyCloud upload setting. | Restore the setting-aware `finalCopy.ts` text and make the interaction check assert that approved copy. | #351 `760a64fa` |
| Meeting-chat upload fixture | #351 (`92ff5241`) | The fixture expected a cloud transcript but saved its note through the new local-only default. | Mark that upload fixture `uploadAudio: true`. | #351 `760a64fa` |
| Tracked `logs/` artifacts | Integration repair commits (`c7e0c115`–`197e0e1d`) | Sixteen transient test logs were committed, making later local/CI output look like source changes. | Remove them from Git while preserving the local directory; ignore `logs/`. | Integration-only cleanup |
| Backend hosted rate-limit test | #375 merge (`3f6bd433`) | The conflict kept #375's limit constants but dropped #380's `SESSION_LIMITS` import; the test threw before assertions. | Restore the combined import. | #375 `a4365377`; #380 `82fc4b71` |
| Backend hosted cleanup and lifecycle fixtures | #375 merge (`3f6bd433`) | The merged fixture neither closed its tombstone store nor supplied #375's fail-closed spool path, identity-store adapter, and startup reconciler. Bun 1.4 reported the leaked lock handle, and the shutdown test waited forever on a server that had refused to boot. | Register the store's established `close()` cleanup, give the boot fixture an explicit absolute spool path, and mock `KvJsonKv` plus `reconcileHostedJobs`. | #375 `a4365377` (`e70460d0`, `518cb948`); existing hosted-store cleanup pattern |
| Transcript-eval `native` lock check | #369 merge (`fc7b183a`) | The train added the local `listener-core` patch without Cargo's unused-patch lock entry, so metadata could not run with `--locked`. | Regenerate metadata; the only lock change is `[[patch.unused]] listener-core 0.1.0` before `local-model`. | #369 `b2316c0a` |
| Desktop debug compile | #369 merge (`fc7b183a`) | Conflict resolution declared `dev_log` twice, producing E0428 and duplicate Tauri command macros in debug builds. | Keep the one declaration in main's module order. | Main; ExoDevLog `5918a341` |
| Exo UI settings and recording-only captions | #351 merge (`92ff5241`) plus a latent main harness omission | The new settings control ran outside recorder context; its checkbox had a 13px target, and the longer recording-only caption retained single-line clipping. | Use the existing screenshot-only `StaticRecorderProvider`, give the checkbox a real 44px label target, and wrap only recording-only captions. No reference image was re-baselined. | #351 `760a64fa`; existing main screenshot-provider contract |
| Clean-order Library unit suite | #400 merge (`4c7a34f7`) | #400's local-audio probe called the mutable native plugin unconditionally; web tests intentionally reset that binding to null, so a clean CI file order failed 32 later Library tests. | Run the probe only when the existing `nativeVoiceNotesAvailable()` contract says the plugin is installed; web keeps an empty local-audio set. | #400 `a988c05d`; existing native availability contract |
| Capture-settings Chromium follow-up | #351 merge (`92ff5241`) | #351 replaced the old automatic-space-save switch with privacy-default-off `Upload audio to TinyCloud`, but the browser interaction still waited for the removed label. | Exercise the upload-audio switch's false-to-true transition while retaining the system-audio rejection check. | #351 `760a64fa` (`bfd8aae6`) |

## Current Status

- **Verified code head**: `b4783626`
- **Frontend unit suite**: 4871 pass, 4 skip, 0 fail (4875 tests, 338 files)
- **`origin/main` `b9c538ee` baseline**: 4735 pass, 4 skip, 0 fail (4739 tests, 326 files)
- **TypeScript**: pinned TypeScript 5.9.3, `tsc --noEmit -p frontend/tsconfig.json`, 0 errors
- **CI frontend lint**: `bunx eslint frontend test`, 0 errors
- **Backend CI suite**: 2477 pass, 7 skip, 0 fail (2484 tests, 111 files)
- **Chromium Exo UI matrix**: phone, phone-land, desktop, and text200-phone pass; no reference image was re-baselined
- **Native checks**: workspace dependency closure passes with `--locked`; desktop debug `cargo check --no-default-features --locked` passes
- **Privacy invariant**: unchanged; audio reaches TinyCloud KV only when `recording.options?.uploadAudio === true`.

