# Synthetic meeting evaluation

New reports use `latencyPolicy: "reviewed-responsiveness-v1"`, reflecting the user's September 10 decision to accept reasonable responsiveness instead of a fixed two-second added-latency cutoff. They require an explicit per-model latency review before readiness. Reports without this policy retain their historical fixed-cutoff scoring; applying review cannot silently change an old report's policy. The earlier numerical comparisons below remain historical context.

`meeting-eval.ts` exercises the actual `orchestrateToolCalling` controller and SSE/inline parsers with real offered models. Every Eliza request resolves to a local synthetic fixture, including public web search. It never uses an account token, reads a meeting space, or sends real meeting content. Service storage correctness remains covered by the separate deterministic service tests.

The matrix contains 30 scenarios and three paraphrases per scenario. The default three repetitions produce 1,080 controller turns for four models, plus 72 paired ordinary/public-web baseline turns. These are turn counts: each controller turn can send multiple model requests. Run the deterministic suites before sending provider requests. Every model needs its own passing report before enablement.

Use Bun 1.4.0, matching the backend Docker runtime. If the local `bun` is older, prefix commands with `bunx --package bun@1.4.0 bun`. From the TinyChat repository root:

```sh
bun test backend/scripts/meeting-eval.test.ts
bun --no-env-file backend/scripts/meeting-eval.ts --output=artifacts/meeting-evaluation.json
```

The second command is an offline dry run. It records the matrix size and missing prerequisites and makes no requests. A live `--run` requires explicit `--min-idle-ms` and `--max-model-requests`; neither has an implicit default. To execute a deliberately planned batch, also supply `REDPILL_API_KEY` through the existing local environment and set `AGENT_STREAM_TURN_TIMEOUT_MS` to the actual configured deployment deadline. `REDPILL_BASE_URL` is optional and defaults to the existing RedPill endpoint. The harness inventories `/models` at runtime and intersects it with `packages/core/src/chatModels.ts`; missing offered models hold release readiness.

| Control | Accepted values and default |
| --- | --- |
| `--min-idle-ms=N` | Integer 1–3,600,000; required for live runs, no default. Zero is rejected. |
| `--max-model-requests=N` | Integer 1–100,000; required for live runs, no default. Zero is rejected. |
| `--repeats=N` | Integer 1–1,000; default 3. Release readiness requires at least two. |
| `--timeout-ms=N` | Integer 1–2,147,483,647 when supplied; otherwise use `AGENT_STREAM_TURN_TIMEOUT_MS`. This is the per-turn deadline, separate from the request budget. |

The parser rejects unknown or duplicate flags, empty values, malformed values and values outside their accepted ranges before any inventory or model request. Use `--name=value` for value options. Omitting either required live control fails before network access. Dry runs and offline review need no pacing or request-budget choices. `--timeout-ms` must reproduce the configured deadline; it does not change application configuration. Omit `--models` only when the planned batch explicitly covers all offered models. Unknown or duplicate scenario IDs are rejected.

The minimum idle interval begins when a complete baseline or controller turn finishes. Saving the report and other work between turns count toward that interval; the scheduler waits only for the remaining time. The same rule applies within pairs, across pair boundaries, when pair order reverses, and across scenarios and models. Inventory is fetched once, outside the model-request budget. The first turn starts immediately after inventory processing, without an initial idle wait.

All waits occur outside `runScenario`, before its first-answer clock and deadline start. Within a turn, interpretation, answer, synthesis and any repair retain their normal sequential calls, with no inserted sleeps. Measured request and turn latency, output budgets and the deployment deadline are unchanged. The report records `pacing.minIdleMs` and `pacing.waits`, whose entries contain `beforeRunId`, `mode`, `requestedMs`, `actualMs` and `idleMs`: the requested sleep, observed sleep and total idle time before the identified turn. It also records `maxModelRequests`, `inventoryRequests` separately, and `realModelRequests`, which excludes inventory.

