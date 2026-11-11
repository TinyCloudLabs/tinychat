import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import express, { type Request, type Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { createChatRouter } from "../routes/chat.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, getUsage, recordUsage } from "../billing/usage.js";
import type { LedgerFlusher, LedgerUsageRecordInput } from "../billing/ledger-flusher.js";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import { TIERS } from "../billing/tiers.js";

const address = "0xreply-settlement";
const model = "z-ai/glm-5.2";
const LIMIT = 1000;
const encoder = new TextEncoder();
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

// Leaves exactly `remaining` credits in today's free window.
function seedRemaining(remaining: number) {
  _resetUsage();
  if (LIMIT - remaining > 0) recordUsage(address, TIERS.free, LIMIT - remaining);
}
const used = () => getUsage(address, TIERS.free).used;

// A ledger that reports `committed` of the LIMIT used, independent of the local counter.
const ledgerWith = (committed: number) => ({
  rehydrateIfNeeded: async () => false,
  getEntitlement: async () => ({ credit_limit: LIMIT, committed_credits: committed, period_anchor: "utc_day", isOutage: false }),
  get unrehydratedServesCount() { return 0; },
}) as unknown as LedgerRehydrator;

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
    defaultModel: () => model, isModelOffered: value => value === model, fetchImpl, flusher,
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {} },
    ...over,
  };
}

const sse = (...frames: string[]) => new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
const usageFrame = (prompt: number, completion: number) => frame({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });
const providerRequests: Array<Record<string, unknown>> = [];
function provider(respond: () => Response) {
  providerRequests.length = 0;
  return (async (_input: unknown, init?: RequestInit) => { providerRequests.push(JSON.parse(String(init?.body))); return respond(); }) as typeof fetch;
}

