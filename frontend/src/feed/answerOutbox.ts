import type { FeedCardIdentity } from "@tinycloud/sdk-services/feed";

/**
 * The page-close outbox. An answer still counting down when the page closes is sent at once,
 * but browsers don't wait for that write, so the pending answer is first written here
 * (synchronously, in localStorage) and sent with the same responseId at the next launch.
 *
 * An entry holds only what rebuilds that exact answer: the card identity, the responseId, the
 * chosen option or written text, the typed action, the answer it replaces, and its time. No
 * tokens, keys or card content.
 */
export interface HeldAnswer extends FeedCardIdentity {
  sourceId: string;
  responseId: string;
  choiceId?: string;
  text?: string;
  /** A typed question's action: an option tap or "Fine, go ahead". */
  action?: "answer" | "accept-default";
  /** Set when the answer is a "Change answer" follow-up. */
  supersedesResponseId?: string;
  /** When the answer was made: the response's createdAt. */
  at: string;
}

const PREFIX = "tinychat.home.answer-outbox.v1:";

/** One key per owner (space) and card identity. */
export function heldAnswerKey(space: string, held: Pick<HeldAnswer, "sourceId" | "cardId" | "revision" | "issuanceId">): string {
  return `${PREFIX}${space}:${JSON.stringify([held.sourceId, held.cardId, held.revision, held.issuanceId])}`;
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
    return value as unknown as HeldAnswer;
  } catch { return null; }
}

/** Writes the pending answer before the page goes. Storage that refuses the write loses only this fallback. */
export function holdAnswer(space: string, held: HeldAnswer): void {
  try { window.localStorage.setItem(heldAnswerKey(space, held), JSON.stringify(held)); }
  catch { /* localStorage full or disabled: the page-close write is the only attempt. */ }
}

/** Clears the entry for this identity, only while it still holds this response. */
export function releaseAnswer(space: string, held: Pick<HeldAnswer, "sourceId" | "cardId" | "revision" | "issuanceId" | "responseId">): void {
  try {
    const key = heldAnswerKey(space, held);
    if (parse(window.localStorage.getItem(key))?.responseId === held.responseId) window.localStorage.removeItem(key);
  } catch { /* Nothing to clear. */ }
}

/** This owner's held answers. A malformed entry is removed: it can't be sent as the owner made it. */
export function heldAnswers(space: string): HeldAnswer[] {
  const held: HeldAnswer[] = [];
  try {
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(`${PREFIX}${space}:`));
    for (const key of keys) {
      const entry = parse(storage.getItem(key));
      if (entry && heldAnswerKey(space, entry) === key) held.push(entry);
      else storage.removeItem(key);
    }
  } catch { /* localStorage disabled: nothing was held. */ }
  return held;
}
