import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { createAgentChatHandler, orchestrateToolCalling, parseSseJson, type AgentChatConfig } from "../routes/agent-chat.js";

const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const answer = (text = "safe answer") => frame({ id: "synthetic-id", choices: [{ delta: { content: text }, finish_reason: "stop" }] });
const done = "data: [DONE]\n\n";
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function clock() {
  let time = 0, id = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const logs: unknown[] = [];
  return {
    now: () => time,
    setTimeout(fn: () => void, ms: number) { const key = ++id; tasks.set(key, { at: time + ms, fn }); return key; },
    clearTimeout(key: unknown) { tasks.delete(key as number); },
    log: (summary: unknown) => { logs.push(summary); },
    logs, tasks,
    async advance(ms: number) {
      const end = time + ms;
      for (;;) { const next = [...tasks].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; time = next[1].at; tasks.delete(next[0]); next[1].fn(); await flush(); }
      time = end; await flush();
    },
  };
}
function response() {
  const req = Object.assign(new EventEmitter(), { user: { address: "sentinel-address" }, body: { messages: [{ role: "user", content: "sentinel-prompt" }] }, aborted: false });
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, destroyed: false, headersSent: false, chunks: [] as Uint8Array[], endCount: 0, destroyCount: 0,
    setHeader() { return this; }, flushHeaders() { this.headersSent = true; },
    write(bytes: string | Uint8Array) { this.chunks.push(typeof bytes === "string" ? encoder.encode(bytes) : bytes.slice()); return true; },
    end() { this.endCount++; this.writableEnded = true; this.emit("finish"); },
    destroy() { this.destroyCount++; this.destroyed = true; this.emit("close"); },
    text() { return new TextDecoder().decode(Buffer.concat(this.chunks)); },
  });
  return { req, res };
}
function config(fetchImpl: typeof fetch, runtime = clock()): AgentChatConfig {
  return { agentId: "sentinel-agent", entityIdFor: () => "sentinel-entity", elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "sentinel-secret", redpillApiKey: "sentinel-key", redpillBaseUrl: "https://provider.test", defaultModel: () => "phala/test", isModelOffered: () => true, fetchImpl, maxRounds: 3,
    streamPolicy: { heartbeatMs: 10, turnTimeoutMs: 100, drainGraceMs: 20 }, streamRuntime: runtime,
  } as AgentChatConfig;
}
function run(cfg: AgentChatConfig, pair = response()) {
  return { ...pair, finished: Promise.resolve(createAgentChatHandler(cfg)(pair.req as unknown as Request, pair.res as unknown as Response, () => {})) };
}
function provider(content: string) { return new globalThis.Response(content, { headers: { "content-type": "text/event-stream" } }); }