describe("orchestrate path: stop at the limit, charge fairly", () => {
  test("a reply cut at the cap keeps its text, ends with one budget_exhausted and one DONE, and is charged at most the allowance", async () => {
    seedRemaining(295);
    const local = browser();
    // 100/1000*10 + 5000/1000*10 = 51 credits would fit; 60_000 completion tokens is 600.
    const config = agentConfig(provider(() => sse(frame({ id: "c", choices: [{ delta: { content: "Partial answer" }, finish_reason: "length" }] }), usageFrame(100, 60_000), "data: [DONE]\n\n")));
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    const stream = local.stream();
    expect(stream).toContain("Partial answer");
    expect(stream.match(/"stream_error":/g)).toHaveLength(1);
    expect(stream).toContain('"stream_error":{"code":"budget_exhausted"}');
    expect(stream.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(providerRequests).toHaveLength(1);
    expect(typeof providerRequests[0].max_tokens).toBe("number");
    expect(providerRequests[0].max_tokens as number).toBeLessThanOrEqual(29_500);
    expect(used()).toBe(LIMIT);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(295);
    expect(enqueued[0].record_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a provider failure before any content is free and leaves no ledger record", async () => {
    seedRemaining(500);
    const local = browser();
    const config = agentConfig(provider(() => sse(usageFrame(60_000, 22_000), frame({ error: { message: "synthetic provider failure" } }))));
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(local.stream()).toContain('"stream_error":{"code":"upstream_failed"}');
    expect(used()).toBe(LIMIT - 500);
    expect(enqueued).toEqual([]);
  });

  test("a provider failure after content was delivered is charged, clamped to the allowance", async () => {
    seedRemaining(500);
    const local = browser();
    const config = agentConfig(provider(() => sse(frame({ choices: [{ delta: { content: "Partial answer" } }] }), usageFrame(60_000, 22_000), frame({ error: { message: "synthetic provider failure" } }))));
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(used()).toBe(LIMIT);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(500);
  });

  test("a timed-out reply is charged at most the allowance it started with, even with nothing delivered", async () => {
    seedRemaining(500);
    const local = browser();
    const stalled = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(usageFrame(60_000, 22_000))); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const config = agentConfig(provider(stalled), { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 80, drainGraceMs: 100 } });
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(local.stream()).toContain('"stream_error":{"code":"turn_timeout"}');
    expect(used()).toBe(LIMIT);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(500);
  });

  // Round 1 streams content, then asks for a tool; round 2 fails. Output reached the user, so round 1's usage is charged.
  // `concurrent` credits are taken by another reply while this one runs, so the window's remainder can bind below the allowance.
  test.each([
    ["usage under the allowance is charged in full", 10, 3, 0, 1],
    ["usage above what the window has left is clamped to it", 0, 40_000, 450, 50],
  ])("prior-round usage is charged when output was delivered: %s", async (_name, prompt, completion, concurrent, charged) => {
    seedRemaining(500);
    let round = 0;
    const fetchImpl = (async (input: unknown) => {
      if (String(input).includes("/tools/")) return Response.json({ result: { text: "tool result" } });
      if (++round > 1) return new Response("failed", { status: 503 });
      if (concurrent) recordUsage(address, TIERS.free, concurrent);
      return sse(
        frame({ choices: [{ delta: { content: "Let me check that." } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
        usageFrame(prompt, completion), "data: [DONE]\n\n");
    }) as typeof fetch;
    const local = browser();
    await createAgentChatHandler(agentConfig(fetchImpl))(local.req, local.res, () => {});
    expect(local.stream()).toContain('"stream_error":{"code":"upstream_failed"}');
    expect(used()).toBe(LIMIT - 500 + concurrent + charged);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(charged);
  });

  test("each reply is recorded under its own id", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      seedRemaining(500);
      const local = browser();
      await createAgentChatHandler(agentConfig(provider(() => sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(10, 5), "data: [DONE]\n\n"))))(local.req, local.res, () => {});
    }
    ids.push(...enqueued.map(record => record.record_id!));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

type TaskFinal = { outcome: "success" | "failed" | "timed_out"; code?: string };
function taskFixture(usage: { prompt: number; completion: number }, final: TaskFinal, text?: string) {
  const requests: Array<{ executionId: string; deadlineAt: string }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
    if (url.endsWith("/tasks")) {
      const task = JSON.parse(String(init?.body)); requests.push(task);
      const aggregate = { promptTokens: usage.prompt, completionTokens: usage.completion, startedAttempts: 1, reportedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "complete" };
      const id = task.executionId; let seq = 1;
      const out: Record<string, unknown>[] = [{ executionId: id, type: "accepted", seq: seq++, version: 1, model, deadlineAt: task.deadlineAt }];
      if (text) out.push({ executionId: id, type: "content_delta", seq: seq++, text });
      out.push({ executionId: id, type: "final", seq, model, outcome: final.outcome, ...(final.code ? { code: final.code } : {}), ...aggregate, ...(final.outcome === "success" ? { answer: { kind: "model_text", delivery: "streamed" } } : {}), answerIsProviderVerbatim: final.outcome === "success", ...(final.outcome === "success" ? { finalProviderCompletionId: "p" } : {}) });
      return new Response(out.map(value => frame(value)).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { requests, config: agentConfig(fetchImpl, { elizaTasksEnabled: true }) };
}

describe("Eliza /tasks path: settlement clamp only", () => {
  test("a task whose observed usage exceeds the allowance is charged the allowance under the execution id", async () => {
    seedRemaining(295);
    const run = taskFixture({ prompt: 60_000, completion: 22_000 }, { outcome: "success" }, "Hello");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(used()).toBe(LIMIT);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(295);
    expect(enqueued[0].record_id).toBe(run.requests[0].executionId);
  });

  test("a failed task with nothing delivered is free", async () => {
    seedRemaining(500);
    const run = taskFixture({ prompt: 60_000, completion: 22_000 }, { outcome: "failed", code: "upstream_failed" });
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(local.stream()).toContain('"stream_error":{"code":"upstream_failed"}');
    expect(used()).toBe(LIMIT - 500);
    expect(enqueued).toEqual([]);
  });

  test("a failed task after content was delivered is charged, clamped", async () => {
    seedRemaining(500);
    const run = taskFixture({ prompt: 60_000, completion: 22_000 }, { outcome: "failed", code: "upstream_failed" }, "Partial");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(used()).toBe(LIMIT);
    expect(enqueued[0].credits).toBe(500);
  });

  test("a timed-out task is charged at most the allowance even with nothing delivered", async () => {
    seedRemaining(500);
    const run = taskFixture({ prompt: 60_000, completion: 22_000 }, { outcome: "timed_out", code: "turn_timeout" });
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(used()).toBe(LIMIT);
    expect(enqueued[0].credits).toBe(500);
  });
});

describe("/api/chat: clamp and free on early failure", () => {
  async function post(respond: () => Response, rehydrator?: LedgerRehydrator) {
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).endsWith("/chat/completions")) return respond();
      return Response.json({ data: [{ id: model, context_length: 100_000, pricing: { prompt: "0.000001", completion: "0.000001" } }] });
    }) as typeof fetch;
    const app = express();
    app.use(express.json());
    app.use("/api/chat", (req, _res, next) => { req.user = { address }; next(); }, createChatRouter({ flusher, ...(rehydrator ? { rehydrator } : {}) }));
    const server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    try {
      const { port } = server.address() as { port: number };
      const response = await originalFetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] }) });
      // The handler records synchronously after res.end(), so EOF cannot reach the client before settlement.
      await response.text().catch(() => "");
    } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
  }
  // Erroring a stream discards its queued chunks, so the error is raised only once they have been read.
  const dropped = (...frames: string[]) => {
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) { controller.error(new Error("upstream reset")); return; }
        sent = true;
        for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };

  test("with the ledger authoritative the allowance is what the ledger has left, not the local counter's", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    // Ledger: 900 of 1000 committed. Local counter: 0 used, so the local window alone would allow 1000.
    await post(() => sse(frame({ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }), usageFrame(60_000, 22_000), "data: [DONE]\n\n"), ledgerWith(900));
    expect(used()).toBe(100);
    expect(enqueued[0].credits).toBe(100);
  });

  test("a reply above the remaining allowance is charged only what is left", async () => {
    seedRemaining(295);
    await post(() => sse(frame({ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }), usageFrame(60_000, 22_000), "data: [DONE]\n\n"));
    expect(used()).toBe(LIMIT);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(295);
    expect(enqueued[0].record_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a stream that fails before any content is free", async () => {
    seedRemaining(500);
    await post(() => dropped(usageFrame(60_000, 22_000)));
    expect(used()).toBe(LIMIT - 500);
    expect(enqueued).toEqual([]);
  });

  test("a stream that fails after content is charged, clamped", async () => {
    seedRemaining(500);
    await post(() => dropped(frame({ choices: [{ delta: { content: "Partial" } }] }), usageFrame(60_000, 22_000)));
    expect(used()).toBe(LIMIT);
    expect(enqueued[0].credits).toBe(500);
  });
});

