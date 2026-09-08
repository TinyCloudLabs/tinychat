# PR 67 accounting and stream-policy validation

Offline evidence collected September 8, 2026 against implementation commit
`5e6550f52ff5c4075767e103eb3d06e5b0fee17b`, using Bun 1.4.0. The scripts use
relative imports and require the repository's existing installed dependencies.

From the repository root, with Bun 1.4.0 on PATH:

```sh
bun --no-env-file --no-install artifacts/agent-stream-rollout-2026-09-08/accounting/audit.ts
bun --no-env-file --no-install artifacts/agent-stream-rollout-2026-09-08/accounting/verify.ts
```

`audit.ts` uses synthetic providers, Stripe, catalog, user identity, and tool
results. It invokes the actual agent route, local usage store, and `LedgerFlusher`
without starting the flusher's background timer. Global fetch is replaced with a
catalog fixture and rejects unexpected requests. No external request is sent.
The short 5/30/10 ms heartbeat/turn/grace values are accounting fixtures, unrelated
to the candidate production policy.

All ten scenarios passed; `results.json` contains only synthetic token counts,
credit totals, and outbox sizes:

| Scenario | Local usage and outbox |
| --- | --- |
| Successful two-round answer | One debit and one record, 30 prompt / 7 completion tokens |
| Second-round HTTP failure | One debit and one record for prior completed round, 10 / 3 tokens |
| Second-round exception, premature EOF, or timeout | Zero debit and zero records |
| Stop during second round | Zero debit and zero records |
| Timeout during tool execution | Zero debit and zero records |
| Terminal close or terminal grace expiry | Preserve completed totals: one debit and one record, 30 / 7 tokens |
| `end()` throws | Zero debit and zero records |

The tested candidate policy is heartbeat **10,000 ms**, turn maximum **300,000 ms**,
and terminal grace **5,000 ms**. `verify.ts` checks the backend validator, the
actual workflow configuration preflight with synthetic required values, and the
deploy env-file / compose round trip. It then runs the maintained policy and
deployment suites (**89 passed**) and focused accounting tests (**14 passed**).
`validation.json` records their commands and concise results.

These checks establish validation and forwarding, not actual heartbeat delivery,
provider latency, production transport limits, or browser recovery. They do not
modify production settings or approve the candidate policy.

The accounting recommendation is to retain existing result-based eligibility for
this transport fix: returned observed totals remain eligible; thrown active
interruptions and write/end exceptions produce no recorded usage. This can
undercount provider spend and permits cancellation-based avoidance of recorded
credits. A separate charging-policy change would be needed to charge partial or
previously completed rounds after an exception. This artifact records that
tradeoff without claiming maintainer approval.

Relevant implementation boundaries are `backend/src/routes/agent-chat.ts` at
the round boundary (475), provider HTTP failure (543), completed-round summation
(629), result invalidation (1170 and 1178), and shared local/outbox gate (1182).
Maintained tests cover these dispositions in `agent-chat.test.ts` beginning at
1137, 1159, 1183, 1211, and 1229, and `agent-chat-lifecycle.test.ts` at 197.
