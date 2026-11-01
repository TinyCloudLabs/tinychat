import { expect, test } from "bun:test";
import type { BillingStatus } from "../lib/billingApi";
import { isConversationCanvasEligible } from "./useExperimentalFeatures";

const status = (tier: BillingStatus["tier"]): BillingStatus => ({
  tier,
  usage: { used: 0, limit: 0, resetsAt: "" },
  subscription: null,
});

test("Conversation Canvas eligibility follows the product kill switch and ignores the plan", () => {
  expect(isConversationCanvasEligible(null)).toBe(true);
  expect(isConversationCanvasEligible(status("free"))).toBe(true);
  expect(isConversationCanvasEligible(status("pro"))).toBe(true);
});
