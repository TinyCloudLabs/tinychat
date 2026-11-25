import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, recordUsage } from "../billing/usage.js";
import { TIERS } from "../billing/tiers.js";

// TC-4312: in enforce mode a turn below the minimum answers 402 with words that say
// what happened: no reply was produced and nothing was charged.

const address = "0xAbC123OutOfCreditsAddr";
const model = "z-ai/glm-5.2";
const budget = 1000;
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let info: Mock<typeof console.info>;
let warn: Mock<typeof console.warn>;

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_local_test";
  process.env.REDPILL_API_KEY = "local_catalog_test";
  process.env.LEDGER_CREDIT_GATE_ENABLED = "false";
  process.env.CREDIT_BUDGET_FREE = String(budget);
  process.env.AGENT_CHAT_BUDGET_PREFLIGHT = "enforce";
  delete process.env.LEDGER_AUTHORITATIVE;
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).endsWith("/models")) throw new Error("Unexpected global network request");
    return Response.json({ data: [{ id: model, context_length: 100_000, pricing: { prompt: "0.000003", completion: "0.000008" } }] });
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

function browser() {
  let jsonBody: unknown = undefined;
  let status = 200;
  const req = Object.assign(new EventEmitter(), {
    method: "POST", user: { address }, get: () => undefined,
    body: { model, messages: [{ role: "user", content: "hello" }] },
  }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    statusCode: 200,
    status(value: number) { status = value; this.statusCode = value; return this; },
    json(value: unknown) { jsonBody = value; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    flushHeaders() {},
    write() { return true; },
    end() { this.emit("finish"); return this; },
    destroy() { this.destroyed = true; this.emit("close"); return this; },
  }) as unknown as ExpressResponse;
  return { req, res, json: () => jsonBody, status: () => status };
}

function config(): AgentChatConfig {
  const fetchImpl = (async () => { throw new Error("no provider call expected"); }) as typeof fetch;
  return {
    agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a", entityIdFor: () => "8ed637c2-9747-4d8e-a36f-803e1c24bc10",
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 },
    elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "local-test", redpillApiKey: "unused", redpillBaseUrl: "https://provider.test/v1",
    defaultModel: () => model, isModelOffered: value => value === model, redpillFetch: fetchImpl, fetchImpl,
    elizaTasksEnabled: false,
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {} },
    flusher: { enqueue() {} } as unknown as AgentChatConfig["flusher"],
  };
}

describe("enforce-mode 402 text", () => {
  test("says no reply was produced and nothing was charged, naming the tier", async () => {
    recordUsage(address, TIERS.free, budget - 10);
    const local = browser();
    await createAgentChatHandler(config())(local.req, local.res, () => {});
    expect(local.status()).toBe(402);
    expect(local.json()).toEqual({
      error: "credit_budget_exceeded",
      message: `You're out of credits on the ${TIERS.free.name} plan, so this message got no reply and nothing was charged.`,
      tier: "free",
    });
  });
});
