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
// Meeting-turn classification is intentionally a tiny, run→append-only handoff.
// It must not travel with the persisted assistant item: M1-18 consumes it before
// post-append memory work.
export interface MeetingTurnCorrelation {
  threadId: string;
  userMessageId: string;
}

export interface MeetingMessageRegistry {
  classify(input: {
    threadId: string;
    assistantMessageId?: string;
    userMessageId?: string;
  }): boolean;
  resolveAssistant(input: MeetingTurnCorrelation & { assistantMessageId: string }): boolean;
  isClassified(threadId: string, assistantMessageId: string): boolean;
}

function assistantKey(threadId: string, messageId: string): string {
  return `${threadId}\u0000assistant\u0000${messageId}`;
}

function turnKey(threadId: string, userMessageId: string): string {
  return `${threadId}\u0000user\u0000${userMessageId}`;
}

/**
 * Workspace-scoped, content-free classification for meeting assistant replies.
 * The owner discards this object when its mounted workspace changes/unmounts.
 */
export function createMeetingMessageRegistry(): MeetingMessageRegistry {
  const assistants = new Set<string>();
  const pendingTurns = new Set<string>();
  return {
    classify({ threadId, assistantMessageId, userMessageId }) {
      if (assistantMessageId) {
        assistants.add(assistantKey(threadId, assistantMessageId));
        return true;
      }
      if (userMessageId) {
        pendingTurns.add(turnKey(threadId, userMessageId));
        return true;
      }
      return false;
    },
    resolveAssistant({ threadId, userMessageId, assistantMessageId }) {
      const resolvedKey = assistantKey(threadId, assistantMessageId);
      if (assistants.has(resolvedKey)) return true;
      const pendingKey = turnKey(threadId, userMessageId);
      if (!pendingTurns.has(pendingKey)) return false;
      pendingTurns.delete(pendingKey);
      assistants.add(resolvedKey);
      return true;
    },
    isClassified(threadId, assistantMessageId) {
      return assistants.has(assistantKey(threadId, assistantMessageId));
    },
  };
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
