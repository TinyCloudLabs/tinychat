import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  TIERS,
  creditBudgetFor,
  isModelAllowed,
  priceIdFor,
  requiredTierForModel,
  tierForPriceId,
} from "../billing/tiers.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.STRIPE_PRICE_PLUS_MONTHLY = "price_plus_m";
  process.env.STRIPE_PRICE_PLUS_YEARLY = "price_plus_y";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_y";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("tier config", () => {
  test("display prices are integer cents", () => {
    expect(TIERS.free.priceMonthly).toBeNull();
    expect(TIERS.plus.priceMonthly).toBe(1000);
    expect(TIERS.plus.priceYearly).toBe(9600);
    expect(TIERS.pro.priceMonthly).toBe(2000);
    expect(TIERS.pro.priceYearly).toBe(19200);
  });

  test("credit budgets and windows", () => {
    expect(TIERS.free.creditBudget).toBe(500);
    expect(TIERS.free.budgetWindow).toBe("day");
    expect(TIERS.plus.creditBudget).toBe(12_000);
    expect(TIERS.plus.budgetWindow).toBe("week");
    expect(TIERS.pro.creditBudget).toBe(28_000);
    expect(TIERS.pro.budgetWindow).toBe("week");
  });
});

describe("creditBudgetFor (env overrides)", () => {
  test("defaults when env unset", () => {
    delete process.env.CREDIT_BUDGET_FREE;
    delete process.env.CREDIT_BUDGET_PLUS_WEEKLY;
    delete process.env.CREDIT_BUDGET_PRO_WEEKLY;
    expect(creditBudgetFor("free")).toBe(500);
    expect(creditBudgetFor("plus")).toBe(12_000);
    expect(creditBudgetFor("pro")).toBe(28_000);
  });

  test("honours valid positive env override", () => {
    process.env.CREDIT_BUDGET_FREE = "750";
    process.env.CREDIT_BUDGET_PLUS_WEEKLY = "15000";
    process.env.CREDIT_BUDGET_PRO_WEEKLY = "40000";
    expect(creditBudgetFor("free")).toBe(750);
    expect(creditBudgetFor("plus")).toBe(15_000);
    expect(creditBudgetFor("pro")).toBe(40_000);
  });

  test("reads env at call time (not module load)", () => {
    delete process.env.CREDIT_BUDGET_FREE;
    expect(creditBudgetFor("free")).toBe(500);
    process.env.CREDIT_BUDGET_FREE = "1234";
    expect(creditBudgetFor("free")).toBe(1234);
    delete process.env.CREDIT_BUDGET_FREE;
    expect(creditBudgetFor("free")).toBe(500);
  });

  test("invalid env falls back to default with a warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.CREDIT_BUDGET_PLUS_WEEKLY = "not-a-number";
      expect(creditBudgetFor("plus")).toBe(12_000);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("non-positive env falls back to default with a warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.CREDIT_BUDGET_PRO_WEEKLY = "0";
      expect(creditBudgetFor("pro")).toBe(28_000);
      process.env.CREDIT_BUDGET_PRO_WEEKLY = "-1000";
      expect(creditBudgetFor("pro")).toBe(28_000);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("empty string is treated as unset (no warning)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.CREDIT_BUDGET_FREE = "";
      expect(creditBudgetFor("free")).toBe(500);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("legacy CREDIT_BUDGET_PLUS / CREDIT_BUDGET_PRO env names are ignored", () => {
    // Old per-month env vars must not silently apply to the new weekly window —
    // a stale 50_000 monthly value left in deploy config would otherwise mean
    // 4× the intended weekly budget. The new vars are *_WEEKLY only.
    delete process.env.CREDIT_BUDGET_PLUS_WEEKLY;
    delete process.env.CREDIT_BUDGET_PRO_WEEKLY;
    process.env.CREDIT_BUDGET_PLUS = "99999";
    process.env.CREDIT_BUDGET_PRO = "99999";
    expect(creditBudgetFor("plus")).toBe(12_000);
    expect(creditBudgetFor("pro")).toBe(28_000);
  });
});

describe("model allowance (prefix matching)", () => {
  // Verifiable-inference product: every tier may call ALL verifiable (phala/*)
  // models and NO non-phala/* model. Tiers differ only by credit budget.
  test("every tier allows phala/* models", () => {
    for (const tier of ["free", "plus", "pro"] as const) {
      expect(isModelAllowed(tier, "phala/glm-5")).toBe(true);
      expect(isModelAllowed(tier, "phala/gpt-oss-120b")).toBe(true);
      expect(isModelAllowed(tier, "phala/anything-at-all")).toBe(true);
    }
  });

  test("no tier allows non-phala/* models", () => {
    for (const tier of ["free", "plus", "pro"] as const) {
      expect(isModelAllowed(tier, "openai/gpt-5-mini")).toBe(false);
      expect(isModelAllowed(tier, "openai/gpt-5")).toBe(false);
      expect(isModelAllowed(tier, "anthropic/claude-opus-4.8")).toBe(false);
      expect(isModelAllowed(tier, "anthropic/claude-3.5-haiku")).toBe(false);
      expect(isModelAllowed(tier, "google/gemini-2.5-pro")).toBe(false);
    }
  });

  test("all tiers have identical model allowance (differ only by budget)", () => {
    // Tiers no longer gate models — every tier resolves the same allow/deny for
    // any given model. This is the invariant that replaces the old per-tier
    // whitelists; only credit budgets differ between tiers.
    for (const modelId of [
      "phala/glm-5",
      "phala/gpt-oss-120b",
      "openai/gpt-5",
      "openai/gpt-5-mini",
      "anthropic/claude-opus-4.8",
      "google/gemini-2.5-pro",
    ]) {
      const free = isModelAllowed("free", modelId);
      expect(isModelAllowed("plus", modelId)).toBe(free);
      expect(isModelAllowed("pro", modelId)).toBe(free);
      // And the verdict is exactly "is it phala/?".
      expect(free).toBe(modelId.startsWith("phala/"));
    }
  });

  test("requiredTierForModel is 'free' for phala/* and null for everything else", () => {
    // The lowest tier that allows any phala/* model is free (all tiers allow it).
    expect(requiredTierForModel("phala/glm-5")).toBe("free");
    expect(requiredTierForModel("phala/gpt-oss-120b")).toBe("free");
    // No tier can call a non-phala/* model, so there is no required tier.
    expect(requiredTierForModel("openai/gpt-5-mini")).toBeNull();
    expect(requiredTierForModel("openai/gpt-5")).toBeNull();
    expect(requiredTierForModel("anthropic/claude-opus-4.8")).toBeNull();
    expect(requiredTierForModel("google/gemini-2.5-pro")).toBeNull();
  });
});

describe("price-id mapping", () => {
  test("tierForPriceId resolves tier + interval", () => {
    expect(tierForPriceId("price_plus_m")).toEqual({ tier: "plus", interval: "monthly" });
    expect(tierForPriceId("price_plus_y")).toEqual({ tier: "plus", interval: "yearly" });
    expect(tierForPriceId("price_pro_m")).toEqual({ tier: "pro", interval: "monthly" });
    expect(tierForPriceId("price_pro_y")).toEqual({ tier: "pro", interval: "yearly" });
    expect(tierForPriceId("price_unknown")).toBeNull();
  });

  test("priceIdFor returns the configured id", () => {
    expect(priceIdFor("plus", "monthly")).toBe("price_plus_m");
    expect(priceIdFor("pro", "yearly")).toBe("price_pro_y");
  });

  test("unconfigured price ids resolve to null and do not false-match empty", () => {
    delete process.env.STRIPE_PRICE_PLUS_MONTHLY;
    expect(priceIdFor("plus", "monthly")).toBeNull();
    // An empty/undefined env must not map a real-but-different price id.
    expect(tierForPriceId("")).toBeNull();
  });
});
