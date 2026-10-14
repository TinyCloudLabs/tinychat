# 0.8.0 Integration Train

Integration branch: `dev/0.8.0`

## PR Merge Order
1. #374 ✓
2. #375 ✓
3. #369 ✓
4. #348 ✓ (P8 - must land before #350)
5. #351 ✓ (must land before #350, privacy invariant verified)
6. #368 (after #351)
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
| #351 | 760a64fa | 62e32d04 | Yes | **PRIVACY INVARIANT**: voiceNoteStore.ts local-only early return (line ~424) precedes ALL audio upload code. When uploadAudio=false: (1) empty transcript key, (2) patchVoiceNoteLocalOnly, (3) note sync, (4) return - NO putVoiceNoteAudio reached. Conflicts in 5 files resolved. |

