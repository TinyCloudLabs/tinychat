import type { FeedCardIdentity, FeedResponsePayload } from "@tinycloud/sdk-services/feed";
import { validOwnerAction, type OwnerAction } from "./ownerActions";

/**
 * The page-close outbox. An answer leaving its undo countdown is written here first
 * (synchronously, in localStorage) and stays until its write is confirmed or refused. Browsers
 * don't wait for a write when the page closes, during the countdown or with the write in flight,
 * so whatever is still held is sent with the same responseId at the next launch.
 *
 * An entry holds only what rebuilds that exact answer: the card identity, the responseId, the
 * chosen option or written text, the typed action, the answer it replaces, and its time. No
 * tokens, keys or card content.
 *
 * Version 2 entries (`version: 2`) may also carry a plain card's `feed.*` answer payload, or be an
 * owner action (a `message`: Drop, Acknowledge, Ask me later) instead of an answer. An entry with no
 * `version` is a version 1 answer, as every entry was before. Owner actions are keyed per response
 * (see heldAnswerKey), so one never replaces a held answer, and a version 1 reader drops them as
 * malformed instead of sending them as empty answers.
 */
export interface HeldAnswer extends FeedCardIdentity {
  /** Absent: version 1, an answer with no payload of its own. */
  version?: 2;
  sourceId: string;
  responseId: string;
  choiceId?: string;
  text?: string;
  /** A typed question's action: an option tap or "Fine, go ahead". */
  action?: "answer" | "accept-default";
  /** Set when the answer is a "Change answer" follow-up. */
  supersedesResponseId?: string;
  /** Version 2: a plain card answer's private `feed.*` payload (a post's answers), sent unchanged. */
  payload?: FeedResponsePayload;
  /** Version 2: not an answer but this owner action, sent as a message (see ownerActions.ts). */
  ownerAction?: OwnerAction;
  /** When the answer was made: the response's createdAt. */
  at: string;
}

type HeldIdentity = Pick<HeldAnswer, "sourceId" | "cardId" | "revision" | "issuanceId" | "responseId">;

const PREFIX = "tinychat.home.answer-outbox.v1:";
/** A held answer older than this is deleted unsent: the card shows unanswered again and can be answered anew. */
export const HELD_ANSWER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One key per owner (space) and card identity for an answer; one per response for an owner action. */
export function heldAnswerKey(space: string, held: Pick<HeldAnswer, "sourceId" | "cardId" | "revision" | "issuanceId"> & Partial<Pick<HeldAnswer, "responseId" | "ownerAction">>): string {
  const identity = [held.sourceId, held.cardId, held.revision, held.issuanceId];
  return `${PREFIX}${space}:${JSON.stringify(held.ownerAction ? [...identity, held.responseId] : identity)}`;
}

/** Both places a response may be held: as its card's answer, or as an owner action. */
function keysOf(space: string, held: HeldIdentity): string[] {
  return [heldAnswerKey(space, held), heldAnswerKey(space, { ...held, ownerAction: { type: "feed.drop" } })];
}

function feedPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.type === "string" && payload.type.startsWith("feed.") && Number.isSafeInteger(payload.version) && (payload.version as number) > 0 && payload.data !== undefined;
}

function parse(raw: string | null): HeldAnswer | null {
  try {
    const value = JSON.parse(raw ?? "") as Record<string, unknown>;
    const text = (key: string) => typeof value[key] === "string" && (value[key] as string).length > 0;
    const optional = (key: string) => value[key] === undefined || text(key);
    if (!value || typeof value !== "object" || !["sourceId", "cardId", "issuanceId", "responseId", "at"].every(text)
      || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
      || !optional("choiceId") || !optional("text") || !optional("supersedesResponseId")
      || (value.action !== undefined && value.action !== "answer" && value.action !== "accept-default")) return null;
    if (value.version === undefined) return value.payload === undefined && value.ownerAction === undefined ? value as unknown as HeldAnswer : null;
    if (value.version !== 2 || (value.payload !== undefined && !feedPayload(value.payload))) return null;
    if (value.ownerAction !== undefined && (!validOwnerAction(value.ownerAction) || value.payload !== undefined || value.choiceId !== undefined || value.text !== undefined || value.action !== undefined || value.supersedesResponseId !== undefined)) return null;
    return value as unknown as HeldAnswer;
  } catch { return null; }
}

/** Writes the pending answer before the page goes. Storage that refuses the write loses only this fallback. */
export function holdAnswer(space: string, held: HeldAnswer): void {
  try { window.localStorage.setItem(heldAnswerKey(space, held), JSON.stringify(held)); }
  catch { /* localStorage full or disabled: the page-close write is the only attempt. */ }
}

/** Clears the entry for this response, only while it still holds this response. */
export function releaseAnswer(space: string, held: HeldIdentity): void {
  try {
    for (const key of keysOf(space, held)) {
      if (parse(window.localStorage.getItem(key))?.responseId === held.responseId) window.localStorage.removeItem(key);
    }
  } catch { /* Nothing to clear. */ }
}

function spaceKeys(storage: Storage, space: string): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(`${PREFIX}${space}:`));
}

/**
 * This owner's held answers. A malformed entry is removed (it can't be sent as the owner made
 * it), and so is one older than HELD_ANSWER_TTL_MS.
 */
export function heldAnswers(space: string, now = Date.now()): HeldAnswer[] {
  const held: HeldAnswer[] = [];
  try {
    const storage = window.localStorage;
    for (const key of spaceKeys(storage, space)) {
      const entry = parse(storage.getItem(key));
      const age = entry ? now - Date.parse(entry.at) : NaN;
      if (entry && heldAnswerKey(space, entry) === key && age <= HELD_ANSWER_TTL_MS) held.push(entry);
      else storage.removeItem(key);
    }
  } catch { /* localStorage disabled: nothing was held. */ }
  return held;
}

/** Whether this exact answer or owner action is still held: not cleared since (sent, refused, expired, or at sign-out). */
export function isHeld(space: string, held: HeldIdentity): boolean {
  try { return keysOf(space, held).some((key) => parse(window.localStorage.getItem(key))?.responseId === held.responseId); }
  catch { return false; }
}

/** Removes every answer this owner holds (at sign-out, after its one bounded flush). */
export function clearHeldAnswers(space: string): void {
  try {
    const storage = window.localStorage;
    for (const key of spaceKeys(storage, space)) storage.removeItem(key);
  } catch { /* Nothing to clear. */ }
}
