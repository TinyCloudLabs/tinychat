import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, getUsage, recordUsage } from "../billing/usage.js";
import { TIERS } from "../billing/tiers.js";

const address = "0xtask-race-fixture";
const model = "phala/gpt-oss-120b";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let quietInfo: ReturnType<typeof spyOn>;
beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "local-stripe-fixture";
  process.env.REDPILL_API_KEY = "local-catalog-fixture";
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).endsWith("/models")) throw new Error("Unexpected global network request");
    return Response.json({ data: [{ id: model, context_length: 100000, pricing: { prompt: "0.000001", completion: "0.000001" } }] });
  }) as typeof fetch;
  quietInfo = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...originalEnv }; globalThis.fetch = originalFetch; quietInfo.mockRestore();
  _setStripeClient(null); _resetCache(); _resetUsage(); _resetCatalogCache();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Controlled race did not settle")), 1500); })]); }
  finally { clearTimeout(timer!); }
}
function fixture() {
  const blocked = deferred();
  const accounted = deferred();
  const chunks: string[] = [];
  const entries: any[] = [];
  const calls: string[] = [];
  const summaries: any[] = [];
  let ended = false;
  let task: any;
  let seq = 0;
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const req = Object.assign(new EventEmitter(), { user: { address }, body: { model, messages: [{ role: "user", content: "Hello" }] } }) as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, headersSent: false,
    setHeader() { return this; }, flushHeaders() { this.headersSent = true; },
    status() { return this; }, json() { throw new Error("Unexpected HTTP admission denial"); },
    write(bytes: Uint8Array | string) {
      const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
      chunks.push(text);
      if (text.includes("Hello")) { blocked.resolve(); return false; }
      return true;
    },
    end() { ended = true; this.emit("finish"); return this; },
    destroy() { this.destroyed = true; this.emit("close"); return this; },
  }) as unknown as ExpressResponse;
  Object.defineProperties(res, { writableEnded: { get: () => ended }, writableFinished: { get: () => ended } });
  const event = (type: string, value: object) => frame({ executionId: task.executionId, seq: ++seq, type, ...value });
  const usage = (attempts: number) => ({ promptTokens: 17 * attempts, completionTokens: 5 * attempts, startedAttempts: attempts, reportedAttempts: attempts, finalizedAttempts: attempts, usageCompleteness: "complete" });
  const emit = (text: string) => stream.enqueue(new TextEncoder().encode(text));
  const finish = () => { emit(event("final", { model, outcome: "success", ...usage(2), answer: { kind: "model_text", delivery: "streamed" }, answerIsProviderVerbatim: true, finalProviderCompletionId: "race-provider-final" })); stream.close(); };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
    if (url.endsWith("/cancel")) { finish(); return Response.json({}); }
    if (!url.endsWith("/tasks")) throw new Error("Unexpected backend provider/tool work");
    task = JSON.parse(String(init?.body));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller;
      emit(event("accepted", { version: 1, model, deadlineAt: task.deadlineAt }) + event("usage", usage(1)) + event("content_delta", { text: "Hello" }));
    } }), { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const config: AgentChatConfig = {
    agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a", entityIdFor: () => "8ed637c2-9747-4d8e-a36f-803e1c24bc10",
    elizaServiceUrl: "https://service.test", elizaServiceSecret: "local-service-fixture", redpillApiKey: "unused", redpillBaseUrl: "https://provider.test/v1",
    defaultModel: () => model, isModelOffered: value => value === model, fetchImpl, elizaTasksEnabled: true,
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 },
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: value => summaries.push(value) },
    flusher: { enqueue(entry: unknown) { entries.push(entry); accounted.resolve(); } } as AgentChatConfig["flusher"],
  };
  return { req, res, chunks, entries, calls, summaries, blocked, accounted, finish,
    burst: (count: number) => emit(Array.from({ length: count }, () => event("content_delta", { text: "x" })).join("")),
    run: () => createAgentChatHandler(config)(req, res, () => {}),
  };
}

describe("task accounting terminal races", () => {
  for (const winner of ["cancel", "final"] as const) test(`${winner} wins while browser delivery is blocked: final usage is recorded once without late success`, async () => {
    const local = fixture();
    const pending = local.run();
    await bounded(local.blocked.promise);
    if (winner === "final") { local.finish(); await bounded(local.accounted.promise); }
    local.req.emit("aborted"); local.req.emit("aborted");
    await bounded(Promise.resolve(pending));
    expect(local.entries).toHaveLength(1);
    expect(local.entries[0]).toMatchObject({ prompt_tokens: 34, completion_tokens: 10, credits: 1 });
    expect(getUsage(address, TIERS.free).used).toBe(1);
    expect(local.calls.filter(url => url.endsWith("/cancel"))).toHaveLength(winner === "cancel" ? 1 : 0);
    expect(local.calls.filter(url => url.endsWith("/tasks"))).toHaveLength(1);
    expect(local.chunks.join("")).not.toMatch(/race-provider-final|\"usage\"|\[DONE\]/);
  });

  test("delivery queue overflow cancels once, drains accounting without browser drain, and bounds delivery", async () => {
    const local = fixture();
    const pending = local.run();
    await bounded(local.blocked.promise);
    const started = performance.now();
    local.burst(1100); // Valid small private frames exceed the route's 1024 pending-frame budget.
    await bounded(local.accounted.promise);
    expect(local.entries).toHaveLength(1);
    expect(local.entries[0]).toMatchObject({ prompt_tokens: 34, completion_tokens: 10, credits: 1 });
    expect(getUsage(address, TIERS.free).used).toBe(1);
    await bounded(Promise.resolve(pending));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(local.calls.filter(url => url.endsWith("/cancel"))).toHaveLength(1);
    expect(local.res.destroyed).toBe(true);
    expect(local.chunks.join("").length).toBeLessThan(1024);
    expect(local.summaries).toHaveLength(1);
    expect(local.summaries[0].outcome).toBe("result_size_limit");
  });

  test("paid task rounds aggregate credits once into the new anchored week after crossing its boundary", async () => {
    const anchor = Date.parse("2026-09-01T00:00:00Z");
    const boundary = anchor + 7 * 24 * 60 * 60 * 1000;
    let now = boundary - 10;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    process.env.STRIPE_PRICE_PLUS_MONTHLY = "price_local_plus";
    _setStripeClient({ customers: { search: async () => ({ data: [{ id: "customer-local" }] }) }, subscriptions: { list: async () => ({ data: [{ status: "active", billing_cycle_anchor: anchor / 1000, current_period_end: (boundary + 30 * 24 * 60 * 60 * 1000) / 1000, items: { data: [{ price: { id: "price_local_plus" } }] } }] }) } } as unknown as Stripe);
    recordUsage(address, TIERS.plus, 7, anchor);
    const local = fixture();
    const pending = local.run();
    try {
      await bounded(local.blocked.promise);
      expect(getUsage(address, TIERS.plus, anchor).used).toBe(7);
      now = boundary + 10;
      local.finish(); await bounded(local.accounted.promise);
      expect(local.entries).toHaveLength(1);
      expect(local.entries[0]).toMatchObject({ prompt_tokens: 34, completion_tokens: 10, credits: 1, window_kind: "anchored_week", window_start: boundary, occurred_at: now });
      expect(getUsage(address, TIERS.plus, anchor).used).toBe(1);
      local.res.emit("drain"); await bounded(Promise.resolve(pending));
      expect(local.chunks.join("").match(/data: \[DONE\]/g)).toHaveLength(1);
    } finally { local.req.emit("aborted"); await Promise.resolve(pending); clock.mockRestore(); }
  });
});
