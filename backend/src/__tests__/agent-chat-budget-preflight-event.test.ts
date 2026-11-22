import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Request, Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, recordUsage } from "../billing/usage.js";
import { TIERS } from "../billing/tiers.js";
import { configureRequestLogAccountHash, createRequestContextMiddleware, requestLogAccountHash, type RequestEvent } from "../request-context.js";

// TC-3734: every agent chat turn that reaches the budget check ships one structured
// `agent_chat_budget_preflight` event beside the plain "[agent-chat] turn budget" line.
// It changes no decision and carries no address, text or exact credit count.

const address = "0xAbC123PreflightAddr";
const model = "z-ai/glm-5.2";
const budget = 1000;
const MESSAGE_TEXT = "PROMPT-CANARY what did the board decide";
const HMAC_KEY = "k".repeat(48);
const PROVIDER_URL = "https://provider.test/v1/chat/completions";
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
  process.env.CREDIT_BUDGET_FREE = String(budget);
  delete process.env.AGENT_CHAT_BUDGET_STOP_MODE;
  delete process.env.AGENT_CHAT_BUDGET_PREFLIGHT;
  delete process.env.LEDGER_AUTHORITATIVE;
  delete process.env.LEDGER_OUTAGE_POLICY;
  configureRequestLogAccountHash(HMAC_KEY);
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).endsWith("/models")) throw new Error("Unexpected global network request");
    return Response.json({ data: [{ id: model, context_length: 100_000, pricing: { prompt: "0.000001", completion: "0.000001" } }] });
  }) as typeof fetch;
  info = spyOn(console, "info").mockImplementation(() => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  info.mockRestore(); warn.mockRestore();
  configureRequestLogAccountHash(undefined);
  _setStripeClient(null); _resetCache(); _resetUsage(); _resetCatalogCache();
});

function seedRemaining(remaining: number) {
  _resetUsage();
  if (budget - remaining > 0) recordUsage(address, TIERS.free, budget - remaining);
}

function browser() {
  let jsonBody: unknown = undefined;
  let status = 200;
  const headers: Record<string, string> = {};
  const req = Object.assign(new EventEmitter(), {
    method: "POST", user: { address }, get: () => undefined,
    body: { model, messages: [{ role: "user", content: MESSAGE_TEXT }] },
  }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    statusCode: 200,
    status(value: number) { status = value; this.statusCode = value; return this; },
    json(value: unknown) { jsonBody = value; return this; },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    flushHeaders() {},
    write() { return true; },
    end() { this.emit("finish"); return this; },
    destroy() { this.destroyed = true; this.emit("close"); return this; },
  }) as unknown as ExpressResponse;
  return { req, res, json: () => jsonBody, status: () => status, header: (name: string) => headers[name.toLowerCase()] };
}

type Rehydrator = NonNullable<AgentChatConfig["rehydrator"]>;
type Entitlement = { credit_limit: number | null; committed_credits: number | null; period_anchor: string; isOutage: boolean };

function setup(entitlement?: Entitlement) {
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
    defaultModel: () => model, isModelOffered: value => value === model, redpillFetch: fetchImpl, fetchImpl,
    elizaTasksEnabled: false,
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {} },
    flusher: { enqueue() {} } as unknown as AgentChatConfig["flusher"],
    ...(entitlement ? {
      rehydrator: {
        rehydrateIfNeeded: async () => false,
        getEntitlement: async () => entitlement,
        get unrehydratedServesCount() { return 0; },
      } as unknown as Rehydrator,
    } : {}),
  };
  return { config, calls };
}

type Preflight = Extract<RequestEvent, { event: "agent_chat_budget_preflight" }>;

/** Runs one turn inside a request scope, the way the backend mounts it, and returns what the scope's sink saw. */
async function turn(remaining: number, opts: { mode?: string; entitlement?: Entitlement } = {}) {
  if (opts.mode !== undefined) process.env.AGENT_CHAT_BUDGET_PREFLIGHT = opts.mode;
  if (opts.entitlement) process.env.LEDGER_AUTHORITATIVE = "true";
  seedRemaining(remaining);
  const run = setup(opts.entitlement);
  const local = browser();
  const events: RequestEvent[] = [];
  const scope = createRequestContextMiddleware(event => events.push(event));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  scope(local.req, local.res, () => { createAgentChatHandler(run.config)(local.req, local.res, () => {}).then(resolve, reject); });
  await promise;
  const preflight = events.filter((event): event is Preflight => event.event === "agent_chat_budget_preflight");
  const budgetLines = info.mock.calls.filter(call => call[0] === "[agent-chat] turn budget");
  return { run, local, events, preflight, budgetLines };
}

const base = { event: "agent_chat_budget_preflight", minimum: 320, tier: "free", source: "local" } as const;

