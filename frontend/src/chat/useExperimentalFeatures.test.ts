import { expect, test } from "bun:test";
import type { BillingStatus } from "../lib/billingApi";
import { isConversationCanvasEligible } from "./useExperimentalFeatures";

const status = (tier: BillingStatus["tier"]): BillingStatus => ({
  tier,
  usage: { used: 0, limit: 0, resetsAt: "" },
  subscription: null,
});

test("Conversation Canvas stays hidden while the product kill switch is off", () => {
  expect(isConversationCanvasEligible(null)).toBe(false);
  expect(isConversationCanvasEligible(status("free"))).toBe(false);
  expect(isConversationCanvasEligible(status("pro"))).toBe(false);
});
