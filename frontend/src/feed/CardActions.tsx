// The foot of an open card, inside its surface: its small actions in one row (CardActions), with the card's wiring
// closed under Details as the last of them (CardDetails). Plain cards (HomeFeedEntries.tsx) and typed cards
// (SitrepCard.tsx) share them.
import type { ReactNode } from "react";

/** The class of a small action at a card's foot. */
export const actionClass = "min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50";

/** The small actions at the foot of an open card, inside it. */
export function CardActions({ children }: { children: ReactNode }) {
  return <div aria-label="Card actions" className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">{children}</div>;
}
/** The card's wiring, closed by default, last among its actions: open, it takes the whole width below them. */
export function CardDetails({ children }: { children: ReactNode }) {
  return <details aria-label="Card details" className="min-w-0 text-xs open:basis-full">
    <summary className="inline-flex min-h-10 cursor-pointer list-none items-center rounded-lg border border-border px-3 text-sm [&::-webkit-details-marker]:hidden">Details</summary>
    <div className="mt-2 space-y-2 break-words rounded-xl bg-muted/50 p-3">{children}</div>
  </details>;
}
