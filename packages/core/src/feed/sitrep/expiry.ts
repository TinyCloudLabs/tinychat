// Card expiry: when an open ask or task stops waiting on Sam. The watcher expires cards past it
// (cli/watch.ts expireOnce) and tells the poster, who may resubmit; Sam's page hints at it.
import { effectivePriority } from "./priority";
import type { Ask, BoardRecord, SamState, Task } from "./schema";

const HOUR = 3_600_000;
/** Sam's page hints "expires in Xh" this close to expiry. */
export const EXPIRY_HINT_MS = 12 * HOUR;
/** Nothing expires sooner than this after the watcher's first expiry pass. */
export const FIRST_RUN_GRACE_MS = 48 * HOUR;
/** A card expires no sooner than this long after its deadline, its Steer decideBy, or Sam's snooze ends. */
export const AFTER_HOLD_MS = 24 * HOUR;

/** Urgency 4–5: a day; 3: three days; 0–2: two weeks. */
export function defaultExpiryMs(urgency: number): number {
  return urgency >= 4 ? 24 * HOUR : urgency === 3 ? 72 * HOUR : 14 * 24 * HOUR;
}

/**
 * When a card's clock starts: the latest of its creation, its latest asking (an ask asked again) and
 * the last rise of its urgency (expiryBaseAt), so escalating a card never expires it at once.
 */
export function expiryStart(card: { createdAt: string; lastAskedAt?: string; expiryBaseAt?: string }): number {
  return Math.max(...[card.createdAt, card.lastAskedAt, card.expiryBaseAt].flatMap((at) => (at ? [Date.parse(at)] : [])));
}

/**
 * The effective expiry (ms): expiresAt when given, else the start plus the urgency default. Never
 * sooner than AFTER_HOLD_MS past a deadline, a Steer decideBy, or the end of Sam's snooze (`state`,
 * sam/state: the later of snoozedUntil and his last recorded snooze, so clearing the "back" marker
 * does not bring expiry forward). null when it never expires: "never", or a task whose every step
 * Sam ticked (he did his part, like an answered ask).
 */
export function expiryOf(card: Ask | Task, state?: SamState): number | null {
  if (card.expiresAt === "never") return null;
  if (card.kind === "task" && card.steps.length && card.steps.every((step) => state?.steps[step.id])) return null;
  const expiry = card.expiresAt ? Date.parse(card.expiresAt) : expiryStart(card) + defaultExpiryMs(effectivePriority(card).urgency);
  const holds = [card.deadline, card.kind === "ask" ? card.decideBy : undefined, state?.snoozedUntil, ...(state?.snoozes ?? []).map((snooze) => snooze.until)];
  const held = Math.max(...holds.flatMap((at) => (at ? [Date.parse(at)] : [])));
  return Number.isFinite(held) ? Math.max(expiry, held + AFTER_HOLD_MS) : expiry;
}

/** Still waiting on Sam: an open ask or a to-do task. Answered asks are the caller's to rule out. */
export const isOpenCard = (record: BoardRecord): record is Ask | Task =>
  (record.kind === "ask" && record.status === "open") || (record.kind === "task" && record.status === "todo");

/** "expires in 3h" for an open card within EXPIRY_HINT_MS of its (snooze-adjusted) expiry; null otherwise. */
export function expiryHint(record: BoardRecord, now: number, state?: SamState): string | null {
  if (!isOpenCard(record)) return null;
  const expiry = expiryOf(record, state);
  if (expiry === null || expiry <= now || expiry - now > EXPIRY_HINT_MS) return null;
  return `expires in ${Math.ceil((expiry - now) / HOUR)}h`;
}
