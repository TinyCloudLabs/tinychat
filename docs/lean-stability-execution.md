# Lean meeting stability execution — 14 September 2026

Candidate implementation covers the four increments. Production cutover and the admitted-provider quality screen remain blocked; this is not an overall completion claim.

## Source and gates

Implementation is isolated in `workspaces/tinychat-lean-stability-20260914` of the development workspace. The original dirty checkouts and investigation evidence were preserved. The workspace helper was absent, so equivalent Git worktrees were created manually.

| Repository | Branch | Base | Result |
| --- | --- | --- | --- |
| TinyChat | `Codex/roman/tinychat-lean-stability-20260914` | `bad9c0e00acb6634fdb9a96d4bdfea2e2fa7c132` | See implementation commit containing this record. |
| tinycloud-agents | `Codex/roman/tinychat-lean-stability-20260914` | `7068737` (includes renewal fix `1374c12`) | `63a2c041721dc6b9d9e033e019aae3b7078c5c2a` |
| tinycloud-node | `workspace/tinychat-publication-v3-20260914` | `458137c97178365faa41009aa10a54bd03e4a7ac` | `74173f9d0fbf04fdc21473ae91130503a1e73829`; final SDK transport integration is recorded in workspace evidence. |

Workspace receipts live in sibling `../evidence/` and contain synthetic identities only. `provider-gate.md`, `publication-completion.md`, `node-publication-findings.md`, `evaluation-synthetic.json`, and the test logs distinguish observations from unperformed deployment claims.

The original publication probe passed 14 checks and deliberately failed two old-writer checks: old SQL grants could overwrite catalog heads and old KV grants could overwrite digest keys. The implementation consequently adds a minimal native boundary inside the existing SQL service and artifact persistence. It reserves before fetch, verifies immutable snapshots, compares operation and expected head, fences delete/recreate, and rejects generic old writers after activation. No new database, queue, retrieval service, or model agent was added.

Catalog enumeration uses 100-row immutable-ID keyset pages, with source predicates in SQL and Unicode title, participant and local-day filters applied before backend selection. Concurrent insert/edit/delete tests establish an observed scan, not a point-in-time archive snapshot. Exhaustive requests retain that limitation even at exhaustion.

RedPill `z-ai/glm-5.3` remains the only candidate. Pinned Hugging Face tokenizer/template revision `aca966e4e02791568aa6a4ced368624b3d897f42` matches retained live prompt usage for 70, 110 and 23,883 tokens, plus 126 offline token-ID differential vectors. Five live synthetic requests returned normal framing/finish. These observations do not establish gateway/upstream attempt counts or remote compute cessation. The reviewed admission receipt allowlist is therefore empty. No environment boolean can enable private synthesis. `MEETING_TOKENIZER_DIRECTORY` and `MEETING_PROVIDER_GATE_RECEIPT` must either both be absent or identify a source-reviewed receipt and verified assets; startup never downloads them.

## Increment status

1. **Sources and selected path implemented.** All enabled connector writers use the native publisher. Library reads published revisions for overlapping identities. Companion produces one v3 evidence envelope with original extent and positional spans. Every Send enters `/api/agent/chat` classification before preparation; private turns bypass factual memory/compaction. Results and source order persist through reload. Old clients receive upgrade-required. Cutover remains gated.
2. **Resolution and multiple subjects implemented.** One optional eight-second interpretation call; explicit selections avoid it. Calendar and timezone resolution, previous Monday–Sunday, duplicate-title clarification, stable parent ordinals, access rechecks and four-body capacity are covered. Every source × requested part has an obligation. Useful earlier evidence survives a later read failure as partial. Unknown dates cannot establish chronological selection.
3. **Discovery, literal search and Continue implemented.** No 12/500 aggregate cap. Search processes one artifact at a time, keeps sentences plus neighbors with original offsets, bounds retained passages, and reports omitted matches. Continuation stores frozen references, counts, filters and the next unread position; pending sources remain resumable even when catalog enumeration is exhausted. Invalid continuations do not restart a scan. Search misses describe examined scope.
4. **Candidate compatibility and deletion audit implemented; live acceptance incomplete.** Legacy owners, adapters and rollout wiring are removed. Migration inventory is read-only, preserves IDs and old bytes, identifies collisions, and classifies unverified originals explicitly. Fresh source fetch is the publication migration path. No live user inventory or external-caller deployment audit has been performed. The fixed synthetic route screen is separate from the blocked live model quality screen.

## Contract and controls

The turn deadline is 120 seconds from Send. Interpretation has no retry. Retrieval is 30 seconds, each I/O at most ten seconds, with one transient retry across the turn. Reads remain serial. Synthesis has one call plus one allowance for transient recovery or structural repair, at most 35 seconds each. Normal selected success takes one model call, free text two, maximum three. Notes cannot fulfill transcript obligations. Body bytes are capped at 1 MiB, complete storage/tool envelopes at 2 MiB. Full inputs share 24,000 exact tokens including 1,024 repair reserve, with 4,096 output tokens and 2,048 context headroom. Evidence is rejected instead of fitted.

