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

The two env vars above drive the in-turn monitor of the Eliza `/tasks` path only. Every path (including that one) is also bounded by the reply allowance below.

Agent turns settle observed credit usage before the success or provider-error terminal frame and before ending the response, so an immediate follow-up `/api/chat` request uses the updated usage and returns HTTP 402 `credit_budget_exceeded` when the budget is exhausted. Two orderings differ: `/api/chat` settles right after it ends the response, and an agent turn that times out has its `stream_error` and `[DONE]` written by the stream owner (on the deadline) before the handler settles.

## One reply, one allowance

A reply's **allowance** is the credits the account still had in its window when the reply was admitted (`limit − used`, or the ledger's `credit_limit − committed_credits` when the ledger is authoritative). The user is never charged above it, and never above what is left of that window when the reply settles.

- **Stop at the limit.** On the backend-orchestrated paths (`orchestrateToolCalling`: the existing tool loop and the meeting turn) every provider call is capped before it is made. A `ReplyBudget` (`backend/src/billing/reply-budget.ts`) prices the prompt from the request's JSON length (3 chars per token: an overestimate for English and JSON, but an UNDERestimate for scripts that take about a token or more per character, such as CJK, where the cap is then too high; that only costs the platform because settlement still clamps the charge), subtracts the credits already spent in this reply across interpretation, tool rounds, synthesis and repair, and sends the rest as the provider `max_tokens` (never above a call's own cap). When the allowance buys more output than the model's context leaves after the prompt (a Pro allowance is about a million tokens), no `max_tokens` is sent, as before this feature. An unaffordable call is not made: the reply ends with `budget_exhausted`, and no tool runs after the allowance is used up. A `finish_reason: "length"` is a budget stop only when the budget's cap bound the call and the reply reached it or used up the allowance; a model stopping at its own limit with credits left ends normally. Text already streamed stays visible. Whether the provider counts reasoning tokens against `max_tokens` is model-specific; where it does not, only the settlement clamp bounds the charge.
- **Settle once.** `settleReply` (`backend/src/billing/settle.ts`) is the only place a reply becomes a charge (agent chat, Eliza tasks, `/api/chat`). It runs once per reply and charges `min(observed credits, allowance, what is left of the window the reply started in)`. Usage observed after the clamp, or above it, is platform cost: it appears only in the `[billing] reply settled` log line (`rawCredits` vs `charged`).
- **Free when nothing was delivered.** A reply that fails before any answer content reached the user (error notices do not count) is charged 0 and writes no ledger record. A reply stopped before any provider call used nothing and costs 0. A reply stopped at the limit after a provider call is charged even if nothing was delivered, so a free retry cannot loop at platform cost. A timed-out reply is charged what it used, at most its allowance, with or without output. A client-cancelled reply is charged like a finished one.
- **Window at reply start.** The charge goes to the window the reply started in, clamped by what that window has left. The in-memory counter keeps the current window's record plus the one a rollover replaced, so a reply admitted before a boundary and settled after it is charged against, and clamped by, the old window. A window older than both (rolled over twice) has no record: the charge is clamped to the allowance only and reaches the ledger alone. `settleReply` returns the window actually charged (`windowKind`, `windowStart`).
- **One ledger record per reply.** The ledger `record_id` is the reply's execution id (generated per reply on every path), so a replayed enqueue is a no-op at the ledger.
- **No mid-stream stop on `/api/chat`.** It is clamped and free on early failure, but it has no allowance-based `max_tokens` cap (only its client-supplied `max_output_tokens`).

### Single instance

The in-memory usage counter, each reply's allowance and the settlement clamp assume **one backend instance** (see `docs/connector-webhooks-single-instance.md`). With a second instance each keeps its own counter, so the clamp can read stale and two replies on different instances could both be charged up to the limit. Running more than one instance is a design decision, not a config change: the fix would be an atomic conditional debit in the ledger. `backend/src/__tests__/single-instance-credit-counter.test.ts` fails if `docker-compose.phala.yml` defines more than one `tinychat-backend` or replicates it.

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
