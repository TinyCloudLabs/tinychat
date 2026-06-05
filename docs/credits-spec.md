# Credits Spec — Cost-Normalized Metering for the Paywall

Status: IMPLEMENTED (2026-06-04; §3 paid-tier windows superseded by docs/weekly-windows-plan.md — weekly, anchored) · Branch: `feature/paywalls` · Depends on: the Stripe gating feature already in this branch

## 1. Problem & Summary

The current paywall meters **raw tokens** (`tiers.ts: tokenBudget`, `usage.ts: tokensUsed`). Models differ ~50–100× in upstream cost (gpt-5-mini completion $2/M vs claude-opus-4.1 completion $75/M — verified live from RedPill `/v1/models` `pricing`), so a flat token budget either bankrupts us on premium models or starves users on cheap ones.

**Fix:** meter in **credits** — a unit pegged internally to upstream dollar cost, with per-model rates *derived automatically* from RedPill's published pricing (no hand-maintained table), *snapped to a stable ladder* (predictable, absorbs upstream repricing), and *published* in-product (auditable: picker badges, per-message receipt, rates table).

Naming: the public unit is **"credit"** ("tinytoken" rejected — wallet-native audience would read it as a crypto token).

## 2. Definitions

### 2.1 The peg (internal only — NEVER shown in UI or API responses)

```
1 credit = $0.0001 of upstream (RedPill) cost   // PEG_USD = 1e-4
```

The peg, and any dollar amounts derived from it, must not appear in any API response, UI string, or public doc. Public rates are denominated in credits only (see §3 "don't publish COGS" rationale in the PR description).

### 2.2 Per-model rates (derived, snapped)

For each model in the RedPill catalog (`pricing.prompt` / `pricing.completion`, USD per token, string-encoded):

```
rawIn  = pricing.prompt     * 1000 / PEG_USD    // credits per 1K input tokens
rawOut = pricing.completion * 1000 / PEG_USD    // credits per 1K output tokens
creditsPerKInput  = niceCeil(rawIn)
creditsPerKOutput = niceCeil(rawOut)
```

`niceCeil(x)` snaps UP to the nearest value in a 1–2–5 style ladder:
`[0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, ...]`
(extend geometrically; values are credits per 1K tokens).

Examples (from live pricing, 2026-06):

| Model | raw in/out per 1K | snapped in/out |
|---|---|---|
| openai/gpt-5-nano | 0.5 / 4 | 0.5 / 4 |
| openai/gpt-5-mini | 2.5 / 20 | 2.5 / 20 |
| anthropic/claude-opus-4.1 | 150 / 750 | 150 / 800 |

Properties:
- **Charged = published.** Users are billed exactly the snapped rates shown in the table — receipts always match the table.
- **Stable.** A snapped rate only moves when upstream pricing crosses a ladder step. No persistence needed; recomputed from the (5-min cached) catalog on every use, but deterministic for given upstream prices.
- **Always ≥ cost** (rounding is up), so margin is protected by construction.

### 2.3 Cost of a message

From the SSE usage chunk (we already request `stream_options: { include_usage: true }`):

```
credits = ceil( promptTokens/1000 * creditsPerKInput
              + completionTokens/1000 * creditsPerKOutput )
```

Minimum charge 1 credit. **Both sides of this formula are computable by the frontend** (the usage chunk passes through to the browser byte-for-byte; rates come from the public rates endpoint) — that is what makes the receipt auditable without the backend injecting anything into the stream.

### 2.4 Multiplier badge

For UI intuition, each model gets a multiplier relative to the default model (`REDPILL_DEFAULT_MODEL`, gpt-5-mini):

```
multiplier = snapToLadder(creditsPerKOutput / baseline.creditsPerKOutput, [1, 2, 5, 10, 25, 50, 100])
```

(opus-4.1: 800/20 = 40 → "50×".) Snap UP. Shown as `1×`/`5×`/`50×` badges; rounding up keeps the badge honest ("at most this much faster than it says" never happens in the expensive direction... i.e. real burn ≤ badge implies).

### 2.5 Missing pricing fallback

Model in catalog without parseable pricing → conservative default `200 in / 1000 out` credits/1K (above opus), `multiplier = 100`, and `console.warn` once per model id per process. No silent free rides (CLAUDE.md: no graceful fallbacks that hide errors).

## 3. Tier budgets (ENV-CONFIGURABLE — decided 2026-06-04; weekly anchored 2026-06-04)

