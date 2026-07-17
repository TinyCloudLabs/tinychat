import { afterEach, describe, expect, test } from "bun:test";

import {
  ContextOverflowError,
  ModelSelectionError,
  PaywallError,
  onModelSelectionError,
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
      model: "deepseek/deepseek-v3.2",
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
});
