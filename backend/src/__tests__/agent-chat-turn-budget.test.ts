import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, recordUsage } from "../billing/usage.js";
import { TIERS } from "../billing/tiers.js";

const address = "0xturn-budget-local";
const model = "phala/gpt-oss-120b";
const budget = 1000;
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let info: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_local_test";
  process.env.REDPILL_API_KEY = "local_catalog_test";
  process.env.LEDGER_CREDIT_GATE_ENABLED = "false";
  process.env.CREDIT_BUDGET_FREE = String(budget);
  delete process.env.AGENT_CHAT_BUDGET_STOP_MODE;
  delete process.env.AGENT_CHAT_BUDGET_PREFLIGHT;
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).endsWith("/models")) throw new Error("Unexpected global network request");
    return Response.json({ data: [{ id: model, context_length: 100_000, pricing: { prompt: "0.000001", completion: "0.000001" } }] });
  }) as typeof fetch;
  info = spyOn(console, "info").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  info.mockRestore(); error.mockRestore();
  _setStripeClient(null); _resetCache(); _resetUsage(); _resetCatalogCache();
});

// Seeds today's free-tier usage so the remaining budget is exactly `remaining`.
function seedRemaining(remaining: number) {
  _resetUsage();
  if (budget - remaining > 0) recordUsage(address, TIERS.free, budget - remaining);
}

function browser() {
  const chunks: string[] = [];
  let jsonBody: unknown = undefined;
  let status = 200;
  const req = Object.assign(new EventEmitter(), { user: { address }, body: { model, messages: [{ role: "user", content: "Hello" }] } }) as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    statusCode: 200,
    status(value: number) { status = value; this.statusCode = value; return this; },
    json(value: unknown) { jsonBody = value; return this; },
    setHeader() { return this; },
    flushHeaders() {},
    write(value: Uint8Array | string) { chunks.push(typeof value === "string" ? value : new TextDecoder().decode(value)); return true; },
    end() { this.emit("finish"); return this; },
    destroy() { this.destroyed = true; this.emit("close"); return this; },
  }) as unknown as ExpressResponse;
  return { req, res, chunks, json: () => jsonBody, status: () => status };
}

type Round = { round: number; prompt: number; completion: number };
type Task = { executionId: string; deadlineAt: string };

// Aggregate fields shared by the usage snapshot and every terminal frame. Attempts are
// reported as fully accounted (reported = finalized = started), matching the harness.
const aggregate = (last: Round | undefined) => ({
  promptTokens: last?.prompt ?? 17,
  completionTokens: last?.completion ?? 5,
  startedAttempts: last?.round ?? 1,
  reportedAttempts: last?.round ?? 1,
  finalizedAttempts: last?.round ?? 1,
  usageCompleteness: "complete",
});