The hard model-request budget is checked before every provider send, including baseline, interpretation, answer, synthesis and repair. Each admitted send counts even if it fails; a denied send does not count. Reaching the ceiling allows an already admitted stream to finish. If another request or turn is needed, the harness saves an incomplete report with `evaluation_budget_exhausted` and `releaseReady: false`, then schedules no further waits or requests. This is an evaluation stop, not evidence of a model semantic failure. Completing every planned turn using exactly the budget does not itself mark the batch incomplete. There are no automatic retries or resumptions.

After offline verification, a possible next experiment is one predeclared GLM-5.3 ordinary batch, using the unchanged three paraphrases and two repetitions. The following is an exact command example only: 60 seconds and 18 requests have not been selected or authorized for live use and do not establish sufficient shared-account capacity. Choose and record a responsible pace and budget before any traffic, leaving room for internal requests and other key users. Use a fresh artifact path and preserve a new protocol, source snapshot, raw report and separate reviews.

```sh
bunx --package bun@1.4.0 bun --no-env-file backend/scripts/meeting-eval.ts --run --models=z-ai/glm-5.3 --scenarios=ordinary-conversation --repeats=2 --min-idle-ms=60000 --max-model-requests=18 --output=artifacts/meeting-evaluation-glm53-paced-ordinary-next.json
```

Six ordinary pairs mean six baseline turns and six controller turns. A normal pair uses three model requests: one baseline, one interpretation and one answer, so this example enforces an 18-request ceiling plus one separately counted inventory request. Additional internal calls would consume that ceiling and can leave the batch incomplete. Twelve turns with this pace require at least 11 minutes between turns in total, plus the turns themselves. A cooldown reduces pressure between tests; it is not a formal per-minute quota guarantee or a production latency fix.

The earlier complete GLM-5.3 ordinary batch added 4,464 ms p95, failing the then-current 2,000 ms gate. The later unpaced confirmation stopped on its ninth model request with HTTP 429 and was incomplete. A subsequent paced batch completed all six pairs with controller first answers in 1,741–2,979 ms and was accepted under the user's revised qualitative criterion; its original 2,184 ms added p95 remains recorded. Those results remain separate and cannot be topped up or pooled with a new run; see the [current handoff](../../../development/docs/specs/tinychat-meeting-content-retrieval-HANDOFF.md). Stop and report a planned batch that hits 429, exhausts its budget or fails qualification. Do not iterate cooldowns or run more samples until something passes.

A passing, complete reviewed ordinary batch for the identical model configuration is required before planning the full 30-scenario matrix with two repeats: 180 controller turns plus 12 baseline turns per model. These 192 turns are not 192 model requests. Size and document that matrix's total request budget, pacing and wall-clock cost before starting it; the ordinary evaluator does not launch it automatically. A partial scenario matrix remains diagnostic and cannot become release-ready after review. A qualifying report must contain every unique model/scenario/variant/repeat combination for all 30 scenarios with at least two repeats. Runs are sequential and there is no resume option.

Every provider response records HTTP status, a validated `Retry-After` value (integer seconds or HTTP date), and a bounded `x-receipt-id` when present, without response bodies or unrelated headers. `modelTimings` records each model request's start, headers, first delta/tool delta, finish and protocol `[DONE]`, all relative to turn start; it retains no reasoning text. It also records the UTC request start, SHA-256 of the exact synthetic request body, and a bounded response/chat ID for receipt lookup when an early-stream response omits the receipt header. Receipt lookup is a separate diagnostic, never part of measured answer latency or an automatic follow-up after 429. RedPill receipts identify the ultimately served route; they do not expose per-event timing or abandoned failover attempts and cannot separate relay and upstream latency. First delta may be a role/reasoning delta and is distinct from first visible answer text. Protocol completion is not transport EOF, and client timestamps cannot separate provider queueing from computation. An HTTP 429 from inventory, baseline, interpretation, answer, synthesis or repair stops further provider requests and matrix scheduling immediately. The script persists the incomplete report with `provider_rate_limited` and `releaseReady: false`; it does not retry, wait for another turn, probe quota, top up samples or fetch receipts. A rate-limited baseline is saved without starting its controller pair. Respect a supplied retry time before any later deliberately planned run; its expiry never starts one automatically. Transport failures remain failed turns, but an absent interpretation caused by an HTTP failure is not labeled a semantic wrong-intent result.

