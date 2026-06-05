# Implementation Plan: Weekly Anchored Credit Windows for Paid Tiers

Status: IMPLEMENTED (2026-06-04: budgets 12K/28K weekly; env rename to _WEEKLY; anchor chain billing_cycle_anchor→current_period_start→created) · Branch: `feature/paywalls` · Supersedes the calendar-month windows in credits-spec.md §3 for paid tiers.

## Open decisions for the user (resolve before build)

1. **Budget numbers (weekly).** Current monthly defaults are 50,000 (Plus) / 120,000 (Pro). A calendar month averages 4.345 weeks. Two options:
   - **(A) Keep monthly totals roughly equivalent** → Plus **12,000/wk**, Pro **28,000/wk** (slightly more generous annualized).
   - **(B) Fresh clean weekly numbers**, e.g. Plus 10,000/wk, Pro 25,000/wk (tighter COGS).
   - **Recommendation: (A) 12,000 / 28,000** — preserves the existing COGS ceiling intent per-week. Free stays **500/day**.

2. **Env var rename.** `CREDIT_BUDGET_PLUS`/`_PRO` currently mean per-month; reusing them with per-week meaning is a silent-misconfiguration trap. **Recommendation: rename to `CREDIT_BUDGET_PLUS_WEEKLY` / `CREDIT_BUDGET_PRO_WEEKLY`** (old names ignored → defaults apply, called out in deploy notes).

3. **Anchor source.** `billing_cycle_anchor` (stable across renewals — exactly "subscription date" semantics), falling back to `current_period_start`, then `created`. Confirm fallback chain OK.

## 1. Anchor source & flow

- Use Stripe `billing_cycle_anchor` (subscription-level, stable across renewals). NOT `current_period_start` (moves every renewal — weekly windows would jump per invoice). `created` = last-resort fallback.
- New helper `billingAnchorIso(sub)` in `backend/src/billing/stripe.ts`, mirroring the API-version tolerance of the existing `periodEndIso` (stripe.ts:153-159).
- Flow: `fetchTierFromStripe` populates `SubscriptionInfo.anchor` (next to `currentPeriodEnd`, stripe.ts:26-31) → 5-min cache carries it (CacheEntry extends TierResolution) → routes pass it to usage fns. `FREE_RESOLUTION` → null. Co-locating in `SubscriptionInfo` keeps the "paid ⇒ has anchor" invariant structurally obvious. Do NOT expose in frontend `BillingSubscription` (UI only needs `usage.resetsAt`).

## 2. Budgets & env semantics (`tiers.ts`)

- `TIERS.plus`: creditBudget 50_000 → 12_000, budgetWindow "month" → "week" (tiers.ts:82-83).
- `TIERS.pro`: 120_000 → 28_000, "month" → "week" (tiers.ts:92-93). Free unchanged.
- `BudgetWindow` type (tiers.ts:15): `"day" | "month"` → `"day" | "week"` (drop month — no tier uses it).
- `creditBudgetFor` (tiers.ts:108-121): env key = `CREDIT_BUDGET_FREE` for free, `CREDIT_BUDGET_${TIER}_WEEKLY` for paid. Old `CREDIT_BUDGET_PLUS`/`_PRO` envs silently ignored → defaults used (deploy note). Invalid-value warn-fallback unchanged.

## 3. usage.ts — anchored-week math

New pure helpers (epoch-ms arithmetic — DST/timezone-irrelevant by construction, unlike the calendar-field UTC helpers):

```ts
export function startOfAnchoredWeek(anchor: number, now: number): number {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  return anchor + Math.floor((now - anchor) / WEEK) * WEEK;
}
export function startOfNextAnchoredWeek(anchor: number, now: number): number {
  return startOfAnchoredWeek(anchor, now) + 7 * 24 * 60 * 60 * 1000;
}
```

