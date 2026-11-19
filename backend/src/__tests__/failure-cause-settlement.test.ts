// Sam, card ask/failed-reply-charges (2026-11-19): a failed reply is charged only when the model's own output
// broke it; our failures (provider, network, our limits) are free, even after content was delivered.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatAccess, type AgentChatConfig } from "../routes/agent-chat.js";
import { settleReply } from "../billing/settle.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, getUsage, recordUsage } from "../billing/usage.js";
import type { LedgerFlusher, LedgerUsageRecordInput } from "../billing/ledger-flusher.js";
import { TIERS } from "../billing/tiers.js";

const address = "0xfailure-cause";
const model = "z-ai/glm-5.2";
const LIMIT = 1000;
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let info: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
let enqueued: LedgerUsageRecordInput[];
const flusher = { enqueue: (record: LedgerUsageRecordInput) => { enqueued.push(record); } } as unknown as LedgerFlusher;

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_local_test";
  process.env.REDPILL_API_KEY = "local_catalog_test";
  process.env.LEDGER_CREDIT_GATE_ENABLED = "false";
  process.env.CREDIT_BUDGET_FREE = String(LIMIT);
  process.env.AGENT_CHAT_BUDGET_STOP_MODE = "off";
  delete process.env.AGENT_CHAT_BUDGET_PREFLIGHT;
  enqueued = [];
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  // 10 credits per 1K tokens each way.
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

// Leaves 500 credits in today's free window.
function seed500() { _resetUsage(); recordUsage(address, TIERS.free, LIMIT - 500); }
const used = () => getUsage(address, TIERS.free).used;

function browser() {
  const chunks: string[] = [];
  const req = Object.assign(new EventEmitter(), { user: { address }, body: { model, messages: [{ role: "user", content: "Hello" }] } }) as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, statusCode: 200,
    status() { return this; }, json() { return this; }, setHeader() { return this; }, flushHeaders() {},
    write(value: Uint8Array | string) { chunks.push(typeof value === "string" ? value : new TextDecoder().decode(value)); return true; },
    end() { this.emit("finish"); return this; },
    destroy() { this.destroyed = true; this.emit("close"); return this; },
  }) as unknown as ExpressResponse;
  return { req, res, stream: () => chunks.join("") };
}

function agentConfig(fetchImpl: typeof fetch, over: Partial<AgentChatConfig> = {}): AgentChatConfig {
  return {
    agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a", entityIdFor: () => "8ed637c2-9747-4d8e-a36f-803e1c24bc10",
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 },
    elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "local-test", redpillApiKey: "unused", redpillBaseUrl: "https://provider.test/v1",
    defaultModel: () => model, isModelOffered: value => value === model, fetchImpl, redpillFetch: fetchImpl, flusher,
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {} },
    ...over,
  };
}

const sse = (...frames: string[]) => new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
const usageFrame = (prompt: number, completion: number) => frame({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });
const toolCall = (name: string, args: string, finish = "tool_calls") =>
  frame({ id: "c", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: args } }] }, finish_reason: finish }] });
// Private access is not active, so the turn offers only web_search.
const noPrivateAccess: AgentChatAccess = {
  capture: () => ({ isCurrent: () => true, onInvalidate: () => () => {} }),
  status: async () => ({ status: "none" }),
};

async function run(config: AgentChatConfig) {
  const local = browser();
  await createAgentChatHandler(config)(local.req, local.res, () => {});
  return local.stream();
}

describe("model-caused failures are charged, clamped, even with nothing delivered", () => {
  // 60K prompt + 22K completion tokens is 820 credits; the allowance is 500.
  test("the model keeps calling a tool it was not offered until the rounds run out", async () => {
    seed500();
    const dispatched: string[] = [];
    // Each round asks for the same unoffered tool: 10K + 5K tokens is 150 credits a round, three rounds.
    const stream = await run(agentConfig(async input => {
      if (String(input).includes("/tools/")) dispatched.push(String(input));
      return sse(toolCall("tinycloud_find_meetings", "{}"), usageFrame(10_000, 5_000), "data: [DONE]\n\n");
    }, { access: noPrivateAccess }));
    expect(stream).toContain('"stream_error":{"code":"routing_mismatch"}');
    expect(dispatched).toEqual([]);
    expect(used()).toBe(LIMIT - 500 + 450);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(450);
  });

  test("the model's tool-call arguments do not parse", async () => {
    seed500();
    // A tool round within the allowance: one that used it up would stop as budget_exhausted before the arguments are read.
    const stream = await run(agentConfig(async () => sse(toolCall("web_search", "{not json"), usageFrame(10_000, 2_000), "data: [DONE]\n\n")));
    expect(stream).toContain('"stream_error":{"code":"upstream_incomplete"}');
    expect(used()).toBe(LIMIT - 500 + 120);
    expect(enqueued[0].credits).toBe(120);
  });

  test("the model's tool call never finishes", async () => {
    seed500();
    // 2K completion tokens is far below the budget cap, so this length stop is the model's, not the allowance's.
    const stream = await run(agentConfig(async () => sse(toolCall("web_search", "{}", "length"), usageFrame(10_000, 2_000), "data: [DONE]\n\n")));
    expect(stream).toContain('"stream_error":{"code":"upstream_incomplete"}');
    expect(used()).toBe(LIMIT - 500 + 120);
    expect(enqueued[0].credits).toBe(120);
  });

  test("the model asks for more meeting calls than a turn allows", async () => {
    seed500();
    const calls = Array.from({ length: 9 }, (_, index) => ({ index, id: `c${index}`, function: { name: "prepare_meeting_turn", arguments: "{}" } }));
    const fetchImpl = (async (input: unknown) => {
      if (String(input).endsWith("/capabilities")) throw new Error("Unexpected capability request");
      return sse(usageFrame(10_000, 2_000), frame({ id: "c", choices: [{ delta: { tool_calls: calls } }] }), "data: [DONE]\n\n");
    }) as typeof fetch;
    await run(agentConfig(fetchImpl, { meetingContentRetrievalEnabled: true }));
    expect(used()).toBe(LIMIT - 500 + 120);
    expect(enqueued[0].credits).toBe(120);
  });
});

