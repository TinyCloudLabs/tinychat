import { useCallback, useMemo, useState } from "react";
import { CheckIcon, Loader2Icon, SparklesIcon, ShieldCheckIcon } from "lucide-react";

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
  yearlyDiscountPercent,
  type BillingClient,
  type BillingConfig,
  type BillingStatus,
  type BillingTier,
  type TierId,
} from "@/lib/billingApi";

type Interval = "monthly" | "yearly";

const TIER_ORDER: Record<TierId, number> = { free: 0, plus: 1, pro: 2 };

/** Short, provider-agnostic blurb per tier (no model/provider names here). */
const TIER_TAGLINE: Record<TierId, string> = {
  free: "Get started with everyday chat.",
  plus: "More capacity and access to premium models.",
  pro: "Maximum capacity, premium and confidential TEE models.",
};

interface PricingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: BillingConfig;
  status: BillingStatus | null;
  billing: BillingClient;
  /** Open the rates table dialog from the footer "How credits work" link. */
  onOpenRates: () => void;
}

export function PricingDialog({
  open,
  onOpenChange,
  config,
  status,
  billing,
  onOpenRates,
}: PricingDialogProps) {
  const [interval, setInterval] = useState<Interval>("yearly");
  // Per-action busy state, keyed by tier id (or "portal") so only the clicked
  // CTA shows a spinner.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tiers = useMemo(
    () => [...config.tiers].sort((a, b) => TIER_ORDER[a.id] - TIER_ORDER[b.id]),
    [config.tiers],
  );

  const maxYearlyDiscount = useMemo(() => {
    let best = 0;
    for (const t of tiers) {
      const d = yearlyDiscountPercent(t.priceMonthly, t.priceYearly);
      if (d > best) best = d;
    }
    return best;
  }, [tiers]);

  const currentTier = status?.tier ?? "free";
  const hasActiveSubscription = Boolean(status?.subscription);

  const startCheckout = useCallback(
    async (tier: "plus" | "pro") => {
      setError(null);
      setBusy(tier);
      try {
        const url = await billing.checkout(tier, interval);
        window.location.href = url;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start checkout.");
        setBusy(null);
      }
    },
    [billing, interval],
  );

  const openPortal = useCallback(async () => {
    setError(null);
    setBusy("portal");
    try {
      const url = await billing.portal();
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open billing portal.");
      setBusy(null);
    }
  }, [billing]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-5 rounded-xl">
        <DialogHeader className="items-center text-center">
          <DialogTitle className="text-xl">Choose your plan</DialogTitle>
          <DialogDescription>
            Upgrade for more capacity and access to premium models.
          </DialogDescription>
        </DialogHeader>

        <IntervalToggle
          interval={interval}
          onChange={setInterval}
          maxYearlyDiscount={maxYearlyDiscount}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {tiers.map((tier) => (
            <TierCard
              key={tier.id}
              tier={tier}
              interval={interval}
              isCurrent={tier.id === currentTier}
              busy={busy}
              hasActiveSubscription={hasActiveSubscription}
              onCheckout={startCheckout}
              onManage={openPortal}
            />
          ))}
        </div>

        {error && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
            {error}
          </p>
        )}

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

function IntervalToggle({
  interval,
  onChange,
  maxYearlyDiscount,
}: {
  interval: Interval;
  onChange: (next: Interval) => void;
  maxYearlyDiscount: number;
}) {
  return (
    <div className="mx-auto inline-flex items-center rounded-lg border border-input bg-muted/50 p-0.5 text-xs font-medium">
      {(["monthly", "yearly"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={cn(
            "rounded-md px-3 py-1.5 capitalize transition-colors",
            interval === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={interval === value}
        >
          {value}
          {value === "yearly" && maxYearlyDiscount > 0 && (
            <span className="ml-1 text-[10px] font-semibold text-primary">
              Save {maxYearlyDiscount}%
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function TierCard({
  tier,
  interval,
  isCurrent,
  busy,
  hasActiveSubscription,
  onCheckout,
  onManage,
}: {
  tier: BillingTier;
  interval: Interval;
  isCurrent: boolean;
  busy: string | null;
  hasActiveSubscription: boolean;
  onCheckout: (tier: "plus" | "pro") => void;
  onManage: () => void;
}) {
  const isPaid = tier.id === "plus" || tier.id === "pro";
  const isPro = tier.id === "pro";
  const price = interval === "yearly" ? tier.priceYearly : tier.priceMonthly;
  const discount = yearlyDiscountPercent(tier.priceMonthly, tier.priceYearly);
  const anyBusy = busy !== null;
  const thisBusy = busy === tier.id || (isCurrent && busy === "portal");

  return (
    <div
      className={cn(
        "relative flex flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground",
        isPro ? "border-primary/60 shadow-sm" : "border-border",
      )}
    >
      {isPro && (
        <span className="absolute -top-2 right-3 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
          Best value
        </span>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          {isPro ? (
            <ShieldCheckIcon className="size-4 text-primary" />
          ) : tier.id === "plus" ? (
            <SparklesIcon className="size-4 text-primary" />
          ) : null}
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
        {isPaid && price > 0 && (
          <span className="text-xs text-muted-foreground">
            /{interval === "yearly" ? "yr" : "mo"}
          </span>
        )}
        {isPaid && interval === "yearly" && discount > 0 && (
          <span className="ml-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            Save {discount}%
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-1.5 text-xs">
        <Feature>{formatCreditBudgetWithWindow(tier.creditBudget, tier.budgetWindow)}</Feature>
        <Feature>{modelAccessSummary(tier.id)}</Feature>
      </ul>

      <div className="mt-auto">
        {!isPaid ? (
          <Button variant="outline" size="sm" className="w-full" disabled>
            {isCurrent ? "Your plan" : "Free forever"}
          </Button>
        ) : isCurrent && hasActiveSubscription ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={anyBusy}
            onClick={onManage}
            aria-label={busy === "portal" ? "Processing…" : undefined}
          >
            {busy === "portal" ? (
              <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              "Manage subscription"
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            className="w-full"
            disabled={anyBusy || isCurrent}
            onClick={() => onCheckout(tier.id as "plus" | "pro")}
            aria-label={thisBusy ? "Processing…" : undefined}
          >
            {thisBusy ? (
              <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
            ) : isCurrent ? (
              "Current plan"
            ) : (
              `Upgrade to ${tier.name}`
            )}
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

/** Provider-agnostic, tier-level model access summary. */
function modelAccessSummary(tier: TierId): string {
  switch (tier) {
    case "free":
      return "Basic models";
    case "plus":
      return "Basic and premium models";
    case "pro":
      return "All models, including confidential TEE models";
  }
}
