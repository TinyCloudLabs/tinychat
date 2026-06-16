// Custom streaming ChatModelAdapter for the TinyChat RN spike.
//
// Mirrors the web app's SSE transport (frontend/src/lib/chatApi.ts):
//   POST `${backendUrl}/api/chat`
//   headers: Authorization: Bearer <token>, X-Requested-With: XMLHttpRequest,
//            Content-Type: application/json
//   body: { model, messages: [{ role, content }] }
//   response: OpenAI SSE — `data: {choices:[{delta:{content}}]}` frames split
//             by blank lines, terminated by `data: [DONE]`.
//
// CRITICAL (RN streaming): the global React Native `fetch` does NOT stream the
// response body — `res.body` is unavailable / fully buffered. We import the
// streaming-capable fetch from `expo/fetch`, which exposes a real
// `ReadableStream` body with `getReader()`. This is the ONLY meaningful
// divergence from the web adapter; the SSE parse + cumulative-yield contract is
// byte-for-byte the same.
//
// This is a spike: no history / memory / billing / paywall handling. Just
// streaming chat against /api/chat with model + bearer token from config.
import { fetch as expoFetch } from "expo/fetch";
import type {
  ChatModelAdapter,
  ThreadMessage,
} from "@assistant-ui/react-native";
import { BACKEND_URL, CHAT_MODEL, getAuthToken } from "../config";

const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

interface WireMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Flatten an assistant-ui ThreadMessage's content parts into plain text. */
function messageText(message: ThreadMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * Streaming fetch against the backend chat proxy using expo/fetch.
 *
 * Yields the CUMULATIVE assistant text after each delta — assistant-ui's
 * ChatModelAdapter expects the full text-so-far on every yield.
 */
async function* streamChat(
  messages: WireMessage[],
  abortSignal: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const token = getAuthToken();

  const res = await expoFetch(`${BACKEND_URL}/api/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
    },
    body: JSON.stringify({ model: CHAT_MODEL, messages }),
    signal: abortSignal,
  });

  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try {
      const err = (await res.json()) as { message?: string; error?: string };
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
            const json = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
            };
            const chunk = json?.choices?.[0]?.delta?.content ?? "";
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
 * The custom streaming ChatModelAdapter. Wire with
 * `useLocalRuntime(chatAdapter)`.
 */
export const chatAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const payload: WireMessage[] = [];
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") {
        continue;
      }
      const content = messageText(m);
      if (!content) continue;
      payload.push({ role: m.role, content });
    }

    for await (const text of streamChat(payload, abortSignal)) {
      yield { content: [{ type: "text", text }] };
    }
  },
};
