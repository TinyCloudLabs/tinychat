# hostedVoiceNotes Integration (dev/0.8.0)

This documents the merge of #375 (claim management) and #368 (timed segments) for the 0.8.0 integration branch.

## Base: PR #375 (a4365377) — L1 backend compose spool + deploy workflow

### hostedVoiceNotes.ts
- Claim management system: `readClaim`, `writeClaim`, `CLAIM_TAKEOVER_MS`
- `withHostedUploadQueue` with claim acquisition and heartbeat
- `reconciliationDelayMs` service parameter
- `watchReconciliation` background checker
- Manual `for(;;)` polling loop with `POLL_MS = 5000`
- `lookupJob` API for job reconciliation
- `createUpload` with `sourceId` parameter
- `createTranscript` with `sourceId` parameter

### assemblyai.ts
- `needs-reconciliation` error kind
- `assemblyai_needs_reconciliation` error code handling
- Extended `HostedSubmission` status: `missing | receiving | submitting | submitted | failed | needs_reconciliation | unresolved | deleted`
- `lookupJob(sourceId)` method
- `createUpload(size, contentType, sourceId)` signature

### hostedVoiceNotes.test.ts
- Claim-related tests: racing instances, claim takeover, failed claim release
- Reconciliation tests: blocked outcome, quarantined lookup

## Layer: PR #368 (52d8380a) — TimestampedTranscript + T1 fixes

### assemblyai.ts
- Import: `splitLongTimedSegment` from `./voiceNotes/timedSegments`
- `AssemblyAiUtterance`: added `channel?: 0 | 1 | null`
- `AssemblyAiSentence`: added `channel?: 0 | 1 | null`, `words?: { start, end, text }[]`
- `AssemblyAiTranscript`: added `audio_channels?: number | null`
- `assemblyAiSentences(t, sentences, options)`: new signature with `{ stereo?: boolean }` option, stereo channel detection, word-level splitting, `splitLongTimedSegment` for long segments

### hostedVoiceNotes.ts
- `recording.channels` instead of `layout === "stereo"` for stereo detection
- `assemblyAiSentences` call with `{ stereo }` option
- Channel-based speaker naming: `channel === 0 ? "Me" : "Them"`
- `LocalTranscript` version: `2` (was `1`)
- Segment fields: `speakerId`, `channel`, `timing`
- Metadata `speaker_labels`: `"channels"` for stereo

### timedSegments.ts (new file)
- `splitLongTimedSegment` function for breaking long segments at word boundaries

## Removed (incompatible with #375's architecture)

### From #379 (60e745c4) — back off transcription status polling
- `pollAssemblyAiTranscript` encapsulated polling function
- Clock injection for testing
- Slow cadence polling test: "hosted voice-note polling scales its slow cadence from the saved recording duration"

This test was removed because it requires #379's `pollAssemblyAiTranscript` architecture which conflicts with #375's manual `for(;;)` polling loop with claim management.

## Test Summary
- 21 tests pass (hostedVoiceNotes.test.ts)
- 14 test functions with multiple test cases
- assemblyai.test.ts: 6 failures (from #379's polling tests, pre-existing in #375 structure)
