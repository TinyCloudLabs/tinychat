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

## Current Status

- **HEAD**: ed1e7a20
- **Test counts**: 4771 pass, 4 skip, 89 fail
- **main baseline**: 4735 pass, 0 fail

### Remaining Failures (89)

Most failures are in:
1. `transcribeVoiceNote (one note end to end)` - 26 failures: tests expect to read audio from space but mocking incomplete for new audio read path
2. `transcribeVoiceNote reads the note's stored audio (TC-517)` - 6 failures: same cause
3. `every path that creates or resumes an off-phone job consults the hold` - 5 failures: semantic conflict between #351 (audio upload opt-in) and #367's hold logic
4. `an explicit move to private cloud survives a restart` - 4 failures

Root cause: semantic conflicts between PRs when combined - each PR's tests passed individually, but the merged behavior differs from what each PR's tests expected.

