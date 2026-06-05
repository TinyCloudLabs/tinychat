import {
  DEFAULT_REQUEST_HEADER_NAME,
  DEFAULT_REQUEST_HEADER_VALUE,
  type SessionStore,
} from "@tinyboilerplate/client";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Shape of the 402 body the backend returns when a request is paywalled. */
export interface PaywallErrorPayload {
  error: "model_not_allowed" | "credit_budget_exceeded";
  message: string;
  tier: string;
  requiredTier?: "plus" | "pro";
  usage?: { used: number; limit: number; resetsAt: string };
}

/** SSE usage chunk surfaced to the caller when the stream completes. */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Thrown when the chat endpoint returns 402 (model not allowed for the current
 * tier, or credit budget exhausted). Carries the parsed body so the UI can both
 * surface `message` in-chat (via assistant-ui ErrorPrimitive) AND open the
 * pricing dialog. Errors thrown from `streamChat` bubble up through the
 * ChatModelAdapter, so we ALSO emit on a small global emitter (below) at throw
 * time — the runtime doesn't give us a place to inspect the thrown error before
 * assistant-ui renders it.
 */
export class PaywallError extends Error {
  readonly payload: PaywallErrorPayload;
  constructor(payload: PaywallErrorPayload) {
    super(payload.message || "This action requires an upgrade.");
    this.name = "PaywallError";
    this.payload = payload;
  }
}

// ── Billing-event emitter (paywall + receipt) ───────────────────────

export type BillingEvent =
  | { type: "paywall"; payload: PaywallErrorPayload }
  | { type: "receipt"; messageId: string; credits: number; modelId: string };

type BillingListener = (event: BillingEvent) => void;
const billingListeners = new Set<BillingListener>();

/** Subscribe to billing events (paywall 402s and per-message receipts). */
export function onBillingEvent(listener: BillingListener): () => void {
  billingListeners.add(listener);
  return () => {
    billingListeners.delete(listener);
  };
}

function emitBilling(event: BillingEvent): void {
  for (const listener of billingListeners) {
    try {
      listener(event);
    } catch {
      // a listener throwing must not break the chat error / receipt path
    }
  }
}

/** Subscribe only to paywall (402) events. Returns an unsubscribe fn. */
export function onPaywallError(
  listener: (payload: PaywallErrorPayload) => void,
): () => void {
  return onBillingEvent((event) => {
    if (event.type === "paywall") listener(event.payload);
  });
}

/** Emit a receipt event (called from runtime.tsx after a stream completes). */
export function emitReceipt(messageId: string, credits: number, modelId: string): void {
  emitBilling({ type: "receipt", messageId, credits, modelId });
}

export interface StreamChatOptions {
  backendUrl: string;
  sessionStore: SessionStore;
  model: string;
  messages: ChatMessage[];
  /** Optional API-level output cap (forwarded as max_tokens). */
  maxTokens?: number;
  abortSignal?: AbortSignal;
  /**
   * Called once when the SSE usage chunk (final frame with empty `choices` and
   * `usage: { prompt_tokens, completion_tokens, ... }`) is observed. The
   * cumulative-text yield contract is unaffected — runtime.tsx still receives
   * text deltas via the generator.
   */
  onUsage?: (usage: UsageInfo) => void;
}

/**
 * Raw streaming fetch against the backend chat proxy.
 *
 * The api client (`createApiClient`) parses JSON, so it cannot be used for the
 * SSE response. This helper mirrors its auth/CSRF headers but streams the body.
 *
 * Yields the CUMULATIVE assistant text after each delta — assistant-ui's
 * ChatModelAdapter expects the full text-so-far on every yield. Token usage is
 * surfaced via the `onUsage` option, not the yield stream.
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<string, void, unknown> {
  const { backendUrl, sessionStore, model, messages, maxTokens, abortSignal, onUsage } = options;

  const token = sessionStore.getToken();
  if (!token) {
    throw new Error("Not authenticated. Please sign in.");
  }
  if (sessionStore.isExpired()) {
    sessionStore.clear();
    throw new Error("Session expired. Please sign in again.");
  }

  const res = await fetch(`${backendUrl}/api/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
    },
    body: JSON.stringify(
      typeof maxTokens === "number" && maxTokens > 0
        ? { model, messages, max_tokens: maxTokens }
        : { model, messages },
    ),
    signal: abortSignal,
  });

  if (res.status === 401) {
    sessionStore.clear();
    throw new Error("Session expired. Please sign in again.");
  }
  if (res.status === 402) {
    // Paywalled: parse the typed body, broadcast so the UI can open the
    // pricing dialog, and throw PaywallError so the human message still renders
    // in-chat via ErrorPrimitive.
    let payload: PaywallErrorPayload;
    try {
      payload = (await res.json()) as PaywallErrorPayload;
    } catch {
      payload = {
        error: "credit_budget_exceeded",
        message: "You've reached your plan's limit. Upgrade to continue.",
        tier: "free",
      };
    }
    emitBilling({ type: "paywall", payload });
    throw new PaywallError(payload);
  }
  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const err = await res.json();
      detail = err.message ?? err.error ?? detail;
    } catch {
      // non-JSON error body
    }
    throw new Error(`Chat request failed (${res.status}): ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        for (const rawLine of frame.split("\n")) {
          const line = rawLine.trimStart();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          if (!data) continue;
          try {
            const json = JSON.parse(data);
            const chunk: string = json?.choices?.[0]?.delta?.content ?? "";
            if (chunk) {
              text += chunk;
              yield text;
              continue;
            }
            // Final usage frame: empty `choices`, populated `usage`. Surface
            // to the caller without disturbing the cumulative-text contract.
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

/**
 * Single-shot, non-streaming completion built on top of `streamChat`.
 *
 * The backend proxy only exposes the streaming endpoint; this helper
 * accumulates the SSE deltas and returns the final assistant text. Used by
 * the memory extraction pipeline (off the visible reply path), so a small
 * model + tight max-output should be passed via `model`.
 *
 * No backend/route change: this reuses the existing `/api/chat` proxy.
 */
export async function completeChat(options: StreamChatOptions): Promise<string> {
  let final = "";
  for await (const text of streamChat(options)) {
    final = text; // streamChat yields the cumulative text-so-far per delta
  }
  return final;
}