Budgets are read from env at tier-resolution time, with these defaults:

| Tier | Env var | Default | Window | Rationale (internal; do not publish) |
|---|---|---|---|---|
| Free | `CREDIT_BUDGET_FREE` | **500** | UTC day | ≤ $0.05/day worst-case COGS; ~22 typical gpt-5-mini messages/day |
| Plus ($10/mo) | `CREDIT_BUDGET_PLUS_WEEKLY` | **12,000** | anchored 7-day window | ≈ $5/mo COGS ceiling at 4.345 weeks/mo (≈50% of $10 revenue); preserves the prior monthly intent per-week |
| Pro ($20/mo) | `CREDIT_BUDGET_PRO_WEEKLY` | **28,000** | anchored 7-day window | ≈ $12/mo COGS ceiling (≈60% of $20 revenue); headroom for opus-class usage |

Paid windows are anchored to the subscription's Stripe `billing_cycle_anchor` (stable across renewals; falls back to `current_period_start`, then `created`). The window boundary is `anchor + floor((now − anchor)/7d) × 7d` — see §4.4. Free stays on a UTC calendar day. Invalid/non-positive env values → fall back to the default with a `console.warn` (misconfig must not zero out budgets). The peg and ladder remain **code constants** (product semantics, not deployment config).

**Env rename:** the legacy `CREDIT_BUDGET_PLUS` / `CREDIT_BUDGET_PRO` names (which used to mean per-month) are deliberately **not read** by the new resolver — a stale monthly value in deploy config must never silently apply to the weekly window. Old envs are ignored → defaults apply; call this out in deploy notes.

