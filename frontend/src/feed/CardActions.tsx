// An open card's foot (feed lab, Sam 11-12: "ask me later should be at the bottom next to details"): its small
// actions ("Ask me later"), then "Details", which opens a pop-up with who posted the card, its history and its
// wiring. Plain cards (HomeFeedEntries.tsx) and typed cards (SitrepCard.tsx) share it.
import { useState, type ReactNode } from "react";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";

/** The class of a small action on a card. */
export const actionClass = "min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50";

/**
 * The card's foot: its small `actions`, then "Details", which opens the card's facts (`children`) in a pop-up, and at
 * the far end `end` ("Show less" on a card opened from the list).
 */
export function CardDetails({ children, actions, end }: { children: ReactNode; actions?: ReactNode; end?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div aria-label="Card actions" className="flex flex-wrap items-center gap-2 text-sm">
    {actions}
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center rounded-lg px-1 text-sm text-muted-foreground underline decoration-border underline-offset-4">Details</button>
    {end && <span className="ml-auto">{end}</span>}
    <ResponsiveSheet open={open} onOpenChange={setOpen} title="Details">
      <ResponsiveSheetBody className="space-y-3 break-words pb-6 text-sm">{children}</ResponsiveSheetBody>
    </ResponsiveSheet>
  </div>;
}
