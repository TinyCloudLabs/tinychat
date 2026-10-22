import { afterEach, describe, expect, test } from "bun:test";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";

import { SUMMARY_MODEL, chatComplete } from "./summaryChat";

const realFetch = globalThis.fetch;

const sessionStore = {
  getToken: () => "token",
  isExpired: () => false,
  clear: () => {},
} as never;

describe("summary model", () => {
  test("SUMMARY_MODEL is one of the offered chat models", () => {
    expect(OFFERED_CHAT_MODELS.map((m) => m.id)).toContain(SUMMARY_MODEL);
  });
});

describe("chatComplete request", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("sends SUMMARY_MODEL with the per-call output cap as max_output_tokens, not max_tokens", async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const complete = chatComplete("http://backend.test", sessionStore);
    await complete([{ role: "user", content: "summarise" }], { maxTokens: 800, signal: new AbortController().signal });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      model: SUMMARY_MODEL,
      messages: [{ role: "user", content: "summarise" }],
      max_output_tokens: 800,
    });
  });
});
