// An open card's foot: its small actions ("Ask me later", "Comment"), then "Details", which unfolds under the foot, in the
// card (the design agent's details/ mock): what the card does not draw ("Not shown on the card"), the card's facts and
// history (`children`), and the whole card as sent. At the right end of the actions, the card's closing action: "Drop
// this card" on a decision, "Acknowledge" on an information card. Plain cards (HomeFeedEntries.tsx) and typed cards
// (SitrepCard.tsx) share it. What a closing action writes lives in the store (ownerActions.ts); the page owns the tap
// and its undo bar.
import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type { UnshownField } from "./unshown";
import { CardData, detailsSectionTitle, UnshownList } from "./UnshownList";

/** The class of a small action on a card: 44px on touch (QA cb784d4), 40px with a mouse. */
export const actionClass = "min-h-11 rounded-lg border border-border px-3 text-sm disabled:opacity-50 fine:min-h-10";
/** The class of a quiet action in the card's foot (Ask me later): text that lights up when touched. */
export const footActionClass = "inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-1.5 text-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50 fine:min-h-9";

/** A card's closing action: which one, and what a tap does (the page takes the card away and shows the undo bar). */
export interface CardClose { kind: "drop" | "acknowledge"; onTap: () => void }

/**
 * The card's foot, with "Details" in the bottom-right corner on every card, and a "+N" when `unshown` lists N parts of
 * the card it does not draw. A decision, one row: its quiet `actions` (Ask me later), then "Drop this card", both taking
 * the card away through the undo bar. An update: "Acknowledge" (its one real action, the dark pill) and its quiet
 * `actions` (Show me later), then a bottom row with `secondary` ("Comment") level with Details. `card` is the card as
 * sent and `agent` who sent it, for the disclosure.
 */
export function CardDetails({ children, actions, secondary, close, unshown, card, agent }: {
  children: ReactNode; actions?: ReactNode; secondary?: ReactNode; close?: CardClose;
  unshown: readonly UnshownField[]; card: unknown; agent: string;
}) {
  const [open, setOpen] = useState(false);
  // Only fields meant to be read count; the feed's own bookkeeping is listed in Details but not counted.
  const count = unshown.filter((field) => !field.quiet).length;
  const listed = unshown.length > 0;
  const details = <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
    {...(count ? { "aria-label": `Details, ${count} ${count === 1 ? "field" : "fields"} not shown on the card` } : {})}
    className={`ml-auto inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-[10px] pl-2 pr-1 text-sm transition-colors fine:min-h-9 ${open ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-surface-2 hover:text-foreground"}`}>
    Details
    {count > 0 && <span aria-hidden className="inline-flex h-5 items-center rounded-full border border-muted-foreground/50 px-[7px] text-[11px] font-semibold tabular-nums text-foreground">+{count}</span>}
    {/* On phones the "+N", the pressed state and aria-expanded carry the disclosure, so the foot keeps one line at 375. */}
    <ChevronDownIcon aria-hidden className={`size-4 transition-transform motion-reduce:transition-none max-sm:hidden ${open ? "rotate-180" : ""}`} />
  </button>;
  const leading = <>
    {close?.kind === "acknowledge" && <button type="button" onClick={close.onTap} className="mr-1 inline-flex min-h-11 items-center gap-1 rounded-full bg-foreground pl-3 pr-3.5 text-sm font-semibold text-background transition-transform active:scale-[.97] motion-reduce:transform-none fine:min-h-9"><CheckIcon aria-hidden className="size-4" />Acknowledge</button>}
    {actions}
    {close?.kind === "drop" && <button type="button" onClick={close.onTap} className={`${footActionClass} hover:text-destructive`}>Drop this card</button>}
  </>;
  return <div className="text-sm">
    <div aria-label="Card actions" className="-mx-1.5">
      {secondary
        ? <><div className="flex flex-wrap items-center gap-0.5">{leading}</div><div className="mt-1 flex items-center gap-0.5">{secondary}{details}</div></>
        : <div className="flex flex-wrap items-center gap-0.5">{leading}{details}</div>}
    </div>
    {open && <div aria-label="Details" className={`mt-2 grid gap-[18px] break-words rounded-[14px] bg-muted/60 p-3.5 ${listed ? "min-[900px]:grid-cols-[240px_minmax(0,1fr)] min-[900px]:gap-x-5" : ""}`}>
      {listed && <div className="min-w-0 min-[900px]:col-start-2 min-[900px]:row-span-3 min-[900px]:row-start-1"><UnshownList fields={unshown} agent={agent} /></div>}
      <div className="grid min-w-0 content-start gap-[18px]">
        <section aria-label="This card"><h3 className={detailsSectionTitle}>This card</h3>{children}</section>
        <CardData card={card} />
      </div>
    </div>}
  </div>;
}
