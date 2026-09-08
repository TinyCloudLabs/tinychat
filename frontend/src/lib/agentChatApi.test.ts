import { afterEach, describe, expect, it } from "bun:test";
import { currentAgentClientContext, streamAgentChat, onAgentPaywallError, onAgentModelSelectionError, type StreamAgentChatOptions, type ToolActivity, type UsageInfo } from "./agentChatApi.js";
import { streamChat } from "./chatApi.js";

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

const streamOptions = {
  backendUrl: "https://api.test",
  getToken: () => "tok",
  messages: [{ role: "user" as const, content: "synthetic question" }],
};
const interruptionMessage = "The connection ended before the reply finished. You can try again.";

async function collectStream(options: StreamAgentChatOptions = streamOptions) {
  const chunks: string[] = [];
  let error: unknown;
  try {
    for await (const chunk of streamAgentChat(options)) chunks.push(chunk);
  } catch (caught) {
    error = caught;
  }
  return { chunks, error };
}

describe("agent stream lifecycle", () => {
  it("keeps comments invisible across every LF and UTF-8 byte boundary", async () => {
    const bytes = new TextEncoder().encode(`: keepalive\n\n${df({ choices: [{ delta: { content: "café 🦋" } }] })}: keepalive\n\ndata: [DONE]\n\n`);
    globalThis.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }))) as typeof fetch;
    expect(await collectStream()).toEqual({ chunks: ["café 🦋"], error: undefined });
  });

  for (const body of ["", ": keepalive\n\n", "data: {\"choices\":", df({ choices: [{ delta: { content: "Partial." } }] })]) {
    it(`rejects EOF without DONE (${JSON.stringify(body)})`, async () => {
      globalThis.fetch = (async () => sseResponse([body])) as typeof fetch;
      const result = await collectStream();
      expect(result.error).toMatchObject({ name: "AgentStreamError", code: "incomplete", message: interruptionMessage });
      expect(result.chunks).toEqual(body.includes("Partial.") ? ["Partial."] : []);
    });
  }

  it("normalizes a pre-header fetch rejection without retaining browser details", async () => {
    globalThis.fetch = (async () => { throw new TypeError("PRIVATE FETCH SENTINEL"); }) as typeof fetch;
    const result = await collectStream();
    expect(result.error).toMatchObject({ name: "AgentStreamError", code: "transport", message: interruptionMessage });
    expect(result.error).not.toHaveProperty("cause");
  });

  it("treats a successful HTTP response with no body as incomplete", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    expect((await collectStream()).error).toMatchObject({ name: "AgentStreamError", code: "incomplete" });
  });

  for (const [status, body, name] of [
    [401, "", "Error"],
    [413, "not JSON", "ContextOverflowError"],
    [400, '{"error":{"code":"context_overflow","message":"too large"}}', "ContextOverflowError"],
  ] as const) {
    it(`keeps the HTTP ${status} classifier outside transport normalization`, async () => {
      globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
      expect((await collectStream()).error).toMatchObject({ name });
    });
  }

  it("does not yield content after a callback cancels the turn", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => sseResponse([
      df({ id: "synthetic-id", choices: [{ delta: { content: "must not arrive after Stop" } }] }),
      "data: [DONE]\n\n",
    ])) as typeof fetch;
    const result = await collectStream({ ...streamOptions, abortSignal: controller.signal,
      onCompletionId: () => controller.abort(),
    });
    expect(result.chunks).toEqual([]);
    expect(result.error).toBe(controller.signal.reason);
  });

  it("normalizes a reader rejection and preserves partial text", async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(df({ choices: [{ delta: { content: "Partial." } }] })));
        else controller.error(new TypeError("PRIVATE READ SENTINEL"));
      },
    });
    globalThis.fetch = (async () => new Response(body)) as typeof fetch;
    const result = await collectStream();
    expect(result.chunks).toEqual(["Partial."]);
    expect(result.error).toMatchObject({ name: "AgentStreamError", code: "transport", message: interruptionMessage });
    expect(body.locked).toBe(false);
  });

  for (const code of ["turn_timeout", "upstream_incomplete", "upstream_failed", "agent_failed"]) {
    it(`handles ${code} before legacy text or any callbacks, after malformed data`, async () => {
      const callbacks: unknown[] = [];
      globalThis.fetch = (async () => sseResponse([
        df({ choices: [{ delta: { content: "Partial." } }] }),
        "data: {broken\n\n",
        df({ stream_error: { code }, id: "must-not-publish", usage: { prompt_tokens: 1, completion_tokens: 2 },
          tool_activity: { name: "must-not-publish", status: "running" }, delegation_error: { code: "delegation_expired" },
          choices: [{ delta: { content: "Legacy interruption notice" } }] }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;
      const result = await collectStream({ ...streamOptions,
        onCompletionId: (value: unknown) => callbacks.push(value), onUsage: (value: unknown) => callbacks.push(value),
        onToolActivity: (value: unknown) => callbacks.push(value), onDelegationError: (value: unknown) => callbacks.push(value),
      });
      expect(result.chunks).toEqual(["Partial."]);
      expect(result.error).toMatchObject({ name: "AgentStreamError", code,
        message: code === "turn_timeout" ? "This reply took too long to finish. You can try again." : interruptionMessage });
      expect(callbacks).toEqual([]);
    });
  }

  it("uses a bounded error class for unknown terminal codes", async () => {
    globalThis.fetch = (async () => sseResponse([
      df({ stream_error: { code: "PRIVATE UNKNOWN SENTINEL" }, choices: [{ delta: { content: "legacy" } }] }),
      "data: [DONE]\n\n",
    ])) as typeof fetch;
    const result = await collectStream();
    expect(result.error).toMatchObject({ name: "AgentStreamError", code: "agent_failed", message: interruptionMessage });
    expect(result.chunks).toEqual([]);
  });

  for (const cancellation of ["resolve", "reject", "pending"]) {
    it(`cancels and releases an open body at DONE without waiting for ${cancellation} cleanup`, async () => {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); },
        cancel() {
          cancelled += 1;
          if (cancellation === "reject") return Promise.reject(new Error("cleanup sentinel"));
          if (cancellation === "pending") return new Promise(() => {});
        },
      });
      globalThis.fetch = (async () => new Response(body)) as typeof fetch;
      expect(await collectStream()).toEqual({ chunks: [], error: undefined });
      expect(cancelled).toBe(1);
      expect(body.locked).toBe(false);
    }, 500);
  }

  it("cancels and releases the body on generator early return", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(df({ choices: [{ delta: { content: "Partial." } }] }))); },
      cancel() { cancelled += 1; },
    });
    globalThis.fetch = (async () => new Response(body)) as typeof fetch;
    for await (const chunk of streamAgentChat(streamOptions)) {
      expect(chunk).toBe("Partial.");
      break;
    }
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  });

  it("starts no request for an already-aborted signal", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return sseResponse(["data: [DONE]\n\n"]); }) as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const result = await collectStream({ ...streamOptions, abortSignal: controller.signal });
    expect(calls).toBe(0);
    expect(result.error).toBe(controller.signal.reason);
  });

  it("keeps intentional abort distinct and settles a reader whose source ignores the signal", async () => {
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = 0;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() { started(); },
      cancel() { cancelled += 1; return new Promise(() => {}); },
    });
    globalThis.fetch = (async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(body);
    }) as typeof fetch;
    const result = collectStream({ ...streamOptions, abortSignal: controller.signal });
    await readStarted;
    controller.abort();
    expect((await result).error).toBe(controller.signal.reason);
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  }, 500);

  it("preserves signal cancellation when initial fetch rejects", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => { controller.abort(); throw new TypeError("fetch aborted"); }) as typeof fetch;
    expect((await collectStream({ ...streamOptions, abortSignal: controller.signal })).error).toBe(controller.signal.reason);
  });

  it("cancels a response body that arrives after Stop", async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } });
    globalThis.fetch = (async () => { controller.abort(); return new Response(body); }) as typeof fetch;
    expect((await collectStream({ ...streamOptions, abortSignal: controller.signal })).error).toBe(controller.signal.reason);
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  });
});

