import { useState } from "react";
import { formatCredits, type BillingStatus } from "../lib/billingApi";

// Compact, clickable usage chip in the composer's toolbar. Shows the current
// tier and a thin progress bar of credit-budget consumption. Opens the pricing
// dialog on click. On hover/focus, an expanded popover above the chip surfaces
// exact numbers + reset date + a "How credits work" link to the rates table
// (spec §5.5). Renders even before status loads (shows "Plans") so the entry
// point is always present once the paywall is on.
export function UsageIndicator(props: {
  status: BillingStatus | null;
  tierName: string | null;
  onClick: () => void;
  onOpenRates: () => void;
}) {
  const { status, tierName, onClick, onOpenRates } = props;
  const [open, setOpen] = useState(false);
  const usage = status?.usage;
  const pct =
    usage && usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : 0;
  const tierLabel = tierName ?? "Plans";
  const near = pct >= 90;
  const resetsLabel = usage?.resetsAt ? formatResetsAt(usage.resetsAt) : null;
  // Compact "12K / 50K" rendered in the visible chip so touch users (who can't
  // hover) still see live usage at a glance (spec §5.5 transparency).
  const compactUsage =
    usage && usage.limit > 0
      ? `${formatCompact(usage.used)} / ${formatCompact(usage.limit)}`
      : null;

  return (
    <div
      className="relative shrink-0"
      onKeyDown={(e) => {
        // Escape (and Android Back, which sends one) closes the details.
        if (e.key === "Escape") setOpen(false);
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(e) => {
        // Close only when focus leaves the whole popover subtree.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label="View plans and usage"
        className="tap-transparent flex h-11 items-center gap-1.5 rounded-full border border-input px-3 text-meta text-foreground transition-colors hover:bg-surface-2 active:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:h-8 sm:gap-2"
      >
        <span className="font-medium">{tierLabel}</span>
        {compactUsage && (
          <span className="hidden tabular-nums text-muted-foreground sm:inline">{compactUsage}</span>
        )}
        {usage && usage.limit > 0 && (
          <span
            className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-muted sm:inline-flex"
            aria-hidden
          >
            <span
              className={`block h-full rounded-full ${near ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${pct}%` }}
            />
          </span>
        )}
      </button>
      {open && (
        <div
          role="region"
          aria-label="Usage and plan details"
          data-overlay-open="true"
          className="absolute bottom-full left-0 z-40 mb-2 w-64 max-w-[calc(100vw-2rem)] rounded-lg bg-popover p-3 text-xs text-popover-foreground shadow-float"
        >
          {usage && usage.limit > 0 && (
            <>
              <div className="tabular-nums text-foreground">
                {usage.used.toLocaleString()} / {formatCredits(usage.limit)}
              </div>
              {resetsLabel && (
                <div className="mt-0.5 text-muted-foreground">
                  Resets {resetsLabel}
                </div>
              )}
            </>
          )}
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => {
              setOpen(false);
              onOpenRates();
            }}
            className={`${usage && usage.limit > 0 ? "mt-2" : ""} text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            How credits work →
          </button>
        </div>
      )}
    </div>
  );
}

// Short numeric label for the always-visible chip (e.g. 12_400 → "12K").
function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(/\.0M$/, "M");
  if (n >= 1_000) return `${Math.round(n / 100) / 10}K`.replace(/\.0K$/, "K");
  return n.toString();
}

function formatResetsAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return d.toDateString();
  }
}
