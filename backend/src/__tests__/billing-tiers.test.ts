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
  test("free allows only its two whitelisted models", () => {
    expect(isModelAllowed("free", "openai/gpt-5-mini")).toBe(true);
    expect(isModelAllowed("free", "anthropic/claude-3.5-haiku")).toBe(true);
    expect(isModelAllowed("free", "openai/gpt-5")).toBe(false);
    expect(isModelAllowed("free", "anthropic/claude-opus-4.8")).toBe(false);
    expect(isModelAllowed("free", "phala/glm-5")).toBe(false);
  });

  test("plus allows all openai/* and anthropic/* but not phala/*", () => {
    expect(isModelAllowed("plus", "openai/gpt-5")).toBe(true);
    expect(isModelAllowed("plus", "anthropic/claude-opus-4.8")).toBe(true);
    expect(isModelAllowed("plus", "phala/glm-5")).toBe(false);
    expect(isModelAllowed("plus", "google/gemini-2.5-pro")).toBe(false);
  });

  test("pro allows everything including phala/*", () => {
    expect(isModelAllowed("pro", "openai/gpt-5")).toBe(true);
    expect(isModelAllowed("pro", "phala/glm-5")).toBe(true);
    expect(isModelAllowed("pro", "anything/at-all")).toBe(true);
  });

  test("requiredTierForModel returns the lowest capable tier", () => {
    expect(requiredTierForModel("openai/gpt-5-mini")).toBe("free");
    expect(requiredTierForModel("anthropic/claude-opus-4.8")).toBe("plus");
    expect(requiredTierForModel("openai/gpt-5")).toBe("plus");
    expect(requiredTierForModel("phala/glm-5")).toBe("pro");
    expect(requiredTierForModel("google/gemini-2.5-pro")).toBe("pro");
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
