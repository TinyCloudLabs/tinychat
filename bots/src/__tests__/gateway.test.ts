import { describe, expect, test } from "bun:test";
import { type GatewayConfig, PINNED_UPSTREAM } from "../config";
import { Gateway, type UpstreamFetch } from "../gateway";

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
  maxTokens: 1000,
  botDailyTokens: 100,
  globalDailyTokens: 150,
  maxBodyBytes: 4096,
  maxResponseBytes: 1024 * 1024,
  connectTimeoutMs: 1000,
  totalTimeoutMs: 5000,
};

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
}

function streamed(usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }): Response {
  const events = [
    { choices: [{ index: 0, delta: { content: "pong" } }] },
    { choices: [], usage },
  ];
  return new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "x-upstream-secret": "leak" },
  });
}

function setup(respond: (url: string) => Response | Promise<Response> = () => streamed()) {
  const calls: Call[] = [];
  const fetchImpl: UpstreamFetch = async (url, init) => {
    calls.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    return respond(url);
  };
  const gateway = new Gateway(cfg, fetchImpl, () => Date.parse("2026-11-11T12:00:00Z"));
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

const minimal = { model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] };

describe("gateway allows", () => {
  test("the bot's own token on chat completions, rebuilt for the pinned upstream with the model key", async () => {
    const { gateway, calls } = setup();
    const res = await gateway.handle(
      BOT_A,
      chat({
        ...minimal,
        tools: [{ type: "function", function: { name: "read" } }],
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
      messages: minimal.messages,
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "read" } }],
      temperature: 0.2,
      max_tokens: 1000,
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

describe("gateway budgets", () => {
  test("a bot over its daily tokens is refused; usage is counted from the upstream report", async () => {
    const { gateway, calls } = setup();
    for (let i = 0; i < 3; i++) await (await gateway.handle(BOT_A, chat(minimal))).text();
    expect(gateway.usage(BOT_A)).toEqual({ bot: 120, total: 120 });
    expect((await gateway.handle(BOT_A, chat(minimal))).status).toBe(429);
    expect(calls).toHaveLength(3);
  });

  test("the global daily cap stops every bot", async () => {
    const { gateway } = setup(() => streamed({ prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 }));
    await (await gateway.handle(BOT_A, chat(minimal))).text();
    await (await gateway.handle(BOT_B, chat(minimal, TOKEN_B))).text();
    expect(gateway.usage(BOT_A).total).toBe(160);
    expect((await gateway.handle(BOT_A, chat(minimal))).status).toBe(429);
    expect((await gateway.handle(BOT_B, chat(minimal, TOKEN_B))).status).toBe(429);
  });

  test("one request at a time per bot; other bots are not blocked", async () => {
    const release = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const { gateway } = setup(async () => {
      reached.resolve();
      await release.promise;
      return streamed();
    });
    const first = gateway.handle(BOT_A, chat(minimal));
    await reached.promise;
    expect((await gateway.handle(BOT_A, chat(minimal))).status).toBe(429);
    const other = gateway.handle(BOT_B, chat(minimal, TOKEN_B));
    release.resolve();
    expect((await first).status).toBe(200);
    expect((await other).status).toBe(200);
  });

  test("a response cut short without usage is charged the conservative estimate", async () => {
    const { gateway } = setup(() => new Response(`data: ${JSON.stringify({ choices: [] })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    await (await gateway.handle(BOT_A, chat(minimal))).text();
    expect(gateway.usage(BOT_A).bot).toBeGreaterThanOrEqual(cfg.maxTokens);
  });
});
