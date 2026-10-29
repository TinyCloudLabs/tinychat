// Holds: what is stopped on purpose and what lifts each one. The dependency graph itself is shared/deps.ts.
// Pure functions over the board's records, shared by the CLI, the page and the tests.
import { activeHolds, blockersCleared, blockersNeverComing, type DepGraph, depGraph, markCleared } from "./deps";
import { type BoardRecord, type Hold, HOLD_RELEASERS, type HoldReleaser } from "./schema";

// ── The Holds view ───────────────────────────────────────────────────

export type HoldFlag = "release-passed" | "bad-ref" | "unblocker-done" | "unblocker-never";

/** Said on the Holds tab and by `hold stale` when a blocker was dropped, cancelled or expired. */
export const NEVER_TEXT = "a blocker was dropped/cancelled/expired: re-plan or lift?";

export interface HoldRow {
  hold: Hold;
  /** Milliseconds since decidedAt (createdAt when it has none). */
  ageMs: number;
  flags: HoldFlag[];
  /** unblockedBy entries that name a record that is not on the board. */
  badRefs: string[];
}

export const HOLD_GROUP_TITLE: Record<HoldReleaser, string> = {
  sam: "Held for your call",
  engineering: "Waiting on engineering",
  upstream: "Waiting on upstream",
  other: "Other",
};

const timeOf = (iso: string | undefined): number | undefined => {
  const ms = iso === undefined ? NaN : Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
};

/** When an expectedRelease falls due: an ISO time as given; a bare date at the end of that day (UTC). Free text ("unknown: upstream") has none. */
export function releaseDue(hold: Hold): number | undefined {
  const raw = hold.expectedRelease;
  if (raw === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return timeOf(`${raw}T23:59:59.999Z`);
  return /^\d{4}-\d{2}-\d{2}T/.test(raw) ? timeOf(raw) : undefined;
}

export const releasePassed = (hold: Hold, now: number): boolean => {
  const due = releaseDue(hold);
  return due !== undefined && due < now;
};

/** The patch that lifts a hold, for `roci-board hold lift` and the watcher's relay of Sam's button: status, who and why (liftedAt is stamped by the upsert). */
export const holdLiftPatch = (reason: string, liftedBy: string): { status: "lifted"; liftReason: string; liftedBy: string } => ({ status: "lifted", liftReason: reason, liftedBy });

/** What lifts the hold is done: every record ref closed as done (answered, done, lifted; a resubmit or superseding card stands in for an expired one), or for an "any" hold at least one. External refs are not checked. */
export function unblockerDone(graph: DepGraph, hold: Hold): boolean {
  return blockersCleared(hold, hold.unblockedBy.map((ref) => markCleared(hold, graph.resolve(ref))));
}

/** A record it waits on closed without being done, so it will never lift this hold: any one of them for an "all" hold, every one for an "any" hold. */
export const unblockerNever = (graph: DepGraph, hold: Hold): boolean => blockersNeverComing(hold, hold.unblockedBy.map((ref) => markCleared(hold, graph.resolve(ref)))).length > 0;

export function holdRow(graph: DepGraph, hold: Hold, now: number): HoldRow {
  const badRefs = hold.unblockedBy.filter((ref) => markCleared(hold, graph.resolve(ref)).state === "missing");
  const flags: HoldFlag[] = [];
  if (releasePassed(hold, now)) flags.push("release-passed");
  if (badRefs.length) flags.push("bad-ref");
  if (unblockerDone(graph, hold)) flags.push("unblocker-done");
  if (unblockerNever(graph, hold)) flags.push("unblocker-never");
  return { hold, ageMs: now - (timeOf(hold.decidedAt) ?? Date.parse(hold.createdAt)), flags, badRefs };
}

/** Active holds grouped by who releases them, in the order Sam reads them; oldest decision first, then id, inside a group. */
export function holdGroups(records: readonly BoardRecord[], now: number): Array<{ releasedBy: HoldReleaser; title: string; rows: HoldRow[] }> {
  const graph = depGraph(records);
  const rows = activeHolds(records).map((hold) => holdRow(graph, hold, now));
  return HOLD_RELEASERS.map((releasedBy) => ({
    releasedBy,
    title: HOLD_GROUP_TITLE[releasedBy],
    rows: rows.filter((row) => row.hold.releasedBy === releasedBy).sort((a, b) => b.ageMs - a.ageMs || (a.hold.id < b.hold.id ? -1 : 1)),
  })).filter((group) => group.rows.length);
}

export const HOLD_STALE_DAYS = 7;

/** Why a hold is stale (`roci-board hold stale`): a blocker will never be done, everything it waits on is done, its expectedRelease has passed, or nobody touched it for a week. */
export function staleReasons(graph: DepGraph, hold: Hold, now: number): string[] {
  const reasons: string[] = [];
  if (unblockerNever(graph, hold)) reasons.push(NEVER_TEXT);
  if (unblockerDone(graph, hold)) reasons.push("everything it waits on is done: lift it?");
  if (releasePassed(hold, now)) reasons.push(`expectedRelease ${hold.expectedRelease} has passed`);
  // Sam's clear is a touch, but not an owner action; clear-only writes preserve updatedAt.
  const touchedAt = Math.max(Date.parse(hold.updatedAt), ...(hold.clearedRefs ?? []).map((clear) => Date.parse(clear.at)));
  const idle = now - touchedAt;
  if (idle > HOLD_STALE_DAYS * 86_400_000) reasons.push(`untouched for ${Math.floor(idle / 86_400_000)} days`);
  return reasons;
}

export function staleHolds(records: readonly BoardRecord[], now: number): Array<{ hold: Hold; reasons: string[] }> {
  const graph = depGraph(records);
  return activeHolds(records).flatMap((hold) => {
    const reasons = staleReasons(graph, hold, now);
    return reasons.length ? [{ hold, reasons }] : [];
  });
}
