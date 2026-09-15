// ── Per-message run→append handoff (ST4) ─────────────────────────────
//
// The streamed completion id + usage are captured in the ChatModelAdapter's
// `run()` (off the reply path), but the receipt + verification badge are wired
// in the history adapter's `append()`. The two are bridged here. Previously a
// SINGLE module-level slot held each pending value, which cross-contaminated
// when two threads' streams finished interleaved (thread A awaiting its receipt
// while thread B's finish overwrote the slot — A's message then got B's
// completionId/model). Keying by the ASSISTANT MESSAGE ID — which run() knows up
// front via `unstable_assistantMessageId` and append() sees as `item.message.id`
// — isolates every turn. When that optional id is absent, the thread plus the
// initiating user-message id is the equally stable append correlation; there
// is deliberately no global next-append fallback.

import type { UsageInfo } from "../lib/chatApi";

export interface PendingReceipt {
  usage: UsageInfo;
  modelId: string;
}

export interface PendingCompletion {
  completionId: string;
  model: string;
}

const pendingReceipts = new Map<string, PendingReceipt>();
const pendingCompletions = new Map<string, PendingCompletion>();
export interface TurnOutcome {
  turnId: string;
  sentAt: number;
  status: import('@tinyboilerplate/core').MeetingResultStatus;
  private: boolean;
  result?: import('@tinyboilerplate/core').MeetingResult;
}

/** A terminal handoff is persisted verbatim; reload restores it independently of history parents. */
export interface TurnOutcomeStore {
  begin(threadId: string, turnId: string, sentAt: number): void;
  claim(threadId: string, outcome: TurnOutcome): boolean;
  get(threadId: string, turnId: string): TurnOutcome | undefined;
  forMessage(threadId: string, messageId: string): TurnOutcome | undefined;
  bind(threadId: string, messageId: string, outcome: TurnOutcome): void;
}

export function createTurnOutcomeStore(): TurnOutcomeStore {
  const turns = new Map<string, TurnOutcome | null>();
  const messages = new Map<string, TurnOutcome>();
  const key = (threadId: string, id: string) => JSON.stringify([threadId, id]);
  return {
    begin(threadId, turnId) { if (!turns.has(key(threadId, turnId))) turns.set(key(threadId, turnId), null); },
    claim(threadId, outcome) {
      const k = key(threadId, outcome.turnId);
      if (turns.get(k)) return false;
      turns.set(k, structuredClone(outcome));
      return true;
    },
    get(threadId, turnId) { return turns.get(key(threadId, turnId)) ?? undefined; },
    forMessage(threadId, messageId) { return messages.get(key(threadId, messageId)); },
    bind(threadId, messageId, outcome) {
      const k = key(threadId, messageId);
      if (!messages.has(k)) messages.set(k, structuredClone(outcome));
      if (!turns.get(key(threadId, outcome.turnId))) turns.set(key(threadId, outcome.turnId), structuredClone(outcome));
    },
  };
}

export function messageTurnOutcome(message: unknown): TurnOutcome | undefined {
  const turn = (message as { metadata?: { custom?: { turn?: TurnOutcome } } })?.metadata?.custom?.turn;
  return turn && typeof turn.turnId === 'string' && ['completed', 'partial', 'unavailable', 'failed', 'cancelled', 'clarification_required'].includes(turn.status) ? turn : undefined;
}

/** Stash a message's pending receipt (run() at stream finish). */
export function setPendingReceipt(messageId: string, receipt: PendingReceipt): void {
  pendingReceipts.set(messageId, receipt);
}

/** Read-and-clear a message's pending receipt (computeReceipt). */
export function takePendingReceipt(messageId: string): PendingReceipt | null {
  const r = pendingReceipts.get(messageId) ?? null;
  pendingReceipts.delete(messageId);
  return r;
}

/** Stash a message's pending completion id (run() at stream finish). */
export function setPendingCompletion(messageId: string, completion: PendingCompletion): void {
  pendingCompletions.set(messageId, completion);
}

/** Read-and-clear a message's pending completion id (append()). */
export function takePendingCompletion(messageId: string): PendingCompletion | null {
  const c = pendingCompletions.get(messageId) ?? null;
  pendingCompletions.delete(messageId);
  return c;
}
