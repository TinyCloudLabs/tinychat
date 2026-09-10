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
  classifyContextOverflow,
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
  /** Distinguishes concurrent calls to the same tool; absent on legacy frames. */
  id?: string;
}

export type AgentDelegationErrorCode = "delegation_required" | "delegation_expired" | "delegation_revoked";

export type AgentStreamErrorCode =
  | "transport"
  | "incomplete"
  | "turn_timeout"
  | "upstream_incomplete"
  | "upstream_failed"
  | "interpretation_failed"
  | "interpretation_timeout"
  | "result_size_limit"
  | "agent_failed";

/** Expected stream failures carry only bounded codes and safe display copy. */
export class AgentStreamError extends Error {
  constructor(readonly code: AgentStreamErrorCode) {
    super(code === "turn_timeout"
      ? "This reply took too long to finish. You can try again."
      : code === "interpretation_failed"
        ? "I could not interpret that request. Please rephrase it and try again."
        : code === "interpretation_timeout"
          ? "Understanding this request took too long. Please try again."
          : code === "upstream_failed"
            ? "The model service could not complete this request. Please try again later."
            : code === "upstream_incomplete"
              ? "The model service returned an incomplete reply. Please try again."
              : code === "result_size_limit"
                ? "The response was too large to process safely. Try a smaller request or fewer meetings."
                : "The connection ended before the reply finished. You can try again.");
    this.name = "AgentStreamError";
  }
}

export interface StreamAgentChatOptions {
  backendUrl: string;
  getToken: () => string | null;
  model?: string;
  messages: AgentChatMessage[];
  /** tinychat thread id bound to this turn (session-summary room key). */
  roomId?: string;
  /** Injectable for tests; normal browser turns derive this from the local clock. */
  clientContext?: AgentClientContext;
  abortSignal?: AbortSignal;
  /** Fired per tool_activity frame (e.g. to render "Searching the web…"). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Fired when a private-data tool reports that its delegation needs renewal. */
  onDelegationError?: (code: AgentDelegationErrorCode) => void;
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

export interface AgentClientContext {
  localDate: string;
  timeZone: string;
}

export function currentAgentClientContext(now = new Date()): AgentClientContext {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value ?? "";
  return { localDate: `${value("year")}-${value("month")}-${value("day")}`, timeZone };
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
  const {
    backendUrl,
    getToken,
    model,
    messages,
    roomId,
    abortSignal,
    onToolActivity,
    onDelegationError,
    onCompletionId,
    onUsage,
  } = options;
  const clientContext = options.clientContext ?? currentAgentClientContext();

  const token = getToken();
  if (!token) throw new Error("Not authenticated. Please sign in.");

  abortSignal?.throwIfAborted();
  let res: Response;
  try {
    res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/agent/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        [CSRF_HEADER]: CSRF_VALUE,
      },
      body: JSON.stringify({ ...(model ? { model } : {}), messages, ...(roomId ? { roomId } : {}), clientContext }),
      signal: abortSignal,
    });
  } catch {
    abortSignal?.throwIfAborted();
    throw new AgentStreamError("transport");
  }

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
  if (!res.ok) {
    // Context-overflow (§C.12): 413 (incl. Wall-A non-JSON) or a JSON
    // error.code === "context_overflow" → typed ContextOverflowError, distinct
    // from the 401/402/403 branches above (§F.8). Reuses the plain-path
    // classifier so both transports agree.
    const { overflow, detail } = await classifyContextOverflow(res);
    if (overflow) throw overflow;
    throw new Error(`Agent chat request failed (${res.status}): ${detail}`);
  }
  if (!res.body) {
    abortSignal?.throwIfAborted();
    throw new AgentStreamError("incomplete");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let idReported = false;
  let cancelled = false;
  const cancelReader = () => {
    if (cancelled) return;
    cancelled = true;
    // Cancellation settles pending reads synchronously. Its underlying source
    // cleanup may never settle, so handle it without delaying DONE or Stop.
    void reader.cancel().catch(() => {});
  };
  abortSignal?.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      abortSignal?.throwIfAborted();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        abortSignal?.throwIfAborted();
        throw new AgentStreamError("transport");
      }
      abortSignal?.throwIfAborted();
      const { done, value } = result;
      if (done) throw new AgentStreamError("incomplete");
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const rawLine of frame.split("\n")) {
          abortSignal?.throwIfAborted();
          const line = rawLine.trimStart();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          if (!data) continue;
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            // Ignore an incomplete/malformed event, including an abandoned
            // partial frame separated from a later terminal error by LF/LF.
            continue;
          }
          if (json?.stream_error) {
            const code = json.stream_error.code;
            throw new AgentStreamError(
              code === "turn_timeout" || code === "upstream_incomplete" || code === "upstream_failed" || code === "interpretation_failed"
                || code === "interpretation_timeout" || code === "result_size_limit"
                ? code : "agent_failed",
            );
          }
          const activity = json?.tool_activity;
          if (activity && onToolActivity && typeof activity.name === "string") {
            try {
              onToolActivity({
                name: activity.name,
                status: activity.status,
                ...(typeof activity.id === "string" && activity.id ? { id: activity.id } : {}),
              });
            } catch {
              // a listener throwing must not break the stream
            }
          }
          const delegationCode = json?.delegation_error?.code;
          if (
            onDelegationError &&
            (delegationCode === "delegation_required" || delegationCode === "delegation_expired" || delegationCode === "delegation_revoked")
          ) {
            try {
              onDelegationError(delegationCode);
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
          abortSignal?.throwIfAborted();
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
        }
      }
    }
  } finally {
    abortSignal?.removeEventListener("abort", cancelReader);
    cancelReader();
    reader.releaseLock();
  }
}
