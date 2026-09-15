import { describe, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { createAgentTaskClient } from "../agent-task-client.js";

const model = "moonshotai/kimi-k3";
const executionId = "710bd411-5191-4d6f-b11f-c741bfe47d62";
const entityId = "8ed637c2-9747-4d8e-a36f-803e1c24bc10";
const request = () => ({ version: 1 as const, executionId, entityId, model: { id: model, contextWindowTokens: 100_000 }, messages: [{ role: "user" as const, content: "Hello" }], allowedTools: ["web_search"], deadlineAt: Date.now() + 10_000 });
const snapshot = (extra: object = {}) => ({ promptTokens: 100, completionTokens: 20, startedAttempts: 1, reportedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "complete", ...extra });
const event = (type: string, seq: number, extra: object = {}) => ({ type, executionId, seq, ...extra });
const accepted = () => event("accepted", 1, { version: 1, model, deadlineAt: Date.now() + 9_000 });
const final = (extra: object = {}) => event("final", 4, { model, outcome: "success", answer: { kind: "model_text", delivery: "streamed" }, answerIsProviderVerbatim: true, finalProviderCompletionId: "completion-1", ...snapshot(), ...extra });
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const capabilities = { chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function fixture(events: unknown[], capabilityBody: unknown = capabilities) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createAgentTaskClient({ baseUrl: "https://eliza.invalid", apiKey: "test-only", fetch: async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/capabilities")) return Response.json(capabilityBody);
    if (url.endsWith("/cancel")) return Response.json({ ok: true });
    return new Response(events.map(frame).join(""), { headers: { "Content-Type": "text/event-stream" } });
  } });
  return { client, calls };
}

