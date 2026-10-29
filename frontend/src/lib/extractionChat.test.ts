import { afterEach, describe, expect, test } from "bun:test";
import { completeExtractionChat } from "./extractionChat";
import { completeChat } from "./chatApi";

const realFetch = globalThis.fetch;
const sessionStore = {
  getToken: () => "token",
  isExpired: () => false,
  clear: () => {},
} as never;

function captureBodies() {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return bodies;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("memory extraction chat request", () => {
  test.each([
    ["moonshotai/kimi-k3", "minimal"],
    ["z-ai/glm-5.3", "minimal"],
    ["z-ai/glm-5.2", "off"],
    ["qwen/qwen3.6-35b-a3b", "off"],
  ] as const)("carries the extraction reasoning setting for %s", async (model, reasoning) => {
    const bodies = captureBodies();
    await completeExtractionChat({
      backendUrl: "http://backend.test",
      sessionStore,
      model,
      messages: [{ role: "user", content: "remember this" }],
      maxTokens: 1200,
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning).toBe(reasoning);
  });

  test("the visible reply request does not carry the extraction-only setting", async () => {
    const bodies = captureBodies();
    await completeChat({
      backendUrl: "http://backend.test",
      sessionStore,
      model: "qwen/qwen3.6-35b-a3b",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("reasoning");
  });
});
