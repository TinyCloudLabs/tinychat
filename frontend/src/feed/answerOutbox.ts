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
 * tokens, keys or card content, apart from the two short labels the owner saw when they answered
 * (the agent's name and the option's label), which a "Not sent" notice needs once no card is left.
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
  /**
   * What the owner saw when they answered, kept so "Not sent" can say it even when no card is left to read it from
   * (the agent was disconnected): the agent's name on the card, and the chosen option's label. Never sent anywhere.
   */
  agent?: string;
  choiceLabel?: string;
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
      || !optional("choiceId") || !optional("text") || !optional("supersedesResponseId") || !optional("agent") || !optional("choiceLabel")
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

/** Removes every answer this owner holds, and every unsent answer still waiting to be seen (at sign-out, after its one bounded flush). */
export function clearHeldAnswers(space: string): void {
  try {
    const storage = window.localStorage;
    for (const key of spaceKeys(storage, space)) storage.removeItem(key);
  } catch { /* Nothing to clear. */ }
  clearUnsentAnswers(space);
}

/**
 * Removes every held and unsent answer on this device, whatever space it belongs to. For a sign-out that cannot
 * name its space: a restart that finds a sign-out still pending has no client and no space to clear by, and the
 * owner's words must not outlive the account on this device.
 */
export function clearAllHeldAnswers(): void {
  try {
    const storage = window.localStorage;
    for (const key of Array.from({ length: storage.length }, (_, index) => storage.key(index)!).filter((name) => name.startsWith(PREFIX) || name.startsWith(UNSENT_PREFIX))) storage.removeItem(key);
  } catch { /* Nothing to clear. */ }
}

/**
 * How many held and unsent answers on this device, whatever space they belong to, are still within
 * HELD_ANSWER_TTL_MS at `now`. Reads only: a malformed or expired entry is not counted (its owner's
 * next read removes it). For the move off tinycloud.chat (originMove.ts), which must not strand them.
 */
export function countStoredAnswers(storage: Pick<Storage, "length" | "key" | "getItem">, now = Date.now()): { held: number; unsent: number } {
  let held = 0;
  let unsent = 0;
  const fresh = (at: string) => now - Date.parse(at) <= HELD_ANSWER_TTL_MS;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX)) {
      const entry = parse(storage.getItem(key));
      if (entry && fresh(entry.at)) held++;
    } else if (key?.startsWith(UNSENT_PREFIX)) {
      const entry = parseUnsent(storage.getItem(key));
      if (entry && fresh(entry.at)) unsent++;
    }
  }
  return { held, unsent };
}

/**
 * An answer the feed did not take when its held entry was flushed at a launch: the owner never saw it counted,
 * so it is kept (one per card) until the owner has seen "Not sent" on that card, whatever the page was doing when
 * the flush ended. It carries what lets the owner say it again: the option's label, or the words they wrote.
 */
export interface UnsentAnswer {
  sourceId: string;
  cardId: string;
  /** The answered revision. */
  revision: number;
  issuanceId: string;
  /** "replaced": a newer revision changed the request; "closed": the agent closed it; "refused": the feed said no; "disconnected": its agent is no longer connected, so no card is left to show it on. */
  outcome: "replaced" | "closed" | "refused" | "disconnected";
  choiceLabel?: string;
  text?: string;
  /** The agent's name as the owner saw it on the card: what a notice names when its card is gone. */
  agent?: string;
  at: string;
}

const UNSENT_PREFIX = "tinychat.home.answer-unsent.v1:";
const unsentKey = (space: string, sourceId: string, cardId: string) => `${UNSENT_PREFIX}${space}:${JSON.stringify([sourceId, cardId])}`;

function parseUnsent(raw: string | null): UnsentAnswer | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return undefined;
    const entry = value as Record<string, unknown>;
    const outcome = entry.outcome;
    if (typeof entry.sourceId !== "string" || typeof entry.cardId !== "string" || typeof entry.issuanceId !== "string" || typeof entry.at !== "string") return undefined;
    if (typeof entry.revision !== "number" || !Number.isSafeInteger(entry.revision) || (outcome !== "replaced" && outcome !== "closed" && outcome !== "refused" && outcome !== "disconnected")) return undefined;
    return {
      sourceId: entry.sourceId, cardId: entry.cardId, revision: entry.revision, issuanceId: entry.issuanceId, outcome, at: entry.at,
      ...(typeof entry.choiceLabel === "string" ? { choiceLabel: entry.choiceLabel } : {}),
      ...(typeof entry.text === "string" ? { text: entry.text } : {}),
      ...(typeof entry.agent === "string" ? { agent: entry.agent } : {}),
    };
  } catch { return undefined; }
}

/** Keeps this unsent answer for its card, replacing an earlier one. */
export function recordUnsentAnswer(space: string, unsent: UnsentAnswer): void {
  try { window.localStorage.setItem(unsentKey(space, unsent.sourceId, unsent.cardId), JSON.stringify(unsent)); }
  catch { /* localStorage full or disabled: the page still shows it this session. */ }
}

/** This owner's unsent answers still to be seen; a malformed or expired one is removed. */
export function unsentAnswers(space: string, now = Date.now()): UnsentAnswer[] {
  const found: UnsentAnswer[] = [];
  try {
    const storage = window.localStorage;
    const prefix = `${UNSENT_PREFIX}${space}:`;
    for (const key of Array.from({ length: storage.length }, (_, index) => storage.key(index)!).filter((name) => name.startsWith(prefix))) {
      const entry = parseUnsent(storage.getItem(key));
      if (entry && key === unsentKey(space, entry.sourceId, entry.cardId) && now - Date.parse(entry.at) <= HELD_ANSWER_TTL_MS) found.push(entry);
      else storage.removeItem(key);
    }
  } catch { /* localStorage disabled: nothing was kept. */ }
  return found;
}

/** The owner has seen it (or answered the card again): it is not shown again. */
export function clearUnsentAnswer(space: string, sourceId: string, cardId: string): void {
  try { window.localStorage.removeItem(unsentKey(space, sourceId, cardId)); } catch { /* Nothing to clear. */ }
}

function clearUnsentAnswers(space: string): void {
  try {
    const storage = window.localStorage;
    const prefix = `${UNSENT_PREFIX}${space}:`;
    for (const key of Array.from({ length: storage.length }, (_, index) => storage.key(index)!).filter((name) => name.startsWith(prefix))) storage.removeItem(key);
  } catch { /* Nothing to clear. */ }
}
