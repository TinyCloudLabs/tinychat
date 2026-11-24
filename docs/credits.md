# Credit Economy (Internal)

How TinyChat meters paid usage. This doc is **internal**: the peg and any
dollar amounts derived from it must never leak into an API response, a UI
string, or a public/marketing doc. The user-facing surface is `credits` —
nothing else. The full design rationale lives in `docs/credits-spec.md`; this
file is the operator's quick reference.

## The peg (NEVER published)

```
1 credit = $0.0001 of upstream (RedPill) cost   // PEG_USD = 1e-4
```

`PEG_USD` is a code constant in `backend/src/billing/credits.ts`. It must not
appear in:

- any JSON returned by `/api/billing/*`, `/api/chat`, or `/api/chat/models`
- any string rendered in the frontend
- any public-facing doc (this file is internal)

`backend/src/__tests__/billing-routes.test.ts` includes an automated
no-dollar-leak walker that asserts the rule across `/rates`, `/config`, and
`/status`. Keep it green.

The list prices in `tiers.ts` (`priceMonthly`, `priceYearly`, in integer cents)
are **display prices**, not COGS — those are allowed in API responses and are
explicitly excluded from the dollar-leak guard.

## The ladder

Per-model rates are derived from `pricing.prompt` / `pricing.completion` in the
RedPill catalog, snapped **up** to a 1–2–5-style ladder:

```
0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100,
150, 200, 250, 300, 400, 500, 600, 800, 1000, …
```

(values are credits per 1,000 tokens; the ladder extends geometrically in both
directions). Snapping UP guarantees `charged_rate ≥ upstream_cost` — margin by
construction. Rates are recomputed from the (5-minute cached) catalog on every
call; there is nothing persisted. The ladder is a code constant, not a config
knob — it is product semantics.

## Tier budgets (defaults + env overrides)

Resolved at call time by `creditBudgetFor(tier)` in `backend/src/billing/tiers.ts`.

| Tier | Env var | Default | Window | Internal COGS ceiling (do NOT publish) |
|---|---|---|---|---|
| Free | `CREDIT_BUDGET_FREE` | **500** | UTC day | ≤ $0.05/day worst-case (≈22 typical mini messages) |
| Plus | `CREDIT_BUDGET_PLUS_WEEKLY` | **12,000** | anchored 7-day window | ≈ $5/mo at 4.345 weeks/mo (≈50% of $10 revenue) |
| Pro  | `CREDIT_BUDGET_PRO_WEEKLY`  | **28,000** | anchored 7-day window | ≈ $12/mo (≈60% of $20 revenue) |

Invalid/non-positive overrides log a warning and fall back to the default — a
misconfigured env var must never zero out a user's budget. Empty string is
treated as unset (no warning).

The legacy `CREDIT_BUDGET_PLUS` / `CREDIT_BUDGET_PRO` env names (which used to
mean per-month) are intentionally **not read** — a stale monthly value left in
deploy config must never silently apply to the weekly window. Old envs are
ignored → defaults apply; call this out in deploy notes when rolling out.

## Per-turn budget checks

An agent chat turn is kept within the remaining credit budget. Two env vars control this:

| Env var | Values | Default | Effect |
|---|---|---|---|
| `AGENT_CHAT_BUDGET_STOP_MODE` | `finish_answer`, `hard_stop`, `predict_next_round`, `off` | `finish_answer` | In-turn check on usage frames. `finish_answer` finishes the answer in progress, bounded to one extra step. `hard_stop` stops at the first crossing. `predict_next_round` stops when accrued cost plus the last round's cost reaches the remaining budget. `off` disables the in-turn check. |
| `AGENT_CHAT_BUDGET_PREFLIGHT` | `log`, `enforce`, `off` | `log` | Check before a turn starts. `log` records the result only. `enforce` returns HTTP 402 `credit_budget_exceeded`. `off` skips the check. |

Invalid values log a warning and fall back to the default. A turn stopped by the in-turn check ends with the stream error code `budget_exhausted`; text produced before the stop remains visible.

