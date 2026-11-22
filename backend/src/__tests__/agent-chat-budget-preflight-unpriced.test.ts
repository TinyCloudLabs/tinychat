import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage } from "../billing/usage.js";
import { createRequestContextMiddleware, recordAgentChatBudgetPreflight, type RequestEvent } from "../request-context.js";

// TC-3734: a turn whose model has no catalog price is checked against the fallback rates (a 2600-credit minimum).
// The preflight event then carries `unpriced: true`, so an unpriced model shows in the logs even when enforce
// refuses every turn on it before it can settle. A priced model's event has no `unpriced` key.

const address = "0xAbC123UnpricedAddr";
const PRICED = "z-ai/glm-5.2";
const UNPRICED = "vendor/new-model";
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let info: Mock<typeof console.info>;
let warn: Mock<typeof console.warn>;

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_local_test";
  process.env.REDPILL_API_KEY = "local_catalog_test";
  process.env.LEDGER_CREDIT_GATE_ENABLED = "false";
  process.env.CREDIT_BUDGET_FREE = "1000";
  process.env.AGENT_CHAT_BUDGET_PREFLIGHT = "enforce";
  delete process.env.AGENT_CHAT_BUDGET_STOP_MODE;
  delete process.env.LEDGER_AUTHORITATIVE;
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).endsWith("/models")) throw new Error("Unexpected global network request");
    return Response.json({ data: [
      { id: PRICED, context_length: 100_000, pricing: { prompt: "0.0000015", completion: "0.000003" } },
      { id: UNPRICED, context_length: 100_000, pricing: null },
    ] });
  }) as typeof fetch;
  info = spyOn(console, "info").mockImplementation(() => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  info.mockRestore(); warn.mockRestore();
  _setStripeClient(null); _resetCache(); _resetUsage(); _resetCatalogCache();
});

type Preflight = Extract<RequestEvent, { event: "agent_chat_budget_preflight" }>;

async function turn(model: string) {
  const calls: string[] = [];
  const fetchImpl = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(
      frame({ choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }) +
      frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) +
      "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const config: AgentChatConfig = {
    agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a", entityIdFor: () => "8ed637c2-9747-4d8e-a36f-803e1c24bc10",
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 },
    elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "local-test", redpillApiKey: "unused", redpillBaseUrl: "https://provider.test/v1",
    defaultModel: () => PRICED, isModelOffered: value => value === PRICED || value === UNPRICED, redpillFetch: fetchImpl, fetchImpl,
    elizaTasksEnabled: false,
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {} },
    flusher: { enqueue() {} } as unknown as AgentChatConfig["flusher"],
  };
  let status = 200;
  const req = Object.assign(new EventEmitter(), {
    method: "POST", user: { address }, get: () => undefined,
    body: { model, messages: [{ role: "user", content: "hi" }] },
  }) as unknown as Request;
  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    statusCode: 200,
    status(value: number) { status = value; this.statusCode = value; return this; },
    json() { return this; },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    flushHeaders() {},
    write() { return true; },
    end() { this.emit("finish"); return this; },
    destroy() { this.destroyed = true; this.emit("close"); return this; },
  }) as unknown as ExpressResponse;
  const events: RequestEvent[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  createRequestContextMiddleware(event => events.push(event))(req, res, () => {
    createAgentChatHandler(config)(req, res, () => {}).then(resolve, reject);
  });
  await promise;
  const preflight = events.filter((event): event is Preflight => event.event === "agent_chat_budget_preflight");
  return { preflight, status, calls };
}

describe("agent chat budget preflight: unpriced models", () => {
  test("an unpriced model is checked at the fallback minimum, refused under enforce and flagged unpriced", async () => {
    const { preflight, status, calls } = await turn(UNPRICED);
    expect(preflight).toEqual([expect.objectContaining({ minimum: 2600, blocked: true, unpriced: true })]);
    expect(status).toBe(402);
    expect(calls).toEqual([]);
  });

  test("a priced model's event has no unpriced key", async () => {
    const { preflight, status } = await turn(PRICED);
    expect(preflight).toHaveLength(1);
    expect(preflight[0]?.minimum).toBe(150);
    expect(Object.keys(preflight[0] ?? {})).not.toContain("unpriced");
    expect(status).toBe(200);
  });

  test("only a literal true is emitted", () => {
    const events: RequestEvent[] = [];
    const req = Object.assign(new EventEmitter(), { method: "POST", get: () => undefined }) as unknown as Request;
    const res = Object.assign(new EventEmitter(), { headersSent: true, statusCode: 200, setHeader() { return this; }, getHeader() { return undefined; } }) as unknown as ExpressResponse;
    createRequestContextMiddleware(event => events.push(event))(req, res, () => {
      const base = { address, mode: "log", remaining: 10, minimum: 150, tier: "free", source: "local" } as const;
      recordAgentChatBudgetPreflight({ ...base, unpriced: false });
      recordAgentChatBudgetPreflight({ ...base });
      recordAgentChatBudgetPreflight({ ...base, unpriced: true });
    });
    const flags = events.filter(event => event.event === "agent_chat_budget_preflight").map(event => "unpriced" in event ? event.unpriced : "absent");
    expect(flags).toEqual(["absent", "absent", true]);
  });
});
