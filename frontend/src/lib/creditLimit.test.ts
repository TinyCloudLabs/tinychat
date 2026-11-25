import { describe, expect, test } from "bun:test";

import type { BillingConfig, BillingTier } from "./billingApi";
import { formatResetTime, hasUpgradeTier, outOfCreditsMessage } from "./creditLimit";

const NOW = Date.parse("2026-11-25T10:30:00.000Z");

describe("outOfCreditsMessage", () => {
  test("names the plan and says nothing was charged when no reset time is known", () => {
    expect(outOfCreditsMessage({ tierName: "Free", resetsAt: null }, NOW)).toBe(
      "You're out of credits on the Free plan, so this message got no reply and nothing was charged.",
    );
  });

  test("appends the reset sentence for the daily free window", () => {
    expect(outOfCreditsMessage({ tierName: "Free", resetsAt: "2026-11-26T00:00:00.000Z" }, NOW)).toBe(
      "You're out of credits on the Free plan, so this message got no reply and nothing was charged. Credits reset tomorrow at 00:00 UTC.",
    );
  });

  test("appends the weekday for the weekly paid window", () => {
    expect(outOfCreditsMessage({ tierName: "Early Access Demo", resetsAt: "2026-11-29T14:05:00.000Z" }, NOW)).toBe(
      "You're out of credits on the Early Access Demo plan, so this message got no reply and nothing was charged. Credits reset Sunday at 14:05 UTC.",
    );
  });

  test("says your plan when the tier name is not available", () => {
    expect(outOfCreditsMessage({ tierName: null, resetsAt: null }, NOW)).toBe(
      "You're out of credits on your plan, so this message got no reply and nothing was charged.",
    );
  });

  test("leaves the reset sentence out when the reset time is already past or malformed", () => {
    const base = "You're out of credits on the Free plan, so this message got no reply and nothing was charged.";
    expect(outOfCreditsMessage({ tierName: "Free", resetsAt: "2026-11-25T00:00:00.000Z" }, NOW)).toBe(base);
    expect(outOfCreditsMessage({ tierName: "Free", resetsAt: "not a time" }, NOW)).toBe(base);
  });
});

describe("formatResetTime", () => {
  test("uses today, tomorrow, the weekday and next weekday by UTC calendar day", () => {
    expect(formatResetTime("2026-11-25T23:00:00.000Z", NOW)).toBe("today at 23:00 UTC");
    expect(formatResetTime("2026-11-26T00:00:00.000Z", NOW)).toBe("tomorrow at 00:00 UTC");
    expect(formatResetTime("2026-11-28T09:07:00.000Z", NOW)).toBe("Saturday at 09:07 UTC");
    expect(formatResetTime("2026-12-02T10:30:00.000Z", NOW)).toBe("next Wednesday at 10:30 UTC");
  });
});

function tier(id: string, creditBudget: number): BillingTier {
  return { id, name: id, priceMonthly: 0, priceYearly: 0, creditBudget, budgetWindow: "day", modelPatterns: [""] } as unknown as BillingTier;
}

describe("hasUpgradeTier", () => {
  const config = { paywallEnabled: true, accountAppUrl: "", tiers: [tier("free", 500), tier("pro", 28_000)] } as BillingConfig;

  test("is true below the top tier and false on it", () => {
    expect(hasUpgradeTier(config, "free")).toBe(true);
    expect(hasUpgradeTier(config, "pro")).toBe(false);
  });

  test("is true when the config or the tier is unknown", () => {
    expect(hasUpgradeTier(null, "pro")).toBe(true);
    expect(hasUpgradeTier(config, "plus")).toBe(true);
  });
});