function fixture(rounds: Round[], tail: "final" | "none") {
  const calls: string[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let task: Task = { executionId: "", deadlineAt: "" };
  const close = () => { if (!closed) { closed = true; controller.close(); } };
  const last = rounds.at(-1);
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
    if (url.endsWith("/cancel")) {
      controller.enqueue(encoder.encode(frame({ executionId: task.executionId, type: "final", seq: 99, model, outcome: "cancelled", ...aggregate(last), answerIsProviderVerbatim: false })));
      close();
      return Response.json({});
    }
    if (url.endsWith("/tasks")) {
      task = JSON.parse(String(init?.body));
      return new Response(new ReadableStream({ start(stream) {
        controller = stream;
        const id = task.executionId;
        let seq = 1;
        const out: Record<string, unknown>[] = [{ executionId: id, type: "accepted", seq: seq++, version: 1, model, deadlineAt: task.deadlineAt }];
        for (const r of rounds) out.push({ executionId: id, type: "usage", seq: seq++, promptTokens: r.prompt, completionTokens: r.completion, startedAttempts: r.round, reportedAttempts: r.round - 1, finalizedAttempts: r.round - 1, usageCompleteness: "partial" });
        if (tail === "final") {
          out.push({ executionId: id, type: "content_delta", seq: seq++, text: "Hello" });
          out.push({ executionId: id, type: "final", seq, model, outcome: "success", ...aggregate(last), answer: { kind: "model_text", delivery: "streamed" }, answerIsProviderVerbatim: true, finalProviderCompletionId: "provider-final-only" });
        }
        for (const value of out) stream.enqueue(encoder.encode(frame(value)));
        if (tail === "final") close();
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("Task route attempted backend provider or tool execution");
  }) as typeof fetch;
  const config: AgentChatConfig = {
    agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a", entityIdFor: () => "8ed637c2-9747-4d8e-a36f-803e1c24bc10",
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 },
    elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "local-test", redpillApiKey: "unused", redpillBaseUrl: "https://provider.test/v1",
    defaultModel: () => model, isModelOffered: value => value === model, fetchImpl,
    elizaTasksEnabled: true,
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {} },
    flusher: { enqueue() {} } as unknown as AgentChatConfig["flusher"],
  };
  return { config, calls };
}

describe("agent chat turn budget", () => {
  test("enforce pre-flight rejects a turn one credit below the minimum before any task starts", async () => {
    process.env.AGENT_CHAT_BUDGET_PREFLIGHT = "enforce";
    seedRemaining(319);
    const run = fixture([], "final");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(local.status()).toBe(402);
    expect(local.json()).toMatchObject({ error: "credit_budget_exceeded" });
    expect(run.calls.some(url => url.endsWith("/tasks"))).toBe(false);
  });

  test("enforce pre-flight admits a turn exactly at the minimum", async () => {
    process.env.AGENT_CHAT_BUDGET_PREFLIGHT = "enforce";
    seedRemaining(320);
    const run = fixture([], "final");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(local.status()).toBe(200);
    expect(run.calls.some(url => url.endsWith("/tasks"))).toBe(true);
  });

  test("default log pre-flight admits a turn below the minimum", async () => {
    seedRemaining(319);
    const run = fixture([], "final");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(local.status()).toBe(200);
    expect(run.calls.some(url => url.endsWith("/tasks"))).toBe(true);
    expect(run.calls.some(url => url.endsWith("/cancel"))).toBe(false);
  });

  test("finish_answer lets the crossing round run and stops the turn at the next round start", async () => {
    seedRemaining(1);
    const run = fixture([{ round: 1, prompt: 0, completion: 0 }, { round: 2, prompt: 17, completion: 5 }, { round: 3, prompt: 34, completion: 10 }], "none");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(run.calls.filter(url => url.endsWith("/cancel"))).toHaveLength(1);
    expect(local.chunks.join("")).toContain('"stream_error":{"code":"budget_exhausted"}');
  });

  test("finish_answer finishes a turn that completes during the crossing round", async () => {
    seedRemaining(1);
    const run = fixture([{ round: 1, prompt: 0, completion: 0 }, { round: 2, prompt: 17, completion: 5 }], "final");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(run.calls.some(url => url.endsWith("/cancel"))).toBe(false);
    expect(local.chunks.join("")).not.toContain("budget_exhausted");
  });

  test("hard_stop cancels at the first crossing round", async () => {
    process.env.AGENT_CHAT_BUDGET_STOP_MODE = "hard_stop";
    seedRemaining(1);
    const run = fixture([{ round: 1, prompt: 0, completion: 0 }, { round: 2, prompt: 17, completion: 5 }], "none");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(run.calls.filter(url => url.endsWith("/cancel"))).toHaveLength(1);
    expect(local.chunks.join("")).toContain('"stream_error":{"code":"budget_exhausted"}');
  });

  test("off mode never cancels a turn for budget", async () => {
    process.env.AGENT_CHAT_BUDGET_STOP_MODE = "off";
    seedRemaining(1);
    const run = fixture([{ round: 1, prompt: 0, completion: 0 }, { round: 2, prompt: 17, completion: 5 }, { round: 3, prompt: 34, completion: 10 }], "final");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(run.calls.some(url => url.endsWith("/cancel"))).toBe(false);
    expect(local.chunks.join("")).not.toContain("budget_exhausted");
  });
});