The script saves its report after every completed turn. It alternates baseline/controller order for ordinary conversation and public-web cases, records first answer token separately from activity, and forwards general-answer streams without buffering them. Provider response bodies are streamed to the application and a separate observer; the observer uses the same parser as the application. The report includes all accepted synthetic interpreter arguments (`interpretationInput`) and the complete validated plan (`interpretedPlan`), including resolved filters, calendar dates, zone, ordering, selection, purpose and content filters. It also records ordered tool/status events, fixture evidence and body read counts, package size, usage, served model IDs, timings, controller diagnostics, and synthetic output for local review. These local synthetic fields may contain invented titles, references and query text; production trace redaction is unchanged. Its immutable repository revision, dirty-state bit, Bun version, and fixture contract revision describe the evaluation checkout; they do not establish a deployed service's provenance.

Fixture discovery applies title/participant substrings, source, inclusive local calendar bounds and stable instant ordering. Topic/speaker/assignee filters apply to evidence. Expected scope, admitted reference sets and date intervals come from the synthetic questions independently of model output. “Last week” is August 31–September 6, 2026; Tuesday attendance is September 8 in the fixed September 9 Lisbon context. Wrong scope, unexpected filters, wrong interval or wrong meeting reads fail the critical-error gate.

Baseline failures remain in the report and set `baselineValid: false`; they cannot qualify latency comparisons. Failed turns retain the application's nonsecret `errorCode`. `generalStreaming` records `passed`, `failed` or `unobservable`: an answer with at least 25 ms between observed initial content and response completion must start delivery before completion (with a 5 ms observation margin). Instant/single-buffer responses are unobservable rather than failures. Native/inline tool-call responses are excluded because their markup is intentionally withheld; their subsequent normal answer is assessed. Any observable buffering holds model readiness; inspect the recorded sample count and perform live browser streaming checks even if every synthetic response is unobservable.

`firstAnswerMs` and streaming-observation start times use the first non-whitespace content, while `answer` retains every delivered character. Earlier saved diagnostics may count leading whitespace as first content rather than first visible text; preserve those raw reports and do not treat their timestamps as verified first-visible-answer latency.

Automatic assertions check intent, required fixture facts, read ownership, context overflow, call limits, and latency. They cannot establish semantic support or correct attribution by themselves. Inspect every controller run's `answer` against `fixtureOutcomes` and the scenario's question in `meeting-eval-fixtures.ts`. In particular, check that no suggestion became an assignment/decision, no unsupported availability/completeness claim appeared, each meeting retained distinct facts and citations, and access revocation produced no private answer. A safe refusal or failed validation is a usefulness failure when the fixture is answerable.

Store review decisions as an array in a local JSON file:

```json
[
  {
    "runId": "moonshotai/kimi-k3:single-overview:0:0",
    "supported": true,
    "correctMeetingCitations": true,
    "honestCoverage": true,
    "useful": true,
    "noPrivateAnswerOnRevocation": true
  }
]
```

Mark `useful` true for a correctly handled unanswerable case; an answerable case requires a useful supported answer. For new-policy reports, use a review envelope to supply an explicit responsiveness decision in addition to the semantic decisions:

```json
{
  "semanticReviews": [],
  "latencyReviews": [
    {
      "model": "z-ai/glm-5.3",
      "reportGeneratedAt": "COPY THE EXACT generatedAt FROM THE REPORT",
      "acceptable": true,
      "notes": "Record the measured controller and baseline first-answer/completion times, material outliers, and why responsiveness is acceptable."
    }
  ]
}
```