describe("a throwing ledger enqueue", () => {
  const throwing = { enqueue() { throw new Error("outbox down"); } } as unknown as LedgerFlusher;

  test("charges the orchestrate path locally exactly once, without logging the error text", async () => {
    seedRemaining(500);
    const local = browser();
    const config = agentConfig(provider(() => sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(10_000, 5_000), "data: [DONE]\n\n")), { flusher: throwing });
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(used()).toBe(LIMIT - 500 + 150);
    expect(local.stream().match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("outbox down");
  });

  test("charges the task path locally exactly once", async () => {
    seedRemaining(500);
    const run = taskFixture({ prompt: 10_000, completion: 5_000 }, { outcome: "success" }, "Hello");
    run.config.flusher = throwing;
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(used()).toBe(LIMIT - 500 + 150);
    expect(local.stream().match(/data: \[DONE\]/g)).toHaveLength(1);
  });
});

describe("ledger-authoritative allowance (agent chat)", () => {
  test("a reply is clamped to what the ledger has left even when the local counter says more", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    const local = browser();
    const config = agentConfig(provider(() => sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(60_000, 22_000), "data: [DONE]\n\n")), { rehydrator: ledgerWith(900) });
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(providerRequests).toHaveLength(1);
    expect(used()).toBe(100);
    expect(enqueued[0].credits).toBe(100);
  });
});

describe("a large paid allowance (agent chat)", () => {
  test("sends no max_tokens: the cap is bounded by the model's context, not the allowance", async () => {
    // About 1e9 output tokens of allowance at 10 credits per 1K: far beyond any context window.
    process.env.CREDIT_BUDGET_FREE = "10000000";
    const local = browser();
    const config = agentConfig(provider(() => sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(10, 5), "data: [DONE]\n\n")));
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0].max_tokens).toBeUndefined();
  });
});