describe("agent stream lifecycle", () => {
  it("writes immediate and periodic invisible comments while waiting for provider headers, then one terminal", async () => {
    const runtime = clock(); const pending = deferred<globalThis.Response>(); let signal: AbortSignal | undefined;
    const turn = run(config((async (_url, init) => { signal = init?.signal as AbortSignal; return pending.promise; }) as typeof fetch, runtime));
    await flush(); expect(turn.res.text()).toBe(": keepalive\n\n");
    await runtime.advance(30); expect(turn.res.text().match(/: keepalive/g)).toHaveLength(4);
    expect(signal).toBeInstanceOf(AbortSignal);
    pending.resolve(provider(answer() + done)); await turn.finished;
    expect(turn.res.text().match(/data: \[DONE\]/g)).toHaveLength(1); expect(turn.res.endCount).toBe(1); expect(runtime.tasks.size).toBe(0);
    expect(turn.res.listenerCount("close")).toBe(0); expect(turn.req.listenerCount("aborted")).toBe(0);
  });
  it("deadline aborts even an uncooperative provider and emits the fixed compatible error", async () => {
    const runtime = clock(); let signal: AbortSignal | undefined;
    const turn = run(config((async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(() => {}); }) as typeof fetch, runtime));
    await flush(); await runtime.advance(100);
    expect(signal?.aborted).toBe(true); expect(turn.res.text()).toContain('"stream_error":{"code":"turn_timeout"}'); expect(turn.res.text()).toContain("This reply was interrupted before it finished.");
    await turn.finished; expect(turn.res.endCount).toBe(1); expect(runtime.tasks.size).toBe(0);
  });
  it("response loss aborts pending work without terminal writes and ignores normal request close", async () => {
    const runtime = clock(); let signal: AbortSignal | undefined;
    const turn = run(config((async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(() => {}); }) as typeof fetch, runtime));
    await flush(); turn.req.emit("close"); expect(signal?.aborted).toBe(false);
    const bytes = turn.res.text(); turn.res.destroy(); await flush(); expect(signal?.aborted).toBe(true); await turn.finished;
    await runtime.advance(200); expect(turn.res.text()).toBe(bytes); expect(turn.res.endCount).toBe(0); expect(runtime.tasks.size).toBe(0);
  });
  it("backpressure suspends provider reads and coalesces heartbeats until drain", async () => {
    const runtime = clock(); const pair = response(); const original = pair.res.write; let reads = 0;
    pair.res.write = function (bytes) { original.call(this, bytes); return this.chunks.length !== 2; };
    const body = { async *[Symbol.asyncIterator]() { reads++; yield encoder.encode(answer("first")); reads++; yield encoder.encode(answer("second") + done); } };
    const turn = run(config((async () => ({ ok: true, body })) as unknown as typeof fetch, runtime), pair);
    await flush(); expect(reads).toBe(1); await runtime.advance(30); expect(reads).toBe(1); expect(pair.res.chunks.length).toBe(2);
    pair.res.emit("drain"); await turn.finished; expect(reads).toBe(2); expect(pair.res.text()).toContain("second"); expect(runtime.tasks.size).toBe(0);
  });
  it("timeout isolates a partially accepted UTF-8 frame and shares one terminal drain budget", async () => {
    const runtime = clock(); const pair = response(); const original = pair.res.write;
    pair.res.write = function (bytes) { original.call(this, bytes); return this.chunks.length !== 2; };
    const turn = run(config((async () => provider(answer("😀".repeat(15000)) + done)) as typeof fetch, runtime), pair);
    await flush(); expect(pair.res.chunks.length).toBe(2); expect(pair.res.chunks[1].byteLength).toBeLessThanOrEqual(16384);
    await runtime.advance(100); expect(pair.res.chunks.length).toBe(2);
    pair.res.emit("drain"); await turn.finished;
    expect(pair.res.text()).toContain('\n\ndata: {"stream_error":{"code":"turn_timeout"}'); expect(pair.res.text().match(/data: \[DONE\]/g)).toHaveLength(1); expect(runtime.tasks.size).toBe(0);
  });
  it("destroys a permanently backpressured response within the terminal grace", async () => {
    const runtime = clock(); const pair = response(); const original = pair.res.write; pair.res.write = function (bytes) { original.call(this, bytes); return false; };
    let calls = 0; const turn = run(config((async () => { calls++; return provider(answer() + done); }) as typeof fetch, runtime), pair);
    await flush(); await runtime.advance(120); expect(pair.res.destroyed).toBe(true); expect(calls).toBe(0); expect(pair.res.text()).not.toContain(done); await turn.finished; expect(runtime.tasks.size).toBe(0);
  });
  it("logs one allowlisted summary without input or raw exception sentinels", async () => {
    const runtime = clock(); const turn = run(config((async () => { throw new Error("sentinel-exception"); }) as typeof fetch, runtime)); await turn.finished;
    expect(runtime.logs).toHaveLength(1); expect(JSON.stringify(runtime.logs)).not.toContain("sentinel"); expect(turn.res.text()).toContain('"upstream_failed"');
  });
});

