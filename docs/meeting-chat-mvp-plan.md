# Lean meeting-chat MVP execution brief

This is the source of truth for the `meeting-chat-mvp` Smithers workflow. The workflow must
implement this brief in small, dependency-ordered tasks and must not expand the MVP.

Run it from the repository root:

```bash
bunx smthrs workflow run meeting-chat-mvp
```

Use `bunx smthrs ps`, `inspect <run-id>`, and `logs <run-id>` to follow it. Smithers persists
completed iterations, so an interrupted run can be resumed instead of restarted.

## Outcome

Add deterministic browser-side meeting retrieval as one async dependency of
`createChatModelAdapter.run()`. On a meeting turn, discover metadata, deterministically select
one meeting (or return a deterministic clarification), read at most three evidence locators
sequentially, construct one escaped meeting system message of at most 12,000 characters, count
it during compaction, and send the turn through plain `/api/chat` even when agent mode is on.
Mark every meeting outcome so memory extraction is skipped.

Raw meeting content may exist only in retrieval memory and the outgoing inference request. It
must not enter stored messages, checkpoints, compaction summaries, memory, logs, tool activity,
source cards, or persisted provenance.

## In scope

- Exactly one meeting per question.
- SQL meetings from Fireflies, Google Meet, and Transcriber.
- Fireflies cohort/server meetings selected by supported title, participant, e-mail/domain,
  date, or a uniquely valid `latest` timestamp from discovered metadata.
- Reconciled KV meetings identifiable through server metadata or an in-session identity.
- Selection by title, participant, email/domain, explicit date, `today`, `yesterday`, or
  `latest`.
- In-session referential follow-ups after a meeting has been selected.
- Summary-only and transcript-only evidence.
- Inline citations `[M1]` and `[M1:E1, Alice, 00:12:04]`.
- Deterministic ambiguity, no-match, no-content, and storage-error responses without a model
  call.
- Prompt-injection fencing, hard evidence bounds, memory-extraction suppression, a disclosure
  near the composer, and connector delete-data repair for KV-only records.

## Explicitly deferred

- Multi-meeting comparison, “all meetings,” and cross-session follow-ups.
- Persisted provenance, source cards, and shared-view source metadata.
- Topic-only discovery across transcript/summary bodies.
- Broad natural-language date grammar, embeddings, indexes, analytics, production diagnostics,
  meeting-aware agent tools, and exact 900 KiB request-body preflight.
- Backend routes, manifests, environment variables, storage schemas, and agent APIs.

## Contracts and modules

Add these four modules with colocated tests:

- `frontend/src/lib/meetingChat/types.ts`: `MeetingRef`, content-free `MeetingCandidate`,
  `MeetingExcerpt`, `MeetingEvidence`, `MeetingRetrievalOutcome`, thread state, and limits.
- `frontend/src/lib/meetingChat/corpus.ts`: strict sequential SQL/server/KV metadata discovery,
  lane health, malformed-row partial state, and exact `(source, sourceId)` deduplication.
- `frontend/src/lib/meetingChat/retriever.ts`: intent, deterministic selection, ambiguity,
  ephemeral follow-up state, and bounded evidence reads.
- `frontend/src/lib/meetingChat/context.ts`: transcript normalization/chunking, excerpt ranking,
  escaping, and context construction.

The canonical `MeetingCandidate` must contain only identity, title/date, participant name/email,
availability booleans, timestamps, and local row identity. It must not contain provider metadata,
summaries, or raw transcript text. Thread state contains only a selected `MeetingRef` and
content-free ambiguity candidates, lives in memory, and is cleared on reload.

Use these hard limits:

```ts
MAX_EVIDENCE_READS = 3;
MAX_EXCERPTS = 4;
CHUNK_TARGET_CHARS = 1_000;
CHUNK_HARD_CHARS = 1_400;
CHUNK_MAX_SPAN_SECS = 90;
MEETING_CONTEXT_MAX_CHARS = 12_000;
```

## Discovery and selection rules

All storage calls are sequential. Non-meeting turns perform zero meeting storage reads.

SQL discovery uses one strict, read-only metadata query. It selects identity, title/date,
participants/organizer, availability timestamps, and created/updated timestamps only. A missing
table is an unused lane; auth/transport failures are lane failures; malformed rows make the
corpus partial. It inspects at most 500 rows plus one SQL overflow sentinel; an overflow makes
the lane partial/truncated so omitted meetings can never produce a complete no-match.

