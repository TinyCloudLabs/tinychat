import { expect, test } from "bun:test";

test("probes only the real interpreter request with disabled reasoning and retains timings without reasoning text", async () => {
  const { probeInterpretation } = await import("./meeting-interpretation-probe.js");
  let calls = 0;
  const result = await probeInterpretation({
    apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
    providerFetch: (async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning).toEqual({ enabled: false });
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.max_tokens).toBe(1024);
      expect(body.tool_choice.function.name).toBe("prepare_meeting_turn");
      const frames = [
        { choices: [{ delta: { reasoning_content: "DO_NOT_RETAIN_THIS_REASONING" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "prepare", function: { name: "prepare_meeting_turn", arguments: '{"kind":"general"}' } }] }, finish_reason: "tool_calls" }] },
      ];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
    }) as typeof fetch,
  });
  expect(calls).toBe(1);
  expect(result.providerRequestCount).toBe(1);
  expect(result.interpretedPlan).toEqual({ kind: "general" });
  expect(result.controllerAcceptedGeneral).toBe(true);
  expect(result.compatible).toBe(true);
  expect(result.releaseReady).toBe(false);
  expect(result.timing.headersMs).toBeGreaterThanOrEqual(0);
  expect(result.timing.firstDeltaMs).toBeGreaterThanOrEqual(result.timing.headersMs!);
  expect(result.timing.firstToolDeltaMs).toBeGreaterThanOrEqual(result.timing.firstDeltaMs!);
  expect(result.timing.finishMs).toBeGreaterThanOrEqual(result.timing.firstToolDeltaMs!);
  expect(result.timing.protocolEndMs).toBeGreaterThanOrEqual(result.timing.finishMs!);
  expect(JSON.stringify(result)).not.toContain("DO_NOT_RETAIN_THIS_REASONING");
});

test("saves a rate limit without issuing another provider request or retaining response text", async () => {
  const { probeInterpretation } = await import("./meeting-interpretation-probe.js");
  let calls = 0;
  const result = await probeInterpretation({
    apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
    providerFetch: (async () => {
      calls++;
      return new Response("DO_NOT_RETAIN_ERROR_BODY", { status: 429, headers: { "retry-after": "60" } });
    }) as typeof fetch,
  });
  expect(calls).toBe(1);
  expect(result.providerResponse).toEqual({ status: 429, retryAfter: "60" });
  expect(result.compatible).toBe(false);
  expect(result.errorCode).toBe("provider_rate_limited");
  expect(result.timing.firstDeltaMs).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("DO_NOT_RETAIN_ERROR_BODY");
});

test("does not call an incomplete interpreter stream compatible", async () => {
  const { probeInterpretation } = await import("./meeting-interpretation-probe.js");
  const result = await probeInterpretation({
    apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
    providerFetch: (async () => new Response('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')) as typeof fetch,
  });
  expect(result.compatible).toBe(false);
  expect(result.timing.protocolEndMs).toBeUndefined();
});

test("cancels observation when the controller rejects an oversized delta before stream end", async () => {
  const { probeInterpretation } = await import("./meeting-interpretation-probe.js");
  let source: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const pending = probeInterpretation({
    apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 100,
    providerFetch: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        const delta = { tool_calls: [{ index: 0, id: "prepare", function: { name: "prepare_meeting_turn", arguments: "x".repeat(13000) } }] };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
      },
      cancel() { cancelled = true; },
    }))) as typeof fetch,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([pending, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 250); })]);
    expect(result).toBeDefined();
    expect(result!.compatible).toBe(false);
    expect(result!.providerRequestCount).toBe(1);
    expect(cancelled).toBe(true);
  } finally {
    clearTimeout(timer);
    if (!cancelled) source!.close();
    await pending;
  }
});

test("an explicitly chosen offered model is probed without switching to the default model", async () => {
  const { probeInterpretation } = await import("./meeting-interpretation-probe.js");
  let requestedModel: string | undefined;
  const result = await probeInterpretation({
    model: "qwen/qwen3.6-35b-a3b", apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
    providerFetch: (async (_input, init) => {
      requestedModel = JSON.parse(String(init?.body)).model;
      return new Response(null, { status: 429 });
    }) as typeof fetch,
  });
  expect(requestedModel).toBe("qwen/qwen3.6-35b-a3b");
  expect(result.model).toBe(requestedModel);
});

test("an unknown probe model is rejected before making any provider request", async () => {
  const { probeInterpretation } = await import("./meeting-interpretation-probe.js");
  let calls = 0;
  await expect(probeInterpretation({
    model: "not-offered", apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
    providerFetch: (async () => { calls++; return new Response(null, { status: 429 }); }) as typeof fetch,
  })).rejects.toThrow("Choose an offered model");
  expect(calls).toBe(0);
});
