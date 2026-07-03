// ── ChatModelAdapter factory (pure; no React hooks) ─────────────────
//
// Extracted from runtime.tsx so it can be tested without pulling in
// @assistant-ui/react (which requires DOM). Runtime.tsx re-exports it.
//
// C1: branches between streamChat (plain relay) and streamAgentChat (agent
// tool-calling path) based on deps.agentEnabledRef.current at call time.
// C2: reads deps.activeThreadIdRef.current for roomId on the agent path.
// C4: wires onToolActivity → toolActivityStore; clears at turn end.

import {
  streamChat,
  ContextOverflowError,
  type ChatMessage,
  type UsageInfo,
} from "../lib/chatApi";
import { streamAgentChat } from "../lib/agentChatApi";
import {
  clearToolActivity,
  setToolActivity,
} from "../lib/toolActivityStore";
import {
  setPendingCompletion,
  setPendingReceipt,
} from "./pendingHandoff";
import {
  COMPACT_TRIGGER_RATIO,
  COMPACT_TARGET_RATIO,
  RETRY_TARGET_RATIO,
  applyCheckpoint,
  buildSummarizationMessages,
  estimatePayloadTokens,
  isCheckpointValid,
  planCompaction,
  type CompactionCheckpoint,
  type PayloadMsgWithId,
} from "./compaction";
import type { ChatModelAdapter } from "@assistant-ui/react";
import type React from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { DEFAULT_MODEL } from "../lib/threadStore";
import { sanitizeModel } from "../lib/sanitizeModel";

/**
 * User-facing copy shown when a conversation is still too long AFTER a
 * compact-and-retry (spec §C.13). Provider-agnostic and actionable — NEVER a
 * raw status string and NEVER naming a model/provider vendor (§F.12).
 */
export const CONTEXT_OVERFLOW_MESSAGE =
  "This conversation is too long for the model even after compaction. Start a new chat to continue.";

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

/** Subset of ChatRuntimeDeps consumed by the adapter factory. */
export interface AdapterDeps {
  sessionStore: SessionStore;
  backendUrl: string;
  modelRef: React.MutableRefObject<string>;
  activeThreadIdRef: React.MutableRefObject<string | null>;
  agentEnabledRef: React.MutableRefObject<boolean>;
  /**
   * Live ref to the currently-offered model ids (from the loaded /models list).
   * Read at request time so the outgoing model is sanitized against the offered
   * catalog — a stale persisted id (e.g. a model dropped from the lineup) can
   * never fire a request and 403, regardless of which restore path set it.
   */
  offeredModelIdsRef: React.MutableRefObject<ReadonlySet<string>>;
  // ── Compaction deps (injected so unit tests can stub them; §D.3) ─────
  /** Latest checkpoint for a thread (or null). */
  getCheckpoint: (threadId: string) => Promise<CompactionCheckpoint | null>;
  /** Append a new checkpoint (INSERT-only) and return it. */
  appendCompaction: (
    threadId: string,
    coversThroughMessageId: string,
    summary: string,
  ) => Promise<CompactionCheckpoint>;
  /**
   * Single-shot summarization — wraps the PLAIN streamChat with
   * max_tokens = COMPACTION_SUMMARY_MAX_TOKENS. MUST NOT write to thread
   * storage or the memory doc and MUST NOT trigger memory extraction (§C.9/§F.3);
   * it bypasses the runtime exchange ring by construction.
   */
  summarize: (opts: { model: string; messages: ChatMessage[] }) => Promise<string>;
  /** Context window (tokens) for a model, falling back to DEFAULT_CONTEXT_TOKENS. */
  contextTokensFor: (modelId: string) => number;
}