- Future anchor (now < anchor): floor of negative ratio still yields boundary ≤ now, reset > now — monotonic, no special case (test it).
- Signatures gain `anchor: number | null = null` (before `now`): `getUsage(address, tier, anchor, now)`, `isOverBudget(...)`, `recordUsage(address, tier, credits, anchor, now)`. Free path passes null and is behaviorally unchanged.
- `windowStart`/`windowReset` route on budgetWindow: "day" → UTC-day fns (anchor ignored); "week" → anchored fns.
- Missing anchor on "week" (shouldn't happen): treat anchor = now (window starts now; never wrongly locks out) + one-shot console.warn. No silent zeroing.
- `UsageRecord.periodStart` rollover check (usage.ts:91,101) works unchanged — boundary deterministic from (anchor, now).

## Edge cases (all handled by stateless design)

- **Upgrade mid-window**: Stripe may keep or reset the anchor; webhook invalidates cache; if anchor shifts, periodStart mismatch → counter resets for new window. Errs user-favorable; document as expected.
- **Cancellation mid-week**: resolveTier → free → daily window immediately on next cache miss/webhook. Same as today's month→day revert.
- **Redeploy**: anchor re-fetched from Stripe (durable), window identity survives; only in-window count forgiven (existing accepted caveat).

## 4. Contract impact

| Surface | Change |
|---|---|
| `GET /api/billing/config` | `budgetWindow` "month" → "week" for paid; creditBudget 50000→12000, 120000→28000 |
| `GET /api/billing/status` | `usage.resetsAt` = next anchored-week boundary (shape unchanged) |
| 402 `credit_budget_exceeded` | shape unchanged; resetsAt anchor-derived |
| models/checkout/portal/webhook | unchanged |

- `openapi.yaml`: budgetWindow enum [day, month] → [day, week] (line ~573); resetsAt description; env mentions.
- `frontend/src/lib/billingApi.ts`: budgetWindow type → "day"|"week" (line 14); `formatCreditBudgetWithWindow` → "/wk" (lines 123-130). PricingDialog renders automatically (line 262); App.tsx formatResetsAt (742-753) works as-is.

## 5. Docs

- credits-spec.md §3 (table: weekly anchored, 12K/28K, _WEEKLY env names), §4.4 (anchored-week design), §6 (contract rows), §7 (upgrade/cancel edge bullets).
- credits.md tier table + anchor prose; stripe-setup.md tiers table (per week, anchored) + usage-limitation note.
- backend/.env.example: `# CREDIT_BUDGET_PLUS_WEEKLY=12000`, `# CREDIT_BUDGET_PRO_WEEKLY=28000` (per-week comment).
- usage.ts header: note anchor sourced from Stripe (durable) so window identity survives redeploys.

## 6. Test plan

- billing-usage.test.ts: keep day/free tests untouched (regression guard); replace month tests with: anchored-week boundaries (anchor mid-week), exactly-on-boundary (now==anchor; now==anchor+7d), multi-week elapsed, future anchor, DST-straddling 7×86.4e6ms assertion, rollover (used resets, resetsAt +7d), isOverBudget w/ _WEEKLY env override.
- billing-tiers.test.ts: new values/window; env tests use _WEEKLY keys.
- billing-stripe.test.ts: fixture gains billing_cycle_anchor; assert anchor ISO; fallback cases (current_period_start only; created only); cache round-trips anchor.
- billing-routes.test.ts: /status resetsAt == anchored boundary; config values; no-dollar-leak walker stays green.
- chat-gating.test.ts: paid gating with anchor; exhaust weekly budget → 402 w/ anchored resetsAt; free tests unchanged.
- Frontend: build green (no test rig).

## 7. Atomic tasks (backend math → resolution → routes → frontend → docs)

1. **week-math**: usage.ts anchored helpers + window routing (no public signature change) + math tests.
2. **tiers**: budgets/window/env-key rename + tiers tests. (1∥2 parallelizable)
3. **usage-signatures**: thread anchor through public fns + warn-once fallback + test callers.
4. **stripe-anchor**: billingAnchorIso + SubscriptionInfo.anchor + cache + stripe tests. (independent of 1-3)
5. **wire-routes**: chat.ts gating/recording + billing.ts /status + gating/routes tests. (needs 3+4)
6. **contract**: openapi.yaml + .env.example.
7. **frontend**: billingApi types + "/wk" formatting; verify dialogs; build green.
8. **docs**: spec/credits/stripe-setup + usage.ts header note.
