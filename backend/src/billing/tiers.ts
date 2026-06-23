// ── Tier configuration ───────────────────────────────────────────────────────
// Single source of truth for the TinyChat subscription tiers.
//
// Tiers gate which RedPill models a user may call and how many credits they
// may consume per billing window. Model allowance is decided by prefix
// matching against the requested model id (e.g. "anthropic/claude-opus-4.8"
// matches the "anthropic/" pattern). Display prices live here only for the
// pricing UI — the real charge amounts are configured in the Stripe dashboard
// and referenced by the price-id env vars below. Per-tier credit budgets are
// env-overridable via `creditBudgetFor`: free → CREDIT_BUDGET_FREE; paid →
// CREDIT_BUDGET_{PLUS,PRO}_WEEKLY. The legacy CREDIT_BUDGET_PLUS/_PRO names
// (which used to mean per-month) are intentionally ignored so a stale monthly
// value left in deploy config can't silently apply to the new weekly window.

export type TierId = "free" | "plus" | "pro";
export type PaidTierId = "plus" | "pro";
export type Interval = "monthly" | "yearly";
export type BudgetWindow = "day" | "week";

export interface PaidPriceIds {
  monthly: string | undefined;
  yearly: string | undefined;
}

export interface TierConfig {
  id: TierId;
  name: string;
  /**
   * Display price for the monthly plan in integer CENTS (UI only; null for
   * free). The frontend divides by 100 to render dollars. Cents keep this
   * consistent with Stripe, whose price `unit_amount` is also in cents.
   */
  priceMonthly: number | null;
  /** Display price for the yearly plan in integer CENTS (UI only; null for free). */
  priceYearly: number | null;
  /**
   * Default credit allowance per budget window. Authoritative resolution must
   * go through `creditBudgetFor(tier)`, which honours env overrides
   * (CREDIT_BUDGET_FREE for free, CREDIT_BUDGET_{PLUS,PRO}_WEEKLY for paid);
   * this field is just the fallback default.
   */
  creditBudget: number;
  /**
   * Window the budget resets on: free = UTC day; paid = anchored 7-day window
   * pinned to the subscription's Stripe billing_cycle_anchor.
   */
  budgetWindow: BudgetWindow;
  /**
   * Model id prefixes this tier may call. A requested model is allowed when it
   * starts with any pattern in this list. "" (empty) would match everything;
   * we keep patterns explicit instead.
   */
  modelPatterns: string[];
}

// ── Stripe price ids (from env; placeholders until the dashboard is set up) ───

export function getPriceIds(): Record<PaidTierId, PaidPriceIds> {
  return {
    plus: {
      monthly: process.env.STRIPE_PRICE_PLUS_MONTHLY,
      yearly: process.env.STRIPE_PRICE_PLUS_YEARLY,
    },
    pro: {
      monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
      yearly: process.env.STRIPE_PRICE_PRO_YEARLY,
    },
  };
}

// ── Tier definitions ──────────────────────────────────────────────────────────

export const TIERS: Record<TierId, TierConfig> = {
  // Verifiable-inference product: every tier can use ALL offered (TEE) models —
  // non-TEE models aren't offered at all. The offered-model gate (PICKER_MODELS)
  // already restricts which ids are reachable, so each tier matches all offered
  // models and differs ONLY by credit budget.
  free: {
    id: "free",
    name: "Free",
    priceMonthly: null,
    priceYearly: null,
    creditBudget: 500,
    budgetWindow: "day",
    // All offered models; differs from paid tiers only by credit budget.
    modelPatterns: [""],
  },
  plus: {
    id: "plus",
    name: "Plus",
    priceMonthly: 1000, // $10.00/mo, in cents
    priceYearly: 9600, // $96.00/yr, in cents
    creditBudget: 12_000,
    budgetWindow: "week",
    modelPatterns: [""],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 2000, // $20.00/mo, in cents
    priceYearly: 19200, // $192.00/yr, in cents
    creditBudget: 28_000,
    budgetWindow: "week",
    modelPatterns: [""],
  },
};

// ── Env-configurable credit budgets (spec §3, §4.3) ──────────────────────────

/**
 * Resolve the credit budget for a tier, honouring the optional env overrides:
 * `CREDIT_BUDGET_FREE` for free; `CREDIT_BUDGET_{PLUS,PRO}_WEEKLY` for paid.
 * The legacy `CREDIT_BUDGET_PLUS` / `CREDIT_BUDGET_PRO` names (which meant
 * per-month) are deliberately not read — a stale monthly value left in deploy
 * config must not silently apply to the weekly window. Read at call time
 * (same pattern as `getPriceIds`) so tests can flip env vars per-case.
 * Invalid or non-positive values log a warning and fall back to the tier's
 * default; misconfig must not zero out budgets.
 */
export function creditBudgetFor(tier: TierId): number {
  const envKey =
    tier === "free" ? "CREDIT_BUDGET_FREE" : `CREDIT_BUDGET_${tier.toUpperCase()}_WEEKLY`;
  const fallback = TIERS[tier].creditBudget;
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[billing] invalid ${envKey}=${JSON.stringify(raw)}; falling back to default ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(parsed);
}

/** Order from least to most privileged. Used to pick the minimum required tier. */
export const TIER_ORDER: TierId[] = ["free", "plus", "pro"];

// ── Model allowance ───────────────────────────────────────────────────────────

/** True when the given tier may call the given model id. */
export function isModelAllowed(tier: TierId, modelId: string): boolean {
  return matchesAnyPattern(modelId, TIERS[tier].modelPatterns);
}

function matchesAnyPattern(modelId: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pattern === "" || modelId.startsWith(pattern));
}

/**
 * The lowest tier that is allowed to call the given model, or null when no tier
 * can (shouldn't happen — "pro" matches everything). Used to annotate models
 * with the `requiredTier` a caller would need to upgrade to.
 */
export function requiredTierForModel(modelId: string): TierId | null {
  for (const tier of TIER_ORDER) {
    if (isModelAllowed(tier, modelId)) return tier;
  }
  return null;
}

// ── Price-id ↔ tier mapping ───────────────────────────────────────────────────

export interface PriceResolution {
  tier: PaidTierId;
  interval: Interval;
}

/** Map a Stripe price id back to its tier + interval, or null when unknown. */
export function tierForPriceId(priceId: string): PriceResolution | null {
  const ids = getPriceIds();
  for (const tier of ["plus", "pro"] as PaidTierId[]) {
    if (ids[tier].monthly && ids[tier].monthly === priceId) return { tier, interval: "monthly" };
    if (ids[tier].yearly && ids[tier].yearly === priceId) return { tier, interval: "yearly" };
  }
  return null;
}

/** Resolve the configured Stripe price id for a tier + interval, or null. */
export function priceIdFor(tier: PaidTierId, interval: Interval): string | null {
  const ids = getPriceIds();
  return ids[tier][interval] ?? null;
}
