import { describe, expect, test } from "bun:test";

import type { BillingConfig, BillingTier } from "./billingApi";
import type { PaywallErrorPayload } from "./chatApi";
import { isPaywallActionable } from "./paywall";

function tier(id: string, creditBudget: number): BillingTier {
  return { id, name: id, priceMonthly: 0, priceYearly: 0, creditBudget, budgetWindow: "day", modelPatterns: [""] } as unknown as BillingTier;
}

const config = { paywallEnabled: true, accountAppUrl: "", tiers: [tier("free", 500), tier("pro", 28_000)] } as BillingConfig;

function exceeded(tierId: string): PaywallErrorPayload {
  return { error: "credit_budget_exceeded", message: "", tier: tierId };
}

describe("pricing dialog rule for credit_budget_exceeded", () => {
  test("opens for a tier that has an upgrade", () => {
    expect(isPaywallActionable(exceeded("free"), config)).toBe(true);
  });

  test("does not open for the top paid tier", () => {
    expect(isPaywallActionable(exceeded("pro"), config)).toBe(false);
  });

  test("opens when the billing config has not loaded", () => {
    expect(isPaywallActionable(exceeded("pro"), null)).toBe(true);
    expect(isPaywallActionable(exceeded("pro"))).toBe(true);
  });
});
