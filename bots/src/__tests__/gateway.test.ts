import { describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GatewayConfig, PINNED_UPSTREAM } from "../config";
import { type BudgetSnapshot, type BudgetStore, fileBudgetStore, Gateway, type UpstreamFetch } from "../gateway";

const BOT_A = "a".repeat(64);
const BOT_B = "b".repeat(64);
const TOKEN_A = "1".repeat(64);
const TOKEN_B = "2".repeat(64);
const MODEL = "z-ai/glm-5.2";

const cfg: GatewayConfig = {
  egressRoot: "/egress",
  modelKey: "model-key",
  upstream: PINNED_UPSTREAM,
  models: [MODEL],
  maxTokens: 100,
  botDailyTokens: 1000,
  globalDailyTokens: 1500,
  maxBodyBytes: 4096,
  maxResponseBytes: 1024 * 1024,
  connectTimeoutMs: 1000,
  totalTimeoutMs: 5000,
  bodyTimeoutMs: 30_000,
  budgetFile: "/unused",
};

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
}

function streamed(total = 400): Response {
  const events = [{ choices: [{ index: 0, delta: { content: "pong" } }] }, { choices: [], usage: { total_tokens: total } }];
  return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "x-upstream-secret": "leak" },
  });
}

function memoryStore(): BudgetStore & { saved: BudgetSnapshot | undefined } {
  const store = {
    saved: undefined as BudgetSnapshot | undefined,
    load: () => store.saved,
    save: (snapshot: BudgetSnapshot) => {
      store.saved = structuredClone(snapshot);
    },
  };
  return store;
}

function setup(respond: (url: string) => Response | Promise<Response> = () => streamed(), store: BudgetStore = memoryStore()) {
  const calls: Call[] = [];
  const fetchImpl: UpstreamFetch = async (url, init) => {
    calls.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return respond(url);
  };
  const gateway = new Gateway(cfg, { fetch: fetchImpl, now: () => Date.parse("2026-11-11T12:00:00Z"), store });
  gateway.setToken(BOT_A, TOKEN_A);
  gateway.setToken(BOT_B, TOKEN_B);
  return { gateway, calls };
}

const chat = (body: unknown, token = TOKEN_A, url = "http://localhost/v1/chat/completions", headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A request whose body starts but never finishes, like a bot trickling bytes. */
function trickling(token = TOKEN_A): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"model":'));
    },
  });
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
}

const minimal = { model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] };

