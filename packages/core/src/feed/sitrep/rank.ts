// The one ranking of what Sam should do next. Used by the "Do next" list, by Waiting on you and by
// "Only you can do", so the three can never disagree about what comes first.
import type { WaitingItem } from "./board";
import { formatDuration } from "./duration";

/** A deadline this close (or already past) outranks everything else but an officer's turn. */
export const DUE_WINDOW_MS = 48 * 3_600_000;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The scoring fields shared by Waiting items and liftable holds. */
export type WaitingRank = Pick<WaitingItem, "waitsOnOthers" | "dueSoon" | "deadlineAt" | "critical" | "unblockWeight" | "pin" | "urgency" | "importance" | "since" | "anchor">;

/**
 * Sam's order, first rule that differs wins:
 *  1. Items that wait on an officer's card come after every item he can act on now: even a release or deploy go
 *     that waits on an officer, since Sam cannot act on it yet. Its reason line says "blocked: needs <officer> first".
 *  2. Overdue or due within DUE_WINDOW_MS first, the earliest deadline first (overdue ones lead).
 *  3. Production/security (a release or deploy go, or `blocks` naming prod or security) before the rest.
 *  4. Unblock weight, highest first, among non-critical items: each open dependent (plus critical bonus).
 *     Top 3 alone adds one point for a stated `blocks` claim not yet linked to a graph dependent.
 *  5. Priority: his pin (2) before a card that lifts a pin (1) before neither (0).
 *  6. Urgency × importance, highest first.
 *  7. Any other deadline, the earliest first; undated last.
 *  8. The longest wait (earliest `since`), then the anchor.
 * It reads fields fixed when the report was made, never the clock, so the order cannot flap.
 */
export function compareWaiting(a: WaitingRank, b: WaitingRank): number {
  return Number(Boolean(a.waitsOnOthers)) - Number(Boolean(b.waitsOnOthers)) ||
    Number(b.dueSoon) - Number(a.dueSoon) ||
    (a.dueSoon && b.dueSoon ? (a.deadlineAt ?? 0) - (b.deadlineAt ?? 0) : 0) ||
    Number(b.critical) - Number(a.critical) ||
    (a.critical ? 0 : b.unblockWeight - a.unblockWeight) ||
    b.pin - a.pin ||
    b.urgency * b.importance - a.urgency * a.importance ||
    (a.deadlineAt ?? Infinity) - (b.deadlineAt ?? Infinity) ||
    Date.parse(a.since) - Date.parse(b.since) ||
    byId(a.anchor, b.anchor);
}

/**
 * One short line saying why an item is where it is: the first rule above that applies to it.
 * "blocked: needs Amos first", "overdue 12m", "due in 2h 05m", "production/security", "unblocks 3", "your priority",
 * "needed for your priority", else its U/I.
 */
export function rankReason(item: WaitingRank & Pick<WaitingItem, "unblocked" | "unblockedCritical" | "blocks">, now: number): string {
  if (item.waitsOnOthers) return `blocked: needs ${item.waitsOnOthers.by} first`;
  if (item.dueSoon && item.deadlineAt !== undefined) {
    return item.deadlineAt < now ? `overdue ${formatDuration(now - item.deadlineAt)}` : `due in ${formatDuration(item.deadlineAt - now)}`;
  }
  if (item.critical) return "holds up production or security";
  if (item.unblocked > 0) return `unblocks ${item.unblocked}${item.unblockedCritical > 0 ? " (prod)" : ""}`;
  if (item.blocks?.trim()) return `unblocks: ${item.blocks}`;
  if (item.pin === 2) return "your priority";
  if (item.pin === 1) return "needed for your priority";
  return `U${item.urgency}·I${item.importance}`;
}
