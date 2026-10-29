import { isClosed, parseKey, type BoardRecord } from "./schema";
import { answerReissued, goStale } from "./transitions";
import type { PreparedOwnerResponse } from "./import-bundle";

export interface ImportedExecutionWindow { dispatchBefore: string | null; refusal?: string; heldReason?: string }

/** Home producer/validator only. Structural importers consume this resolved deadline. */
export function importedExecutionWindow(record: BoardRecord, event: PreparedOwnerResponse, now: string): ImportedExecutionWindow {
  let dispatchBefore: string | null = null;
  const answer = event.legacyAnswer;
  if (answer && record.kind === "approval") {
    if (answer.action === "done" && record.approvalType === "go") {
      dispatchBefore = record.expiresAt ?? null;
      const refusal = goStale(answer, record, now);
      if (refusal) return { dispatchBefore, refusal: "Legacy go is no longer executable" };
    } else if (answerReissued(answer, record)) return { dispatchBefore, refusal: "Legacy approval issuance changed" };
    // A consent page's expiry does not end delivery of an already saved code.
  }
  if (event.ownerEventKind === "claim") {
    dispatchBefore = new Date(Date.parse(event.response.createdAt) + 30 * 86400000).toISOString();
    if (Date.parse(now) >= Date.parse(dispatchBefore)) return { dispatchBefore, refusal: "Legacy claim delivery window expired" };
    if (Date.parse(event.response.createdAt) > Date.parse(now) + 86400000) return { dispatchBefore, heldReason: "Legacy claim timestamp exceeds the watcher skew window" };
  }
  if (event.ownerEventKind === "thread" && isClosed(record)) return { dispatchBefore, refusal: "Legacy thread parent is closed" };
  if (event.ownerEventKind === "hold-notice") {
    dispatchBefore = new Date(Date.parse(event.response.createdAt) + 7 * 86400000).toISOString();
    if (Date.parse(now) >= Date.parse(dispatchBefore)) return { dispatchBefore, refusal: "Legacy notice delivery window expired" };
  }
  return { dispatchBefore };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The captured runtime's positive pending evidence; absence is never permission. */
export function hasCapturedPendingEvidence(record: BoardRecord, event: PreparedOwnerResponse, recipient: string, raw: unknown, sourceArea: string): boolean {
  if (!object(raw)) return false;
  if (event.ownerEventKind === "thread") {
    const attempt = sourceArea === "thread-watch-state" && object(raw.attempts) ? raw.attempts[event.eventKey] : sourceArea === "kv" ? raw : undefined;
    return object(attempt) && attempt.state === "waiting" && !attempt.reason && attempt.recipient === recipient;
  }
  if (event.ownerEventKind === "hold-notice") {
    const notice = object(raw.owed) ? raw.owed[event.eventKey] : undefined;
    return raw.version === 1 && object(raw.acted) && object(notice) && notice.to === recipient && notice.sending === undefined;
  }
  if (sourceArea !== "watch-state" || (raw.version !== 1 && raw.version !== 2) || typeof raw.cursor !== "string" || !object(raw.delivered) || !object(raw.tasks)) return false;
  if (event.ownerEventKind === "claim") {
    const delivered = object(raw.claimDelivered) ? raw.claimDelivered[event.eventKey] : undefined;
    const since = typeof raw.claimsSince === "string" ? raw.claimsSince : raw.cursor;
    return !delivered && Date.parse(event.response.createdAt) > Date.parse(since) && (typeof raw.prunedThrough !== "string" || Date.parse(event.response.createdAt) > Date.parse(raw.prunedThrough));
  }
  const receipt = raw.delivered[event.eventKey];
  if (receipt !== undefined && (!object(receipt) || !Array.isArray(receipt.done) || typeof receipt.complete !== "boolean" || receipt.complete || receipt.done.includes(recipient))) return false;
  if (event.ownerEventKind === "answer") {
    const key = parseKey(event.sourceKey);
    return key?.area === "answer" && key.at > raw.cursor;
  }
  if (event.ownerEventKind === "note") return true;
  if (event.ownerEventKind === "state" && record.kind === "task" && event.eventKey === `done:${record.id}`) return !object(raw.taskClosed) || !raw.taskClosed[record.id];
  return false;
}
