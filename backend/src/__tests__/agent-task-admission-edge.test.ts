import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import express from "express";
import { request as httpRequest } from "node:http";
import type Stripe from "stripe";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { createAgentRouter } from "../routes/agent.js";
import type { AgentChatConfig } from "../routes/agent-chat.js";
import { applyRateLimiters, GLOBAL_LIMIT } from "../rate-limits.js";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "../entity-id.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, recordUsage } from "../billing/usage.js";
import { TIERS } from "../billing/tiers.js";

// Actual middleware and browser HTTP sockets; the private service/provider are controlled fixtures.
const key = `0x${"02".repeat(32)}`;
const address = "0x1111111111111111111111111111111111111111";
const model = "phala/gpt-oss-120b";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const originalEnv = { ...process.env };
const originalPatterns = TIERS.free.modelPatterns;
const realFetch = globalThis.fetch;
let quietInfo: ReturnType<typeof spyOn>;
beforeEach(() => {
  process.env.PAYWALL_ENABLED = "false";
  process.env.STRIPE_SECRET_KEY = "local-stripe-fixture";
  _resetCache(); _resetUsage();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  quietInfo = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...originalEnv };
  TIERS.free.modelPatterns = originalPatterns;
  _setStripeClient(null); _resetCache(); _resetUsage(); quietInfo.mockRestore();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Local socket assertion timed out")), 1500); })]); }
  finally { clearTimeout(timer!); }
}
async function setup(options: { rateLimit?: boolean; holdTask?: boolean; capabilityVersion?: number } = {}) {
  const calls: string[] = [];
  const cancelled = deferred();
  let task: any;
  let stream: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const totals = { promptTokens: 17, completionTokens: 5, startedAttempts: 1, reportedAttempts: 1, finalizedAttempts: 1, usageCompleteness: "complete" };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: options.capabilityVersion ?? 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
    if (url.endsWith("/cancel")) {
      stream.enqueue(encoder.encode(frame({ executionId: task.executionId, seq: 3, type: "final", model, outcome: "cancelled", ...totals, answerIsProviderVerbatim: false })));
      stream.close(); cancelled.resolve();
      return Response.json({});
    }
    if (url.endsWith("/tasks")) {
      task = JSON.parse(String(init?.body));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode(frame({ executionId: task.executionId, seq: 1, type: "accepted", version: 1, model, deadlineAt: task.deadlineAt }) + frame({ executionId: task.executionId, seq: 2, type: "content_delta", text: "Task fixture answer." })));
        if (!options.holdTask) {
          controller.enqueue(encoder.encode(frame({ executionId: task.executionId, seq: 3, type: "final", model, outcome: "success", ...totals, answer: { kind: "model_text", delivery: "streamed" }, answerIsProviderVerbatim: true })));
          controller.close();
        }
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url === "http://provider.test/v1/chat/completions") return new Response(
      frame({ id: "legacy-provider-fixture", choices: [{ delta: { content: "Legacy fixture answer." } }] }) + frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
    throw new Error("Unexpected fixture destination");
  }) as typeof fetch;
  const cfg: AgentChatConfig = {
    agentId: TINYCHAT_AGENT_ID, entityIdFor: value => addressToEntityId(value, TINYCHAT_AGENT_ID),
    elizaServiceUrl: "http://service.test", elizaServiceSecret: "local-service-fixture",
    redpillApiKey: "local-provider-fixture", redpillBaseUrl: "http://provider.test/v1", defaultModel: () => model,
    isModelOffered: value => value === model, fetchImpl, elizaTasksEnabled: true,
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 3000, drainGraceMs: 100 },
  };
  const app = express();
  app.use(express.json({ limit: "1mb" })); app.use(createCsrfMiddleware());
  if (options.rateLimit) applyRateLimiters(app);
  app.get("/api/rate-fixture", (_req, res) => res.json({ ok: true }));
  app.use("/api/agent", createAgentRouter({ agentDid: "did:key:local-fixture", elizaServiceUrl: cfg.elizaServiceUrl, elizaServiceSecret: cfg.elizaServiceSecret, authMiddleware: createAuthMiddleware(key), chat: cfg }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = (await issueSessionToken(address, key)).token;
  const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Authorization: `Bearer ${token}` };
  const body = JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }], roomId: "same-browser-thread" });
  return { calls, cfg, base, headers, body, cancelled,
    send: () => realFetch(`${base}/api/agent/chat`, { method: "POST", headers, body }),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

describe("task-enabled backend admission edges", () => {
  test("rate denial at the actual agent route starts zero capability/task/provider work", async () => {
    const run = await setup({ rateLimit: true });
    try {
      for (let i = 0; i < GLOBAL_LIMIT; i++) {
        const response = await realFetch(`${run.base}/api/rate-fixture`);
        expect(response.status).toBe(200); await response.text();
      }
      const response = await run.send();
      expect(response.status).toBe(429); await response.text();
      expect(run.calls).toEqual([]);
    } finally { await run.close(); }
  });

  for (const gate of ["tier", "credits"] as const) test(`${gate} denial with the task flag enabled starts zero task work`, async () => {
    const run = await setup();
    process.env.PAYWALL_ENABLED = "true";
    if (gate === "tier") TIERS.free.modelPatterns = ["unoffered/"];
    else { process.env.CREDIT_BUDGET_FREE = "10"; recordUsage(address, TIERS.free, 10); }
    try {
      const response = await run.send();
      expect(response.status).toBe(402);
      expect((await response.json() as { error: string }).error).toBe(gate === "tier" ? "model_not_allowed" : "credit_budget_exceeded");
      expect(run.calls).toEqual([]);
    } finally { await run.close(); }
  });

  test("capability mismatch never replays through the legacy provider", async () => {
    const run = await setup({ capabilityVersion: 2 });
    try {
      const response = await run.send();
      const text = await response.text();
      expect(text).toContain('"stream_error"');
      expect(run.calls).toEqual(["http://service.test/capabilities"]);
      expect(text).not.toContain("fixture answer");
    } finally { await run.close(); }
  });

  test("closing the actual browser response socket posts one task cancellation", async () => {
    const run = await setup({ holdTask: true });
    let client: ReturnType<typeof httpRequest> | undefined;
    try {
      const disconnected = new Promise<void>((resolve, reject) => {
        client = httpRequest(`${run.base}/api/agent/chat`, { method: "POST", headers: run.headers }, response => {
          response.on("data", chunk => { if (String(chunk).includes("Task fixture answer")) { response.destroy(); resolve(); } });
        });
        client.on("error", reject); client.end(run.body);
      });
      await bounded(disconnected); await bounded(run.cancelled.promise);
      expect(run.calls.filter(url => url.endsWith("/tasks"))).toHaveLength(1);
      expect(run.calls.filter(url => url.endsWith("/cancel"))).toHaveLength(1);
      expect(run.calls.every(url => url.startsWith("http://service.test/"))).toBe(true);
    } finally { client?.destroy(); await run.close(); }
  });

  test("turning the flag off changes the next request's selection without replaying the first", async () => {
    const run = await setup();
    try {
      const first = await (await run.send()).text();
      run.cfg.elizaTasksEnabled = false;
      const second = await (await run.send()).text();
      expect(first).toContain("Task fixture answer");
      expect(second).toContain("Legacy fixture answer");
      expect(run.calls).toEqual(["http://service.test/capabilities", "http://service.test/tasks", "http://provider.test/v1/chat/completions"]);
    } finally { await run.close(); }
  });
});