describe("agent chat budget preflight event", () => {
  test("log mode below the minimum: would_block true, blocked false, turn admitted, old line kept", async () => {
    const { preflight, local, run, budgetLines } = await turn(319);
    expect(preflight).toHaveLength(1);
    expect(preflight[0]).toMatchObject({ ...base, mode: "log", would_block: true, blocked: false, remaining_known: true, remaining_bucket: "100-319" });
    expect(local.status()).toBe(200);
    expect(run.calls).toContain(PROVIDER_URL);
    expect(budgetLines).toHaveLength(1);
  });

  test("log mode exactly at the minimum: would_block false, one event, no old line", async () => {
    const { preflight, local, run, budgetLines } = await turn(320);
    expect(preflight).toHaveLength(1);
    expect(preflight[0]).toMatchObject({ ...base, mode: "log", would_block: false, blocked: false, remaining_known: true, remaining_bucket: "320-999" });
    expect(local.status()).toBe(200);
    expect(run.calls).toContain(PROVIDER_URL);
    expect(budgetLines).toHaveLength(0);
  });

  test("enforce below the minimum: blocked true, 402, no provider call", async () => {
    const { preflight, local, run, budgetLines } = await turn(319, { mode: "enforce" });
    expect(preflight).toHaveLength(1);
    expect(preflight[0]).toMatchObject({ ...base, mode: "enforce", would_block: true, blocked: true, remaining_bucket: "100-319" });
    expect(local.status()).toBe(402);
    expect(local.json()).toMatchObject({ error: "credit_budget_exceeded" });
    expect(run.calls).toEqual([]);
    expect(budgetLines).toHaveLength(1);
  });

  test("enforce at the minimum: blocked false and the turn is admitted", async () => {
    const { preflight, local, run } = await turn(320, { mode: "enforce" });
    expect(preflight).toMatchObject([{ mode: "enforce", would_block: false, blocked: false }]);
    expect(local.status()).toBe(200);
    expect(run.calls).toContain(PROVIDER_URL);
  });

  test("off mode still ships the event (would_block true, blocked false) and neither logs the old line nor blocks", async () => {
    const { preflight, local, run, budgetLines } = await turn(150, { mode: "off" });
    expect(preflight).toHaveLength(1);
    expect(preflight[0]).toMatchObject({ ...base, mode: "off", would_block: true, blocked: false, remaining_known: true, remaining_bucket: "100-319" });
    expect(local.status()).toBe(200);
    expect(run.calls).toContain(PROVIDER_URL);
    expect(budgetLines).toHaveLength(0);
  });

  test("an invalid mode falls back to log", async () => {
    const { preflight, local } = await turn(10, { mode: "bogus" });
    expect(preflight).toMatchObject([{ mode: "log", would_block: true, blocked: false }]);
    expect(local.status()).toBe(200);
  });

  test("remaining credits ship only as a bucket, at every edge", async () => {
    const expected: Array<[number, string]> = [[1, "0-99"], [99, "0-99"], [100, "100-319"], [319, "100-319"], [320, "320-999"], [999, "320-999"], [1000, "1000+"]];
    for (const [remaining, bucket] of expected) {
      const { preflight } = await turn(remaining);
      expect(preflight[0]?.remaining_bucket, `remaining ${remaining}`).toBe(bucket);
    }
  });

  test("the ledger path reports source ledger", async () => {
    const { preflight, local } = await turn(900, { entitlement: { credit_limit: 1000, committed_credits: 700, period_anchor: "utc_day", isOutage: false } });
    expect(preflight).toMatchObject([{ source: "ledger", would_block: true, remaining_bucket: "100-319", remaining_known: true }]);
    expect(local.status()).toBe(200);
  });

  test("an unreadable ledger falls back to the local counter and reports source outage", async () => {
    const { preflight, local } = await turn(500, { entitlement: { credit_limit: null, committed_credits: null, period_anchor: "utc_day", isOutage: true } });
    expect(preflight).toMatchObject([{ source: "outage", would_block: false, remaining_bucket: "320-999" }]);
    expect(local.status()).toBe(200);
  });

  test("the event carries the request's own id and the same account hash as the request record", async () => {
    const { preflight, local, events } = await turn(7);
    const requestId = local.header("x-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(preflight[0]?.request_id).toBe(requestId);
    expect(preflight[0]?.account_hash).toBe(requestLogAccountHash(address)!);
    const record = events.find(event => event.event === "tinychat_request");
    expect(record).toMatchObject({ request_id: requestId, account_hash: preflight[0]?.account_hash });
  });

  test("the payload is closed: no address, message text or exact credit count", async () => {
    const { preflight } = await turn(7);
    expect(Object.keys(preflight[0]).sort()).toEqual([
      "account_hash", "blocked", "event", "minimum", "mode", "remaining_bucket", "remaining_known", "request_id", "source", "tier", "would_block",
    ]);
    const wire = JSON.stringify(preflight[0]);
    expect(wire.toLowerCase()).not.toContain(address.toLowerCase());
    expect(wire).not.toContain("PROMPT-CANARY");
    expect(wire).not.toContain("board");
    expect(wire).not.toContain('"remaining":');
    expect(wire).not.toMatch(/[:,]7[,}]/);
  });

  test("without a configured hash key the event omits account_hash", async () => {
    configureRequestLogAccountHash(undefined);
    const { preflight } = await turn(7);
    expect(preflight).toHaveLength(1);
    expect(preflight[0]).not.toHaveProperty("account_hash");
  });

  test("a turn that never reaches the budget check (paywall off) ships no event and is admitted", async () => {
    process.env.PAYWALL_ENABLED = "false";
    const { preflight, local, run } = await turn(5);
    expect(preflight).toEqual([]);
    expect(local.status()).toBe(200);
    expect(run.calls).toContain(PROVIDER_URL);
  });

  test("outside a request scope the handler decides the same and writes no event", async () => {
    process.env.AGENT_CHAT_BUDGET_PREFLIGHT = "enforce";
    seedRemaining(319);
    const run = setup();
    const local = browser();
    const write = spyOn(process.stdout, "write");
    try {
      await createAgentChatHandler(run.config)(local.req, local.res, () => {});
      expect(write.mock.calls.some(call => String(call[0]).includes("agent_chat_budget_preflight"))).toBe(false);
    } finally {
      write.mockRestore();
    }
    expect(local.status()).toBe(402);
    expect(run.calls).toEqual([]);
  });
});
