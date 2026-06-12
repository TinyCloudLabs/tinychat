import { afterEach, describe, expect, test } from "bun:test";

import {
  ModelSelectionError,
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