Populate `semanticReviews` with the decisions described above; an empty array does not approve any pending answer. Judge actual first-answer and completion responsiveness, inspect all ordinary controller/baseline samples and disclose substantial stalls. A semantic-only array remains supported, but leaves new-policy latency review pending. A rejected or missing latency decision holds readiness; unknown models, duplicate decisions, mismatched report timestamps, nonboolean decisions and blank or oversized notes are rejected. Notes are limited to 4,000 characters. Use a separate reviewed copy of the immutable raw report before applying decisions; the output file is updated in place. Review makes no provider requests:

```sh
bun --no-env-file backend/scripts/meeting-eval.ts --output=artifacts/meeting-evaluation-kimi.json --review-file=artifacts/meeting-evaluation-kimi-review.json
```

The report keeps `releaseReady: false` until the complete matrix is present, all controller runs have passed semantic review, critical errors are zero, useful answers reach 95%, no context overflow occurred, successful p95 latency fits within 80% of the configured deadline, and at least six valid ordinary-conversation pairs have exactly one extra model call. New-policy reports additionally require explicit accepted responsiveness review. `ordinaryPairingPassed` records the sample/call checks, `latencyReviewStatus` distinguishes pending/passed/failed (or historical `not_required`), and `ordinaryLatencyPassed` combines the applicable policy with pairing checks. `addedP95FirstAnswerMs` and `legacyAddedP95Within2000Ms` always retain the old numerical comparison; it only blocks historical reports without a latency policy. These pairs must include two distinct valid repeats for each of the three paraphrases, explicitly valid baselines, successful controller answers, and finite first-answer timestamps. Failed answers, duplicate pairs and public-web samples cannot replace them. Streaming requires at least one observable passing sample and no observed buffering failures; zero observable samples is not a pass. Review failures remain recorded. Live browser cancellation, deployed build provenance, and authorized account checks are separate rollout gates and are not asserted by this synthetic report.

Fixture bodies are deliberately small. A report with no observed context overflow does not establish behavior near model context limits or bound transport memory allocation.

## One-request interpreter compatibility probe

For a candidate that still needs interpreter compatibility established, `meeting-interpretation-probe.ts` makes exactly one synthetic interpreter request. GLM-5.2 is the default; `--model=<offered-model>` explicitly selects another offered model and unknown IDs are rejected before spending. It uses the actual controller's prompt, schema, 1,024-token budget and interpreter deadline slice, ensuring `reasoning: { enabled: false }` without a conflicting `reasoning_effort`. The guarded backend now uses this interpreter-only candidate setting too; synthesis/repair still use low effort, and the feature remains off pending qualification. Any answer continuation stops locally before a second provider request; this is never a scored conversation or a latency pair. The evaluator's pacing-only change does not require repeating the already completed GLM-5.3 compatibility probe.

The probe's deterministic tests make no provider requests:

```sh
bunx --package bun@1.4.0 bun test backend/scripts/meeting-interpretation-probe.test.ts
```

For any separately planned live probe, supply the existing relay environment and verified `AGENT_STREAM_TURN_TIMEOUT_MS`; its output path must be new and its parent directory must exist. The probe records the exact request hash, selected source-file hashes, HTTP status/safe Retry-After, request start, headers, first delta/tool delta, finish and protocol `[DONE]` times. Protocol completion is distinct from transport EOF, which the application does not wait for. Timing cannot separate server queueing from computation. No reasoning text, raw response body or request credentials are retained. The observer is cancelled when the controller finishes or rejects a response, including early size-limit failures.

An HTTP 200 with an accepted general plan establishes only compatibility for this sample; it does not prove the deployed route honors disabled reasoning or satisfies the two-second added-latency gate. An HTTP 429 is a capacity failure, not a semantic result: preserve it and stop requests until capacity is available. After compatibility, test six valid ordinary pairs with the exact candidate configuration before a full matrix. This probe alone always reports `releaseReady: false`.
