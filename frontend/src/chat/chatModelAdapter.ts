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
import type { ChatModelAdapter } from "@assistant-ui/react";
import type React from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { DEFAULT_MODEL } from "../lib/threadStore";

/** Subset of ChatRuntimeDeps consumed by the adapter factory. */
export interface AdapterDeps {
  sessionStore: SessionStore;
  backendUrl: string;
  modelRef: React.MutableRefObject<string>;
  activeThreadIdRef: React.MutableRefObject<string | null>;
  agentEnabledRef: React.MutableRefObject<boolean>;
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
      const payload: ChatMessage[] = [];

      // Prepend the merged model-context system prompt FIRST so memory (and
      // any other registered context provider) lands at the start of the
      // system content — the position least affected by context rot. The
      // existing payload filter at the for-loop below already accepts the
      // "system" role, so this matches the on-wire schema.
      const systemContent = context?.system;
      if (typeof systemContent === "string" && systemContent.length > 0) {
        payload.push({ role: "system", content: systemContent });
      }

      for (const m of messages) {
        if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue;
        const content = messageText(m);
        if (!content) continue;
        payload.push({ role: m.role, content });
      }

      const modelId = deps.modelRef.current || DEFAULT_MODEL;
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

      // C1: branch on agentEnabledRef. When the agent path is active, route to
      // streamAgentChat; otherwise keep the plain streamChat relay unchanged.
      if (deps.agentEnabledRef.current) {
        // C2: read the active thread id from the ref written by the per-thread
        // Provider so roomId is always current at call time.
        const roomId = deps.activeThreadIdRef.current ?? undefined;
        try {
          for await (const text of streamAgentChat({
            backendUrl: deps.backendUrl,
            getToken: () => deps.sessionStore.getToken(),
            model: modelId,
            messages: payload,
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
          // C4: clear the chip at turn end — on both clean completion and error/abort.
          if (unstable_assistantMessageId) {
            clearToolActivity(unstable_assistantMessageId);
          }
        }
      } else {
        for await (const text of streamChat({
          backendUrl: deps.backendUrl,
          sessionStore: deps.sessionStore,
          model: modelId,
          messages: payload,
          abortSignal,
          onUsage,
          onCompletionId,
        })) {
          yield { content: [{ type: "text", text }] };
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
