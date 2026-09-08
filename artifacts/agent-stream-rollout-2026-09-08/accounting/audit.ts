// Offline audit: synthetic providers, Stripe, catalog, user, and tool data only.
// Uses the actual route, local usage store, and LedgerFlusher without starting its timer.
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { createAgentChatHandler } from "../../../backend/src/routes/agent-chat.ts";
import { _resetUsage, getUsage } from "../../../backend/src/billing/usage.ts";
import {
  _resetCache,
  _setStripeClient,
} from "../../../backend/src/billing/stripe.ts";
import { _resetCatalogCache } from "../../../backend/src/billing/catalog.ts";
import { TIERS } from "../../../backend/src/billing/tiers.ts";
import { LedgerFlusher } from "../../../backend/src/billing/ledger-flusher.ts";
process.env.PAYWALL_ENABLED = "true";
process.env.STRIPE_SECRET_KEY = "synthetic";
process.env.REDPILL_API_KEY = "synthetic";
process.env.LEDGER_AUTHORITATIVE = "false";
process.env.CREDIT_BUDGET_FREE = "10000";
globalThis.fetch = async (input) => {
  assert.ok(
    String(input).endsWith("/models"),
    "Unmocked network request prohibited",
  );
  return new Response(
    JSON.stringify({
      data: [
        {
          id: "phala/gpt-oss-120b",
          pricing: { prompt: "0.0000025", completion: "0.000002" },
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
};
_setStripeClient({
  customers: { search: async () => ({ data: [] }) },
  subscriptions: { list: async () => ({ data: [] }) },
} as any);
const frame = (x) => `data: ${JSON.stringify(x)}\n\n`;
const done = "data: [DONE]\n\n";
const provider = (s) =>
  new Response(s, { headers: { "content-type": "text/event-stream" } });
const first =
  frame({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: { name: "web_search", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }) +
  frame({ usage: { prompt_tokens: 10, completion_tokens: 3 } }) +
  done;
const second =
  frame({
    id: "answer-id",
    choices: [{ delta: { content: "answer" }, finish_reason: "stop" }],
  }) + frame({ usage: { prompt_tokens: 20, completion_tokens: 4 } });
const results = [];
for (const scenario of [
  "success",
  "second_exception",
  "second_http_error",
  "second_eof",
  "second_timeout",
  "stop",
  "tool_timeout",
  "terminal_close",
  "terminal_grace",
  "end_throw",
]) {
  _resetUsage();
  _resetCache();
  _resetCatalogCache();
  const address = "0xsynthetic";
  const req = Object.assign(new EventEmitter(), {
    user: { address },
    body: { messages: [{ role: "user", content: "synthetic" }] },
  });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    headersSent: false,
    setHeader() {
      return this;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(chunk) {
      const text = new TextDecoder().decode(chunk);
      chunks.push(text);
      if (text.includes('"id"') && scenario === "terminal_close")
        this.destroy();
      if (text.includes('"id"') && scenario === "terminal_grace") return false;
      return true;
    },
    end() {
      if (scenario === "end_throw") throw new Error("synthetic");
      this.writableEnded = true;
      this.writableFinished = true;
      this.emit("finish");
    },
    destroy() {
      this.destroyed = true;
      this.emit("close");
      return this;
    },
    status(code) {
      throw new Error(`unexpected HTTP gate ${code}`);
    },
    json() {
      throw new Error("unexpected JSON response");
    },
  });
  const ledger = new LedgerFlusher("https://synthetic.invalid", "synthetic");
  const records = [];
  const original = ledger.enqueue.bind(ledger);
  ledger.enqueue = (r) => {
    records.push(r);
    original(r);
  };
  let round = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/tools/")) {
      if (scenario === "tool_timeout") return new Promise(() => {});
      return new Response(
        JSON.stringify({ result: { text: "synthetic tool result" } }),
      );
    }
    if (++round === 1) return provider(first);
    if (scenario === "second_exception") throw new Error("synthetic");
    if (scenario === "second_http_error")
      return new Response("synthetic", { status: 503 });
    if (scenario === "second_eof") return provider(second);
    if (scenario === "second_timeout") return new Promise(() => {});
    if (scenario === "stop") {
      setTimeout(() => res.destroy(), 0);
      return new Promise(() => {});
    }
    return provider(second + done);
  };
  await createAgentChatHandler({
    agentId: "synthetic",
    entityIdFor: () => "synthetic",
    elizaServiceUrl: "https://synthetic.invalid",
    elizaServiceSecret: "synthetic",
    redpillBaseUrl: "https://synthetic.invalid/v1",
    redpillApiKey: "synthetic",
    defaultModel: () => "phala/gpt-oss-120b",
    isModelOffered: () => true,
    fetchImpl,
    flusher: ledger,
    streamPolicy: { heartbeatMs: 5, turnTimeoutMs: 30, drainGraceMs: 10 },
    streamRuntime: {
      now: () => performance.now(),
      setTimeout: (f, ms) => setTimeout(f, ms),
      clearTimeout: (h) => clearTimeout(h),
      log: () => {},
    },
  } as any)(req as any, res as any, () => {});
  const charged = [
    "success",
    "second_http_error",
    "terminal_close",
    "terminal_grace",
  ].includes(scenario);
  const used = getUsage(address, TIERS.free, null).used;
  assert.equal(used > 0, charged, scenario);
  assert.equal(ledger.outboxSize, charged ? 1 : 0, scenario);
  assert.equal(records.length, charged ? 1 : 0, scenario);
  if (charged) {
    assert.equal(records[0].credits, used, scenario);
    assert.equal(
      records[0].prompt_tokens,
      scenario === "second_http_error" ? 10 : 30,
      scenario,
    );
    assert.equal(
      records[0].completion_tokens,
      scenario === "second_http_error" ? 3 : 7,
      scenario,
    );
  }
  results.push({
    scenario,
    localCredits: used,
    outboxSize: ledger.outboxSize,
    promptTokens: records[0]?.prompt_tokens ?? null,
    completionTokens: records[0]?.completion_tokens ?? null,
  });
}
console.log(JSON.stringify(results, null, 2));
