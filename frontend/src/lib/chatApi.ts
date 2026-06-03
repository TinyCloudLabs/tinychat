import {
  DEFAULT_REQUEST_HEADER_NAME,
  DEFAULT_REQUEST_HEADER_VALUE,
  type SessionStore,
} from "@tinyboilerplate/client";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamChatOptions {
  backendUrl: string;
  sessionStore: SessionStore;
  model: string;
  messages: ChatMessage[];
  /** Optional API-level output cap (forwarded as max_tokens). */
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

/**
 * Raw streaming fetch against the backend chat proxy.
 *
 * The api client (`createApiClient`) parses JSON, so it cannot be used for the
 * SSE response. This helper mirrors its auth/CSRF headers but streams the body.
 *
 * Yields the CUMULATIVE assistant text after each delta — assistant-ui's
 * ChatModelAdapter expects the full text-so-far on every yield.
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<string, void, unknown> {
  const { backendUrl, sessionStore, model, messages, maxTokens, abortSignal } = options;

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