describe("agent stream client compatibility", () => {
  // The unchanged plain-chat parser is the production LF/data/content/DONE
  // decoder that the original agent parser mirrored. It has no typed terminal
  // handling and exercises the behavior retained by cached older clients.
  const legacySession = { getToken: () => "tok", isExpired: () => false, clear: () => {} };
  const legacyNotice = "\n\nThis reply was interrupted before it finished. Please try again.";
  const encoder = new TextEncoder();
  for (const scenario of ["success", "before_content", "after_content", "partial_utf8_frame", "complete_final_slice"]) {
    it(`decodes ${scenario} with both the legacy and new parser`, async () => {
      const chunks: Uint8Array[] = [encoder.encode(": keepalive\n\n")];
      const hasText = scenario !== "before_content";
      if (hasText) chunks.push(encoder.encode(df({ choices: [{ delta: { content: "Earlier text." } }] })));
      if (scenario === "partial_utf8_frame") {
        const frame = encoder.encode(df({ choices: [{ delta: { content: "Abandoned 🦋 suffix." } }] }));
        const split = frame.indexOf(0xf0) + 2;
        // Actual accepted bytes end inside the four-byte butterfly. The
        // abandoned JSON suffix is never resumed; LF/LF creates a clean event.
        chunks.push(frame.slice(0, split), encoder.encode("\n\n"));
      }
      if (scenario === "complete_final_slice") chunks.push(encoder.encode(df({ choices: [{ delta: { content: " Final text." } }] })));
      if (scenario !== "success") chunks.push(encoder.encode(df({
        stream_error: { code: "turn_timeout" }, choices: [{ delta: { content: legacyNotice } }],
      })));
      chunks.push(encoder.encode("data: [DONE]\n\n"));
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          // Also split transport delivery inside field names, JSON and DONE.
          for (const chunk of chunks) for (const byte of chunk) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }))) as typeof fetch;
      const current = await collectStream();
      const priorText = hasText ? "Earlier text." + (scenario === "complete_final_slice" ? " Final text." : "") : "";
      expect(current.chunks.at(-1) ?? "").toBe(priorText);
      if (scenario === "success") expect(current.error).toBeUndefined();
      else expect(current.error).toMatchObject({ name: "AgentStreamError", code: "turn_timeout" });

      let legacyText = "";
      for await (const text of streamChat({ ...streamOptions, sessionStore: legacySession as never, model: "synthetic" })) legacyText = text;
      expect(legacyText).toBe(priorText + (scenario === "success" ? "" : legacyNotice));
      expect(legacyText).not.toContain("Abandoned");
      expect(legacyText).not.toContain("�");
    });
  }
});

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
      clientContext: { localDate: "2026-08-26", timeZone: "America/Los_Angeles" },
    })) {
      // drain
    }

    expect(seen!.auth).toBe("Bearer tok");
    expect(seen!.csrf).toBe("XMLHttpRequest");
    expect(seen!.body).toEqual({
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
      roomId: "thread-9",
      clientContext: { localDate: "2026-08-26", timeZone: "America/Los_Angeles" },
    });
  });

  it("derives a stable local calendar date for relative meeting prompts", () => {
    const context = currentAgentClientContext(new Date("2026-08-26T12:00:00.000Z"));
    expect(context.timeZone.length).toBeGreaterThan(0);
    expect(context.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

  it("surfaces a streamed delegation failure for reconnect UI", async () => {
    const errors: string[] = [];
    globalThis.fetch = (async () =>
      sseResponse([
        df({ choices: [{ delta: {} }], delegation_error: { code: "delegation_expired" } }),
        df({ choices: [{ delta: { content: "Reconnect access." } }] }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    const chunks: string[] = [];
    for await (const text of streamAgentChat({
      backendUrl: "https://api.test",
      getToken: () => "tok",
      messages: [{ role: "user", content: "last meeting?" }],
      onDelegationError: (code) => errors.push(code),
    })) {
      chunks.push(text);
    }

    expect(errors).toEqual(["delegation_expired"]);
    expect(chunks).toEqual(["Reconnect access."]);
  });

  it("ignores unknown delegation errors and swallows a throwing listener", async () => {
    let calls = 0;
    globalThis.fetch = (async () =>
      sseResponse([
        df({ delegation_error: { code: "unknown" } }),
        df({ delegation_error: { code: "delegation_required" } }),
        df({ choices: [{ delta: { content: "Still streaming." } }] }),
        "data: [DONE]\n\n",
      ])) as typeof fetch;

    const chunks: string[] = [];
    for await (const text of streamAgentChat({
      backendUrl: "https://api.test",
      getToken: () => "tok",
      messages: [{ role: "user", content: "last meeting?" }],
      onDelegationError: () => {
        calls += 1;
        throw new Error("listener failed");
      },
    })) {
      chunks.push(text);
    }

    expect(calls).toBe(1);
    expect(chunks).toEqual(["Still streaming."]);
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
