// Expanded shows every card open, so a card cannot count as seen because it was opened. It counts once it has been
// properly on screen: enough of it visible, for long enough. A quick scroll past marks nothing seen (and so clears no
// unread comments).

/** How long a card must stay enough on screen before it counts as seen. */
export const SEEN_DWELL_MS = 1000;

/** Fractions at which the observer reports, fine enough for a card much taller than the screen. */
export const SEEN_THRESHOLDS: readonly number[] = Array.from({ length: 101 }, (_, step) => step / 100);

/**
 * Whether enough of a card is visible: half of it, or, for a card too tall for half of it ever to fit, nearly all of
 * what the scroller can show (`rootHeight / cardHeight` of it).
 */
export function visibleEnoughToSee(view: { intersectionRatio: number; cardHeight: number; rootHeight: number }): boolean {
  const { intersectionRatio, cardHeight, rootHeight } = view;
  const fits = cardHeight > 0 && rootHeight > 0 ? (0.9 * rootHeight) / cardHeight : 0.5;
  return intersectionRatio > 0 && intersectionRatio >= Math.min(0.5, fits);
}
