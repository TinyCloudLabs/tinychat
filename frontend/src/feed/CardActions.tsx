// An open card's foot (feed lab, Sam 11-12: "ask me later should be at the bottom next to details"): its small
// actions ("Ask me later", "Show me later"), then "Details", which opens a pop-up (DetailsSheet.tsx: a sheet on
// phones, a dialog from 640px up) with who posted the card, its history and its wiring; at the right end, the card's
// closing action (Sam 23:40Z): "Drop this card" on a decision, "Acknowledge" on an information card. Plain cards
// (HomeFeedEntries.tsx) and typed cards (SitrepCard.tsx) share it.
import { useState, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import type { FeedResponse, FeedResponsePayload } from "@tinycloud/sdk-services/feed";
import { DetailsSheet } from "./DetailsSheet";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";

/** The class of a small action on a card. */
export const actionClass = "min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50";
/** The class of a quiet action in the card's foot (Ask me later, Details): text that lights up when touched. */
export const footActionClass = "inline-flex min-h-11 items-center rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-50 fine:min-h-9";

/**
 * The owner's card actions an agent hears about, as a `message` response with a private payload (names agreed with
 * the card guide v2): Ask me later ("feed.snooze", `{ until }`), Drop this card ("feed.drop") and Acknowledge
 * ("feed.acknowledge"). Each is written only once its undo has passed; the agent acknowledges it with no reply.
 */
export type OwnerAction = "feed.snooze" | "feed.drop" | "feed.acknowledge";
export async function sendOwnerAction(entry: HomeFeedEntry, source: HomeFeedSource, type: OwnerAction, text: string, data: { [key: string]: string } = {}): Promise<FeedResponse> {
  if (!source.sendMessage) throw new Error("No agent can hear about this card");
  const card = entry.state.card;
  const payload: FeedResponsePayload = { type, version: 1, data };
  return source.sendMessage(entry, { responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, kind: "message", text, createdAt: new Date().toISOString() }, payload);
}

/**
 * How and when you closed a card, if you did: its latest drop or acknowledgement. A closed card leaves the feed for
 * History (Filter → History, and the earlier answers' timeline at the time you closed it).
 */
export function closedEvent(entry: HomeFeedEntry): { as: "Dropped" | "Acknowledged"; at: string } | undefined {
  const last = [...(entry.responses ?? [])].reverse().find((response) => response.payloadType === "feed.drop" || response.payloadType === "feed.acknowledge");
  return last && { as: last.payloadType === "feed.drop" ? "Dropped" : "Acknowledged", at: last.createdAt };
}
export function closedAs(entry: HomeFeedEntry): "Dropped" | "Acknowledged" | undefined {
  return closedEvent(entry)?.as;
}

/** A card's closing action: which one, and what a tap does (the page takes the card away and shows the undo bar). */
export interface CardClose { kind: "drop" | "acknowledge"; onTap: () => void }

/**
 * The card's foot, with "Details" (the card's facts, `children`, in a pop-up) alone in the bottom-right corner on every
 * card (Sam, 23:5xZ; the design agent's layout). A decision, one row: its quiet `actions` (Ask me later), then "Drop
 * this card", both taking the card away through the undo bar. An update: "Acknowledge" (its one real action, the dark
 * pill) and its quiet `actions` (Show me later), then a bottom row with `secondary` ("Comment") level with Details.
 */
export function CardDetails({ children, actions, secondary, close }: { children: ReactNode; actions?: ReactNode; secondary?: ReactNode; close?: CardClose }) {
  const [open, setOpen] = useState(false);
  const details = <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className={`${footActionClass} ml-auto`}>Details</button>;
  const leading = <>
    {close?.kind === "acknowledge" && <button type="button" onClick={close.onTap} className="mr-1 inline-flex min-h-11 items-center gap-1 rounded-full bg-foreground pl-3 pr-3.5 text-sm font-semibold text-background transition-transform active:scale-[.97] motion-reduce:transform-none fine:min-h-9"><CheckIcon aria-hidden className="size-4" />Acknowledge</button>}
    {actions}
    {close?.kind === "drop" && <button type="button" onClick={close.onTap} className={`${footActionClass} hover:text-destructive`}>Drop this card</button>}
  </>;
  return <div aria-label="Card actions" className="text-sm">
    {secondary
      ? <><div className="flex flex-wrap items-center gap-1">{leading}</div><div className="mt-1 flex items-center gap-1">{secondary}{details}</div></>
      : <div className="flex flex-wrap items-center gap-1">{leading}{details}</div>}
    <DetailsSheet open={open} onOpenChange={setOpen}>{children}</DetailsSheet>
  </div>;
}
