import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, getUsage } from "../billing/usage.js";
import { TIERS } from "../billing/tiers.js";

const address = "0xtask-accounting-local";
const model = "phala/gpt-oss-120b";
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let info: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_local_test";
  process.env.REDPILL_API_KEY = "local_catalog_test";
  process.env.LEDGER_CREDIT_GATE_ENABLED = "false";
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).endsWith("/models")) throw new Error("Unexpected global network request");
    // Each checkpoint and the final aggregate round to one credit: charging each event would overbill.
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

function browser(mode: "normal" | "throw-write" | "slow" | "throw-end" = "normal") {
  const chunks: string[] = [];
  let ended = false;
  let endCalls = 0;
  let headersSent = false;
  const req = Object.assign(new EventEmitter(), { user: { address }, body: { model, messages: [{ role: "user", content: "Hello" }] } }) as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    statusCode: 200,
    status(value: number) { this.statusCode = value; return this; },
    json(value: unknown) { throw new Error(`Unexpected admission response: ${JSON.stringify(value)}`); },
    setHeader() { return this; },
    flushHeaders() { headersSent = true; },
    write(value: Uint8Array | string) {
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      if (mode === "throw-write" && text.includes("Hello")) throw new Error("private-write-exception-sentinel");
      chunks.push(text);
      return !(mode === "slow" && text.includes("Hello"));
    },
    end() { endCalls++; if (mode === "throw-end") throw new Error("private-end-exception-sentinel"); ended = true; this.emit("finish"); return this; },
    destroy() { this.destroyed = true; this.emit("close"); return this; },
  }) as unknown as ExpressResponse;
  Object.defineProperties(res, { writableEnded: { get: () => ended }, writableFinished: { get: () => ended }, headersSent: { get: () => headersSent } });
  return { req, res, chunks, endCalls: () => endCalls };
}

