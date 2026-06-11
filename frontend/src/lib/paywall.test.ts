import { describe, expect, test } from "bun:test";

import { isPaywallActionable } from "./paywall";
import type { PaywallErrorPayload } from "./chatApi";

function payload(over: Partial<PaywallErrorPayload>): PaywallErrorPayload {
  return { error: "model_not_allowed", message: "", tier: "free", ...over };
}

describe("ST3 — isPaywallActionable routes 402s to the right remedy", () => {
  test("credit_budget_exceeded is actionable → opens the pricing dialog", () => {
    expect(isPaywallActionable(payload({ error: "credit_budget_exceeded" }))).toBe(true);
  });

  test("model_not_allowed WITH a requiredTier is actionable → upgrade can fix it", () => {
    expect(
      isPaywallActionable(payload({ error: "model_not_allowed", requiredTier: "pro" })),
    ).toBe(true);
  });

  test("model_not_allowed WITHOUT a requiredTier is NOT actionable → reset picker, no dialog", () => {
    // Every tier shares the phala/* namespace, so no upgrade unlocks the model;
    // popping the pricing dialog would be an un-fixable dead end.
    expect(isPaywallActionable(payload({ error: "model_not_allowed" }))).toBe(false);
    expect(
      isPaywallActionable(payload({ error: "model_not_allowed", requiredTier: undefined })),
    ).toBe(false);
  });
});