describe("provider completion and cancellation", () => {
  it("returns at DONE and cancels an open body without waiting for cleanup", async () => {
    let canceled = 0;
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(answer() + done)); }, cancel() { canceled++; return new Promise(() => {}); } });
    const result = await Promise.race([(async () => { const values = []; for await (const value of parseSseJson(stream)) values.push(value); return values; })(), new Promise((resolve) => setTimeout(() => resolve("hung"), 30))]);
    expect(result).not.toBe("hung"); expect(canceled).toBe(1);
  });
  it("rejects EOF after finish_reason without DONE", async () => {
    const stream = provider(answer()).body!;
    await expect((async () => { for await (const _ of parseSseJson(stream)) { /* Consume until explicit completion or failure. */ } })()).rejects.toMatchObject({ code: "upstream_incomplete" });
  });
  it("never dispatches incomplete tool arguments even when the provider sends DONE", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return provider(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: '{"query":' } }] }, finish_reason: "tool_calls" }] }) + done); }) as typeof fetch;
    await expect(orchestrateToolCalling({ config: config(fetchImpl), model: "phala/test", messages: [{ role: "user", content: "q" }], entityId: "e", write: () => {} })).rejects.toMatchObject({ code: "upstream_incomplete" }); expect(calls).toBe(1);
  });
});

describe("active body ownership", () => {
  it("cancels a stalled tool JSON reader, settles the turn, and never starts synthesis", async () => {
    const runtime = clock(); let canceled = 0, calls = 0; const signals: AbortSignal[] = [];
    const fetchImpl = (async (_url, init) => {
      calls++; signals.push(init?.signal as AbortSignal);
      if (calls === 1) return provider(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) + done);
      return new globalThis.Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('{"result":')); }, cancel() { canceled++; return Promise.reject(new Error("sentinel-cleanup")); } }));
    }) as typeof fetch;
    const turn = run(config(fetchImpl, runtime)); await flush(); expect(calls).toBe(2);
    await runtime.advance(100); await turn.finished;
    expect(canceled).toBe(1); expect(signals[0]).toBe(signals[1]); expect(signals.every((s) => s.aborted)).toBe(true); expect(calls).toBe(2); expect(runtime.tasks.size).toBe(0);
  });
  it("cancels a stalled provider reader exactly once even when cancellation rejects", async () => {
    const runtime = clock(); let canceled = 0;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode(answer("partial"))); }, cancel() { canceled++; return Promise.reject(new Error("sentinel-cleanup")); } });
    const turn = run(config((async () => new globalThis.Response(body)) as typeof fetch, runtime)); await flush(); await runtime.advance(100); await turn.finished;
    expect(canceled).toBe(1); expect(body.locked).toBe(false); expect(turn.res.text()).toContain('"turn_timeout"');
  });
});

