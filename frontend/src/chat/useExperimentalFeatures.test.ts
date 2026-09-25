import { expect, test } from "bun:test";
import type { BillingStatus } from "../lib/billingApi";
import { isConversationCanvasEligible } from "./useExperimentalFeatures";

const status = (tier: BillingStatus["tier"]): BillingStatus => ({
  tier,
  usage: { used: 0, limit: 0, resetsAt: "" },
  subscription: null,
});

test("Conversation Canvas is available to every signed-in account during testing", () => {
  expect(isConversationCanvasEligible(null)).toBe(true);
  expect(isConversationCanvasEligible(status("free"))).toBe(true);
  expect(isConversationCanvasEligible(status("pro"))).toBe(true);
});
