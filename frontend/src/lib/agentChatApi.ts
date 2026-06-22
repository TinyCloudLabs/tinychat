// Frontend SSE adapter for the agent (tool-calling) chat path (Milestone E, §5).
//
// Mirrors lib/chatApi.ts streamChat (cumulative-text yield contract for the
// assistant-ui ChatModelAdapter) but targets POST /api/agent/chat and surfaces the
// extra `tool_activity` frames the orchestration emits (web search running/done) via
// an onToolActivity callback — the plain streamChat consumer ignores those frames.
//
// Eliza-tool note: the agent path needs a registered delegation only for tools that
// touch the user's own space; web_search needs none. Callers should still run
// ensureAgentSession() (lib/agentDelegation.ts) before the first agent turn so
// per-user-data tools work and the session is live.

import {
  type UsageInfo,
  PaywallError,
  ModelSelectionError,
  type PaywallErrorPayload,
  type ModelSelectionErrorPayload,
} from "./chatApi.js";

export type { UsageInfo };

// Agent-path paywall pub-sub. Mirrors chatApi.ts's internal emitBilling for the
// agent path (chatApi.ts's emitter is module-private). App.tsx subscribes to both
// so the pricing dialog opens on 402 regardless of which path is active.
type AgentPaywallListener = (payload: PaywallErrorPayload) => void;
const agentPaywallListeners = new Set<AgentPaywallListener>();

export function onAgentPaywallError(listener: AgentPaywallListener): () => void {
  agentPaywallListeners.add(listener);
  return () => { agentPaywallListeners.delete(listener); };
}

function emitAgentPaywallError(payload: PaywallErrorPayload): void {
  for (const listener of agentPaywallListeners) {
    try { listener(payload); } catch { /* listener throw must not break the stream */ }
  }
}

type AgentModelSelectionListener = (payload: ModelSelectionErrorPayload) => void;
const agentModelSelectionListeners = new Set<AgentModelSelectionListener>();

export function onAgentModelSelectionError(listener: AgentModelSelectionListener): () => void {
  agentModelSelectionListeners.add(listener);
  return () => { agentModelSelectionListeners.delete(listener); };
}

function emitAgentModelSelectionError(payload: ModelSelectionErrorPayload): void {
  for (const listener of agentModelSelectionListeners) {
    try { listener(payload); } catch { /* listener throw must not break the stream */ }
  }
}

export interface AgentChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolActivity {
  name: string;
  status: "running" | "done" | "error";
}

export interface StreamAgentChatOptions {
  backendUrl: string;
  getToken: () => string | null;
  model?: string;
  messages: AgentChatMessage[];
  /** tinychat thread id bound to this turn (session-summary room key). */
  roomId?: string;
  abortSignal?: AbortSignal;
  /** Fired per tool_activity frame (e.g. to render "Searching the web…"). */
  onToolActivity?: (activity: ToolActivity) => void;
  /**
   * Called once with the completion id from the first frame that carries one.
   * Byte-identical behaviour to chatApi.ts streamChat — guarded by idReported.
   */
  onCompletionId?: (id: string) => void;
  /**
   * Called once with token usage from the final usage frame
   * (`{choices:[], usage:{prompt_tokens, completion_tokens}}`).
   * Reuses the UsageInfo type from chatApi.ts so runtime.tsx handlers are compatible.
   */
  onUsage?: (u: UsageInfo) => void;
}

const CSRF_HEADER = "X-Requested-With";
const CSRF_VALUE = "XMLHttpRequest";

/**
 * Stream the agent chat turn. Yields the CUMULATIVE assistant text after each
 * content delta (assistant-ui contract). Tool activity is surfaced via
 * onToolActivity, not the yield stream.
 */
export async function* streamAgentChat(
  options: StreamAgentChatOptions,
): AsyncGenerator<string, void, unknown> {
  const { backendUrl, getToken, model, messages, roomId, abortSignal, onToolActivity, onCompletionId, onUsage } = options;

  const token = getToken();
  if (!token) throw new Error("Not authenticated. Please sign in.");

  const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/agent/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [CSRF_HEADER]: CSRF_VALUE,
    },
    body: JSON.stringify({ ...(model ? { model } : {}), messages, ...(roomId ? { roomId } : {}) }),
    signal: abortSignal,
  });

  if (res.status === 401) throw new Error("Session expired. Please sign in again.");
  if (res.status === 402) {
    let payload: PaywallErrorPayload;
    try {
      payload = (await res.json()) as PaywallErrorPayload;
    } catch {
      payload = { error: "credit_budget_exceeded", message: "You've reached your plan's limit. Upgrade to continue.", tier: "free" };
    }
    emitAgentPaywallError(payload);
    throw new PaywallError(payload);
  }
  if (res.status === 403) {
    let modelPayload: ModelSelectionErrorPayload | null = null;
    try {
      const body = (await res.json()) as Partial<ModelSelectionErrorPayload>;
      if (body.error === "model_not_offered" || body.error === "model_blocklisted") {
        modelPayload = { error: body.error, message: typeof body.message === "string" ? body.message : "This model is not available." };
      }
    } catch {
      // non-JSON 403 body; fall through to generic error
    }
    if (modelPayload) {
      emitAgentModelSelectionError(modelPayload);
      throw new ModelSelectionError(modelPayload);
    }
  }
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const err = await res.json();
      detail = err.message ?? err.error ?? detail;
    } catch {
      // non-JSON error body
    }
    throw new Error(`Agent chat request failed (${res.status}): ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let idReported = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const rawLine of frame.split("\n")) {
          const line = rawLine.trimStart();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          if (!data) continue;
          try {
            const json = JSON.parse(data);
            const activity = json?.tool_activity;
            if (activity && onToolActivity && typeof activity.name === "string") {
              try {
                onToolActivity({ name: activity.name, status: activity.status });
              } catch {
                // a listener throwing must not break the stream
              }
            }
            // Surface the completion id from the first frame that carries one.
            // Fired before the delta yield; a throwing listener is swallowed.
            const completionId = json?.id;
            if (onCompletionId && !idReported && typeof completionId === "string" && completionId) {
              idReported = true;
              try {
                onCompletionId(completionId);
              } catch {
                // caller throwing must not break the stream
              }
            }
            const chunk: string = json?.choices?.[0]?.delta?.content ?? "";
            if (chunk) {
              text += chunk;
              yield text;
              continue;
            }
            // Final usage frame: populated `usage`. Surface to the caller.
            const usage = json?.usage;
            if (
              onUsage &&
              usage &&
              typeof usage.prompt_tokens === "number" &&
              typeof usage.completion_tokens === "number"
            ) {
              try {
                onUsage({
                  promptTokens: usage.prompt_tokens,
                  completionTokens: usage.completion_tokens,
                });
              } catch {
                // caller throwing must not break the stream
              }
            }
          } catch {
            // ignore malformed frame
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