describe("terminal and transport races", () => {
  for (const closedAt of ["request", "response", "ended", "headers", "first-write", "response-error"] as const) {
    it(`starts no provider work when closed at ${closedAt}`, async () => {
      const runtime = clock(); const pair = response(); let calls = 0;
      if (closedAt === "request") pair.req.aborted = true;
      if (closedAt === "response") pair.res.destroyed = true;
      if (closedAt === "ended") pair.res.writableEnded = true;
      if (closedAt === "headers") pair.res.flushHeaders = function () { this.headersSent = true; this.destroy(); };
      if (closedAt === "first-write") pair.res.write = () => { throw new Error("sentinel-write"); };
      if (closedAt === "response-error") pair.res.write = function () { this.emit("error", new Error("sentinel-response-error")); return false; };
      const turn = run(config((async () => { calls++; return provider(answer() + done); }) as typeof fetch, runtime), pair);
      await turn.finished; expect(calls).toBe(0); expect(pair.res.endCount).toBe(0); expect(runtime.tasks.size).toBe(0); expect(runtime.logs).toHaveLength(1);
    });
  }
  it("claims timeout before a reentrant abort callback closes the response", async () => {
    const runtime = clock(); const pair = response();
    const turn = run(config((async (_url, init) => {
      init?.signal?.addEventListener("abort", () => pair.res.destroy(), { once: true });
      return new Promise(() => {});
    }) as typeof fetch, runtime), pair);
    await flush(); const before = pair.res.text(); await runtime.advance(100); await turn.finished;
    expect(pair.res.text()).toBe(before + ": keepalive\n\n".repeat(9)); expect(pair.res.text()).not.toContain("stream_error"); expect(pair.res.endCount).toBe(0);
    expect(runtime.logs).toHaveLength(1); expect(runtime.logs[0]).toMatchObject({ outcome: "turn_timeout", responseDestroyed: true });
  });
  it("ignores queued heartbeat callbacks and late provider resolution after cancellation", async () => {
    const runtime = clock(); const pending = deferred<globalThis.Response>(); let canceled = 0;
    const turn = run(config((async () => pending.promise) as typeof fetch, runtime)); await flush(); const queued = [...runtime.tasks.values()].map((task) => task.fn);
    turn.req.aborted = true; turn.req.emit("aborted"); await turn.finished; const bytes = turn.res.text();
    pending.resolve(new globalThis.Response(new ReadableStream({ cancel() { canceled++; return Promise.reject(new Error("sentinel-late-cleanup")); } })));
    for (const callback of queued) callback(); await flush();
    expect(turn.res.text()).toBe(bytes); expect(canceled).toBe(1); expect(turn.res.endCount).toBe(0); expect(runtime.logs).toHaveLength(1); expect(runtime.tasks.size).toBe(0);
  });
  it("does not reset grace after recovering the ordinary drain and blocking terminal output", async () => {
    const runtime = clock(); const pair = response(); const original = pair.res.write;
    pair.res.write = function (bytes) { original.call(this, bytes); return this.chunks.length !== 2 && this.chunks.length !== 4; };
    const turn = run(config((async () => provider(answer("😀".repeat(15000)) + done)) as typeof fetch, runtime), pair);
    await flush(); await runtime.advance(115); pair.res.emit("drain"); await flush(); expect(pair.res.chunks).toHaveLength(4);
    await runtime.advance(5); await turn.finished; expect(pair.res.destroyed).toBe(true); expect(pair.res.text()).not.toContain(done); expect(runtime.now()).toBe(120); expect(runtime.tasks.size).toBe(0);
  });
  it("does not replay an accepted complete frame when its final slice awaits drain at timeout", async () => {
    const runtime = clock(); const pair = response(); const original = pair.res.write;
    pair.res.write = function (bytes) { original.call(this, bytes); return this.chunks.length !== 2; };
    const turn = run(config((async () => provider(answer("already accepted") + done)) as typeof fetch, runtime), pair);
    await flush(); await runtime.advance(100); pair.res.emit("drain"); await turn.finished;
    expect(pair.res.text().match(/already accepted/g)).toHaveLength(1); expect(pair.res.text().match(/data: \[DONE\]/g)).toHaveLength(1); expect(pair.res.chunks).toHaveLength(4);
  });
  it("retains a success claim if a previously queued deadline fires during terminal drain", async () => {
    const runtime = clock(); const pair = response(); const pending = deferred<globalThis.Response>(); const original = pair.res.write;
    pair.res.write = function (bytes) { original.call(this, bytes); return !new TextDecoder().decode(this.chunks.at(-1)).includes('"id"'); };
    const turn = run(config((async () => pending.promise) as typeof fetch, runtime), pair); await flush(); const deadline = [...runtime.tasks.values()].find((task) => task.at === 100)!.fn;
    pending.resolve(provider(answer() + done)); await flush(); deadline(); pair.res.emit("drain"); await turn.finished;
    expect(pair.res.text()).not.toContain("stream_error"); expect(pair.res.text().match(/data: \[DONE\]/g)).toHaveLength(1); expect(runtime.logs[0]).toMatchObject({ outcome: "success" });
  });
});

describe("orchestration accounting boundaries", () => {
  it("returns completed-round totals for cancellation observed at the next round boundary", async () => {
    let round = 0, boundaries = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes("/tools/")) return new globalThis.Response(JSON.stringify({ result: { text: "result" } }));
      round++;
      return provider(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }) + frame({ usage: { prompt_tokens: 7, completion_tokens: 3 } }) + done);
    }) as typeof fetch;
    const result = await orchestrateToolCalling({ config: config(fetchImpl), model: "phala/test", messages: [{ role: "user", content: "q" }], entityId: "e", write: () => {}, isAborted: () => ++boundaries > 1 });
    expect(result).toEqual({ promptTokens: 7, completionTokens: 3, completionId: "" }); expect(round).toBe(1);
  });
  it("starts no operation for an already-aborted signal", async () => {
    let calls = 0; const controller = new AbortController(); controller.abort();
    const result = await orchestrateToolCalling({ config: config((async () => { calls++; return provider(answer() + done); }) as typeof fetch), model: "phala/test", messages: [{ role: "user", content: "q" }], entityId: "e", write: () => {}, signal: controller.signal });
    expect(calls).toBe(0); expect(result).toEqual({ promptTokens: 0, completionTokens: 0, completionId: "" });
  });
});