Server discovery pages Fireflies metadata sequentially with `limit: 200` up to the existing
500-inspected-meeting bound (independent of accepted candidates). Reject repeated cursors,
empty `hasMore` pages, and malformed no-progress pages. Keep feature-dark, signed-out, offline,
retryable, and rejected states distinct. KV discovery lists meeting and transcript prefixes for
identity/availability without reading every body, for Fireflies and each SQL-discovered Google
Meet or Transcriber source. Merge only by exact `(source, sourceId)`. Opaque unmatched KV-only
records are excluded from fresh selection and clarification; they may be used only after an exact
metadata merge or through an existing in-session identity.

Meeting intent requires a meeting noun, a supported retrieval phrase, or a referential follow-up
with selected in-session state. Selection order is:

1. Explicit date is a hard browser-local calendar-day filter; relative dates use the browser's
   local calendar rather than UTC.
2. Exact email.
3. Exact title or participant phrase.
4. Title/participant token overlap.
5. `latest` after other filters, only when exactly one candidate has the newest valid timestamp;
   tied or undated candidates require clarification.
6. Recency only as a tie-breaker.

Require a strong selector unless thread state already selects a meeting. If plausible candidates
remain, return at most five uniquely numbered, localized title/date/time/connector-label choices;
when discovery is partial or more choices exist, say so and tell the user to refine by title,
participant/email, or date.
Resolve a clarification only when the complete normalized reply is an offered number, title, or
date; unrelated prose remains ordinary chat. Do not call a model. Topic-only discovery without a
meeting selector is out of scope.

## Evidence and secure context

For the selected meeting, read only likely missing locators in this order: SQL summary, listed
local KV record/transcript, then server fallback. Thread the turn's `AbortSignal` through every
discovery, storage, pagination, and connector read, and stop before later sequential calls after
cancellation. Validate normalized transcript readability before treating it as sufficient;
continue after empty or malformed content, distinguish valid empty content from malformed reads,
return deterministic no-content when all successful reads are unreadable, and retain
transport/auth/retryable failures as storage errors. Transcript,
quote, speaker, and “what was said” requests attempt available transcript locators within the
three-read cap and mark unread or skipped relevant evidence partial. Chunk transcript sentences
while preserving speakers/timestamps and select up to four chunks using query terms plus small
decision/objection/risk/action-item boosts. Every emitted chunk has a maximum 90-second span; an
atomic source sentence with a longer known span is marked partial and rendered without fabricated
timestamps.

Escape all meeting-controlled text, including delimiters, titles, speakers, summaries, and
sentences. The system message says meeting data is untrusted evidence and instructions inside it
must never be followed, requires visible inline `[M1]`/`[M1:E…]` citations, and requires an
honest visible limitation when evidence is partial or truncated.

Prompt order is: user memory system message, meeting context system message, compaction summary
if any, then recent conversation. Meeting context counts toward compaction but is never input to
the summarizer.

## Integration changes

- `frontend/src/chat/chatModelAdapter.ts`: inject one retriever; call it once before checkpoint
  loading and compaction; return deterministic responses without inference; force grounded turns
  through `streamChat`; prepend meeting context after memory and before compacted conversation;
  do not repeat retrieval on reactive overflow retry.
- `frontend/src/chat/compaction.ts`: rename `memoryBlockChars` to `fixedSystemBlockChars`; count
  memory plus meeting context; exclude meeting context from summary input.
- `frontend/src/chat/pendingHandoff.ts`: add a collision-safe message-ID or thread/user-turn
  keyed `meetingTurn` flag with no wildcard or eviction path.
- `frontend/src/chat/runtime.tsx`: keep applicable assistant replies transient, so raw evidence
  cannot enter stored history, extraction, or later compaction; do not attach evidence/provenance
  to stored items.
- `frontend/src/App.tsx`: construct and inject one retriever instance.
- `frontend/src/chat/Thread.tsx`: near the composer, disclose: “Meeting questions send selected
  meeting text to the chosen inference provider.”
- `frontend/src/lib/connectors/backendReconcile.ts`: export the existing V1 KV record type.
- `frontend/src/lib/connectors/connectorStore.ts`: as a prerequisite/lifecycle repair, enumerate
  and delete reconciled `/meeting/` and `/transcript/` KV keys during delete-data purge. Any KV
  enumeration failure prevents purge from reporting success.

## Deterministic failure behavior