/** Flatten an assistant-ui ThreadMessage's content parts into plain text. */
export function messageText(message: { content: readonly unknown[] }): string {
  return message.content
    .map((part) => {
      const p = part as { type?: string; text?: string };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

/**
 * Create the ChatModelAdapter. Reads all live values off refs at call time
 * (not at creation time), so the useMemo() can be stable for the component
 * lifetime. Exported for unit tests (runtimeAdapter.test.ts).
 */
export function createChatModelAdapter(deps: AdapterDeps): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, context, unstable_assistantMessageId }) {
      // Separate the memory system block (kept caller-side, prepended first so it
      // lands at the least-context-rotted position) from the conversation
      // messages (which compaction may fold into a summary checkpoint).
      const systemContent = context?.system;
      const memoryBlock: ChatMessage | null =
        typeof systemContent === "string" && systemContent.length > 0
          ? { role: "system", content: systemContent }
          : null;

      const convo: PayloadMsgWithId[] = [];
      for (const m of messages) {
        if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue;
        const content = messageText(m);
        if (!content) continue;
        const id = typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : "";
        convo.push({ id, role: m.role, content });
      }

      // Request-path heal (Bug #1): sanitize the selected id against the offered
      // catalog before it can hit the wire. Any restore path (localStorage, space
      // SQL active_model, per-thread row) can seed a stale non-offered id; this is
      // the single choke point that guarantees no request fires with one.
      const modelId = sanitizeModel(
        deps.modelRef.current || DEFAULT_MODEL,
        deps.offeredModelIdsRef.current,
      );

      // ── Compaction wiring (§D.3) ─────────────────────────────────────
      // All compaction deps are injected together (App wires them). When any is
      // absent — e.g. a unit harness that only exercises the transport branch —
      // the adapter degrades to exact baseline behaviour: full history, no
      // proactive/reactive compaction.
      const threadId = deps.activeThreadIdRef.current;
      const canCompact =
        !!threadId &&
        typeof deps.contextTokensFor === "function" &&
        typeof deps.getCheckpoint === "function" &&
        typeof deps.summarize === "function" &&
        typeof deps.appendCompaction === "function";
      const contextTokens = canCompact ? deps.contextTokensFor(modelId) : 0;
      const memoryChars = memoryBlock?.content.length ?? 0;
      const messageIds = convo.map((m) => m.id);

      // (a) Load + chain-validate the latest checkpoint (§C.8). Never crash on a
      // bad/stale checkpoint — an unreadable or invalid one just sends full
      // history and the reactive path re-compacts if needed.
      let activeCheckpoint: CompactionCheckpoint | null = null;
      if (canCompact && threadId) {
        let loaded: CompactionCheckpoint | null = null;
        try {
          loaded = await deps.getCheckpoint(threadId);
        } catch {
          loaded = null;
        }
        if (isCheckpointValid(loaded, messageIds)) activeCheckpoint = loaded;
      }

      const assemble = (cp: CompactionCheckpoint | null): ChatMessage[] => {
        const body: ChatMessage[] = cp
          ? (applyCheckpoint(convo, cp) as ChatMessage[])
          : convo.map((m) => ({ role: m.role, content: m.content }));
        return memoryBlock ? [memoryBlock, ...body] : body;
      };

      let payload = assemble(activeCheckpoint);
      if (canCompact && threadId) {
        patchCompaction(threadId, { summary: activeCheckpoint?.summary ?? null, compacting: false });
      }

      // Run a compaction pass at `targetRatio`: plan → summarize → append →
      // re-apply. Returns true when a new checkpoint was created/applied. The
      // summarization call bypasses the runtime exchange ring by construction
      // (it never touches thread storage / memory / extraction) — §C.9/§F.3.
      const runCompactionPass = async (targetRatio: number): Promise<boolean> => {
        if (!canCompact || !threadId) return false;
        const plan = planCompaction({
          messages: convo,
          memoryBlockChars: memoryChars,
          contextTokens,
          targetRatio,
          prevCheckpoint: activeCheckpoint,
        });
        if (!plan.needed || !plan.coversThroughMessageId) return false;
        patchCompaction(threadId, { compacting: true });
        try {
          const summaryMessages = buildSummarizationMessages(plan, activeCheckpoint?.summary);
          const summary = await deps.summarize({ model: modelId, messages: summaryMessages });
          const cp = await deps.appendCompaction(threadId, plan.coversThroughMessageId, summary);
          activeCheckpoint = cp;
          payload = assemble(cp);
          patchCompaction(threadId, { summary: cp.summary, compacting: false });
          return true;
        } finally {
          patchCompaction(threadId, { compacting: false });
        }
      };

      // (b) Proactive: pre-send estimate > 0.7 × context → compact first (§C.2).
      if (canCompact && estimatePayloadTokens(payload) > COMPACT_TRIGGER_RATIO * contextTokens) {
        await runCompactionPass(COMPACT_TARGET_RATIO);
      }

      let lastUsage: UsageInfo | null = null;
      let completionId: string | null = null;

      // Shared handlers — reused verbatim for both the plain relay and the agent
      // path so the receipt + verification badge fire identically on every turn.
      const onUsage = (u: UsageInfo) => {
        lastUsage = u;
      };
      const onCompletionId = (id: string) => {
        completionId = id;
      };

      // One transport attempt with the CURRENT payload. C1: branch on
      // agentEnabledRef (agent tool-calling vs plain relay). Both paths receive
      // the SAME compaction-rewritten payload; the server-side §C.11 guard covers
      // intra-round agent growth. ContextOverflowError is thrown BEFORE any yield
      // (pre-stream), so a reactive retry never double-emits text.
      const sendOnce = async function* (
        sendPayload: ChatMessage[],
      ): AsyncGenerator<{ content: { type: "text"; text: string }[] }, void, unknown> {
        if (deps.agentEnabledRef.current) {
          // C2: read the active thread id from the ref written by the per-thread
          // Provider so roomId is always current at call time.
          const roomId = deps.activeThreadIdRef.current ?? undefined;
          try {
            for await (const text of streamAgentChat({
              backendUrl: deps.backendUrl,
              getToken: () => deps.sessionStore.getToken(),
              model: modelId,
              messages: sendPayload,
              roomId,
              abortSignal,
              onUsage,
              onCompletionId,
              onToolActivity: unstable_assistantMessageId
                ? (a) => setToolActivity(unstable_assistantMessageId, a)
                : undefined,
            })) {
              yield { content: [{ type: "text", text }] };
            }
          } finally {
            // C4: clear the chip at turn end — on clean completion and error/abort.
            if (unstable_assistantMessageId) {
              clearToolActivity(unstable_assistantMessageId);
            }
          }
        } else {
          for await (const text of streamChat({
            backendUrl: deps.backendUrl,
            sessionStore: deps.sessionStore,
            model: modelId,
            messages: sendPayload,
            abortSignal,
            onUsage,
            onCompletionId,
          })) {
            yield { content: [{ type: "text", text }] };
          }
        }
      };

      // (c) Reactive: on a typed ContextOverflowError with NO prior retry this
      // run, force-plan at RETRY_TARGET_RATIO, compact, and retry ONCE (§C.13).
      // A second overflow surfaces the friendly, provider-agnostic error. At most
      // one reactive retry per run() (§F.8). A 402/403 raised during the
      // summarization call is NOT a ContextOverflowError — it bubbles through the
      // existing typed emitters unchanged (§F.4).
      let reactiveRetried = false;
      for (;;) {
        try {
          yield* sendOnce(payload);
          break;
        } catch (err) {
          if (err instanceof ContextOverflowError && canCompact && !reactiveRetried) {
            reactiveRetried = true;
            await runCompactionPass(RETRY_TARGET_RATIO);
            continue;
          }
          if (err instanceof ContextOverflowError) {
            // Terminal overflow (retry exhausted, or compaction unavailable):
            // always surface the vendor-agnostic friendly copy. The raw
            // ContextOverflowError.message carries the upstream detail, which may
            // name a model/provider — never render it verbatim (§C.13/§F.12).
            throw new Error(CONTEXT_OVERFLOW_MESSAGE);
          }
          throw err;
        }
      }

      // Stream completed cleanly. Stash the usage + completion id keyed by THIS
      // assistant message id (ST4) so its `append()`/receipt hook consumes
      // exactly its own handoff. Message ids are globally unique, so an
      // interleaved finish on another thread can never overwrite ours (the
      // module-slot race). `unstable_assistantMessageId` equals the id append()
      // sees as `item.message.id`. If it is absent the handoff simply no-ops (no
      // badge/receipt) — never a wrong one.
      if (unstable_assistantMessageId) {
        if (lastUsage) {
          setPendingReceipt(unstable_assistantMessageId, { usage: lastUsage, modelId });
        }
        if (completionId) {
          setPendingCompletion(unstable_assistantMessageId, { completionId, model: modelId });
        }
      }
    },
  };
}