it("returns a stalled provider iterator exactly once without waiting for return settlement", async () => {
  const runtime = clock(); let returned = 0;
  const body = { [Symbol.asyncIterator]() { return {
    next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
    return: () => { returned++; return new Promise<IteratorResult<Uint8Array>>(() => {}); },
  }; } };
  const turn = run(config((async () => ({ ok: true, body })) as unknown as typeof fetch, runtime));
  await flush(); await runtime.advance(100); await turn.finished;
  expect(returned).toBe(1); expect(runtime.tasks.size).toBe(0);
});

it("retains the shared grace and response error listener until the HTTP finish event", async () => {
  const runtime = clock(); const pair = response();
  pair.res.end = function () { this.endCount++; this.writableEnded = true; };
  let finished = false;
  const turn = run(config((async () => provider(answer() + done)) as typeof fetch, runtime), pair);
  void turn.finished.then(() => { finished = true; }); await flush();
  expect(pair.res.endCount).toBe(1); expect(finished).toBe(false); expect(pair.res.listenerCount("error")).toBe(1);
  await runtime.advance(20); await turn.finished; expect(pair.res.destroyed).toBe(true); expect(runtime.tasks.size).toBe(0);
});

it("handles a response error during end flush without another terminal or unhandled rejection", async () => {
  const runtime = clock(); const pair = response();
  pair.res.end = function () { this.endCount++; this.writableEnded = true; };
  const turn = run(config((async () => provider(answer() + done)) as typeof fetch, runtime), pair); await flush(); const bytes = pair.res.text();
  expect(() => pair.res.emit("error", new Error("sentinel-late-response"))).not.toThrow(); await turn.finished;
  expect(pair.res.destroyed).toBe(true); expect(pair.res.text()).toBe(bytes); expect(pair.res.endCount).toBe(1); expect(runtime.tasks.size).toBe(0);
});

describe("malformed provider tool deltas", () => {
  for (const invalid of [
    { index: -1, id: "c1", function: { name: "web_search", arguments: "{}" } },
    { index: 0, id: { unexpected: true }, function: { name: "web_search", arguments: "{}" } },
    { index: 0, id: "c1", function: { name: { unexpected: true }, arguments: "{}" } },
  ]) {
    it(`rejects invalid tool metadata before dispatch (${JSON.stringify(invalid)})`, async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return provider(frame({ choices: [{ delta: { tool_calls: [invalid] }, finish_reason: "tool_calls" }] }) + done);
      }) as typeof fetch;
      await expect(orchestrateToolCalling({ config: config(fetchImpl), model: "phala/test", messages: [{ role: "user", content: "q" }], entityId: "e", write: () => {} })).rejects.toMatchObject({ code: "upstream_incomplete" });
      expect(calls).toBe(1);
    });
  }
});

describe("provider protocol errors", () => {
  for (const partial of ["", "Already received."]) {
    it(`reports provider JSON errors as typed upstream failure ${partial ? "after partial content" : "before content"}`, async () => {
      const runtime = clock(); let canceled = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoder.encode((partial ? answer(partial) : "") + frame({ error: { message: "sentinel-provider-secret", type: "sentinel-provider-type" } }) + done)); },
        cancel() { canceled++; },
      });
      const turn = run(config((async () => new globalThis.Response(body)) as typeof fetch, runtime));
      await turn.finished;
      expect(turn.res.text()).toContain('"stream_error":{"code":"upstream_failed"}');
      expect(turn.res.text()).not.toContain('"usage"');
      expect(turn.res.text()).not.toContain('"id"');
      expect(turn.res.text()).not.toContain("sentinel-provider");
      if (partial) expect(turn.res.text()).toContain(partial);
      expect(turn.res.text().match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(canceled).toBe(1);
      expect(runtime.logs[0]).toMatchObject({ outcome: "upstream_failed" });
    });
  }
});
