# Actual Safari 18.6 recovery verification

All nine requested scenarios passed in installed Safari 18.6 on macOS 15.6.1,
using the real product Thread, assistant-ui runtime, parser, adapter, history
code, and backend agent route from implementation commit `5e6550f`. Native UI
actions drove Send and Stop. Remote automation settings were unchanged.

The existing local full-component fixture ran at `http://127.0.0.1:4489/chat`:
authentication, provider/tool data, and the SQLite transport were synthetic.
No real meetings or production provider requests were involved in this lane.
The fixture source is not included in this PR. Repeating the actual browser run
requires the separate local checkout
`development/worktrees/tinychat-load-failed-handoff`, whose
`docs/specs/tinychat-load-failed-local-test-assets/FULL-COMPONENT-FIXTURE.md`
contains the source and launch instructions. The committed audits and `verify.py`
are sufficient to reproduce the recorded-evidence verification, not to launch
the entire browser fixture from this repository alone.

| Case | Outcome |
| --- | --- |
| Success | Complete, receipt and completion metadata present |
| Delayed model, tool, synthesis, citation repair | Complete; comments delivered; tool activity cleared |
| Premature EOF and broken socket | Partial text retained, fixed error copy, composer recovered |
| Turn timeout | Partial text retained, typed timeout, provider cancelled |
| Actual Stop button | Incomplete/cancelled, provider cancelled, composer recovered |

Five valid successes had receipts and completion metadata; all four required
incomplete replies had neither. Browser audit recorded zero page errors, zero
unhandled rejections, and no blocked nonlocal fetches. All 164 server-written
comments reached the browser across the whole run. Rejected citation draft text
was absent from the browser bytes, runtime messages, and persisted messages.
The composer accepted a final unsent draft and reported `canSend=true`.

There were ten total requests and twenty persisted messages. One early typed
prompt lost a character (`fixture:of` instead of `fixture:eof`); that explicit
extra request failed before provider work and is excluded from the nine-case
acceptance count. The exact EOF prompt was subsequently pasted, checked in the
UI, and passed. No request was automatically replayed. The extra request remains
in both audits rather than being removed from the evidence.

Safari's console showed the expected native network diagnostic for the injected
broken socket. This is distinct from a JavaScript page error or unhandled
rejection; the instrumented counters for both were zero. `browser-audit.json`
was exported from `window.componentAudit()` through Safari's own console.
`backend-audit.json` independently records route settlement and persisted state.

Run `python3 artifacts/agent-stream-rollout-2026-09-08/safari/verify.py` from the
repository root to validate the recorded artifacts. `verification.json` stores
the resulting assertions and per-case summary. This script sends no requests.

Timing policy was the established local fixture policy: 50 ms heartbeat,
15-second turn bound (1.2 seconds for timeout), and 200 ms grace. Stop settled
3,999 ms after request start, including operator delay before clicking Stop;
that is not cancellation latency. Production timing values and the public
gateway were not exercised. No new Safari reload claim is made by this run;
the prior authenticated Chrome run covers real TinyCloud restore.

The test inspector and only the test tab were closed after capture. The owned
fixture server was stopped; the pre-existing signed-in local app was preserved.