describe("gateway allows", () => {
  test("the bot's own token on chat completions, rebuilt for the pinned upstream with the model key", async () => {
    const { gateway, calls } = setup();
    const res = await gateway.handle(
      BOT_A,
      chat({
        model: MODEL,
        stream: true,
        messages: [
          { role: "system", content: "be brief", name: "x" },
          {
            role: "user",
            content: [
              { type: "text", text: "look", cache_control: { type: "ephemeral" } },
              { type: "image_url", image_url: { url: "https://evil.example/pixel.png" } },
            ],
          },
          {
            role: "assistant",
            content: null,
            reasoning_content: "hidden",
            tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" }, extra: 1 }],
          },
          { role: "tool", tool_call_id: "c1", content: "file text", name: "read" },
        ],
        tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" }, strict: true }, x: 1 }],
        tool_choice: { type: "function", function: { name: "read", extra: true } },
        temperature: 0.2,
        max_completion_tokens: 50_000,
        provider: { aci_verified: false, order: ["somewhere-else"] },
        stream_options: { include_usage: false },
        user: "tracking-id",
        extra_body: { anything: true },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pong");
    expect(res.headers.get("x-upstream-secret")).toBeNull();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://tee.redpill.ai/v1/chat/completions");
    expect(call!.init.redirect).toBe("error");
    expect(call!.init.headers).toEqual({ authorization: "Bearer model-key", "content-type": "application/json" });
    expect(call!.body).toEqual({
      model: MODEL,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "look" }] },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", content: "file text", tool_call_id: "c1" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "read" } },
      temperature: 0.2,
      max_tokens: 100,
      provider: { aci_verified: true, allow_fallbacks: false },
    });
  });

  test("the host is pinned whatever the request names", async () => {
    const { gateway, calls } = setup();
    await (await gateway.handle(BOT_A, chat(minimal, TOKEN_A, "http://evil.example/v1/chat/completions", { host: "evil.example" }))).text();
    await (await gateway.handle(BOT_A, chat(minimal, TOKEN_A, "http://localhost/v1/chat/completions?url=https://evil.example"))).text();
    expect(calls.map(call => call.url)).toEqual([
      "https://tee.redpill.ai/v1/chat/completions",
      "https://tee.redpill.ai/v1/chat/completions",
    ]);
  });

  test("models, filtered to the allowlist", async () => {
    const { gateway, calls } = setup(() =>
      Response.json({ object: "list", data: [{ id: MODEL, object: "model" }, { id: "other/model", object: "model" }] }),
    );
    const res = await gateway.handle(BOT_A, new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${TOKEN_A}` } }));
    expect(await res.json()).toEqual({ object: "list", data: [{ id: MODEL, object: "model" }] });
    expect(calls[0]!.url).toBe("https://tee.redpill.ai/v1/models");
  });
});

describe("gateway denies", () => {
  const denied: Array<[string, () => Request, number]> = [
    ["no token", () => new Request("http://localhost/v1/models"), 403],
    ["wrong token", () => chat(minimal, "3".repeat(64)), 403],
    ["another bot's token", () => chat(minimal, TOKEN_B), 403],
    ["the model key itself", () => chat(minimal, "model-key"), 403],
    ["other route", () => new Request("http://localhost/v1/files", { headers: { authorization: `Bearer ${TOKEN_A}` } }), 403],
    ["embeddings", () => new Request("http://localhost/v1/embeddings", { method: "POST", headers: { authorization: `Bearer ${TOKEN_A}` }, body: "{}" }), 403],
    ["wrong method", () => new Request("http://localhost/v1/chat/completions", { headers: { authorization: `Bearer ${TOKEN_A}` } }), 403],
    ["model off the allowlist", () => chat({ ...minimal, model: "other/model" }), 400],
    ["no messages", () => chat({ model: MODEL, messages: [] }), 400],
    ["unknown role", () => chat({ ...minimal, messages: [{ role: "function", content: "x" }] }), 400],
    ["tool message without its call id", () => chat({ ...minimal, messages: [{ role: "tool", content: "x" }] }), 400],
    ["non-function tool", () => chat({ ...minimal, tools: [{ type: "retrieval" }] }), 400],
    ["not JSON", () => chat("not json"), 400],
    ["body over the cap", () => chat({ ...minimal, pad: "x".repeat(5000) }), 413],
  ];
  for (const [name, request, status] of denied) {
    test(`${name}: ${status}, nothing sent upstream`, async () => {
      const { gateway, calls } = setup();
      const res = await gateway.handle(BOT_A, request());
      expect(res.status).toBe(status);
      expect(calls).toHaveLength(0);
    });
  }

  test("a dropped bot's token stops working", async () => {
    const { gateway, calls } = setup();
    gateway.dropToken(BOT_A);
    expect((await gateway.handle(BOT_A, chat(minimal))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("gateway holds one slot per bot, taken before the body", () => {
  test("a second request while one runs is refused without reading its body; other bots are not blocked", async () => {
    const release = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const { gateway } = setup(async () => {
      reached.resolve();
      await release.promise;
      return streamed();
    });
    const first = gateway.handle(BOT_A, chat(minimal));
    await reached.promise;
    // The trickling body never completes: a refusal that waited for it would hang this test.
    expect((await gateway.handle(BOT_A, trickling())).status).toBe(429);
    const other = gateway.handle(BOT_B, chat(minimal, TOKEN_B));
    release.resolve();
    expect((await first).status).toBe(200);
    expect((await other).status).toBe(200);
  });

  test("a body that does not arrive in time is refused and frees the slot", async () => {
    const { gateway } = setup();
    jest.useFakeTimers();
    try {
      const slow = gateway.handle(BOT_A, trickling());
      jest.advanceTimersByTime(cfg.bodyTimeoutMs + 1);
      expect((await slow).status).toBe(408);
    } finally {
      jest.useRealTimers();
    }
    const res = await gateway.handle(BOT_A, chat(minimal));
    expect(res.status).toBe(200);
    await res.text();
  });

  test("a bot over budget is refused before its body is read", async () => {
    const store = memoryStore();
    store.saved = { day: "2026-11-11", total: 1000, perBot: { [BOT_A]: 1000 } };
    const { gateway, calls } = setup(undefined, store);
    expect((await gateway.handle(BOT_A, trickling())).status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});

describe("gateway budgets", () => {
  test("a bot over its daily tokens is refused; usage is counted from the upstream report", async () => {
    const { gateway, calls } = setup();
    for (let i = 0; i < 3; i++) await (await gateway.handle(BOT_A, chat(minimal))).text();
    expect(gateway.usage(BOT_A)).toEqual({ bot: 1200, total: 1200 });
    expect((await gateway.handle(BOT_A, chat(minimal))).status).toBe(429);
    expect(calls).toHaveLength(3);
  });

  test("the global daily cap stops every bot", async () => {
    const { gateway } = setup(() => streamed(800));
    await (await gateway.handle(BOT_A, chat(minimal))).text();
    await (await gateway.handle(BOT_B, chat(minimal, TOKEN_B))).text();
    expect(gateway.usage(BOT_A).total).toBe(1600);
    expect((await gateway.handle(BOT_A, chat(minimal))).status).toBe(429);
    expect((await gateway.handle(BOT_B, chat(minimal, TOKEN_B))).status).toBe(429);
  });

  test("max_tokens is clamped to what is left, and a prompt bigger than what is left is refused", async () => {
    const store = memoryStore();
    store.saved = { day: "2026-11-11", total: 900, perBot: { [BOT_A]: 900 } };
    const { gateway, calls } = setup(() => streamed(1), store);
    await (await gateway.handle(BOT_A, chat(minimal))).text();
    const estimate = Math.ceil(JSON.stringify(minimal).length / 3);
    expect(calls[0]!.body!.max_tokens).toBe(100 - estimate);
    const big = { ...minimal, messages: [{ role: "user", content: "x".repeat(400) }] };
    expect((await gateway.handle(BOT_A, chat(big))).status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  test("a response cut short without usage is charged the conservative estimate", async () => {
    const { gateway } = setup(() => new Response(`data: ${JSON.stringify({ choices: [] })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    await (await gateway.handle(BOT_A, chat(minimal))).text();
    expect(gateway.usage(BOT_A).bot).toBeGreaterThanOrEqual(cfg.maxTokens);
  });

  test("counters survive a gateway restart", async () => {
    const store = memoryStore();
    const before = setup(undefined, store);
    await (await before.gateway.handle(BOT_A, chat(minimal))).text();
    const after = setup(undefined, store);
    expect(after.gateway.usage(BOT_A)).toEqual({ bot: 400, total: 400 });
  });

  test("an unreadable budget file stops the gateway instead of resetting the budgets", () => {
    const dir = mkdtempSync(join(tmpdir(), "bots-budget-"));
    try {
      const path = join(dir, "budget.json");
      const store = fileBudgetStore(path);
      expect(store.load()).toBeUndefined();
      store.save({ day: "2026-11-11", total: 5, perBot: { [BOT_A]: 5 } });
      expect(fileBudgetStore(path).load()).toEqual({ day: "2026-11-11", total: 5, perBot: { [BOT_A]: 5 } });
      writeFileSync(path, '{"day":"2026-11-11","total":"lots"}');
      expect(() => new Gateway(cfg, { store: fileBudgetStore(path) })).toThrow();
      writeFileSync(path, "not json");
      expect(() => new Gateway(cfg, { store: fileBudgetStore(path) })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