describe("our failures are free, even after content was delivered", () => {
  test("round two's provider error after round one streamed content and used tokens", async () => {
    seed500();
    let round = 0;
    const fetchImpl = (async (input: unknown) => {
      if (String(input).includes("/tools/")) return Response.json({ result: { text: "tool result" } });
      if (++round > 1) return new Response("failed", { status: 503 });
      return sse(frame({ choices: [{ delta: { content: "Let me check that." } }] }), toolCall("web_search", "{}"), usageFrame(10_000, 2_000), "data: [DONE]\n\n");
    }) as typeof fetch;
    const stream = await run(agentConfig(fetchImpl));
    expect(stream).toContain("Let me check that.");
    expect(stream).toContain('"stream_error":{"code":"upstream_failed"}');
    expect(used()).toBe(LIMIT - 500);
    expect(enqueued).toEqual([]);
  });

  test("a stream that ends before DONE after content", async () => {
    seed500();
    const stream = await run(agentConfig(async () => sse(frame({ choices: [{ delta: { content: "Partial" } }] }), usageFrame(60_000, 22_000))));
    expect(stream).toContain('"stream_error":{"code":"upstream_incomplete"}');
    expect(used()).toBe(LIMIT - 500);
    expect(enqueued).toEqual([]);
  });

  test("a web search result over the size cap", async () => {
    seed500();
    const fetchImpl = (async (input: unknown) => {
      if (String(input).includes("/tools/")) return new Response(JSON.stringify({ result: { text: "x".repeat(70_000) } }));
      return sse(toolCall("web_search", "{}"), usageFrame(10_000, 2_000), "data: [DONE]\n\n");
    }) as typeof fetch;
    const stream = await run(agentConfig(fetchImpl));
    expect(stream).toContain('"stream_error":{"code":"result_size_limit"}');
    expect(used()).toBe(LIMIT - 500);
    expect(enqueued).toEqual([]);
  });
});

type TaskFinal = { outcome: "failed"; code: string };
function taskConfig(final: TaskFinal, text?: string) {
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
    if (url.endsWith("/tasks")) {
      const task = JSON.parse(String(init?.body));
      const id = task.executionId; let seq = 1;
      const out: Record<string, unknown>[] = [{ executionId: id, type: "accepted", seq: seq++, version: 1, model, deadlineAt: task.deadlineAt }];
      if (text) out.push({ executionId: id, type: "content_delta", seq: seq++, text });
      out.push({ executionId: id, type: "final", seq, model, outcome: final.outcome, code: final.code, promptTokens: 60_000, completionTokens: 22_000,
        startedAttempts: 1, reportedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "complete", answerIsProviderVerbatim: false });
      return new Response(out.map(value => frame(value)).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return agentConfig(fetchImpl, { elizaTasksEnabled: true });
}

describe("Eliza /tasks: only its unambiguous model codes are charged", () => {
  test.each(["tool_attempt_limit", "routing_mismatch"])("%s with nothing delivered is charged, clamped", async code => {
    seed500();
    await run(taskConfig({ outcome: "failed", code }));
    expect(used()).toBe(LIMIT);
    expect(enqueued[0].credits).toBe(500);
  });

  test.each(["agent_failed", "upstream_incomplete", "result_size_limit"])("%s is free: it also covers provider and tool causes", async code => {
    seed500();
    await run(taskConfig({ outcome: "failed", code }, "Partial"));
    expect(used()).toBe(LIMIT - 500);
    expect(enqueued).toEqual([]);
  });
});

describe("a tool the model was not offered (TC-3463)", () => {
  test("gets a tool_not_found result; the model answers and the reply is a normal success", async () => {
    seed500();
    const dispatched: string[] = [];
    let rounds = 0;
    // 10K + 2K tokens is 120 credits a round.
    const stream = await run(agentConfig(async input => {
      if (String(input).includes("/tools/")) { dispatched.push(String(input)); return Response.json({}); }
      rounds++;
      return rounds === 1
        ? sse(toolCall("tinycloud_find_meetings", "{}"), usageFrame(10_000, 2_000), "data: [DONE]\n\n")
        : sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(10_000, 2_000), "data: [DONE]\n\n");
    }, { access: noPrivateAccess }));
    expect(stream).not.toContain("stream_error");
    expect(stream).toContain('"content":"Hi"');
    expect(dispatched).toEqual([]);
    expect(rounds).toBe(2);
    expect(enqueued.map(record => record.credits)).toEqual([240]);
  });
});

describe("settleReply", () => {
  const base = { address, tier: TIERS.free, anchor: null, allowance: 500, model, usage: { promptTokens: 60_000, completionTokens: 22_000 }, rates: null, executionId: "e", flusher };
  test("a model-caused failure with nothing delivered is charged, clamped", () => {
    seed500();
    const settled = settleReply({ ...base, startedAt: Date.now(), outcome: "failed", failureCause: "model", deliveredOutput: false });
    expect(settled.charged).toBe(500);
    expect(used()).toBe(LIMIT);
  });

  test("a failure with no cause is ours and free", () => {
    seed500();
    expect(settleReply({ ...base, startedAt: Date.now(), outcome: "failed", deliveredOutput: true }).charged).toBe(0);
    expect(enqueued).toEqual([]);
  });
});
