import { afterEach, describe, expect, it } from "bun:test";
import { streamAgentChat, onAgentPaywallError, onAgentModelSelectionError, type ToolActivity, type UsageInfo } from "./agentChatApi.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function df(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("streamAgentChat", () => {
  it("yields cumulative text and surfaces tool activity", async () => {
    const activity: ToolActivity[] = [];
    globalThis.fetch = (async () =>
      sseResponse([
        df({ choices: [{ delta: {} }], tool_activity: { name: "web_search", status: "running" } }),
        df({ choices: [{ delta: {} }], tool_activity: { name: "web_search", status: "done" } }),
        df({ choices: [{ delta: { content: "Paris" } }] }),
        df({ choices: [{ delta: { content: " is the capital." } }] }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    const chunks: string[] = [];
    for await (const t of streamAgentChat({
      backendUrl: "https://api.test",
      getToken: () => "tok",
      messages: [{ role: "user", content: "capital of France?" }],
      roomId: "thread-1",
      onToolActivity: (a) => activity.push(a),
    })) {
      chunks.push(t);
    }

    expect(chunks).toEqual(["Paris", "Paris is the capital."]);
    expect(activity).toEqual([
      { name: "web_search", status: "running" },
      { name: "web_search", status: "done" },
    ]);
  });

  it("sends auth + CSRF headers and the roomId/model in the body", async () => {
    let seen: { auth: string | null; csrf: string | null; body: unknown } | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen = {
        auth: h.get("authorization"),
        csrf: h.get("x-requested-with"),
        body: JSON.parse(init!.body as string),
      };
      return sseResponse(["data: [DONE]\n\n"]);
    }) as typeof fetch;

    for await (const _ of streamAgentChat({
      backendUrl: "https://api.test/",
      getToken: () => "tok",
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
      roomId: "thread-9",
    })) {
      // drain
    }

    expect(seen!.auth).toBe("Bearer tok");
    expect(seen!.csrf).toBe("XMLHttpRequest");
    expect(seen!.body).toEqual({
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
      roomId: "thread-9",
    });
  });

  it("throws without a token", async () => {
    await expect(async () => {
      for await (const _ of streamAgentChat({
        backendUrl: "https://api.test",
        getToken: () => null,
        messages: [{ role: "user", content: "hi" }],
      })) {
        // no-op
      }
    }).toThrow("Not authenticated");
  });

  it("fires onUsage with mapped tokens from the usage frame", async () => {
    let usageInfo: UsageInfo | null = null;
    globalThis.fetch = (async () =>
      sseResponse([
        df({ choices: [{ delta: { content: "Hello" } }], id: "cmpl-1" }),
        df({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    for await (const _ of streamAgentChat({
      backendUrl: "https://api.test",
      getToken: () => "tok",
      messages: [{ role: "user", content: "hi" }],
      onUsage: (u) => {
        usageInfo = u;
      },
    })) {
      // drain
    }

    expect(usageInfo).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it("fires onCompletionId once from the first frame carrying an id", async () => {
    const ids: string[] = [];
    globalThis.fetch = (async () =>
      sseResponse([
        df({ choices: [{ delta: { content: "A" } }], id: "cmpl-first" }),
        df({ choices: [{ delta: { content: "B" } }], id: "cmpl-second" }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    for await (const _ of streamAgentChat({
      backendUrl: "https://api.test",
      getToken: () => "tok",
      messages: [{ role: "user", content: "hi" }],
      onCompletionId: (id) => ids.push(id),
    })) {
      // drain
    }

    expect(ids).toEqual(["cmpl-first"]);
  });

  it("surfaces tool_activity alongside onUsage and onCompletionId without interference", async () => {
    const activity: ToolActivity[] = [];
    let usageInfo: UsageInfo | null = null;
    const ids: string[] = [];
    globalThis.fetch = (async () =>
      sseResponse([
        df({ choices: [{ delta: {} }], tool_activity: { name: "web_search", status: "running" }, id: "cmpl-x" }),
        df({ choices: [{ delta: { content: "Result" } }] }),
        df({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    const chunks: string[] = [];
    for await (const t of streamAgentChat({
      backendUrl: "https://api.test",
      getToken: () => "tok",
      messages: [{ role: "user", content: "search" }],
      onToolActivity: (a) => activity.push(a),
      onUsage: (u) => { usageInfo = u; },
      onCompletionId: (id) => ids.push(id),
    })) {
      chunks.push(t);
    }

    expect(chunks).toEqual(["Result"]);
    expect(activity).toEqual([{ name: "web_search", status: "running" }]);
    expect(usageInfo).toEqual({ promptTokens: 5, completionTokens: 3 });
    expect(ids).toEqual(["cmpl-x"]);
  });

  it("swallows a throwing onUsage listener without breaking the stream", async () => {
    const chunks: string[] = [];
    globalThis.fetch = (async () =>
      sseResponse([
        df({ choices: [{ delta: { content: "Hi" } }] }),
        df({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    for await (const t of streamAgentChat({
      backendUrl: "https://api.test",
      getToken: () => "tok",
      messages: [{ role: "user", content: "hi" }],
      onUsage: () => {
        throw new Error("boom");
      },
    })) {
      chunks.push(t);
    }

    expect(chunks).toEqual(["Hi"]);
  });

  it("swallows a throwing onCompletionId listener without breaking the stream", async () => {
    const chunks: string[] = [];
    globalThis.fetch = (async () =>
      sseResponse([
        df({ choices: [{ delta: { content: "Hi" } }], id: "cmpl-x" }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    for await (const t of streamAgentChat({
      backendUrl: "https://api.test",
      getToken: () => "tok",
      messages: [{ role: "user", content: "hi" }],
      onCompletionId: () => {
        throw new Error("boom");
      },
    })) {
      chunks.push(t);
    }

    expect(chunks).toEqual(["Hi"]);
  });

  it("throws PaywallError and emits onAgentPaywallError on 402", async () => {
    const paywallPayload = { error: "credit_budget_exceeded", message: "Budget exceeded", tier: "free" };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(paywallPayload), {
        status: 402,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const emitted: unknown[] = [];
    const unsub = onAgentPaywallError((p) => emitted.push(p));

    let thrownName: string | undefined;
    try {
      for await (const _ of streamAgentChat({
        backendUrl: "https://api.test",
        getToken: () => "tok",
        messages: [{ role: "user", content: "hi" }],
      })) { /* drain */ }
    } catch (err) {
      thrownName = err instanceof Error ? err.name : undefined;
    } finally {
      unsub();
    }

    expect(thrownName).toBe("PaywallError");
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { error: string }).error).toBe("credit_budget_exceeded");
  });

  it("emits onAgentPaywallError with a fallback payload when the 402 body is non-JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("not json", { status: 402 })) as typeof fetch;

    const emitted: unknown[] = [];
    const unsub = onAgentPaywallError((p) => emitted.push(p));

    try {
      for await (const _ of streamAgentChat({
        backendUrl: "https://api.test",
        getToken: () => "tok",
        messages: [{ role: "user", content: "hi" }],
      })) { /* drain */ }
    } catch {
      // expected
    } finally {
      unsub();
    }

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { error: string }).error).toBe("credit_budget_exceeded");
  });

  it("throws ModelSelectionError and emits onAgentModelSelectionError on 403 model_not_offered", async () => {
    const modelPayload = { error: "model_not_offered", message: "Model not offered" };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(modelPayload), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const emitted: unknown[] = [];
    const unsub = onAgentModelSelectionError((p) => emitted.push(p));

    let thrownName: string | undefined;
    try {
      for await (const _ of streamAgentChat({
        backendUrl: "https://api.test",
        getToken: () => "tok",
        messages: [{ role: "user", content: "hi" }],
      })) { /* drain */ }
    } catch (err) {
      thrownName = err instanceof Error ? err.name : undefined;
    } finally {
      unsub();
    }

    expect(thrownName).toBe("ModelSelectionError");
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { error: string }).error).toBe("model_not_offered");
  });
});
