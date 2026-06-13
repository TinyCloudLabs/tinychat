import { useEffect, useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BillingClient, RatesResponse, ModelRates } from "@/lib/billingApi";

interface RatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  billing: BillingClient;
}

/**
 * Public per-model credit rates table (spec §5.5). Opened from the usage chip,
 * the pricing dialog, and the high-burn picker nudge. Denominated in credits
 * only — never expose dollar amounts here (spec §2.1).
 */
export function RatesDialog({ open, onOpenChange, billing }: RatesDialogProps) {
  const [rates, setRates] = useState<RatesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy-load on first open; reuse the response across subsequent opens for
  // the session (catalog already 5-min-cached server-side; no need to refetch
  // on every open).
  useEffect(() => {
    if (!open || rates || loading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    billing
      .getRates()
      .then((r) => {
        if (!cancelled) setRates(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load rates.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, billing, rates]);

  const rows = useMemo(() => sortRates(rates), [rates]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-4 rounded-xl" aria-busy={loading}>
        <DialogHeader>
          <DialogTitle className="text-lg">Credit rates</DialogTitle>
          <DialogDescription>
            What each model costs in credits per 1,000 tokens.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            Loading rates…
          </div>
        )}

        {error && !loading && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
            {error}
          </p>
        )}

        {rates && rows.length > 0 && !loading && (
          <div className="max-h-[60vh] overflow-x-auto overflow-y-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Model</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Multiplier</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Credits / 1K in
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Credits / 1K out
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const isBaseline = m.id === rates.baseline;
                  return (
                    <tr
                      key={m.id}
                      className="border-t border-border first:border-t-0 hover:bg-accent/40"
                    >
                      <td className="max-w-[8rem] px-3 py-2 align-middle font-mono text-foreground md:max-w-none">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate">{m.id}</span>
                          {isBaseline && (
                            <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              Baseline
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 align-middle">
                        {isBaseline ? (
                          <span className="text-muted-foreground" aria-label="Baseline">
                            —
                          </span>
                        ) : (
                          <MultiplierBadge multiplier={m.multiplier} />
                        )}
                      </td>
                      <td className="px-3 py-2 text-right align-middle tabular-nums text-foreground">
                        {formatRate(m.creditsPerKInput)}
                      </td>
                      <td className="px-3 py-2 text-right align-middle tabular-nums text-foreground">
                        {formatRate(m.creditsPerKOutput)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Charged exactly as listed. Rates may change when provider pricing
          changes.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function MultiplierBadge({ multiplier }: { multiplier: number }) {
  const label = `${formatRate(multiplier)}×`;
  return (
    <span className="inline-block rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary tabular-nums">
      {label}
    </span>
  );
}

function formatRate(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return n.toLocaleString();
  return Number.parseFloat(n.toFixed(2)).toString();
}

/** Baseline pinned first, then ascending multiplier, then id (spec §5.5). */
function sortRates(rates: RatesResponse | null): ModelRates[] {
  if (!rates) return [];
  const others = rates.models
    .filter((m) => m.id !== rates.baseline)
    .sort((a, b) => a.multiplier - b.multiplier || a.id.localeCompare(b.id));
  const baseline = rates.models.find((m) => m.id === rates.baseline);
  return baseline ? [baseline, ...others] : others;
}
