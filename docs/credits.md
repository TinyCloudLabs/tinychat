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
