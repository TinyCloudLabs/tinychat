# hostedVoiceNotes Integration (dev/0.8.0)

This documents the merge of main (including #379), #375, and #368 for the 0.8.0 integration branch.

**Rule: main's behaviour is the floor.** Nothing on main may be lost.

## Base: main (including #379) — shipped in 0.7.3

### assemblyai.ts
- `pollAssemblyAiTranscript`: Encapsulated polling with exponential backoff, slow-cadence for long recordings
- `cloudStatusIntervalMs`, `jitteredCloudIntervalMs`, `DEFAULT_CLOUD_POLLING` from privateCloud
- `AssemblyAiError` with `retryAfterMs` parameter
- Rate limit handling with `parseRateLimitWaitSeconds`

### hostedVoiceNotes.ts
- Uses `pollAssemblyAiTranscript(client, handle, { clock, durationSeconds, guard, onStatus })` for transcript polling
- `CloudClock` injection via `services.clock` parameter

### Tests
- "hosted voice-note polling scales its slow cadence from the saved recording duration"
- All polling-related tests in assemblyai.test.ts

## Layer: PR #375 (a4365377) — L1 backend compose spool + deploy workflow

### assemblyai.ts
- `needs-reconciliation` error kind added to `AssemblyAiErrorKind`
- `assemblyai_needs_reconciliation` error code handling in `hostedError`
- Extended `HostedSubmission` status: added `missing | needs_reconciliation | unresolved | deleted`
- `upload_id` field added to `HostedSubmission`
- `lookupJob(sourceId)` method for job reconciliation
- `createUpload(size, contentType, sourceId)` with optional sourceId
- `createTranscript` with optional sourceId parameter
- `needs_reconciliation` status handling in `createUpload`

### hostedVoiceNotes.ts
- Claim management: `readClaim`, `writeClaim`, `CLAIM_TAKEOVER_MS`
- `withHostedUploadQueue` with claim acquisition, heartbeat, and release
- `reconciliationDelayMs` service parameter
- `watchReconciliation` background checker for failed reconciliations
- Claim-based duplicate prevention across instances

### Tests
- "a paid outcome needing reconciliation blocks the note without another upload or automatic retry"
- "a quarantined or missing lookup never enables Retry; provider-confirmed submission does"
- "two instances racing on one note create one upload and one transcript"
- "a crashed owner with an upload ID is taken over and resumed"
- "a failed claim release is retried before the next run"

## Layer: PR #368 (52d8380a) — TimestampedTranscript + T1 fixes

### assemblyai.ts
- Import: `splitLongTimedSegment` from `./voiceNotes/timedSegments`
- `AssemblyAiUtterance`: added `channel?: 0 | 1 | null`
- `AssemblyAiSentence`: added `channel?: 0 | 1 | null`, `words?: { start, end, text }[]`
- `AssemblyAiTranscript`: added `audio_channels?: number | null`
- `assemblyAiSentences(t, sentences, options)`: new signature with `{ stereo?: boolean }` option
  - Stereo channel detection from `audio_channels`
  - Channel inference from speaker labels
  - Word-level splitting for long segments
  - `splitLongTimedSegment` for 30-second max segments
  - Output includes `timing`, `speaker_id`, `channel` fields

### hostedVoiceNotes.ts
- `recording.channels` for stereo detection (replaces `layout === "stereo"`)
- `assemblyAiSentences` call with `{ stereo }` option
- Channel-based speaker naming: `channel === 0 ? "Me" : "Them"`
- `LocalTranscript` version: `2` (was `1`)
- Segment fields: `speakerId`, `channel`, `timing`
- Metadata `speaker_labels`: `"channels"` for stereo

### timedSegments.ts (new file)
- `splitLongTimedSegment` function for breaking long segments at word boundaries

### assemblyai.test.ts updates
- Test expectations updated to include `timing` and `speaker_id` fields

## Test Summary

- **hostedVoiceNotes.test.ts**: 22 tests pass
- **assemblyai.test.ts**: 26 tests pass
- **Total**: 48 tests pass, 0 fail

All tests that pass on main also pass on dev/0.8.0.
