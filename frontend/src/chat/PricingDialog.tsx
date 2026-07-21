import { useCallback, useMemo } from "react";
import { CheckIcon, ShieldCheckIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatCreditBudgetWithWindow,
  formatPrice,
  type BillingConfig,
  type BillingStatus,
  type BillingTier,
  type TierId,
} from "@/lib/billingApi";

/** Fallback account-app origin if `/config` somehow omits `accountAppUrl`. */
const ACCOUNT_APP_URL_FALLBACK = "https://account.tinycloud.xyz";

const TIER_ORDER: Record<TierId, number> = { free: 0, pro: 1 };

/** Short, provider-agnostic blurb per tier (no model/provider names here). */
const TIER_TAGLINE: Record<TierId, string> = {
  free: "Get started with everyday chat.",
  pro: "One plan, everything unlocked.",
};

interface PricingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: BillingConfig;
  status: BillingStatus | null;
  /** Open the rates table dialog from the footer "How credits work" link. */
  onOpenRates: () => void;
}

export function PricingDialog({
  open,
  onOpenChange,
  config,
  status,
  onOpenRates,
}: PricingDialogProps) {
  const tiers = useMemo(
    () => [...config.tiers].sort((a, b) => TIER_ORDER[a.id] - TIER_ORDER[b.id]),
    [config.tiers],
  );

  const currentTier = status?.tier ?? "free";
  const hasActiveSubscription = Boolean(status?.subscription);

  // Checkout + subscription management both live in the account app now. Open it
  // in a NEW TAB so the chat session stays intact; the Stripe success bounce
  // returns to the account app, never back to TinyChat.
  const openAccountBilling = useCallback(() => {
    const base = config.accountAppUrl || ACCOUNT_APP_URL_FALLBACK;
    window.open(`${base}/billing`, "_blank", "noopener,noreferrer");
  }, [config.accountAppUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-5 rounded-xl">
        <DialogHeader className="items-center text-center">
          <DialogTitle className="text-xl">Choose your plan</DialogTitle>
          <DialogDescription>
            Upgrade to the paid plan for more credits every week.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {tiers.map((tier) => (
            <TierCard
              key={tier.id}
              tier={tier}
              isCurrent={tier.id === currentTier}
              hasActiveSubscription={hasActiveSubscription}
              onManageBilling={openAccountBilling}
            />
          ))}
        </div>

        <div className="text-center">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={onOpenRates}
            className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            How credits work →
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TierCard({
  tier,
  isCurrent,
  hasActiveSubscription,
  onManageBilling,
}: {
  tier: BillingTier;
  isCurrent: boolean;
  hasActiveSubscription: boolean;
  onManageBilling: () => void;
}) {
  const isPaid = tier.id === "pro";
  const price = tier.priceMonthly;

  return (
    <div
      className={cn(
        "relative flex flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground",
        isPaid ? "border-primary/60 shadow-sm" : "border-border",
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          {isPaid && <ShieldCheckIcon className="size-4 text-primary" />}
          <span className="text-sm font-semibold">{tier.name}</span>
          {isCurrent && (
            <span className="ml-auto rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              Current
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{TIER_TAGLINE[tier.id]}</p>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tracking-tight">
          {formatPrice(price)}
        </span>
        {isPaid && price > 0 && <span className="text-xs text-muted-foreground">/mo</span>}
      </div>

      <ul className="flex flex-col gap-1.5 text-xs">
        {tierFeatures(tier).map((feature) => (
          <Feature key={feature}>{feature}</Feature>
        ))}
      </ul>

      <div className="mt-auto">
        {!isPaid ? (
          <Button variant="outline" size="sm" className="w-full" disabled>
            {isCurrent ? "Your plan" : "Free forever"}
          </Button>
        ) : hasActiveSubscription ? (
          <Button variant="outline" size="sm" className="w-full" onClick={onManageBilling}>
            Manage subscription
          </Button>
        ) : (
          <Button size="sm" className="w-full" onClick={onManageBilling}>
            Upgrade to {tier.name}
          </Button>
        )}
      </div>
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-1.5">
      <CheckIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <span className="text-foreground">{children}</span>
    </li>
  );
}

/**
 * Feature bullets per tier. Credits/window are derived from the live config so
 * they never drift from the backend; the paid plan spells out the unified
 * product (all models incl. confidential TEE + storage).
 */
function tierFeatures(tier: BillingTier): string[] {
  const credits = formatCreditBudgetWithWindow(tier.creditBudget, tier.budgetWindow);
  if (tier.id === "pro") {
    return [
      credits,
      "All models, including confidential TEE models",
      "1 GiB storage",
    ];
  }
  return [credits, "All models, including confidential TEE models"];
}
