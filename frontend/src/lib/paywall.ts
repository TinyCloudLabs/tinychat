import type { PaywallEventPayload } from "@/lib/chatApi";
import type { BillingConfig } from "@/lib/billingApi";
import { hasUpgradeTier } from "@/lib/creditLimit";

/**
 * ST3 — a 402 is "actionable" (an upgrade can resolve it, so pop the pricing
 * dialog) ONLY for `credit_budget_exceeded` or a `model_not_allowed` that carries
 * a higher `requiredTier`. A `model_not_allowed` WITHOUT an actionable
 * `requiredTier` (every tier shares the `phala/*` namespace, so an upgrade can't
 * unlock the model) is NOT actionable — the caller resets to a verifiable model
 * instead of opening an un-fixable dialog. `credit_budget_exceeded` on the top
 * tier is not actionable either, because no higher tier exists: the caller
 * shows the message and leaves the dialog closed. When `config` is omitted or
 * does not list the account's tier, the dialog is not withheld.
 *
 * Pure + DOM-free (the payload type is imported type-only) so the routing is
 * unit-tested rather than browser-checked — see paywall.test.ts.
 */
export function isPaywallActionable(
  payload: PaywallEventPayload,
  config?: BillingConfig | null,
): boolean {
  if (payload.error === "credit_budget_exceeded") {
    return hasUpgradeTier(config ?? null, payload.tier);
  }
  return payload.error === "model_not_allowed" && payload.requiredTier != null;
}
