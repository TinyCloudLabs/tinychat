# 0.8.0 Integration Train

Integration branch: `dev/0.8.0`

## PR Merge Order
1. #374
2. #375
3. #367
4. #372
5. #369
6. #368
7. #373
8. #364
9. #348
10. #351
11. #350 (TC-947 P9+P10: Mac Me/Them stereo notes)

## Merge Log

| PR | Head SHA | Merge Commit | Conflicts | Resolution |
|----|----------|--------------|-----------|------------|
| #374 | f475230b | d8822e56 | Yes | hostedVoiceNotes.test.ts: merged harness() signature (main's durationMs/transcriptResponses + #374's readGate); merged readCommit with readGate await + main's clock. voiceNoteStore.ts: combined imports (VoiceNoteRow + VoiceNoteTranscriptionStatsMetadata) |
| #375 | a4365377 | 013ba68a | Yes | hostedVoiceNotes.test.ts: merged harness() params + return helpers; kept both test sets. hostedVoiceNotes.ts: added constants + service params. assemblyai-hosted.test.ts: took #375's rate limit imports + reconcileHostedJobs |

