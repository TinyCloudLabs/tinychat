import type { ChatModelAdapter } from '@assistant-ui/react';
import type React from 'react';
import type { SessionStore } from '@tinyboilerplate/client';
import type { MeetingTurnInput, MeetingResult } from '@tinyboilerplate/core';
import { streamAgentChat, AgentStreamError, type AgentDelegationErrorCode } from '../lib/agentChatApi';
import { ContextOverflowError, type UsageInfo } from '../lib/chatApi';
import { clearToolActivity, setToolActivity } from '../lib/toolActivityStore';
import { setPendingCompletion, setPendingReceipt, createTurnOutcomeStore, messageTurnOutcome, type TurnOutcomeStore } from './pendingHandoff';
import type { CompactionCheckpoint } from './compaction';
import type { ModelSelectionCoordinator } from './modelSelection';

export const CONTEXT_OVERFLOW_MESSAGE = 'This conversation is too long for the model even after compaction. Start a new chat to continue.';

// ── Compaction indicator store (subtle UX; §C.14) ────────────────────
//
// A tiny per-thread module store the adapter writes when it applies/creates a
// checkpoint, so the thread view can render "Earlier conversation summarized"
// (with an affordance to read the summary) and a transient "Compacting…" hint.
// Mirrors the toolActivityStore pattern (useSyncExternalStore-friendly).

export interface CompactionIndicator {
  /** The active checkpoint summary text (null while none applies). */
  summary: string | null;
  /** True during an in-flight compaction pass (transient hint). */
  compacting: boolean;
}

const compactionState = new Map<string, CompactionIndicator>();
const compactionListeners = new Set<() => void>();

function notifyCompaction(): void {
  for (const l of compactionListeners) {
    try {
      l();
    } catch {
      // a listener throwing must not break the chat path
    }
  }
}

function patchCompaction(threadId: string, patch: Partial<CompactionIndicator>): void {
  const prev = compactionState.get(threadId) ?? { summary: null, compacting: false };
  const next: CompactionIndicator = { ...prev, ...patch };
  if (next.summary === prev.summary && next.compacting === prev.compacting && compactionState.has(threadId)) {
    return;
  }
  compactionState.set(threadId, next);
  notifyCompaction();
}

/** Read the compaction indicator for a thread (stable reference per state). */
export function getThreadCompaction(threadId: string | null | undefined): CompactionIndicator | null {
  if (!threadId) return null;
  return compactionState.get(threadId) ?? null;
}

/** Subscribe to compaction-indicator changes (useSyncExternalStore contract). */
export function subscribeThreadCompaction(cb: () => void): () => void {
  compactionListeners.add(cb);
  return () => {
    compactionListeners.delete(cb);
  };
}

export interface AdapterDeps {
  sessionStore: SessionStore;
  backendUrl: string;
  selection: ModelSelectionCoordinator;
  agentEnabledRef: React.MutableRefObject<boolean>;
  onAgentDelegationError?: (code: AgentDelegationErrorCode) => void;
  turnOutcomes?: TurnOutcomeStore;
  getCheckpoint?: (threadId: string) => Promise<CompactionCheckpoint | null>;
  appendCompaction?: (threadId: string, coversThroughMessageId: string, summary: string) => Promise<CompactionCheckpoint>;
}

export function messageText(message: { content: readonly unknown[] }): string {
  return message.content.map(part => {
    const p = part as { type?: string; text?: string };
    return p.type === 'text' && typeof p.text === 'string' ? p.text : '';
  }).join('');
}

