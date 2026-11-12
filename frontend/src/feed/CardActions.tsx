// An open card's controls (feed lab, Sam's order of 11-12): its small actions in one row at its top (CardActions),
// and one control at its foot, "Details", which opens a pop-up with who posted the card, its history and its wiring
// (CardDetails). Plain cards (HomeFeedEntries.tsx) and typed cards (SitrepCard.tsx) share them.
import { useState, type ReactNode } from "react";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";

/** The class of a small action on a card. */
export const actionClass = "min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50";

/** The small actions of an open card, in one row at its top. */
export function CardActions({ children }: { children: ReactNode }) {
  return <div aria-label="Card actions" className="flex flex-wrap items-center gap-2 text-sm">{children}</div>;
}
/** The card's foot: "Details", which opens the card's facts in a pop-up. */
export function CardDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center rounded-lg px-1 text-sm text-muted-foreground underline decoration-border underline-offset-4">Details</button>
    <ResponsiveSheet open={open} onOpenChange={setOpen} title="Details">
      <ResponsiveSheetBody className="space-y-3 break-words pb-6 text-sm">{children}</ResponsiveSheetBody>
    </ResponsiveSheet>
  </>;
}
