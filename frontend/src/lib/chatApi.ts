import {
  type SessionStore,
} from "@tinyboilerplate/client";

const DEFAULT_REQUEST_HEADER_NAME = "X-Requested-With";
const DEFAULT_REQUEST_HEADER_VALUE = "XMLHttpRequest";

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

export interface ModelSelectionErrorPayload {
  error: "model_not_offered" | "model_blocklisted";
  message: string;
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

export class ModelSelectionError extends Error {
  readonly payload: ModelSelectionErrorPayload;
  constructor(payload: ModelSelectionErrorPayload) {
    super(payload.message || "This model is not available.");
    this.name = "ModelSelectionError";
    this.payload = payload;
  }
}

/**
 * Thrown when the backend (or Wall-A body parser) signals a context-window
 * overflow (spec §C.12): HTTP 413 — including the non-JSON `PayloadTooLargeError`
 * body the global express.json limit emits before any handler runs — or a JSON
 * body carrying `error.code === "context_overflow"`. Kept DISTINCT from the
 * 401/402/403 typed emitters (§F.8) so the adapter can compact-and-retry.
 */
export class ContextOverflowError extends Error {
  readonly code = "context_overflow";
  constructor(message = "The conversation exceeds the model's context window.") {
    super(message);
    this.name = "ContextOverflowError";
  }
}

/**
 * Defensive classifier for the non-ok branch. A 413 (JSON or not) is always an
 * overflow; otherwise a parsed JSON `error.code === "context_overflow"` (nested
 * or flat) is too. Returns null when the response is not an overflow so the
 * caller can fall through to its existing generic error. Consumes the body via
 * `res.text()` so the caller does not double-read it.
 */
export async function classifyContextOverflow(
  res: Response,
): Promise<{ overflow: ContextOverflowError | null; detail: string }> {
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    // body already consumed / unreadable — status alone still classifies 413.
  }
  let detail = res.statusText;
  let code: unknown;
  try {
    const parsed = JSON.parse(bodyText) as {
      message?: unknown;
      code?: unknown;
      error?: { code?: unknown; message?: unknown } | string;
    };
    code =
      (parsed.error && typeof parsed.error === "object" ? parsed.error.code : undefined) ??
      parsed.code;
    const nestedMsg =
      parsed.error && typeof parsed.error === "object" ? parsed.error.message : undefined;
    const msg = nestedMsg ?? parsed.message ?? (typeof parsed.error === "string" ? parsed.error : undefined);
    if (typeof msg === "string" && msg.length > 0) detail = msg;
  } catch {
    // non-JSON body (Wall-A PayloadTooLargeError) — status drives the decision.
  }
  if (res.status === 413 || code === "context_overflow") {
    return { overflow: new ContextOverflowError(detail || undefined), detail };
  }
  return { overflow: null, detail };
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

type ModelSelectionListener = (payload: ModelSelectionErrorPayload) => void;
const modelSelectionListeners = new Set<ModelSelectionListener>();

export function onModelSelectionError(listener: ModelSelectionListener): () => void {
  modelSelectionListeners.add(listener);
  return () => {
    modelSelectionListeners.delete(listener);
  };
}

function emitModelSelectionError(payload: ModelSelectionErrorPayload): void {
  for (const listener of modelSelectionListeners) {
    try {
      listener(payload);
    } catch {
      // a listener throwing must not break the chat error path
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
  /**
   * Called once with the streamed completion's `id` (the OpenAI
   * `chat.completion.chunk` `id`, surfaced verbatim by the backend proxy) as
   * soon as the first frame carrying it is seen. Used to wire RedPill
   * verification to the rendered turn. Non-blocking: fired off the delta path
   * and a throwing listener never breaks the stream.
   */
  onCompletionId?: (id: string) => void;
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
  const { backendUrl, sessionStore, model, messages, maxTokens, abortSignal, onUsage, onCompletionId } = options;

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
  if (res.status === 403) {
    let payload: ModelSelectionErrorPayload | null = null;
    try {
      const body = (await res.json()) as Partial<ModelSelectionErrorPayload>;
      if (body.error === "model_not_offered" || body.error === "model_blocklisted") {
        payload = {
          error: body.error,
          message: typeof body.message === "string" ? body.message : "This model is not available.",
        };
      }
    } catch {
      // non-JSON 403 body; fall through to the generic error path
    }
    if (payload) {
      emitModelSelectionError(payload);
      throw new ModelSelectionError(payload);
    }
  }
  if (!res.ok || !res.body) {
    // Context-overflow (§C.12): 413 (incl. Wall-A non-JSON) or a JSON
    // error.code === "context_overflow" → typed ContextOverflowError so the
    // adapter can compact-and-retry. Kept ahead of the generic throw below and
    // distinct from the 401/402/403 branches handled earlier (§F.8). This
    // consumes the body, so the generic branch reads statusText only.
    const { overflow, detail } = await classifyContextOverflow(res);
    if (overflow) throw overflow;
    throw new Error(`Chat request failed (${res.status}): ${detail}`);
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
            // Surface the completion id from the first frame that carries one.
            // Fired before the delta yield so the badge can wire up early; kept
            // strictly off the reply path (a throwing listener is swallowed).
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
