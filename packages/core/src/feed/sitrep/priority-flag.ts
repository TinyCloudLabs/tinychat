// Priority flags and ordering (docs/SPEC-priority.md). Pure: the board, the CLI and the tests share these.
// Not to be confused with shared/priority.ts, which holds the urgency quadrant matrix.
import type { Priority } from "./schema";

/** Sam's toggle as stored: on pins, off unpins even when an officer flagged it. */
export interface PriorityDecision {
  on: boolean;
  at: string;
}

export interface PriorityFlag {
  by: "sam" | "officer";
  reason: string;
  at: string;
}

/** The officer's `priority` on a record. Records of kinds without the field have none. */
export function officerPriority(record: object): Priority | undefined {
  return "priority" in record ? (record.priority as Priority | undefined) : undefined;
}

/** A card's flag: Sam's decision wins over the officer's record. Sam's "off" hides an earlier officer flag; a later officer flag shows again. */
export function cardPriority(record: object, decision: PriorityDecision | undefined): PriorityFlag | null {
  const officer = officerPriority(record);
  // Sam's "off" hides an officer's flag, unless the officer flagged it again after Sam's decision.
  if (decision && !decision.on && !(officer && officer.at > decision.at)) return null;
  if (officer) return officer;
  if (decision?.on) return { by: "sam", reason: "Marked priority by Sam", at: decision.at };
  return null;
}

/** A group is priority when Sam decided it, or (with no decision) when any of its open cards is. */
export function groupPriorityFlag(decision: PriorityDecision | undefined, members: readonly boolean[]): boolean {
  return decision ? decision.on : members.some(Boolean);
}

/** A card that blocks something (`blocks` set) or unblocks at least one other card. */
export function isBlocker(blocks: boolean, unblocks: number): boolean {
  return blocks || unblocks > 0;
}

export interface Ordered<T> {
  value: T;
  flagged: boolean;
  blocker: boolean;
}

/**
 * Splits entries (already in the normal order) into the Priority section and the rest. Inside the section,
 * blockers come first; otherwise the input order is kept.
 */
export function orderPriority<T>(entries: readonly Ordered<T>[]): { priority: T[]; rest: T[] } {
  const flagged = entries.filter((entry) => entry.flagged);
  return {
    priority: [...flagged.filter((entry) => entry.blocker), ...flagged.filter((entry) => !entry.blocker)].map((entry) => entry.value),
    rest: entries.filter((entry) => !entry.flagged).map((entry) => entry.value),
  };
}
