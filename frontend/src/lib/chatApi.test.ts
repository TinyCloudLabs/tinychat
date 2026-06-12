import { afterEach, describe, expect, test } from "bun:test";

import {
  ModelSelectionError,
  onModelSelectionError,
  streamChat,
  type ModelSelectionErrorPayload,
} from "./chatApi";
import type { RelaySignatureFrame } from "./relayFrame";

const realFetch = globalThis.fetch;

const sessionStore = {
  getToken: () => "token",
  isExpired: () => false,
  clear: () => {},
} as never;

/** Serve a literal SSE body as a 200 event-stream response (one read source). */
function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Run streamChat against a stubbed SSE body, collecting the cumulative-text
 *  yields and any relay-signature frame surfaced off the rendered-text path. */
async function drain(body: string): Promise<{ texts: string[]; frames: RelaySignatureFrame[] }> {
  globalThis.fetch = (async () => sseResponse(body)) as typeof fetch;
  const texts: string[] = [];
  const frames: RelaySignatureFrame[] = [];
  for await (const text of streamChat({
    backendUrl: "http://backend.test",
    sessionStore,
    model: "phala/gpt-oss-120b",
    messages: [{ role: "user", content: "hi" }],
    onRelaySignature: (f) => frames.push(f),
  })) {
    texts.push(text);
  }
  return { texts, frames };
}

const RELAY_FRAME: RelaySignatureFrame = {
  v: 1,
  completion_id: "chatcmpl-relayfixture001",
  model: "phala/gpt-oss-120b",
  content_sha256: "deadbeef".repeat(8),
  signature: "0xabc123",
  address: "0xRELAY",
};

function contentChunk(content: string, id = "chatcmpl-x"): string {
  return `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

describe("streamChat model-selection errors", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("emits a structured event for 403 model_blocklisted responses", async () => {
    const payload: ModelSelectionErrorPayload = {
      error: "model_blocklisted",
      message: "Model phala/glm-4.7 is not available.",
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const events: ModelSelectionErrorPayload[] = [];
    const unsubscribe = onModelSelectionError((event) => events.push(event));
    try {
      const stream = streamChat({
        backendUrl: "http://backend.test",
        sessionStore,
        model: "phala/glm-4.7",
        messages: [{ role: "user", content: "hi" }],
      });

      let thrown: unknown;
      try {
        await stream.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ModelSelectionError);
      expect(events).toEqual([payload]);
    } finally {
      unsubscribe();
    }
  });
});

describe("streamChat relay-signature frame", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("captures the frame and excludes it from rendered text (new FE + new BE)", async () => {
    const body =
      contentChunk("Hello") +
      contentChunk(", world!") +
      `data: ${JSON.stringify({ tinychat_relay_signature: RELAY_FRAME })}\n\n` +
      "data: [DONE]\n\n";

    const { texts, frames } = await drain(body);

    // The relay frame is surfaced exactly once, intact.
    expect(frames).toEqual([RELAY_FRAME]);
    // ...and contributes NOTHING to the rendered text (hard constraint 7): the
    // final cumulative yield is the content deltas only, never the frame JSON.
    expect(texts.at(-1)).toBe("Hello, world!");
    for (const t of texts) {
      expect(t).not.toContain("tinychat_relay_signature");
      expect(t).not.toContain("0xRELAY");
    }
  });

  test("no frame → no relay signature, text unchanged (new FE + old BE)", async () => {
    const body = contentChunk("Hello") + contentChunk(", world!") + "data: [DONE]\n\n";

    const { texts, frames } = await drain(body);

    // Old backend emits no frame: the listener never fires, rendering is
    // byte-identical to the no-relay path (graceful degrade, hard constraint 7).
    expect(frames).toEqual([]);
    expect(texts.at(-1)).toBe("Hello, world!");
  });

  test("a malformed relay envelope is ignored, not rendered", async () => {
    // tinychat_relay_signature present but missing required fields → parseRelayFrame
    // returns null → frame skipped, no listener call, no text contamination.
    const body =
      contentChunk("Hi") +
      `data: ${JSON.stringify({ tinychat_relay_signature: { v: 1 } })}\n\n` +
      "data: [DONE]\n\n";

    const { texts, frames } = await drain(body);

    expect(frames).toEqual([]);
    expect(texts.at(-1)).toBe("Hi");
  });
});
