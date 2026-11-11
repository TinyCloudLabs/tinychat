import { afterEach, describe, expect, test } from "bun:test";

import {
  ContextOverflowError,
  ModelSelectionError,
  PaywallError,
  onModelSelectionError,
  completeChat,
  streamChat,
  type ModelSelectionErrorPayload,
} from "./chatApi";

const realFetch = globalThis.fetch;

const sessionStore = {
  getToken: () => "token",
  isExpired: () => false,
  clear: () => {},
} as never;

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

describe("streamChat context-overflow classification (§C.12)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function firstError(response: Response): Promise<unknown> {
    globalThis.fetch = (async () => response) as typeof fetch;
    const stream = streamChat({
      backendUrl: "http://backend.test",
      sessionStore,
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });
    try {
      await stream.next();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  test("overflow_response_classified_as_context_overflow_error", async () => {
    // (1) A 413 carrying a JSON error.code === "context_overflow" body.
    const jsonBody = await firstError(
      new Response(
        JSON.stringify({ error: { code: "context_overflow", message: "maximum context length exceeded" } }),
        { status: 413, headers: { "content-type": "application/json" } },
      ),
    );
    expect(jsonBody).toBeInstanceOf(ContextOverflowError);
    expect((jsonBody as ContextOverflowError).code).toBe("context_overflow");

    // (2) A 413 with a NON-JSON Wall-A body (express PayloadTooLargeError).
    const wallABody = await firstError(
      new Response("PayloadTooLargeError: request entity too large", {
        status: 413,
        headers: { "content-type": "text/html" },
      }),
    );
    expect(wallABody).toBeInstanceOf(ContextOverflowError);

    // Distinct from the 402/403 typed emitters (§F.8): a paywall 402 must NOT
    // be classified as an overflow, and an overflow must not be a PaywallError.
    expect(jsonBody).not.toBeInstanceOf(PaywallError);
    expect(jsonBody).not.toBeInstanceOf(ModelSelectionError);
    const paywall = await firstError(
      new Response(
        JSON.stringify({ error: "credit_budget_exceeded", message: "limit", tier: "free" }),
        { status: 402, headers: { "content-type": "application/json" } },
      ),
    );
    expect(paywall).toBeInstanceOf(PaywallError);
    expect(paywall).not.toBeInstanceOf(ContextOverflowError);
  });
  test("uses fixed copy for unverified replies regardless of server detail", async () => {
    const error = await firstError(new Response(
      JSON.stringify({
        error: {
          code: "private_response_unverified",
          message: "RedPill internal verification error: receipt rejected.",
        },
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    ));
    expect(error).toMatchObject({
      message: "The model service could not complete this request. Try again later.",
    });
    expect(error.message).not.toContain("RedPill");
    expect(error.message).not.toContain("receipt rejected");
    expect(error).not.toBeInstanceOf(ContextOverflowError);
  });
  test("shows a verified mark only after the explicit receipt event", async () => {
    const verified: string[] = [];
    const yielded: string[] = [];
    globalThis.fetch = (async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Reply" } }] })}\n\n`,
      `event: tinycloud.receipt-verification\ndata: {"status":"verified"}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { status: 200 })) as typeof fetch;
    for await (const text of streamChat({
      backendUrl: "http://backend.test", sessionStore, model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      onReceiptVerification: (status) => verified.push(status),
    })) yielded.push(text);
    expect(yielded).toEqual(["Reply"]);
    expect(verified).toEqual(["verified"]);
  });
  test("ignores provider-shaped receipt fields without the TinyCloud verification event", async () => {
    const verified: string[] = [];
    globalThis.fetch = (async () => new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Reply" } }] })}\n\n`,
      `data: ${JSON.stringify({ receipt_verification: { status: "verified" } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { status: 200 })) as typeof fetch;
    for await (const _ of streamChat({
      backendUrl: "http://backend.test", sessionStore, model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      onReceiptVerification: (status) => verified.push(status),
    })) { /* consume */ }
    expect(verified).toEqual([]);
  });


  test("keeps a failed streamed reply visible without setting verified, and absent verdict stays unmarked", async () => {
    const warning = "Couldn't confirm this reply came through the verified enclave. Don't rely on it.";
    const statuses: string[] = [];
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial." } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: `\n\n${warning}` } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    globalThis.fetch = (async () => new Response(frames.join(""), { status: 200 })) as typeof fetch;
    const yielded: string[] = [];
    for await (const text of streamChat({
      backendUrl: "http://backend.test", sessionStore, model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      onReceiptVerification: (status) => statuses.push(status),
    })) yielded.push(text);
    expect(yielded.at(-1)).toBe(`Partial.\n\n${warning}`);
    expect(statuses).toEqual([]);

    globalThis.fetch = (async () => new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "No verdict." } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    )) as typeof fetch;
    for await (const _ of streamChat({
      backendUrl: "http://backend.test", sessionStore, model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      onReceiptVerification: (status) => statuses.push(status),
    })) { /* consume */ }
    expect(statuses).toEqual([]);
  });
});

describe("completeChat output caps", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function capturedBody(options: { maxTokens?: number; maxOutputTokens?: number }): Promise<Record<string, unknown>> {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    await completeChat({
      backendUrl: "http://backend.test",
      sessionStore,
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      ...options,
    });
    return bodies[0] ?? {};
  }

  test("maxOutputTokens is sent as max_output_tokens and not as max_tokens", async () => {
    expect(await capturedBody({ maxOutputTokens: 1500 })).toEqual({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_output_tokens: 1500,
    });
  });

  test("the legacy maxTokens option still sends max_tokens and no max_output_tokens", async () => {
    expect(await capturedBody({ maxTokens: 2000 })).toEqual({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 2000,
    });
  });

  test("with neither option the body is unchanged", async () => {
    expect(await capturedBody({})).toEqual({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });
  });
});