function fixture(kind: "success" | "composite" | "parser-error" | "write-failure" | "cancel" = "success", throwingEnqueue = false) {
  const calls: string[] = [];
  const entries: any[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let task: any;
  const usage = (tokens = 17) => ({ promptTokens: tokens, completionTokens: tokens === 17 ? 5 : 10, startedAttempts: tokens === 17 ? 1 : 2, reportedAttempts: tokens === 17 ? 1 : 2, finalizedAttempts: tokens === 17 ? 1 : 2, usageCompleteness: "complete" });
  const final = (outcome = "success", tokens = 34) => ({ executionId: task.executionId, type: "final", seq: 5, model, outcome, ...usage(tokens), ...(outcome === "success" ? { answer: kind === "composite" ? { kind: "meeting_prose", delivery: "buffered", text: "Final supported answer." } : { kind: "model_text", delivery: "streamed" } } : {}), answerIsProviderVerbatim: outcome === "success", finalProviderCompletionId: "provider-final-only" });
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
    if (url.endsWith("/cancel")) {
      if (kind === "write-failure") controller.enqueue(encoder.encode(frame(final("cancelled"))));
      return Response.json({}, { status: kind === "cancel" ? 404 : 200 });
    }
    if (url.endsWith("/tasks")) {
      task = JSON.parse(String(init?.body));
      const envelope = { executionId: task.executionId };
      return new Response(new ReadableStream({ start(stream) {
        controller = stream;
        stream.enqueue(encoder.encode(frame({ ...envelope, type: "accepted", seq: 1, version: 1, model, deadlineAt: task.deadlineAt }) + frame({ ...envelope, type: "usage", seq: 2, ...usage() })));
        if (kind === "parser-error") {
          stream.enqueue(encoder.encode("data: {truncated-private-frame")); stream.close();
        } else if (kind !== "cancel") {
          stream.enqueue(encoder.encode(frame({ ...envelope, type: "content_delta", seq: 3, text: "Hello" })));
          if (kind === "success" || kind === "composite") { stream.enqueue(encoder.encode(frame({ ...envelope, type: "usage", seq: 4, ...usage(34) }) + frame(final()))); stream.close(); }
        }
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
    flusher: { enqueue(entry: unknown) { entries.push(entry); if (throwingEnqueue) throw new Error("private-enqueue-exception-sentinel"); } } as AgentChatConfig["flusher"],
  };
  return { config, calls, entries };
}

describe("Eliza task route accounting", () => {
  test("retains partial usage after a truncated final without a success receipt", async () => {
    const run = fixture("parser-error");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(getUsage(address, TIERS.free).used).toBe(1);
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0]).toMatchObject({ prompt_tokens: 17, completion_tokens: 5, credits: 1, signed_token_count: null, window_kind: "utc_day" });
    expect(local.chunks.join("")).toContain('"stream_error":{"code":"upstream_incomplete"}');
    expect(local.chunks.join("")).not.toContain('"usage"');
    expect(local.chunks.join("")).not.toContain("provider-final-only");
    expect(info.mock.calls.some(call => call[1]?.complete === false)).toBe(true);
  });

  test("a browser write exception retains late final accounting and never invokes backend providers", async () => {
    const run = fixture("write-failure");
    const local = browser("throw-write");
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(getUsage(address, TIERS.free).used).toBe(1);
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0]).toMatchObject({ prompt_tokens: 34, completion_tokens: 10, credits: 1 });
    expect(run.calls.filter(url => url.endsWith("/tasks"))).toHaveLength(1);
    expect(run.calls.filter(url => url.endsWith("/cancel"))).toHaveLength(1);
    expect(local.chunks.join("")).not.toMatch(/provider-final-only|\"usage\"/);
  });

  test("throwing ledger enqueue does not record usage twice or expose its exception", async () => {
    const run = fixture("success", true);
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(getUsage(address, TIERS.free).used).toBe(1);
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0]).toMatchObject({ prompt_tokens: 34, completion_tokens: 10, credits: 1 });
    expect(local.chunks.join("").match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-enqueue-exception-sentinel");
  });

  test("slow browser writes do not block aggregate accounting reads", async () => {
    const run = fixture();
    const local = browser("slow");
    const pending = createAgentChatHandler(run.config)(local.req, local.res, () => {});
    await pause(30);
    try {
      expect(getUsage(address, TIERS.free).used).toBe(1);
      expect(run.entries[0]).toMatchObject({ prompt_tokens: 34, completion_tokens: 10 });
      expect(local.endCalls()).toBe(0);
    } finally { local.res.emit("drain"); await pending; }
    expect(local.chunks.join("").match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  test("browser end exception cannot discard or duplicate the already settled usage", async () => {
    const run = fixture();
    const local = browser("throw-end");
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    expect(getUsage(address, TIERS.free).used).toBe(1);
    expect(run.entries).toHaveLength(1);
    expect(local.endCalls()).toBe(1);
  });

  test("buffered text after streamed preamble gets a paragraph boundary and no composite badge", async () => {
    const run = fixture("composite");
    const local = browser();
    await createAgentChatHandler(run.config)(local.req, local.res, () => {});
    const frames = local.chunks.join("").split("\n\n").filter(value => value.startsWith("data: {")).map(value => JSON.parse(value.slice(6)));
    const text = frames.map(value => value.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toBe("Hello\n\nFinal supported answer.");
    expect(local.chunks.join("")).not.toContain("provider-final-only");
    expect(run.entries).toHaveLength(1);
    expect(getUsage(address, TIERS.free).used).toBe(1);
  });

  test("Stop and disabling the flag after submission never replay an uncertain task", async () => {
    const run = fixture("cancel");
    const local = browser();
    const pending = createAgentChatHandler(run.config)(local.req, local.res, () => {});
    await pause(30);
    run.config.elizaTasksEnabled = false;
    local.req.emit("aborted");
    await pending;
    expect(run.calls.filter(url => url.endsWith("/tasks"))).toHaveLength(1);
    expect(run.calls.filter(url => url.endsWith("/cancel"))).toHaveLength(1);
    expect(run.calls.every(url => url.startsWith("https://eliza.test/"))).toBe(true);
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0]).toMatchObject({ prompt_tokens: 17, completion_tokens: 5 });
    expect(getUsage(address, TIERS.free).used).toBe(1);
    expect(local.chunks.join("")).not.toMatch(/\"usage\"|provider-final-only/);
  });
});
