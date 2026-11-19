// The words of an update's foot, its "Acknowledge all" and its history rail, in one place for the copy owner.
import { UNDO_SECONDS } from "./cardKit";

/** The action at the right of the Updates heading. */
export const ACKNOWLEDGE_ALL = "Acknowledge all";
/** What the button says to a screen reader: how many cards it takes. */
export const acknowledgeAllLabel = (count: number) => (count === 1 ? "Acknowledge 1 update" : `Acknowledge all ${count} updates`);
/** The pill while the count runs, and what a screen reader hears when it appears. */
export const acknowledgedPill = (count: number) => `${count} acknowledged`;
export const acknowledgingAnnounce = (count: number) => (count === 1
  ? `1 update will be acknowledged in ${UNDO_SECONDS} seconds. Choose Undo to keep it.`
  : `${count} updates will be acknowledged in ${UNDO_SECONDS} seconds. Choose Undo to keep them.`);

/** An update's foot: its later action, the box it opens, and the times it offers. */
export const SHOW_ME_LATER = "Show me later";
export const SHOW_ME_AGAIN = "Show me again";
export const SHIP_RECORD = "Ship record";
export const HISTORY = "History";

/** The record's own steps on an update's rail. */
export const WENT_LIVE = "Went live";
export const POSTED_TO_BOARD = "Posted to the board";