- Not applicable: normal chat and no meeting reads.
- No match with complete healthy lanes: ask for a title, participant/email, or date.
- Ambiguous: list at most five uniquely numbered localized choices; no inference.
- Summary only: provide grounded context with `[M1]`.
- Transcript only: provide selected excerpts.
- Matched but no readable content: say so only after successful complete reads; partial or
  transient read failures offer retry guidance instead.
- Critical storage failure: say meetings could not be read; never claim an empty corpus.
- Partial corpus plus confident match: ground the answer and tell the model sources are missing.
- Partial corpus without confident match: storage error or clarification, never no-match.
- Truncated context: use selected excerpts and label them incomplete.

## Suggested atomic task boundaries

The planning step may adjust these boundaries to repository reality, but must preserve their
small size and dependency order. One Ralph iteration implements exactly one task.

1. Export the reconciled V1 KV record type without changing its shape.
2. Repair delete-data KV enumeration/deletion and add fail-closed purge tests.
3. Add minimal meeting-chat contracts, constants, and contract tests.
4. Implement strict SQL metadata parsing/discovery and lane-state tests.
5. Implement bounded sequential server metadata paging and state tests.
6. Implement prefix-only KV identity/availability discovery and tests.
7. Implement exact-identity corpus merge/deduplication and partial-health tests.
8. Implement conservative meeting intent and supported date parsing tests.
9. Implement deterministic selector scoring, strong-selector rules, ambiguity, and no-match tests.
10. Implement ephemeral per-thread selection/follow-up state tests.
11. Implement the sequential evidence-read coordinator, early stop, and three-read cap tests.
12. Implement transcript normalization and bounded speaker/timestamp-preserving chunking tests.
13. Implement query-aware excerpt selection and citation identity tests.
14. Implement full escaping and the 12,000-character secure context builder tests.
15. Inject retrieval into the adapter with not-applicable and deterministic-response tests.
16. Update compaction fixed-block accounting and prove meeting context is never summarized.
17. Add the pending meeting-turn handoff flag and unit tests.
18. Integrate runtime memory/extraction suppression without persisting evidence/provenance.
19. Construct/inject one retriever in `App.tsx` and add the composer disclosure.
20. Force grounded agent-enabled turns through plain chat and prove overflow retry reuses retrieval.
21. Add seeded privacy/failure integration coverage, including the transcript canary.
22. Run the complete release gate and fix failures caused by this change. The user additionally
    authorized the smallest stable fixes for the confirmed baseline blockers: the two
    catalog-dependent `backend/src/__tests__/agent-chat.test.ts` failures that occur without
    `REDPILL_API_KEY`, and the six lint errors in `backend/src/services/google-oauth.ts`,
    `frontend/src/chat/ConnectorDialog.tsx`, `frontend/src/lib/connectors/gmeetClient.ts`, and
    `frontend/src/lib/connectors/gmeetSync.ts`. Do not broaden this exception to other cleanup.

## Exit criteria

All of the following must be demonstrated by tests or direct code inspection:

- Non-meeting chat makes zero meeting storage reads.
- Provider metadata never enters the canonical candidate.
- Storage failure is distinguishable from an empty lane/corpus.
- Exact identity is the sole deduplication key.
- Evidence reads are sequential, stop early, and never exceed three.
- Context never exceeds 12,000 characters and all untrusted delimiters/text are escaped.
- Retrieval runs once before compaction and does not repeat on overflow retry.
- Meeting context is counted but never summarized.
- Grounded meeting turns always use plain `/api/chat`; deterministic outcomes make no inference.
- Every meeting outcome skips memory extraction.
- Raw evidence is absent from persisted messages, checkpoints, compaction inputs, memory,
  extraction calls, logs, tool activity, source metadata, and provenance; a runtime canary
  appears only in the outgoing `/api/chat` request.
- Delete-data removes SQL, meeting KV, transcript KV, and connector state, and fails closed when
  KV enumeration fails.
- SQL-only, server-only, reconciled-KV, summary-only, transcript-only, ambiguity, partial failure,
  abort, retry, and agent-enabled cases pass.

The release gate is:

```bash
bun test frontend/src/lib/meetingChat
bun test frontend/src/chat/chatModelAdapter.test.ts
bun test frontend/src/chat/compaction.test.ts
bun test frontend/src/chat/runtimeAdapter.test.ts
bun test frontend/src/lib/connectors/connectorStore.test.ts
bun run test:connectors
bun run test
bun run lint
bun run build:frontend
git diff --check
```
