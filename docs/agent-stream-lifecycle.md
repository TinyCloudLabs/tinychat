# Agent chat stream lifecycle

Agent chat sends an immediate invisible SSE comment and repeats it during model,
tool, synthesis, and citation-repair work. A single response owner serializes
writes, propagates cancellation, enforces one absolute turn deadline, and bounds
terminal flushing. Citation validation still precedes release of meeting answers.

Provider `[DONE]` completes a round without waiting for HTTP EOF. Missing DONE,
malformed tool calls, provider errors, and downstream transport loss become explicit
incomplete replies. The frontend preserves already displayed text and restores the
composer without replaying the request or handing off successful completion receipts.
Stop remains cancellation. Cached clients receive a fixed interruption notice when
the connection can still carry a terminal error.

## Required runtime

Use **Bun 1.4.0**, pinned in the root package manifest and backend Dockerfile.
The original implementation plan's Bun 1.3.9 constraint changed after a real-socket
regression reproduced a runtime defect independently of TinyChat: after consuming
a POST body, a downstream disconnect did not reach the response owner. Bun 1.3.13
also reproduced it. These observations cover local macOS and Linux fixtures; they
do not establish the cause of the original production incident.

The [1.3.9 request cleanup](https://github.com/oven-sh/bun/blob/bun-v1.3.9/src/js/node/_http_incoming.ts#L274-L290)
clears the native abort callback. The
[1.4.0 socket closure implementation](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/js/node/_http_server.ts#L1523-L1608)
closes the attached response independently. The same consumed-body disconnect
fixture and all 13 maintained socket tests pass on 1.4.0, including client Stop.
No private runtime hooks or dependency/lockfile changes are used.

Validated Linux/amd64 base-image repository digest:
`oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6`.

## Explicit stream policy

When existing configuration enables agent chat, all three settings are required:

| Setting | Meaning |
| --- | --- |
| `AGENT_STREAM_HEARTBEAT_MS` | Period between invisible response-body comments. |
| `AGENT_STREAM_TURN_TIMEOUT_MS` | Absolute maximum turn duration, beginning when SSE opens. |
| `AGENT_STREAM_DRAIN_GRACE_MS` | One shared allowance for any pending drain, error boundary, terminal frames, and response finish. |

Environment values must contain only decimal digits and represent positive integer
milliseconds at most 2,147,483,647. Missing, blank, whitespace-containing, malformed,
fractional, nonpositive, nonfinite, and overflowing values fail startup before
background work or listening. Errors name the setting without echoing its value.
Direct route construction validates the corresponding numeric policy too.
Agent-disabled configurations need no stream settings.

The Phala workflow validates the values before building or deploying and forwards
them through compose. On September 8, the repository Actions variables were set
and read back as **10,000 ms heartbeat, 300,000 ms turn timeout, and 5,000 ms drain
grace**. The pinned ingress image's silent control failed at 60.2 seconds, while
10-second comments traversed it for 75 seconds through DONE and actual HTTP EOF.
The turn and grace bounds are explicit operational choices, not provider latency
guarantees. These settings still need a live gateway canary. Tests' smaller timing
values remain fixture policy, never application defaults. No ingress change is
included. See the [rollout evidence](../artifacts/agent-stream-rollout-2026-09-08/README.md).

## Cancellation, accounting, and diagnostics

Backpressure accepts each byte slice once and pauses provider consumption. Comments
skip a pending writer. Large frames are encoded once and sliced as UTF-8 bytes. If a
deadline interrupts a partial event, its unsent suffix is abandoned and an explicit
blank-line boundary precedes the fixed terminal error. Both client parsers are
tested against the actual resulting socket bytes.

The first terminal claim stops producer admission before abort callbacks run.
Transport loss invalidates terminal writes. A single grace deadline covers terminal
drain and finish; a nonreading client or unfinished flush cannot hold resources
indefinitely. Late or noncompliant upstream operations cannot reopen the response.

Accounting eligibility remains separate from UI success. Completed results and
existing nonthrowing provider HTTP failure/boundary-cancellation returns retain
their observed totals. Exceptions, including new interruptions of active fetches,
and final write/end exceptions keep the existing no-result accounting behavior.
New cancellation can therefore record less usage than previously uncancelled work.
The rollout recommendation is to retain this disposition and review its undercount
tradeoff when authorizing production enablement. This change does not estimate
partial charges or change rates or ledger policy; no earlier signoff is implied.

The lifecycle emits one structured summary with fixed classes and numeric/boolean
timing and transport fields. It excludes prompts, tool data, identifiers, credentials,
URLs, and raw exceptions. A backend write or queued DONE does not prove client receipt.

## Local execution evidence — September 8, 2026

Implementation began from main `abdab6c3db7665a3c7f43a3ad4122ca9a31972e0`.
Regression tests first reproduced missing liveness, incomplete EOF, lost cancellation,
unsafe terminal framing, and unhandled composer rejection before the fixes.

On Bun 1.4.0, full backend tests pass (1,354), frontend tests pass (1,124), and
package tests pass (147). The root production build passes. The lockfile is unchanged;
installation passed with `--frozen-lockfile`. A pre-existing meeting-chat integration
fixture was updated to supply its existing model-selection dependency after the
same failure was reproduced against unchanged main.

The real-socket suite uses only loopback servers and synthetic providers/tools. It
covers four silent phases, an intentionally buffering proxy, deadline/Stop, native
fetch header/body/tool-JSON aborts, and old/new parser compatibility with an interrupted
UTF-8 frame. The buffering case demonstrates that backend writes alone cannot prove
delivery. Synthetic timing thresholds are unrelated to production timeout estimates.

The backend Dockerfile builds successfully for Linux/amd64. Its image
`sha256:3eecf52569bb6116e15221c6260ceb897bf656eda9462614bb2632ba5db678ab`
passes 98 route/lifecycle/socket tests (424 assertions) with external networking
disabled. Route, policy, and startup source hashes match the worktree. The current
socket test and frontend parser source are mounted read-only for this test run.
An 8 MiB citation-validated fixture verifies bounded writes and settlement with a
nonreading socket; it is a stress fixture, not a production answer-size policy.

An isolated Chrome 152 session exercised the actual parser, adapter, and installed
assistant-ui runtime with a disposable renderer. Read failure, subsequent successful
submission, Stop, pre-header failure, premature EOF, and typed timeout passed: six
synthetic requests, zero unhandled rejections/page errors, and a reusable composer.
This does not certify the production `Thread.tsx` render tree. Safari 18.6 automation
was unavailable because remote automation is disabled; its settings were not changed.

Full lint retains three errors reproduced on unchanged main: empty catches in the two
September 7 model-probe artifacts and an unused assignment in `frontend/src/App.tsx`.
Changed implementation/test files pass scoped lint and `git diff --check`.

## Rollout follow-up and remaining gate

The September 8 [rollout follow-up](../artifacts/agent-stream-rollout-2026-09-08/README.md)
records eight successful live usage-before-DONE plain/tool probes across all four
selected models, actual Safari 18.6 local recovery, matching local/ledger accounting
dispositions, validation of the configured policy, and refreshed deployment/recovery
identities. The recommendation is to retain the existing conservative accounting
policy with its documented undercount tradeoff. Initial provider 429s are retained
in the evidence; successful samples do not certify provider availability.

A controlled production deployment and bounded live gateway canary remain. Verify
heartbeat receipt, HTTP termination, and actual Safari success/Stop/recovery on the
deployed build. Deterministic public-path stall testing requires an isolated canary
seat; it must not replace global provider/tool configuration. The exact incident
closing boundary remains unproven. No production deployment was performed during
this follow-up.