Model-allowance patterns per tier are **unchanged** (free: mini+haiku; plus: openai/+anthropic/; pro: everything incl. phala/*).

## 4. Backend changes

### 4.1 New: `backend/src/billing/catalog.ts`

Extract the model-catalog fetching + 5-min cache out of `routes/chat.ts` (currently `modelsCache` at chat.ts:27-38, fetch at chat.ts:270-300) into a shared module, now also retaining pricing:

```ts
interface CatalogModel { id: string; pricing: { prompt: number; completion: number } | null }
getCatalog(): Promise<CatalogModel[]>   // fetches RedPill /models, parses pricing strings, 5-min cache
_resetCatalogCache(): void              // test seam (replaces chat.ts _resetModelsCache)
```

Used by the chat router, the models annotation, and the new rates endpoint. Keep the existing error behavior (502 on upstream failure, 500 on missing REDPILL_API_KEY) at the route level.

### 4.2 New: `backend/src/billing/credits.ts`

Pure functions, fully unit-testable:

```ts
PEG_USD                                       // 1e-4 (internal constant)
niceCeil(x: number): number                   // ladder snap, §2.2
ratesForModel(m: CatalogModel): { creditsPerKInput; creditsPerKOutput; fallback: boolean }
multiplierFor(model: ModelRates, baseline: ModelRates): number   // §2.4
creditsFor(rates, promptTokens, completionTokens): number        // §2.3, min 1
estimateCredits(rates, messages, completionText): number
  // chars/4 estimate per side: prompt chars from messages, completion chars
  // from streamed text → priced through creditsFor. Replaces flat estimateTokens.
```

### 4.3 `backend/src/billing/tiers.ts`

- `tokenBudget` → **`creditBudget`**, resolved per §3: `creditBudgetFor(tier)` reads `CREDIT_BUDGET_{FREE,PLUS,PRO}` with defaults `500` / `50_000` / `120_000` (follow the existing `getPriceIds()` read-env-at-call-time pattern so tests can set env per-case).
- Doc comments updated (budgets are credits, not tokens). Everything else (patterns, price ids, cents) unchanged.

### 4.4 `backend/src/billing/usage.ts`

Mechanical rename: `tokensUsed` → `creditsUsed`, `estimateTokens` **moves** to `credits.ts` as `estimateCredits` (it needs rates now).

**Anchored-week window math.** Two pure helpers operate on epoch-ms (DST/timezone-irrelevant by construction, unlike the calendar-field UTC helpers):

```ts
export function startOfAnchoredWeek(anchor: number, now: number): number {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  return anchor + Math.floor((now - anchor) / WEEK) * WEEK;
}
export function startOfNextAnchoredWeek(anchor: number, now: number): number {
  return startOfAnchoredWeek(anchor, now) + 7 * 24 * 60 * 60 * 1000;
}
```

Future anchor (now < anchor): floor of a negative ratio still yields boundary ≤ now and reset > now — monotonic, no special case.

**Anchor threading.** Public signatures gain `anchor: number | null = null` immediately before `now`: `getUsage(address, tier, anchor, now)`, `isOverBudget(address, tier, anchor, now)`, `recordUsage(address, tier, credits, anchor, now)`. The free path passes `null` and is behaviorally byte-identical to the prior daily-window code path. `windowStart` / `windowReset` route on `budgetWindow`: "day" → UTC-day helpers (anchor ignored); "week" → anchored helpers.

**Warn-once fallback.** Missing anchor on "week" (shouldn't happen — `SubscriptionInfo.anchor` is populated for every paid tier) is treated as `anchor = now` (window starts now; never wrongly locks out a paying user) plus a one-shot `console.warn`. No silent zeroing.

The `UsageRecord.periodStart` rollover check works unchanged — the boundary is deterministic from `(anchor, now)`, so a new window mismatching the stored `periodStart` resets the counter as before.

### 4.5 `backend/src/routes/chat.ts`

- `UsageScanner`: capture `usage.prompt_tokens` and `usage.completion_tokens` (not just `total_tokens`). Keep accumulating `completionText` for the estimate fallback. Byte-for-byte passthrough guarantee unchanged.
- Gating block (chat.ts:134-169): same flow; `token_budget_exceeded` → **`credit_budget_exceeded`** (error code rename, see §6 contract v2); resolve the requested model's rates once, reject unknown-model ids that aren't in the catalog? **No** — keep current behavior (RedPill 502s on bad ids); rates fallback (§2.5) covers catalog gaps.
- Post-stream recording (chat.ts:240-246): `credits = scanner.hasUsage ? creditsFor(rates, prompt, completion) : estimateCredits(rates, messages, scanner.completionText)`; `recordUsage(address, TIERS[gatedTier], credits)`.
- `GET /models` annotation (chat.ts:314-323): each entry becomes
  `{ id, allowed, requiredTier?, creditsPerKInput, creditsPerKOutput, multiplier }`
  (rates/multiplier always present, even when paywall is off — the picker badges are harmless info either way; `allowed:true` for all when off, unchanged).

### 4.6 `backend/src/routes/billing.ts`

- `GET /config`: tier objects now carry `creditBudget` (key rename; `budgetWindow` etc. unchanged).
- **New** `GET /rates` (public, no auth — feeds the rates table and lets receipts be verified pre-sign-in):
  ```json
  { "baseline": "openai/gpt-5-mini",
    "models": [ { "id": "...", "creditsPerKInput": 2.5, "creditsPerKOutput": 20, "multiplier": 1 } ] }
  ```
  Served from the shared catalog; 502/500 behavior mirrors `/models`. NOTE: rates are denominated in credits only — no dollar fields (§2.1).
- `GET /status`: unchanged shape; `usage.used/limit` are now credits.

### 4.7 OpenAPI + env + docs

- `openapi.yaml`: rename budget fields, add `/api/billing/rates`, update 402 error enum, extend ModelInfo.
- `.env.example`: add `CREDIT_BUDGET_FREE`, `CREDIT_BUDGET_PLUS`, `CREDIT_BUDGET_PRO` (optional, documented defaults). Peg and ladder stay code constants (product semantics, not deployment config).
- `docs/stripe-setup.md`: update the usage-limitation section to say credits; Billing Meters follow-up note stays.
- **New** `docs/credits.md`: internal economy doc — peg, ladder, budget rationale (the §3 table), and the explicit rule that the peg is never published.

## 5. Frontend changes

### 5.1 `frontend/src/lib/billingApi.ts`

- `BillingTier.tokenBudget` → `creditBudget`; add `getRates(): Promise<RatesResponse>` (public route, cache for session in the caller).
- Formatting: `formatTokenBudget`/`formatBudgetWithWindow` → `formatCreditBudget` (`50_000` → "50K credits", window suffix logic kept); add `formatCredits(n)` for receipts ("1,240 credits"). `formatPrice` unchanged (still cents).

### 5.2 `frontend/src/lib/chatApi.ts`

- The SSE parse loop additionally captures the usage chunk (`prompt_tokens`, `completion_tokens`, empty `choices`) and exposes it to the caller when the stream completes (e.g. via an `onUsage` callback option or a final yielded sentinel — pick whichever fits the existing generator shape with the smallest diff; do NOT change the cumulative-text yield contract that runtime.tsx depends on).
- `PaywallError`: error code `token_budget_exceeded` → `credit_budget_exceeded`.

### 5.3 Receipt plumbing (decided 2026-06-04: always-on per-message footer)

- `chat/runtime.tsx` (SURGICAL — do not disturb persistence/flashing fixes): when a stream finishes with usage data, compute `credits = creditsFor(rates, prompt, completion)` using a tiny frontend mirror of `creditsFor`/`niceCeil` placed in `billingApi.ts` (≈15 lines; duplication accepted — frontend/backend don't share a package, and the receipt deliberately re-derives the charge from public data, that's the audit) and emit `{ type: 'receipt', messageId, credits, modelId }` on the existing paywall-event emitter (extend it to a general billing-event emitter; paywall events keep their current shape).
- Receipt store: a module-level `Map<assistantMessageId, credits>` + subscribe hook (in `billingApi.ts` or a tiny `lib/receipts.ts`), populated from the emitter. Session-scoped: messages from before a reload have no receipt (persisting receipts into thread payloads is the v2 follow-up, §9).
- `App.tsx`: on receipt event — optimistically add to the local `billingStatus.usage.used`. No status refetch per message (refetch points stay as-is: dialog-open, `?billing=success`, 402).
- `chat/Thread.tsx`: **always-on footer** on each assistant message — a muted, small-type line (e.g. "340 credits") rendered with/next to the existing per-message ActionBar, present whenever the receipt map has that message id, absent otherwise. Must not shift message layout while streaming (appears only on completion).
- **Input/output split (both footers):** one exchange registers two receipt entries. `inputCredits = clamp(round(promptTokens/1000 × creditsPerKInput), 0, total)` is stored on the **user message** (footer right-aligned under the user bubble, with title/aria-label "Input cost — includes conversation context" since the prompt re-sends prior turns); `outputCredits = total − inputCredits` is stored on the **assistant message**. The split is **sum-exact**: `inputCredits + outputCredits === total` always, where `total = creditsFor(rates, prompt, completion)` is what the meter records. App.tsx's optimistic usage bump consumes a single `receipt` event carrying `total`, so the charge is counted exactly once (never per-side).

### 5.4 Model picker (`App.tsx` ModelPicker)

- Each option shows its multiplier badge (`1×` hidden, `2×`+ shown) next to the existing lock/requiredTier affordance. When paywall is off: badges still shown (informational), locks absent (unchanged).
- **First-switch nudge:** selecting a model with `multiplier ≥ 10` for the first time (localStorage flag `xyz.tinycloud.tinychat:high-burn-ack`) shows a one-time inline confirm: "This model uses credits ~{N}× faster than {baseline name}. [Rates] [OK]".

### 5.5 Transparency surfaces

- **UsageIndicator** (header chip): unchanged percent bar; tooltip/expanded state shows real numbers — "12,400 / 50,000 credits · resets {date}" + link "How credits work".
- **Receipt:** always-on per-message footer under assistant messages (§5.3). Not persisted into thread payloads (v2 candidate).
- **New `chat/RatesDialog.tsx`:** dialog (reuse `ui/dialog.tsx`) with the rates table — columns: Model, multiplier badge, credits/1K input, credits/1K output; baseline row pinned first; sorted by multiplier then id. Data from `getRates()`. Footer note: "Charged exactly as listed. Rates may change when provider pricing changes." Opened from: UsageIndicator link, PricingDialog footer link, picker nudge.
- **PricingDialog:** budgets render via `formatCreditBudget` ("50K credits/mo"); add footer link "How credits work →" opening RatesDialog. Tier copy stays provider-agnostic.

## 6. API contract v2 (delta from v1 — pre-launch, no back-compat shims)

| Surface | Change |
|---|---|
| `GET /api/billing/config` | `tiers[].tokenBudget` → `tiers[].creditBudget`; `tiers[].budgetWindow` enum `"day" \| "month"` → `"day" \| "week"` (paid tiers now `"week"`); paid `creditBudget` defaults 50_000→**12_000** (plus), 120_000→**28_000** (pro) |
| `GET /api/billing/rates` | NEW, public: `{ baseline, models: [{ id, creditsPerKInput, creditsPerKOutput, multiplier }] }` |
| `GET /api/billing/status` | shape unchanged; `usage.used`/`usage.limit` now credits; `usage.resetsAt` for paid tiers is the next anchored-week boundary (free still next UTC midnight) |
| `POST /api/chat` 402 | `token_budget_exceeded` → `credit_budget_exceeded`; `usage` payload now credits; `usage.resetsAt` anchor-derived for paid tiers |
| `GET /api/chat/models` | entries gain `creditsPerKInput`, `creditsPerKOutput`, `multiplier` (always present) |
| Env vars | paid budgets resolved from `CREDIT_BUDGET_{PLUS,PRO}_WEEKLY` (renamed from `CREDIT_BUDGET_{PLUS,PRO}`); legacy names are ignored — defaults apply |

Everything else (checkout, portal, webhook, `model_not_allowed`, cents prices) unchanged.

## 7. Edge cases

- **No usage chunk from upstream** → `estimateCredits` (chars/4 per side, priced) — same fallback philosophy as today, now cost-aware.
- **Reasoning models** bill thinking tokens inside `completion_tokens` — automatically priced correctly; this is precisely why receipts (not predictions) are the transparency contract. RatesDialog footer should NOT promise per-message predictability.
- **Catalog fetch fails mid-gating** → surface the error (500), as `resolveTier` failures do today. Exception: post-stream recording must not throw after bytes were served — on rates failure there, record via fallback rates and `console.error`.
- **Memory-extraction `completeChat`** shares the budget and the 402 path (unchanged, accepted in the prior phase). Its costs now correctly meter as cheap-model credits.
- **Paywall off** → no gating, no recording (unchanged); badges/rates remain visible as informational UI, receipts suppressed (no budget to reconcile against — receipt without a meter is noise).
- **Frontend/backend credit drift**: both compute from the same published rates + same usage chunk, so receipts match server accounting except across a rate change mid-flight (5-min catalog cache skew) — accept; magnitude is one ladder step on one message.
- **Upgrade mid-window** (free→plus/pro or plus→pro): Stripe may keep or shift `billing_cycle_anchor`. The webhook invalidates the tier cache; on the next request the new anchor produces a new window boundary, so `UsageRecord.periodStart` mismatches and the counter resets for the new window. This errs user-favorably (the user is never charged twice for the same week) and is the documented expected behavior.
- **Cancellation mid-week**: `resolveTier` flips to `free` on the next cache miss (or webhook), and the daily UTC window applies immediately (paid weekly → free daily revert). The paid weekly counter is discarded with the subscription; no carry-over.
- **Redeploy**: the anchor is re-fetched from Stripe (durable), so window identity survives even when the in-memory counter does not — only the in-window count is forgiven (existing accepted caveat from the stateless-by-design tracker).

## 8. Tests

Backend (extend the 6 existing billing test files):
- `credits.ts`: niceCeil ladder boundaries; ratesForModel vs known pricing fixtures (mini, nano, opus); fallback path + warn; creditsFor rounding/min-1; estimateCredits; multiplier snapping (40→50).
- `catalog.ts`: pricing string parsing, cache, unparseable pricing → null.
- Gating: 402 `credit_budget_exceeded` shape; recording uses prompt/completion split (fixture SSE with usage chunk); estimate path when chunk absent.
- Routes: `/rates` shape, public (no auth), no dollar-denominated fields anywhere in any response (explicit assertion — guards the §2.1 rule); `/config` creditBudget rename; models annotation includes rates always.
- All 67 existing tests updated/passing.

Frontend: build green (`bun --bun run build:frontend`); unit-test the mirrored `creditsFor`/`niceCeil` if a frontend test rig exists (none today — skip rather than introduce one).

## 9. Out of scope / follow-ups

- Durable usage (Stripe Billing Meters) — unchanged follow-up.
- Persisting receipts into thread payloads (would survive reload; v2).
- Public marketing/economy page on the landing site (RatesDialog content is the source).
- Budget top-ups / pay-as-you-go beyond the subscription.

## 10. Resolved knobs (user decisions, 2026-06-04)

1. **Tier budgets**: env-configurable (`CREDIT_BUDGET_*`) with 500/50K/120K defaults — §3.
2. **Budget display**: K/M abbreviations ("50K credits") — approved.
3. **Receipt visibility**: always-on per-message footer under assistant messages — §5.3.

Status: APPROVED FOR BUILD.
