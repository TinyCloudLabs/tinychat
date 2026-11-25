import { afterEach, describe, expect, test } from "bun:test";
import { BACKGROUND_CHAT_MODELS } from "@tinyboilerplate/core";

import type { ChatMessage } from "@/lib/chatApi";
import { chatReadings, NAMING_MAX_OUTPUT_TOKENS, NAMING_MODEL, namingRequestBytes } from "./namingChat";
import { NAMING_READINGS } from "./parseNaming";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const sessionStore = { getToken: () => "token", isExpired: () => false, clear: () => {} } as never;
const MESSAGES: ChatMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "Привет — S1 [00:00]: 你好" }];
const stream = (text: string) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } });

describe("the naming model's readings", () => {
  test("the model is one the backend admits for background calls", () => {
    expect(BACKGROUND_CHAT_MODELS.map((model) => model.id)).toContain(NAMING_MODEL);
  });

  test("every reading is sent at once, with the output cap and the reasoning setting the backend asks for", async () => {
    const bodies: string[] = [];
    // No reply comes until every reading has been sent: readings sent one after another would never finish.
    const allSent = Promise.withResolvers<void>();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === NAMING_READINGS) allSent.resolve();
      await allSent.promise;
      return stream("reply");
    }) as typeof fetch;

    const { replies, paywall } = await chatReadings("http://backend.test", sessionStore)(MESSAGES, new AbortController().signal);

    expect(bodies).toHaveLength(NAMING_READINGS);
    for (const body of bodies) {
      expect(JSON.parse(body)).toEqual({ model: NAMING_MODEL, messages: MESSAGES, max_output_tokens: NAMING_MAX_OUTPUT_TOKENS, reasoning: "minimal" });
    }
    expect(replies).toHaveLength(NAMING_READINGS);
    expect(paywall).toBe(false);
  });

  test("the size of a request is the bytes of the body that is sent, not its characters", async () => {
    let sent = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { sent = String(init?.body); return stream("ok"); }) as typeof fetch;
    await chatReadings("http://backend.test", sessionStore)(MESSAGES, new AbortController().signal);
    expect(namingRequestBytes(MESSAGES)).toBe(new TextEncoder().encode(sent).byteLength);
    expect(namingRequestBytes(MESSAGES)).toBeGreaterThan(sent.length);
  });

  test("a reading that fails is left out and the others still count", async () => {
    let call = 0;
    globalThis.fetch = (async () => (++call === 2 ? new Response("upstream down", { status: 502 }) : stream(`reply ${call}`))) as typeof fetch;
    const { replies, paywall } = await chatReadings("http://backend.test", sessionStore)(MESSAGES, new AbortController().signal);
    expect(replies).toHaveLength(NAMING_READINGS - 1);
    expect(paywall).toBe(false);
  });

  test("a refusal for credits is reported", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "credit_budget_exceeded", message: "limit", tier: "free" }),
      { status: 402, headers: { "content-type": "application/json" } })) as typeof fetch;
    expect(await chatReadings("http://backend.test", sessionStore)(MESSAGES, new AbortController().signal)).toEqual({ replies: [], paywall: true });
  });
});