Typed result status is independent of transport completion. Missing/partial evidence, failed obligations, access revocation, provider truncation and malformed framing cannot report completed. Citation validation establishes structural provenance, not factual truth. Coverage persists fetched, decoded, supplied and processed counts, original extent and overview provenance. Product limitations remain visible.

The frontend claims one terminal outcome, closes answer admission before cancellation, and appends an immutable same-ID payload through the serialized queue. Lost acknowledgments reconcile the same payload. Private user and assistant prose cannot enter ordinary factual extraction or checkpoint promotion. Checkpoint frames are staged until clean terminal framing and rejected when mixed with a private result. Authentication, delegated session renewal, ordinary preparation/memory, public tools, billing and stream backpressure remain in their existing services.

## Deletion audit

| Plan seam | Final disposition |
| --- | --- |
| Private `orchestrateExistingLoop`, guidance/clean-synthesis/citation expansion/private repair | Removed. Loop now serves ordinary/public web tools only; `runMeetingTurn` owns private requests. |
| `meeting-turn.ts`, `meeting-evidence.ts`, `meeting-answer.ts` | Replaced with resolve → select → exact read → synthesize → validate/render → finish; no prefix fitting or “usable evidence” completion shortcut. |
| Legacy projection and companion projection/duplicate fitted fields | Deleted; one typed v3 envelope and complete framing cap. |
| Legacy date prompts, omitted-reference fallback, room selection | Deleted; backend calendar and durable parent order. `roomToEntity`, `readerFor`, grants and renewal retained. |
| Browser `lib/meetingChat/`, retriever wiring and `meetingSystemBlock` | Deleted. Shared pure compaction moved to core and invoked backend-side only after general classification. |
| Ephemeral `MeetingMessageRegistry` | Deleted; persisted turn/result metadata and private extraction filters. |
| Fireflies, targeted/webhook, Google Meet, transcriber and connectorStore writes | One native publisher; known IDs revisited; webhook ACK follows confirmed publication. |
| Notes-first destructive merge and inferred title/date associations | Removed. Independent notes identity; explicit provider links; historical fields retained only as refetch candidates. |
| Library merge/cache and archive reconciliation | Published revision wins overlap; cache includes space/source/revision/readiness; archive copies use isolated keys. |
| Provider call/result, stream completion, adapter/runtime/thread persistence | Typed product result, fixed private provider shape, single terminal claim; stream/auth/billing controls retained. |
| Companion post-cap filters and aggregate search actions | Removed. Authorized 100-row pages and exact revision reads. |
| Obsolete projection/browser/room/repair-policy tests and scripts | Removed with owners. New route, obligation, provider, persistence, cancellation and discovery regressions; unrelated controls retained. |
| `meeting-rollout.ts`, cohort predicates and three `MEETING_CONTENT_*` settings | Removed from source and deployment wiring. A regression proves old flags cannot reopen private routing. Archive `MAX_MEETING_CONTENT_BYTES` is unrelated and retained. |
| Finite old-data adapter | Removed from candidate. Unverified legacy data is visible as unavailable; it is never reconstructed from an overview or mutable old body. Production cutover awaits inventory verification. |

## Validation and remaining acceptance

Use the declared Bun 1.4 runtime. Bun 1.3.9 locally failed the native HTTP Stop reproduction; Bun 1.4 passes the actual route/socket control. This is a runtime requirement, not proof of upstream compute cancellation.

New checkpoints use the `ordinary-v3:` ID provenance marker; legacy rows remain stored but are excluded from reuse. An executable admitted-provider evaluator is available as `bun backend/scripts/meeting-eval.ts <output.json> --admitted-provider`; it fails before network work until the same reviewed receipt loader admits the provider. Composite fault injections and actual upstream HTTP requests are counted separately, and complete synthetic result outputs are retained for human review.

The exact commands and final totals are retained in the workspace execution record and evidence logs. The fixed 12-scenario corpus runs three interleaved attempts via the actual loopback route with synthetic stores/provider faults. Every attempt is retained; there is no retry-until-success scoring. Marker support and required-point recall are reported separately from status/citation checks. This screen is not human semantic evaluation or evidence of 99% reliability.

Remaining acceptance requires a reviewed gateway configuration/receipt proving bounded upstream attempts for the exact provider options; the admitted-provider 36-attempt screen with factual support and required-point review; authenticated live inventory and external companion consumer verification; and coordinated activation on a compatible node/companion/backend/frontend release set. Mixed old/new native writers cannot be assumed fenced. If a compatible release set cannot be selected for a subsequent attempt, pause private synthesis. No request may revive an old implementation as fallback. No production deployment or private user migration was performed in this execution.

Progress within one second, usable-answer p50 ≤30 seconds/p95 ≤90 seconds, terminal by 120 seconds and local Stop ≤1 second remain product targets. Synthetic lifecycle tests and local socket timings do not establish representative production latency. Downstream abort acknowledgment and actual remote compute cessation remain separate unmeasured acceptance items.
