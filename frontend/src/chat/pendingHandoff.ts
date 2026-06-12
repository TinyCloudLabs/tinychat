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
// — isolates every turn: a finish can only ever be consumed by its own message.
// Message ids are globally unique, so this is immune to thread interleaving and
// to the new-thread `remoteId`-not-yet-resolved window.

import type { UsageInfo } from "../lib/chatApi";
import type { RelaySignature } from "../lib/completionStore";

export interface PendingReceipt {
  usage: UsageInfo;
  modelId: string;
}

export interface PendingCompletion {
  completionId: string;
  model: string;
  /** Attested-relay signature for this turn, when the backend emitted a frame. */
  relaySignature?: RelaySignature;
}

const pendingReceipts = new Map<string, PendingReceipt>();
const pendingCompletions = new Map<string, PendingCompletion>();

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