function withinTurn<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Every Send is classified by the backend before any model or compaction work. */
export function createChatModelAdapter(deps: AdapterDeps): ChatModelAdapter {
  const outcomes = deps.turnOutcomes ?? createTurnOutcomeStore();
  return {
    async *run({ messages, abortSignal, context, unstable_assistantMessageId }) {
      const latestUser = [...messages].reverse().find(message => message.role === 'user');
      if (!latestUser?.id) throw new Error('Cannot send without a stable user-message id.');
      const turnId = latestUser.id;
      const createdAt = latestUser.createdAt instanceof Date ? latestUser.createdAt.getTime() : Date.now();
      const sentAt = Number.isFinite(createdAt) ? Math.min(createdAt, Date.now()) : Date.now();
      const deadline = AbortSignal.timeout(Math.max(1, 120_000 - (Date.now() - sentAt)));
      abortSignal = AbortSignal.any([abortSignal, deadline]);
      const cancelSelection = deps.selection.captureCancel();
      abortSignal.addEventListener('abort', cancelSelection, { once: true });
      let origin;
      try {
        abortSignal.throwIfAborted();
        origin = await withinTurn(deps.selection.beginActiveTurn(turnId), abortSignal);
      } finally { abortSignal.removeEventListener('abort', cancelSelection); }
      abortSignal = AbortSignal.any([abortSignal, origin.signal, deadline]);
      const threadId = origin.threadId;
      outcomes.begin(threadId, turnId, sentAt);
      let result: MeetingResult | undefined;
      const cancel = () => outcomes.claim(threadId, { turnId, sentAt, status: deadline.aborted ? 'failed' : 'cancelled', private: true });
      abortSignal.addEventListener('abort', cancel, { once: true });
      const assertTurn = () => { abortSignal.throwIfAborted(); deps.selection.assertActive(origin); };
      let lastUsage: UsageInfo | undefined;
      let completionId: string | undefined;
      let pendingCheckpoint: { coversThroughMessageId: string; summary: string } | undefined;
      try {
        assertTurn();
        await withinTurn(deps.selection.waitForAppend(origin), abortSignal);
        assertTurn();
        deps.selection.setRunning(origin, true);
        const storedCheckpoint = deps.getCheckpoint ? await withinTurn(deps.getCheckpoint(threadId), abortSignal) : null;
        const checkpoint = typeof storedCheckpoint?.id === "string" && storedCheckpoint.id.startsWith("ordinary-v3:") ? storedCheckpoint : null;
        assertTurn();
        const parentMessage = [...messages].reverse().find(message => message.role === 'assistant');
        const parentOutcome = parentMessage && (messageTurnOutcome(parentMessage) ?? outcomes.forMessage(threadId, parentMessage.id));
        const custom = latestUser.metadata?.custom as { meetingTurn?: Partial<MeetingTurnInput> } | undefined;
        const explicit = custom?.meetingTurn;
        const turn: MeetingTurnInput = {
          ...explicit, turnId, sentAt,
          ...(parentMessage && !explicit?.parentMessageId ? { parentMessageId: parentMessage.id } : {}),
          ...(parentOutcome?.result && parentMessage && !explicit?.parent ? { parent: { messageId: parentMessage.id, turnId: parentOutcome.turnId, sources: parentOutcome.result.sources } } : {}),
          ...(!explicit?.continuation && /^continue[.!?]?$/i.test(messageText(latestUser).trim()) && parentOutcome?.result?.continuation ? { continuation: parentOutcome.result.continuation } : {}),
        };
        const privateUserIds = new Set<string>();
        for (const message of messages) {
          const prior = messageTurnOutcome(message) ?? outcomes.forMessage(threadId, message.id);
          if (prior?.private) privateUserIds.add(prior.turnId);
        }
        const payload = messages.filter(message => {
          if (message.id === turnId) return true;
          const prior = messageTurnOutcome(message) ?? outcomes.forMessage(threadId, message.id);
          return !prior?.private && !privateUserIds.has(message.id);
        }).filter(message => ['user', 'assistant', 'system'].includes(message.role)).map(message => ({
          id: message.id, role: message.role as 'user' | 'assistant' | 'system', content: messageText(message),
        }));
        for await (const text of streamAgentChat({
          backendUrl: deps.backendUrl, getToken: () => deps.sessionStore.getToken(), model: origin.model,
          messages: payload, roomId: threadId, turn, publicTools: deps.agentEnabledRef.current,
          preparation: { checkpoint, memory: typeof context?.system === 'string' ? context.system : '' },
          abortSignal, onUsage: usage => { lastUsage = usage; }, onCompletionId: id => { completionId = id; },
          onMeetingResult: value => { assertTurn(); if (pendingCheckpoint) throw new AgentStreamError('incomplete'); result = value; },
          onCompactionCheckpoint: cp => {
            assertTurn();
            if (result || pendingCheckpoint || !payload.some(message => message.id === cp.coversThroughMessageId)) throw new AgentStreamError('incomplete');
            // A later private/error/malformed frame must prevent fact promotion.
            pendingCheckpoint = cp;
          },
          onDelegationError: deps.onAgentDelegationError,
          onToolActivity: unstable_assistantMessageId ? activity => setToolActivity(unstable_assistantMessageId, activity) : undefined,
        })) {
          assertTurn();
          yield { content: [{ type: 'text', text }] };
        }
        if (pendingCheckpoint && deps.appendCompaction) {
          assertTurn();
          if (result) throw new AgentStreamError('incomplete');
          const saved = await withinTurn(deps.appendCompaction(threadId, pendingCheckpoint.coversThroughMessageId, pendingCheckpoint.summary), abortSignal);
          assertTurn();
          patchCompaction(threadId, { summary: saved.summary, compacting: false });
        }
        assertTurn();
        const terminal = { turnId, sentAt, status: result?.status ?? 'completed' as const, private: !!result, ...(result ? { result } : {}) };
        if (!outcomes.claim(threadId, terminal)) return;
        if (unstable_assistantMessageId) {
          outcomes.bind(threadId, unstable_assistantMessageId, terminal);
          if (lastUsage) setPendingReceipt(unstable_assistantMessageId, { usage: lastUsage, modelId: origin.model });
          if (completionId) setPendingCompletion(unstable_assistantMessageId, { completionId, model: origin.model });
        }
        yield { metadata: { custom: { turn: terminal } } };
      } catch (error) {
        if (abortSignal.aborted) cancel();
        else outcomes.claim(threadId, { turnId, sentAt, status: 'failed', private: true });
        const terminal = outcomes.get(threadId, turnId)!;
        if (unstable_assistantMessageId) outcomes.bind(threadId, unstable_assistantMessageId, terminal);
        if (abortSignal.aborted) {
          yield { metadata: { custom: { turn: terminal } }, status: terminal.status === 'cancelled'
            ? { type: 'incomplete', reason: 'cancelled' }
            : { type: 'incomplete', reason: 'error', error: 'This reply took too long to finish. You can try again.' } };
          return;
        }
        if (error instanceof AgentStreamError || error instanceof ContextOverflowError) {
          yield { metadata: { custom: { turn: terminal } }, status: { type: 'incomplete', reason: 'error', error: error instanceof ContextOverflowError ? CONTEXT_OVERFLOW_MESSAGE : error.message } };
          return;
        }
        throw error;
      } finally {
        abortSignal.removeEventListener('abort', cancel);
        if (unstable_assistantMessageId) clearToolActivity(unstable_assistantMessageId);
        deps.selection.setRunning(origin, false);
      }
    },
  };
}