The pre-flight minimum is the cost of one short turn at the turn's own model rates: 8,000 input and 1,000 output tokens (`minTurnCredits` in `backend/src/billing/turn-budget.ts`). On 2026-11-22 rates that is 150 credits on `z-ai/glm-5.2`, 31 on `qwen/qwen3.6-35b-a3b` and 390 on `moonshotai/kimi-k3`. A model without catalog pricing uses the fallback rates, so its minimum is 2,600. Ten controlled production turns on 2026-11-22 (TC-3734, free tier, no delegation) cost 4 to 110 credits: a short answer about 300 input tokens, a one-search turn about 2,000, a three-search research turn up to 3,775 input and 1,936 output. Every `z-ai/glm-5.2` turn stayed under its minimum; one `qwen/qwen3.6-35b-a3b` search turn wrote 2,266 output tokens and cost 39, above its 31. Turns that read private data were not measured and may cost more.

Every preflight evaluation also ships a structured `agent_chat_budget_preflight` event (mode, `would_block`, a remaining-credit bucket, tier, source, `account_hash`, `request_id`, and `unpriced: true` when the model had no catalog price and the 2,600 fallback minimum applied), so the share of turns under the minimum can be counted before `enforce` is chosen. See `docs/dev-logging.md`.

Every settled agent turn also ships an `agent_turn_settled` event (`raw_credits`, `charged`, `window_kind`, `outcome`, `started_attempts` on the Eliza task path, and `timeout_capped: true` on a timeout charged as a Stop past the free timeouts), with no IDs, so real per-turn cost can be compared with the per-turn minimum. See `docs/dev-logging.md`.

The two env vars above drive the in-turn monitor of the Eliza `/tasks` path only. Every path (including that one) is also bounded by the reply allowance below.

Agent turns settle observed credit usage before the success or provider-error terminal frame and before ending the response, so an immediate follow-up `/api/chat` request uses the updated usage and returns HTTP 402 `credit_budget_exceeded` when the budget is exhausted. Two orderings differ: `/api/chat` settles right after it ends the response, and an agent turn that times out has its `stream_error` and `[DONE]` written by the stream owner (on the deadline) before the handler settles.

## One reply, one allowance

A reply's **allowance** is the credits the account still had in its window when the reply was admitted (`limit − used`, or, when the ledger is authoritative, the ledger's `credit_limit` less the larger of its `committed_credits` and the local counter's `used`, since the ledger trails local settlements by up to one flush), less what the account's other replies in flight hold. It is read after the last await of admission, so a reply that settled meanwhile counts. An allowance of 0 or less is a 402 `credit_budget_exceeded` on every path (agent chat, its Eliza `/tasks` path, `/api/chat`), whether or not anything is held; the log's `source` is `held` when other replies hold credits, else `ledger` or `local`. The user is never charged above it, and never above what is left of that window when the reply settles.

