import { createContext, useContext, useLayoutEffect, useRef } from "react";

/**
 * What a card tells the feed while its answer (or other action) waits out its undo window and then its write: the
 * feed hides the card for that time and shows one pill for it. `seconds` is null once the window ended and the write
 * is in flight.
 */
export interface WaitReport { label: string; seconds: number | null; undo: () => void }

/** The feed's side of that: one per open card, stable for the card's key. */
export interface CardWait {
  report: (wait: WaitReport | null) => void;
  /** A new wait is starting: every other wait is sent now (one wait at a time). */
  begin: () => void;
  /** The answer's held write has landed. */
  sent: () => void;
}

export const CardWaitContext = createContext<CardWait | null>(null);

/** The card's own wait, reported up to the feed. Outside a feed (a post's page) nothing is reported. */
export function useAnnounceWait(pending: { label: string; seconds: number } | null, undo: () => void, sending: boolean) {
  const wait = useContext(CardWaitContext);
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const label = useRef("");
  if (pending) label.current = pending.label;
  const seconds = pending ? pending.seconds : null;
  const active = !!pending || sending;
  // Before paint, so the card is gone the moment it is tapped.
  useLayoutEffect(() => {
    wait?.report(active ? { label: label.current, seconds, undo: () => undoRef.current() } : null);
  }, [wait, active, seconds]);
  useLayoutEffect(() => () => wait?.report(null), [wait]);
}
