// Sam, 11-14: "When decision is made card moves away gracefully, undo is bottom popup." A card in the Home feed tells
// the page that it is leaving: from the tap of a decision until its answer is saved, the page fades it out and closes
// its space (HomeFeedEntries.tsx), while the bottom undo bar (UndoBar.tsx) counts the card's own wait and offers Undo.
// The card keeps its countdown and its write (usePendingSend), and stays mounted throughout: unmounting would send.
import { createContext, useContext, useEffect, useRef } from "react";

/** What the bottom bar shows for a card's decision while it counts: "Answered: 08:15 direct" or "Dropped". */
export interface LeaveBar {
  /** "Answered" or "Dropped". */
  text: string;
  /** The option chosen, shown after the text ("Answered: 08:15 direct"); none for a written answer. */
  choice?: string;
  /** When the card's own wait ends (epoch ms). */
  endsAt: number;
  /** The card's Undo: nothing is sent, and the card comes back. */
  undo: () => void;
  /** The option to give focus back to after Undo (its `data-option-id`). */
  focusOption?: string;
}
/** A card on its way out: `away` takes it off the list (the page animates it), `bar` while its wait counts. */
export interface Leaving { away: boolean; bar?: LeaveBar }

/** Provided around each open card by a page with a bottom bar; absent elsewhere (a post's own page). */
export const CardLeaveContext = createContext<((leaving: Leaving | null) => void) | null>(null);

/**
 * Reports the card's state to its page, and clears it when the card goes. Returns whether the page shows decisions in
 * its bottom bar, so the card drops its own countdown line.
 */
export function useLeave(leaving: Leaving | null): boolean {
  const report = useContext(CardLeaveContext);
  const latest = useRef(leaving);
  latest.current = leaving;
  // Re-reported when what shows changes, not on every render (`undo` is a fresh function each time).
  const signature = leaving ? JSON.stringify([leaving.away, leaving.bar?.text, leaving.bar?.choice, leaving.bar?.endsAt]) : "";
  useEffect(() => { report?.(latest.current); }, [report, signature]);
  useEffect(() => () => report?.(null), [report]);
  return report !== null;
}