describe("private task client", () => {
  test("relays ordinary content, replaces duplicate checkpoints, and sends exactly one task POST", async () => {
    const usage = event("usage", 3, snapshot());
    const { client, calls } = fixture([accepted(), event("content_delta", 2, { text: "Hello" }), usage, usage, final()]);
    const content: string[] = [];
    const result = await client.run(request(), { onContent: (text: string) => { content.push(text); } });
    expect(content).toEqual(["Hello"]);
    expect(result.errorCode).toBeUndefined();
    expect(result.usage).toEqual(snapshot());
    expect(result.observationComplete).toBe(true);
    expect(result.final.finalProviderCompletionId).toBe("completion-1");
    expect(calls.filter(call => call.url.endsWith("/tasks"))).toHaveLength(1);
    expect(calls[1].init?.headers).toMatchObject({ Authorization: "Bearer test-only" });
  });

  test("capability incompatibility blocks task work and successful checks are cached", async () => {
    const bad = fixture([], { chatTasks: { ...capabilities.chatTasks, version: 2 } });
    expect((await bad.client.run(request(), {})).errorCode).toBe("task_unavailable");
    expect(bad.calls).toHaveLength(1);
    const good = fixture([]);
    expect(await good.client.checkCapability(model)).toBe(true);
    expect(await good.client.checkCapability(model)).toBe(true);
    expect(good.calls).toHaveLength(1);
    expect(await good.client.checkCapability("different-model")).toBe(false);
  });

  test("capability cache expires after at most sixty seconds", async () => {
    let now = 100;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const { client, calls } = fixture([]);
      expect(await client.checkCapability(model)).toBe(true);
      now += 59_999;
      expect(await client.checkCapability(model)).toBe(true);
      expect(calls).toHaveLength(1);
      now += 1;
      expect(await client.checkCapability(model)).toBe(true);
      expect(calls).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });

  test("final accounting works without a preceding usage checkpoint", async () => {
    const { client } = fixture([accepted(), event("content_delta", 2, { text: "Hello" }), final()]);
    const result = await client.run(request(), {});
    expect(result.usage).toEqual(snapshot());
    expect(result.observationComplete).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  test("preserves multibyte text with CRLF framing split at every byte", async () => {
    const bytes = new TextEncoder().encode([accepted(), event("content_delta", 2, { text: "🦋 café" }), final()].map(frame).join("").replace(/\n/g, "\r\n"));
    const client = createAgentTaskClient({ baseUrl: "https://eliza.invalid", apiKey: "test-only", fetch: (async (input: unknown) => {
      if (String(input).endsWith("/capabilities")) return Response.json(capabilities);
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch });
    const content: string[] = [];
    const result = await client.run(request(), { onContent: (text: string) => { content.push(text); } });
    expect(content).toEqual(["🦋 café"]);
    expect(result.errorCode).toBeUndefined();
    expect(result.observationComplete).toBe(true);
  });

  test("applies the entire private frame byte limit including its separator", async () => {
    for (const extra of [0, 1]) {
      const client = createAgentTaskClient({ baseUrl: "https://eliza.invalid", apiKey: "test-only", fetch: (async (input: unknown) => {
        if (String(input).endsWith("/capabilities")) return Response.json(capabilities);
        if (String(input).endsWith("/cancel")) return Response.json({ ok: true });
        const comment = ":" + "x".repeat(128 * 1024 - 3 + extra) + "\n\n";
        return new Response(frame(accepted()) + frame(event("usage", 2, snapshot())) + comment + frame(event("content_delta", 3, { text: "Hello" })) + frame(final()), { headers: { "Content-Type": "text/event-stream" } });
      }) as typeof fetch });
      const result = await client.run(request(), {});
      expect(result.errorCode).toBe(extra ? "result_size_limit" : undefined);
      expect(result.usage).toEqual(snapshot());
      expect(result.observationComplete).toBe(extra === 0);
    }
  });

  test("buffered partial answer remains in validated final for one caller-owned delivery", async () => {
    const answer = { kind: "safe_fallback", delivery: "buffered", text: "No supported summary was produced. Coverage: no content read." };
    const { client } = fixture([accepted(), final({ outcome: "partial", code: "no_usable_evidence", answer, answerIsProviderVerbatim: false })]);
    const content: string[] = [];
    const result = await client.run(request(), { onContent: (text: string) => { content.push(text); } });
    expect(result.final?.answer).toEqual(answer);
    expect(result.errorCode).toBeUndefined();
    expect(content).toEqual([]);
  });

  test("attempt start can change complete accounting back to partial", async () => {
    const { client } = fixture([accepted(), event("usage", 2, snapshot()), event("usage", 3, snapshot({ startedAttempts: 2, usageCompleteness: "partial" }))]);
    const result = await client.run(request(), {});
    expect(result.usage).toEqual(snapshot({ startedAttempts: 2, usageCompleteness: "partial" }));
    expect(result.observationComplete).toBe(false);
    expect(result.errorCode).toBe("upstream_incomplete");
  });

  for (const [name, invalid] of [
    ["counter regression", event("usage", 3, snapshot({ promptTokens: 99 }))],
    ["conflicting duplicate", event("usage", 2, snapshot({ promptTokens: 101 }))],
    ["identity mismatch", event("usage", 3, { ...snapshot(), executionId: "different" })],
    ["invalid completeness", event("usage", 3, snapshot({ startedAttempts: 2 }))],
    ["unknown fields", event("usage", 3, { ...snapshot(), transcript: "must never pass" })],
  ] as const) test(`preserves accounting after ${name}`, async () => {
    const { client } = fixture([accepted(), event("usage", 2, snapshot()), invalid]);
    const result = await client.run(request(), {});
    expect(result.usage).toEqual(snapshot());
    expect(result.observationComplete).toBe(false);
    expect(result.errorCode).toBeDefined();
    expect(result.final).toBeUndefined();
  });

  test("validates an entire buffered final before exposing its answer", async () => {
    const { client } = fixture([accepted(), event("usage", 2, snapshot()), final({ model: "wrong", answer: { kind: "meeting_prose", delivery: "buffered", text: "private draft" } })]);
    const content: string[] = [];
    const result = await client.run(request(), { onContent: (text: string) => { content.push(text); } });
    expect(content).toEqual([]);
    expect(result.final).toBeUndefined();
    expect(result.errorCode).toBe("routing_mismatch");
    expect(result.usage.promptTokens).toBe(100);
  });

  test("a callback exception stops content but drains final accounting", async () => {
    const { client, calls } = fixture([accepted(), event("usage", 2, snapshot()), event("content_delta", 3, { text: "Hello" }), final({ promptTokens: 120 })]);
    const result = await client.run(request(), { onContent: () => { throw new Error("browser write failed"); } });
    expect(result.errorCode).toBe("agent_failed");
    expect(result.cancelled).toBe(true);
    expect(result.usage.promptTokens).toBe(120);
    expect(result.observationComplete).toBe(true);
    expect(calls.filter(call => call.url.endsWith("/cancel"))).toHaveLength(1);
  });

  test("bounds frame bytes and cumulative answer characters", async () => {
    for (const text of ["x".repeat(64_001), "é".repeat(70_000)]) {
      const { client } = fixture([accepted(), event("usage", 2, snapshot()), event("content_delta", 3, { text })]);
      const result = await client.run(request(), {});
      expect(result.errorCode).toBe("result_size_limit");
      expect(result.usage.promptTokens).toBe(100);
    }
  });

  test("truncated final retains checkpoint and cannot report success", async () => {
    const client = createAgentTaskClient({ baseUrl: "https://eliza.invalid", apiKey: "test-only", fetch: (async (input: unknown) => {
      if (String(input).endsWith("/capabilities")) return Response.json(capabilities);
      if (String(input).endsWith("/cancel")) return Response.json({ ok: true });
      return new Response(frame(accepted()) + frame(event("usage", 2, snapshot())) + `data: ${JSON.stringify(final()).slice(0, -10)}`, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch });
    const result = await client.run(request(), {});
    expect(result.usage).toEqual(snapshot());
    expect(result.final).toBeUndefined();
    expect(result.observationComplete).toBe(false);
    expect(result.errorCode).toBe("upstream_incomplete");
  });

  test("cancel before task registration with 404 settles immediately without replay", async () => {
    let signal: AbortSignal | null | undefined;
    let tasks = 0;
    let cancels = 0;
    let began!: () => void;
    const submitted = new Promise<void>(resolve => { began = resolve; });
    const client = createAgentTaskClient({ baseUrl: "https://eliza.invalid", apiKey: "test-only", fetch: (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/capabilities")) return Response.json(capabilities);
      if (String(input).endsWith("/cancel")) { cancels++; return new Response("", { status: 404 }); }
      tasks++;
      signal = init?.signal;
      began();
      return new Promise<Response>(() => {}); // Deliberately ignores upstream abort.
    }) as typeof fetch });
    const controller = new AbortController();
    const pending = client.run(request(), { signal: controller.signal });
    await submitted;
    const started = performance.now();
    controller.abort();
    controller.abort();
    const result = await pending;
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.cancelled).toBe(true);
    expect(result.accepted).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(tasks).toBe(1);
    expect(cancels).toBe(1);
  });

  test("closes a task response that arrives after an upstream ignored transport abort", async () => {
    let resolveResponse!: (response: Response) => void;
    let began!: () => void;
    let bodyClosed = false;
    const submitted = new Promise<void>(resolve => { began = resolve; });
    const client = createAgentTaskClient({ baseUrl: "https://eliza.invalid", apiKey: "test-only", fetch: (async (input: unknown) => {
      if (String(input).endsWith("/capabilities")) return Response.json(capabilities);
      if (String(input).endsWith("/cancel")) return new Response("", { status: 404 });
      began();
      return new Promise<Response>(resolve => { resolveResponse = resolve; });
    }) as typeof fetch });
    const controller = new AbortController();
    const pending = client.run(request(), { signal: controller.signal });
    await submitted;
    controller.abort();
    await pending;
    resolveResponse(new Response(new ReadableStream({ cancel() { bodyClosed = true; } }), { headers: { "Content-Type": "text/event-stream" } }));
    await pause(0);
    expect(bodyClosed).toBe(true);
  });

  test("uncooperative task and cancel transports settle at the independent two-second grace", async () => {
    let began!: () => void;
    const submitted = new Promise<void>(resolve => { began = resolve; });
    const client = createAgentTaskClient({ baseUrl: "https://eliza.invalid", apiKey: "test-only", fetch: (async (input: unknown) => {
      if (String(input).endsWith("/capabilities")) return Response.json(capabilities);
      if (String(input).endsWith("/tasks")) began();
      return new Promise<Response>(() => {});
    }) as typeof fetch });
    const controller = new AbortController();
    const pending = client.run(request(), { signal: controller.signal });
    await submitted;
    const started = performance.now();
    controller.abort();
    const result = await pending;
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(result.observationComplete).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  test("honors an earlier effective deadline from accepted and drains timeout usage", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const client = createAgentTaskClient({ baseUrl: "https://eliza.invalid", apiKey: "test-only", fetch: (async (input: unknown) => {
      if (String(input).endsWith("/capabilities")) return Response.json(capabilities);
      if (String(input).endsWith("/cancel")) {
        stream.enqueue(encoder.encode(frame(final({ outcome: "timed_out", answer: undefined, answerIsProviderVerbatim: false }))));
        return Response.json({ ok: true });
      }
      return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(encoder.encode(frame(event("accepted", 1, { version: 1, model, deadlineAt: Date.now() + 20 })))); } }), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch });
    const controller = new AbortController();
    const pending = client.run(request(), { signal: controller.signal });
    try {
      const result = await Promise.race([pending, pause(250).then(() => undefined)]);
      expect(result?.errorCode).toBe("turn_timeout");
      expect(result?.usage.promptTokens).toBe(100);
      expect(result?.observationComplete).toBe(true);
    } finally { controller.abort(); await pending; }
  });

  test("real HTTP cancellation retains late usage without delivering late content", async () => {
    let response: import("node:http").ServerResponse;
    let cancelBody = "";
    const server = createServer((req, res) => {
      if (req.url === "/capabilities") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(capabilities)); return; }
      if (req.url?.endsWith("/cancel")) {
        req.on("data", chunk => { cancelBody += chunk; });
        req.on("end", () => {
          res.end("{}");
          setTimeout(() => { response.write(frame(event("content_delta", 3, { text: "late content" }))); response.end(frame(final({ outcome: "cancelled", answer: undefined, answerIsProviderVerbatim: false, finalProviderCompletionId: undefined, promptTokens: 140 }))); }, 20);
        });
        return;
      }
      response = res;
      res.setHeader("Content-Type", "text/event-stream");
      res.write(frame(accepted()) + frame(event("usage", 2, snapshot())));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const controller = new AbortController();
      const content: string[] = [];
      const client = createAgentTaskClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-only" });
      const pending = client.run(request(), { signal: controller.signal, onContent: (text: string) => { content.push(text); } });
      await pause(50);
      controller.abort();
      const result = await pending;
      expect(content).toEqual([]);
      expect(result.cancelled).toBe(true);
      expect(result.usage.promptTokens).toBe(140);
      expect(result.observationComplete).toBe(true);
      expect(JSON.parse(cancelBody)).toEqual({ version: 1, entityId, reason: "client_cancelled" });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
