import type { PaywallErrorPayload } from "@/lib/chatApi";

/**
 * ST3 — a 402 is "actionable" (an upgrade can resolve it, so pop the pricing
 * dialog) ONLY for `credit_budget_exceeded` or a `model_not_allowed` that carries
 * a higher `requiredTier`. A `model_not_allowed` WITHOUT an actionable
 * `requiredTier` (every tier shares the `phala/*` namespace, so an upgrade can't
 * unlock the model) is NOT actionable — the caller resets to a verifiable model
 * instead of opening an un-fixable dialog.
 *
 * Pure + DOM-free (the payload type is imported type-only) so the routing is
 * unit-tested rather than browser-checked — see paywall.test.ts.
 */
export function isPaywallActionable(payload: PaywallErrorPayload): boolean {
  return (
    payload.error === "credit_budget_exceeded" ||
    (payload.error === "model_not_allowed" && payload.requiredTier != null)
  );
}