- **Held from admission to settlement (TC-3488).** Admission holds the reply's allowance (`holdCredits` in `backend/src/billing/usage.ts`) and settlement releases it, so overlapping replies cannot each plan against the same credits. An agent reply holds everything left. An `/api/chat` request holds only what its prompt (its request JSON at the token estimate every path uses, `estimateTextTokens`; see Stop at the limit) and its output cap can cost, within what is left; its output is capped to fit (`max_tokens`) and to the model's context after the prompt, and a request whose prompt alone costs more than is left gets 402. The estimate is not an upper bound (digit runs and 4-byte characters count higher at the provider), so an `/api/chat` request is charged the provider's full count, not only its hold. Its charge is bounded by what the window had left at admission, less what other replies have settled since and what they hold when it settles, and is never bounded below its own hold (`chargeBound` in `backend/src/routes/chat.ts`). The bound keeps parallel requests within the window even when the local counter trails the ledger (after a restart), where the settlement's own window clamp would not. While other replies hold everything left, a new request gets 402 `credit_budget_exceeded` (logged with `source=held`). Each handler releases its hold after settlement, on every exit. A hold the handler never releases lapses at its expiry: a minute past the agent turn's wall cap (with the drain grace), 30 minutes for `/api/chat`. Holds are in memory, like the counter (see Single instance below).
- **Stop at the limit.** On the backend-orchestrated paths (`orchestrateToolCalling`: the existing tool loop and the meeting turn) every provider call is capped before it is made. A `ReplyBudget` (`backend/src/billing/reply-budget.ts`) prices the prompt from the request's JSON at the backend's token estimate (`measuredTokens` in `backend/src/billing/credits.ts`: the larger of UTF-8 bytes / 4 and the count of non-ASCII characters, so CJK text counts at least a token per character), subtracts the credits already spent in this reply across interpretation, tool rounds, synthesis and repair, and sends the rest as the provider `max_tokens` (never above a call's own cap). An estimate below the provider's count only costs the platform, because settlement still clamps the charge. When the allowance buys more output than the model's context leaves after the prompt (a Pro allowance is about a million tokens), the budget sets no cap; the turn-clock cap below still does. An unaffordable call is not made: the reply ends with `budget_exhausted`, and no tool runs after the allowance is used up. A `finish_reason: "length"` is a budget stop only when the budget's cap bound the call and the reply reached it or used up the allowance; a model stopping at its own limit with credits left ends normally. Text already streamed stays visible. Whether the provider counts reasoning tokens against `max_tokens` is model-specific; where it does not, only the settlement clamp bounds the charge.
- **Output capped to the turn clock (TC-4203).** On the same paths every provider call's `max_tokens` is also at most what the model streams in the turn time left at its normal speed, with 20% of that time kept for time to first token, tools and delivery (`backend/src/model-output-speed.ts`). A reply that would run past the clock at normal speed ends at the cap instead, keeps its text and is charged normally; a reply that still times out ran slower than normal, which is ours. The speeds are the median of OpenRouter's per-provider throughput for each offered model, read 2026-11-24 (Kimi K3 60, GLM 5.3 87, GLM 5.2 74, Qwen 3.6 35B 22 tokens/s; an unlisted model gets the slowest). RedPill declares no throughput, and these are not measurements of RedPill's endpoints (calibration: TC-4213).
- **A provider that ignores `max_tokens` is cut locally.** On the same paths, once a call's estimated streamed output (content, reasoning and tool-call text at the estimate above) passes its turn-clock cap, or twice its budget cap, before a usage frame arrives, the backend ends the call as `finish_reason: "length"` and forwards nothing more from it (`callCaps` and `callCut` in `backend/src/routes/agent-chat.ts`). The clock cap is used as is, because it already keeps 20% of the time in hand, so a call cut at normal speed still ends before the deadline (an honest provider streaming CJK, which the estimate counts high, can be cut a little early). The budget cap gets a 2× margin for the estimate's error, so a provider that honours it always stops first; settlement clamps the charge to the allowance anyway. The backend then reads the cut call for its usage frame, for at most 3 s and never past 500 ms before the turn's deadline (`CUT_DRAIN_MS`, `CUT_DEADLINE_MARGIN_MS`), and charges the provider's count; only a call that sends none in that time is charged its estimate (its request JSON and all streamed output). The reply completes normally. The Eliza `/tasks` path has neither the clock cap nor this cut (Eliza makes its own provider calls); it stays off (`ELIZA_TASKS_ENABLED`) until TC-4216 adds them.
- **Settle once.** `settleReply` (`backend/src/billing/settle.ts`) is the only place a reply becomes a charge (agent chat, Eliza tasks, `/api/chat`). It runs once per reply and charges `min(observed credits, allowance, what is left of the window the reply started in)`. Usage observed after the clamp, or above it, is platform cost: it appears only in the `[billing] reply settled` log line (`rawCredits` vs `charged`).
- **Failed replies: the model's failures are charged, ours are free.** A failed reply is charged (clamped as above), whether or not anything was delivered, only when the model's own output broke it: it kept calling a tool it was not offered until its rounds ran out (`routing_mismatch`; since TC-3463 such a call first gets a `tool_not_found` tool result, nothing is dispatched, and a reply the model then answers is an ordinary success), its tool calls never finished or did not parse (`upstream_incomplete` raised on its output; meeting interpretation that did not finish, or an invalid meeting plan, `interpretation_failed`), or its buffered meeting output went over its cap (`result_size_limit` there). On the Eliza `/tasks` path only its final codes `routing_mismatch` and `tool_attempt_limit` count as the model's; its other codes also cover provider and tool causes, so they are free. Every other failure is ours and is charged 0 with no ledger record, even after content was delivered: provider and network errors, a stream that ended early, an unverified receipt, an oversized tool result, our own limits and errors, and every `/api/chat` failure. The cause is set where each failure is raised (`StreamFailure.failureCause`), never inferred from the code; an unknown cause is ours. A reply stopped before any provider call used nothing and costs 0. A reply stopped at the limit after a provider call is charged even if nothing was delivered, so a free retry cannot loop at platform cost.
- **Timed-out replies are free, unless the client stopped reading, up to 10 a day (TC-4203).** The turn deadline is ours, so a timed-out reply (`turn_timeout`, or an Eliza task final `timed_out`) is charged 0 with no ledger record. The turn clock stops while the client is not reading (a write is waiting on backpressure), so a slow reader cannot run a turn out of time; a wall cap of twice the turn timeout still ends every turn. A turn that times out after the client stopped reading for more than half of it (a turn stalled for exactly half stays free), and after answer content was delivered, is charged as a Stop: its metered usage, clamped. Answer content counts as delivered once the socket accepted a content frame's first bytes, whether or not the client read them; error notices never count. A timeout that delivered no content is always free and is not counted. **Free timeouts are capped:** each account gets at most 10 free timeouts that delivered content per rolling 24 hours (`FREE_TIMEOUTS_PER_WINDOW` in `backend/src/billing/usage.ts`, in memory like the counter). The count is not persisted: every backend restart or deploy resets it, so an account can get up to 10 more free timeouts after each one. That is accepted: deploys are infrequent, and each free timeout is still bounded by the turn clock's output cap. Past the cap such a timeout settles as a Stop (metered on what was delivered, clamped), its `[billing] reply settled` line has `freeTimeoutCapped: true` and `outcome: "cancelled"`, and its `agent_turn_settled` event has `timeout_capped: true`.
- **A Stop is charged for what was used up to it (TC-3487).** A client-cancelled reply is charged its usage up to the Stop, clamped as above. On the backend-orchestrated paths a provider call whose usage frame has not arrived is metered while it streams: its request JSON and streamed output (content, reasoning and tool-call text, `streamedOutputText` in `backend/src/billing/credits.ts`) at the token estimate above (the larger of UTF-8 bytes / 4 and non-ASCII characters, so CJK text is not undercharged), replaced by the provider's count once the usage frame arrives. `/api/chat` charges the provider's count, or the same estimate when no usage frame arrived, over its messages' text (string content and the `text` of content parts) and the same streamed output text, reasoning included. The Eliza `/tasks` path charges the usage Eliza reports; the backend does not meter that path's provider calls itself (TC-4216).
- **Window at reply start.** The charge goes to the window the reply started in, clamped by what that window has left. The in-memory counter keeps the current window's record plus the one a rollover replaced (a tier switch moves a record aside the same way), so a reply admitted before a boundary and settled after it is charged against, and clamped by, the old window; a window that had no record at all used nothing and is charged from zero. Only when the previous slot already holds a different, newer window (rolled over twice) does no record describe it: the charge is then clamped to the allowance only and reaches the ledger alone. A settlement never overwrites another window's record. `settleReply` returns the window actually charged (`windowKind`, `windowStart`).
- **Oversized web search results are trimmed, not failed (TC-3464).** A `web_search` result over 64K characters is cut to 64K with the `[...truncated...]` marker and the reply continues (charged normally); only a response over its 256K read bound still ends the reply with `result_size_limit` (ours, free). Meeting reads still fail at their cap: their structured evidence cannot be cut.
- **One ledger record per reply.** The ledger `record_id` is the reply's execution id (generated per reply on every path), so a replayed enqueue is a no-op at the ledger.
- **`/api/chat` output is capped to its hold.** It sends `max_tokens` so its output cannot cost more than it holds; there is no other mid-stream stop. Its charge is bounded as in Held from admission to settlement, and its failures are free.

### Single instance

The in-memory usage counter, the admission holds, each reply's allowance and the settlement clamp assume **one backend instance**. With a second instance each keeps its own counter and holds, so the clamp can read stale and two replies on different instances could both be charged up to the limit. Running more than one instance is a design decision, not a config change: the fix would be an atomic conditional debit in the ledger. `backend/src/__tests__/single-instance-credit-counter.test.ts` fails if `docker-compose.phala.yml` defines more than one `tinychat-backend` or replicates it.

## Paid windows are anchored, not calendar

Paid tiers use a **rolling 7-day window anchored to the subscription's Stripe
`billing_cycle_anchor`** (stable across renewals — exactly "subscription date"
semantics). The window boundary is

```
windowStart = anchor + floor((now − anchor) / 7 days) × 7 days
windowEnd   = windowStart + 7 days
```

— pure epoch-ms arithmetic, DST/timezone-irrelevant by construction. Free still
runs on the UTC calendar day (unchanged).

**Anchor source** (`backend/src/billing/stripe.ts: billingAnchorIso`): tries
`subscription.billing_cycle_anchor` first, then falls back to
`current_period_start`, then `created`. The first two move with API-version
quirks, so the helper mirrors the same tolerance as `periodEndIso`. The anchor
is populated on `SubscriptionInfo.anchor` and carried through the 5-min
tier cache; routes thread it into `getUsage` / `isOverBudget` / `recordUsage`
as the `anchor` parameter (`null` for free).

**Missing anchor on a "week" tier** (shouldn't happen — the paid path always
sets it) is treated as `anchor = now` (window starts now; never wrongly locks
out a paying user) plus a one-shot `console.warn`. No silent zeroing.

**Anchor lives in Stripe (durable)**, so the window identity survives
redeploys even though the in-memory in-window counter does not. A redeploy
only forgives consumption within the current window — it cannot drift the
boundary.

## Where the numbers come from

- `creditsFor(rates, promptTokens, completionTokens)` —
  `ceil(prompt/1000 * creditsPerKInput + completion/1000 * creditsPerKOutput)`,
  minimum 1 credit when any tokens were consumed. Pure function in
  `backend/src/billing/credits.ts`.
- `estimateCredits(rates, messages, completionText)` — chars/4 fallback for
  when the upstream stream omitted the usage chunk.
- `multiplierFor(model, baseline)` — picker-badge ratio snapped UP to
  `[1, 2, 5, 10, 25, 50, 100]`; baseline = `REDPILL_DEFAULT_MODEL`'s output rate.
- Catalog gaps (no parseable `pricing`) fall back to a conservative
  `200 in / 1000 out` credits per 1K + a one-shot `console.warn` — never silent.

## Public surfaces

- `GET /api/billing/rates` — `{ baseline, models: [{ id, creditsPerKInput,
  creditsPerKOutput, multiplier }] }`. Public, no auth. Mirrors `/models`' 500/502
  error contract.
- `GET /api/billing/config` — `tiers[].creditBudget` (renamed from
  `tokenBudget`).
- `GET /api/billing/status` — `usage.used` / `usage.limit` are credits.
- `POST /api/chat` 402 — `{ error: "credit_budget_exceeded", … }`.
- `GET /api/chat/models` — each entry carries `creditsPerKInput`,
  `creditsPerKOutput`, `multiplier`.

All denominated in credits. No dollar fields, no peg.
