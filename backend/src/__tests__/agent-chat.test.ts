import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type Stripe from "stripe";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { isOfferedModel, _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { TIERS } from "../billing/tiers.js";
import { _resetUsage, getUsage, recordUsage } from "../billing/usage.js";
import {
  accumulateToolCalls,
  createAgentChatHandler,
  orchestrateToolCalling,
  parseInlineToolCalls,
  parseSseJson,
  type AgentChatConfig,
} from "../routes/agent-chat.js";
import type { Request, Response } from "express";

const AGENT_ID = "92361e74-91ed-43a2-9656-5cc37ff3a07a";
const ADDR = "0xabc";

// R3 ruling: 402 bodies hide `source` unless LEDGER_EXPOSE_SOURCE=true; this
// suite asserts on the tag, so opt in before the env snapshot.
process.env.LEDGER_EXPOSE_SOURCE = "true";
const ORIGINAL_ENV = { ...process.env };

/** Successful provider fixtures explicitly end with the protocol terminal. */
function sseStream(frames: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const f of frames) yield enc.encode(f);
      if (!frames.some((f) => f.includes("data: [DONE]"))) yield enc.encode("data: [DONE]\n\n");
    },
  };
}

function dataFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function sizedToolJson(length: number): string {
  const prefix = "OVERSIZED PRIVATE SENTINEL 🦋";
  const framing = JSON.stringify({ result: { text: "" } }).length;
  return JSON.stringify({ result: { text: prefix + "x".repeat(length - framing - prefix.length) } });
}

/** Concatenate every forwarded delta.content across frames. */
function forwardedContent(frames: string[]): string {
  return frames
    .map((f) => {
      try {
        return JSON.parse(f.replace(/^data: /, "").trim())?.choices?.[0]?.delta?.content ?? "";
      } catch {
        return "";
      }
    })
    .join("");
}

function baseConfig(fetchImpl: typeof fetch): AgentChatConfig {
  return {
    agentId: AGENT_ID,
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 10000, drainGraceMs: 100 },
    entityIdFor: () => "entity-1",
    elizaServiceUrl: "https://eliza.test",
    elizaServiceSecret: "svc",
    redpillApiKey: "rp-key",
    redpillBaseUrl: "https://redpill.test/v1",
    defaultModel: () => "phala/gpt-oss-120b",
    isModelOffered: (m) => m.startsWith("phala/"),
    fetchImpl: (async (url, init) => { const body = init?.body ? JSON.parse(String(init.body)) : {}; if(body.messages?.[0]?.content?.startsWith("Interpret only")) return new Response(dataFrame({choices:[{delta:{content:JSON.stringify({kind:"general"})},finish_reason:"stop"}]}) + "data: [DONE]\n\n"); return fetchImpl(url,init); }) as typeof fetch,
    maxRounds: 3,
  };
}

/** Mock Stripe resolving the caller to a given tier via its price id. */
function mockStripe(priceId: string | null, anchorEpochSec?: number | null): Stripe {
  return {
    customers: { search: async () => ({ data: priceId ? [{ id: "cus_1" }] : [] }) },
    subscriptions: {
      list: async () => ({
        data: priceId
          ? [
              {
                status: "active",
                current_period_end: 1_800_000_000,
                billing_cycle_anchor: anchorEpochSec === undefined ? 1_700_000_000 : anchorEpochSec,
                items: { data: [{ price: { id: priceId } }] },
              },
            ]
          : [],
      }),
    },
  } as unknown as Stripe;
}

/** Install a global fetch stub for catalog (/models) calls; returns a restore fn. */
function stubCatalogFetch(): () => void {
  const original = globalThis.fetch;
  const originalApiKey = process.env.REDPILL_API_KEY;
  process.env.REDPILL_API_KEY = "rp-test-key";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "phala/gpt-oss-120b", pricing: { prompt: "0.0000025", completion: "0.000002" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    if (originalApiKey === undefined) delete process.env.REDPILL_API_KEY;
    else process.env.REDPILL_API_KEY = originalApiKey;
  };
}

/** Build mock req/res objects for direct handler invocation. */
function makeReqRes(opts?: { body?: object; address?: string }) {
  const body = opts?.body ?? { messages: [{ role: "user", content: "hi" }] };
  Object.assign(body, {turn: {turnId: "synthetic", sentAt: Date.now()}});
  const address = opts?.address ?? ADDR;
  let statusCode = 200;
  const jsonResponses: Array<{ status: number; body: unknown }> = [];
  const writtenChunks: string[] = [];
  let ended = false;
  let flushed = false;

  const req = Object.assign(new EventEmitter(), {
    user: { address },
    body,
  }) as unknown as Request;

  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() { this.destroyed = true; this.emit("close"); return this; },
    status(code: number) { statusCode = code; return res; },
    json(responseBody: unknown) { jsonResponses.push({ status: statusCode, body: responseBody }); return res; },
    setHeader() { return res; },
    flushHeaders() { flushed = true; },
    write(chunk: string | Uint8Array) { writtenChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); return true; },
    end() { ended = true; this.emit("finish"); },
    // test helpers
    chunks: writtenChunks,
  }) as unknown as Response & {
    lastJson: { status: number; body: unknown } | undefined;
    chunks: string[];
    isEnded: boolean;
    lastStatus: number;
  };

  Object.defineProperties(res, {
    statusCode: { get: () => statusCode, configurable: true },
    writableEnded: { get: () => ended, configurable: true },
    writableFinished: { get: () => ended, configurable: true },
    headersSent: { get: () => flushed, configurable: true },
    lastJson: { get: () => jsonResponses[jsonResponses.length - 1], configurable: true },
    isEnded: { get: () => ended, configurable: true },
    lastStatus: { get: () => statusCode, configurable: true },
  });
  return { req, res };
}

beforeEach(() => {
  process.env.STRIPE_PRICE_PLUS_MONTHLY = "price_plus_m";
  process.env.STRIPE_PRICE_PLUS_YEARLY = "price_plus_y";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_y";
  _resetCache();
  _resetUsage();
  _resetCatalogCache();
  _resetCreditsWarnings();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _setStripeClient(null);
  _resetCache();
  _resetUsage();
  _resetCatalogCache();
  _resetCreditsWarnings();
});

describe("accumulateToolCalls", () => {
  it("concatenates streamed argument fragments by index", () => {
    const acc = new Map();
    accumulateToolCalls(acc, [{ index: 0, id: "call_1", function: { name: "web_search" } }]);
    accumulateToolCalls(acc, [{ index: 0, function: { arguments: '{"que' } }]);
    accumulateToolCalls(acc, [{ index: 0, function: { arguments: 'ry":"x"}' } }]);
    expect(acc.get(0)).toEqual({ id: "call_1", name: "web_search", args: '{"query":"x"}' });
  });
});

describe("parseInlineToolCalls", () => {
  it("parses a single leaked tool_call block into name + JSON args", () => {
    const markup =
      "<tool_call>web_search<arg_key>query</arg_key><arg_value>Portugal match today</arg_value></tool_call>";
    expect(parseInlineToolCalls(markup)).toEqual([
      { name: "web_search", args: '{"query":"Portugal match today"}' },
    ]);
  });

  it("parses two concatenated blocks", () => {
    const markup =
      "<tool_call>web_search<arg_key>query</arg_key><arg_value>a</arg_value></tool_call>" +
      "<tool_call>web_search<arg_key>query</arg_key><arg_value>b</arg_value></tool_call>";
    expect(parseInlineToolCalls(markup)).toEqual([
      { name: "web_search", args: '{"query":"a"}' },
      { name: "web_search", args: '{"query":"b"}' },
    ]);
  });

  it("tolerates whitespace around name and args", () => {
    const markup =
      "  <tool_call> web_search <arg_key> query </arg_key>\n  <arg_value>spaced value</arg_value> </tool_call>";
    expect(parseInlineToolCalls(markup)).toEqual([
      { name: "web_search", args: '{"query":"spaced value"}' },
    ]);
  });

  it("JSON-stringifies raw (unescaped) values and supports multiple arg pairs", () => {
    const markup =
      '<tool_call>some_tool<arg_key>query</arg_key><arg_value>he said "hi"</arg_value>' +
      "<arg_key>limit</arg_key><arg_value>5</arg_value></tool_call>";
    const out = parseInlineToolCalls(markup);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("some_tool");
    expect(JSON.parse(out[0].args)).toEqual({ query: 'he said "hi"', limit: "5" });
  });

  it("returns [] for content with no markup", () => {
    expect(parseInlineToolCalls("Just a normal answer mentioning nothing.")).toEqual([]);
  });
});

describe("parseSseJson", () => {
  it("yields parsed data payloads and skips [DONE]", async () => {
    const out: unknown[] = [];
    for await (const o of parseSseJson(sseStream([dataFrame({ a: 1 }), "data: [DONE]\n\n"]))) {
      out.push(o);
    }
    expect(out).toEqual([{ a: 1 }]);
  });
});

describe("ordinary orchestration controls after backend classification", () => {
it("streams a plain answer through when the model emits no tool calls", async () => {
    const fetchImpl = (async () => ({
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({ choices: [{ delta: { content: "Hello" } }] }),
          dataFrame({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] }),
        ]),
      })) as unknown as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
      entityId: "entity-1",
      write: (f) => frames.push(f),
    });

    const text = frames
      .map((f) => {
        try {
          return JSON.parse(f.replace(/^data: /, "").trim())?.choices?.[0]?.delta?.content ?? "";
        } catch {
          return "";
        }
      })
      .join("");
    expect(text).toBe("Hello world");
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("dispatches a tool call to eliza and loops back for the final answer", async () => {
    const elizaCalls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    let round = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        elizaCalls.push({
          url: String(url),
          body: JSON.parse(init!.body as string),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(
          JSON.stringify({ ok: true, tool: "WEB_SEARCH", result: { text: "Paris." } }),
          { status: 200 },
        );
      }
      // RedPill: round 1 → tool_calls; round 2 → final answer.
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            dataFrame({
              choices: [
                {
                  delta: {
                    content: "Searching the public web. ",
                    tool_calls: [
                      { index: 0, id: "call_1", function: { name: "web_search", arguments: '{"query":"capital of France"}' } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          ]),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({ choices: [{ delta: { content: "The capital is Paris." }, finish_reason: "stop" }] }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "capital of France?" }],
      entityId: "entity-7",
      roomId: "thread-3",
      turnContext: { localDate: "2026-08-26", timeZone: "America/Los_Angeles" },
      write: (f) => frames.push(f),
    });

    // Tool was dispatched with the parsed args + credential + entityId/roomId.
    expect(elizaCalls).toHaveLength(1);
    expect(elizaCalls[0].url).toBe("https://eliza.test/tools/web_search");
    expect(elizaCalls[0].auth).toBe("Bearer svc");
    expect(elizaCalls[0].body).toEqual({
      args: { query: "capital of France" },
      entityId: "entity-7",
      roomId: "thread-3",
      context: { localDate: "2026-08-26", timeZone: "America/Los_Angeles" },
    });

    // Public-web progress and the final answer each stream once, preserving the
    // legacy cumulative content contract while private-tool preambles are hidden.
    const text = frames
      .map((f) => {
        try {
          return JSON.parse(f.replace(/^data: /, "").trim())?.choices?.[0]?.delta?.content ?? "";
        } catch {
          return "";
        }
      })
      .join("");
    expect(text).toBe("Searching the public web. The capital is Paris.");
    expect(frames.some((f) => f.includes("tool_activity"))).toBe(true);
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("detects a single leaked inline tool_call, never forwards it, dispatches + synthesizes", async () => {
    const elizaCalls: Array<{ url: string; body: unknown }> = [];
    let round = 0;
    const leak =
      "<tool_call>web_search<arg_key>query</arg_key><arg_value>Portugal match today June 11 2026</arg_value></tool_call>";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        elizaCalls.push({ url: String(url), body: JSON.parse(init!.body as string) });
        return new Response(
          JSON.stringify({ ok: true, result: { text: "Portugal won 2-0." } }),
          { status: 200 },
        );
      }
      round += 1;
      if (round === 1) {
        // Leaks the native tool-call template as PLAIN TEXT with finish "stop".
        return {
          ok: true,
          status: 200,
          body: sseStream([
            dataFrame({ choices: [{ delta: { content: leak }, finish_reason: "stop" }] }),
          ]),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({ choices: [{ delta: { content: "Portugal won 2-0 today." }, finish_reason: "stop" }] }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/glm-5.1",
      messages: [{ role: "user", content: "did Portugal play today?" }],
      entityId: "entity-9",
      write: (f) => frames.push(f),
    });

    // (a) NO forwarded frame contains the raw markup.
    expect(frames.some((f) => f.includes("<tool_call") || f.includes("<arg_key"))).toBe(false);
    // (b) web_search was dispatched with the parsed query + a running/done activity.
    expect(elizaCalls).toHaveLength(1);
    expect(elizaCalls[0].url).toBe("https://eliza.test/tools/web_search");
    expect(elizaCalls[0].body).toMatchObject({
      args: { query: "Portugal match today June 11 2026" },
      entityId: "entity-9",
    });
    expect(frames.some((f) => f.includes("tool_activity") && f.includes("running"))).toBe(true);
    expect(frames.some((f) => f.includes("tool_activity") && f.includes("done"))).toBe(true);
    // (c) the synthesized answer IS forwarded.
    const text = forwardedContent(frames);
    expect(text).toBe("Portugal won 2-0 today.");
    // The lifecycle owner emits usage and terminal frames.
    expect(frames.some((f) => f.includes('"usage"'))).toBe(false);
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("detects two concatenated leaked inline tool_calls and dispatches both", async () => {
    const elizaCalls: Array<{ body: unknown }> = [];
    let round = 0;
    const leak =
      "<tool_call>web_search<arg_key>query</arg_key><arg_value>q1</arg_value></tool_call>" +
      "<tool_call>web_search<arg_key>query</arg_key><arg_value>q2</arg_value></tool_call>";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        elizaCalls.push({ body: JSON.parse(init!.body as string) });
        return new Response(JSON.stringify({ ok: true, result: { text: "r" } }), { status: 200 });
      }
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          status: 200,
          body: sseStream([
            dataFrame({ choices: [{ delta: { content: leak }, finish_reason: "stop" }] }),
          ]),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({ choices: [{ delta: { content: "Both done." }, finish_reason: "stop" }] }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/glm-5.1",
      messages: [{ role: "user", content: "two searches" }],
      entityId: "e",
      write: (f) => frames.push(f),
    });

    expect(frames.some((f) => f.includes("<tool_call") || f.includes("<arg_key"))).toBe(false);
    expect(elizaCalls).toHaveLength(2);
    expect((elizaCalls[0].body as { args: { query: string } }).args.query).toBe("q1");
    expect((elizaCalls[1].body as { args: { query: string } }).args.query).toBe("q2");
    expect(forwardedContent(frames)).toBe("Both done.");
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("does not false-trigger leak mode on a normal answer", async () => {
    let elizaHit = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/tools/")) {
        elizaHit = true;
        return new Response(JSON.stringify({ ok: true, result: { text: "x" } }), { status: 200 });
      }
      return {
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({ choices: [{ delta: { content: "You can use a " } }] }),
          dataFrame({ choices: [{ delta: { content: "<tool_call> if you want." }, finish_reason: "stop" }] }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "explain tool calls" }],
      entityId: "e",
      write: (f) => frames.push(f),
    });

    // The answer (incl. a non-leading mention of <tool_call>) is forwarded verbatim.
    expect(forwardedContent(frames)).toBe("You can use a <tool_call> if you want.");
    expect(elizaHit).toBe(false);
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("stops after maxRounds even if the model keeps requesting tools", async () => {
    let redpillRounds = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/tools/")) {
        return new Response(JSON.stringify({ ok: true, result: { text: "r" } }), { status: 200 });
      }
      redpillRounds += 1;
      return {
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id: `c${redpillRounds}`, function: { name: "web_search", arguments: "{}" } }] },
                finish_reason: "tool_calls",
              },
            ],
          }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: { ...baseConfig(fetchImpl), maxRounds: 2 },
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "loop" }],
      entityId: "e",
      write: (f) => frames.push(f),
    });

    expect(redpillRounds).toBe(2);
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("forced round issues a clean-synthesis request (no tools) when tool results exist", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    let elizaDispatches = 0;
    let redpillRound = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        elizaDispatches += 1;
        return new Response(
          JSON.stringify({ ok: true, result: { text: "Lisbon is the capital. https://example.com/pt" } }),
          { status: 200 },
        );
      }
      upstreamBodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      redpillRound += 1;
      if (redpillRound <= 2) {
        // Rounds 0 and 1: keep emitting structured tool_calls (the gpt-oss behavior).
        return {
          ok: true,
          status: 200,
          body: sseStream([
            dataFrame({
              choices: [
                {
                  delta: { tool_calls: [{ index: 0, id: `c${redpillRound}`, function: { name: "web_search", arguments: '{"query":"capital of Portugal"}' } }] },
                  finish_reason: "tool_calls",
                },
              ],
            }),
          ]),
        } as unknown as Response;
      }
      // Forced round (round 2, maxRounds 3): clean synthesis → a real answer.
      return {
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({ id: "cmpl-synth", choices: [{ delta: { content: "Lisbon (https://example.com/pt)." }, finish_reason: "stop" }] }),
          dataFrame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: { ...baseConfig(fetchImpl), maxRounds: 3 },
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "What is the capital of Portugal?" }],
      entityId: "e",
      write: (f) => frames.push(f),
    });

    // (c) web_search was dispatched on the earlier rounds.
    expect(elizaDispatches).toBe(2);
    expect(upstreamBodies).toHaveLength(3);

    // Earlier rounds carried tools + tool_choice.
    expect(upstreamBodies[0].tools).toBeDefined();
    expect(upstreamBodies[0].tool_choice).toBe("auto");

    // (a) the FINAL request has NO tools and NO tool_choice, and inlines the result + question.
    const finalBody = upstreamBodies[2];
    expect(finalBody.tools).toBeUndefined();
    expect(finalBody.tool_choice).toBeUndefined();
    expect(finalBody.reasoning_effort).toBe("low");
    const finalMessages = finalBody.messages as ChatMsg[];
    expect(finalMessages[0].role).toBe("system");
    expect(finalMessages[1].role).toBe("user");
    expect(finalMessages[1].content).toContain("What is the capital of Portugal?");
    expect(finalMessages[1].content).toContain("Lisbon is the capital. https://example.com/pt");
    // The final request must NOT carry any role:"tool" message (reshaped, not continued).
    expect(finalMessages.some((m) => m.role === "tool")).toBe(false);

    // Synthesized content is forwarded; the owner controls terminal metadata.
    expect(forwardedContent(frames)).toBe("Lisbon (https://example.com/pt).");
    expect(frames.some((f) => f.includes('"usage"'))).toBe(false);
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("does not reshape when the forced round has no tool results", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        return new Response(JSON.stringify({ ok: true, result: { text: "x" } }), { status: 200 });
      }
      upstreamBodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      // Answer directly on round 0 — no tool call.
      return {
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({ choices: [{ delta: { content: "Direct answer." }, finish_reason: "stop" }] }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: { ...baseConfig(fetchImpl), maxRounds: 3 },
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "say hi" }],
      entityId: "e",
      write: (f) => frames.push(f),
    });

    // Only one upstream round, and it kept tools (no reshape).
    expect(upstreamBodies).toHaveLength(1);
    expect(upstreamBodies[0].tools).toBeDefined();
    expect(forwardedContent(frames)).toBe("Direct answer.");
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("A1: returns the final round's completion id to its owner", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        dataFrame({ id: "cmpl-abc123", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }),
        dataFrame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      ]),
    })) as unknown as typeof fetch;

    const frames: string[] = [];
    const result = await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
      entityId: "entity-1",
      write: (f) => frames.push(f),
    });

    // The owner receives the ID; orchestration does not write terminal metadata.
    expect(frames.some((f) => f.startsWith('data: {"id":'))).toBe(false);
    expect(frames).not.toContain("data: [DONE]\n\n");

    // A3: return value carries the completion id
    expect(result.completionId).toBe("cmpl-abc123");
  });
it("A1: returns only the answer round completion id", async () => {
    let round = 0;
    const fetchImpl = (async (url: string, _init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        return new Response(JSON.stringify({ ok: true, result: { text: "Paris." } }), { status: 200 });
      }
      round++;
      if (round === 1) {
        return {
          ok: true,
          body: sseStream([
            dataFrame({
              id: "cmpl-tool-round",
              choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
            }),
          ]),
        } as unknown as Response;
      }
      return {
        ok: true,
        body: sseStream([
          dataFrame({ id: "cmpl-answer", choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    const result = await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "q" }],
      entityId: "e",
      write: (f) => frames.push(f),
    });

    // Orchestration returns only the answer ID and emits no terminal metadata.
    const idFrames = frames.filter((f) => {
      try {
        const parsed = JSON.parse(f.replace(/^data: /, "").trim()) as Record<string, unknown>;
        return typeof parsed.id === "string";
      } catch {
        return false;
      }
    });
    expect(idFrames).toHaveLength(0);
    expect(result.completionId).toBe("cmpl-answer");
  });
it("A2: returns summed tokens across all rounds to its owner", async () => {
    let round = 0;
    const fetchImpl = (async (url: string, _init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        return new Response(JSON.stringify({ ok: true, result: { text: "result" } }), { status: 200 });
      }
      round++;
      if (round === 1) {
        return {
          ok: true,
          body: sseStream([
            dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
            dataFrame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
          ]),
        } as unknown as Response;
      }
      return {
        ok: true,
        body: sseStream([
          dataFrame({ choices: [{ delta: { content: "Answer." }, finish_reason: "stop" }] }),
          dataFrame({ choices: [], usage: { prompt_tokens: 15, completion_tokens: 5 } }),
        ]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const frames: string[] = [];
    const result = await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "q" }],
      entityId: "entity-1",
      write: (f) => frames.push(f),
    });

    // Find the usage frame (has usage field, choices is empty array)
    const usageFrames = frames.filter((f) => {
      try {
        const parsed = JSON.parse(f.replace(/^data: /, "").trim()) as Record<string, unknown>;
        return parsed.usage !== undefined;
      } catch {
        return false;
      }
    });
    expect(usageFrames).toHaveLength(0);
    expect(result.promptTokens).toBe(25);
    expect(result.completionTokens).toBe(8);
    expect(frames).not.toContain("data: [DONE]\n\n");
  });
it("A3: return value carries promptTokens, completionTokens, completionId", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      body: sseStream([
        dataFrame({ id: "cmpl-xyz", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }),
        dataFrame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      ]),
    })) as unknown as typeof fetch;

    const result = await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
      entityId: "e",
      write: () => {},
    });

    expect(result.completionId).toBe("cmpl-xyz");
    expect(result.promptTokens).toBe(7);
    expect(result.completionTokens).toBe(3);
  });
});

describe("createAgentChatHandler — A4 paywall + A5 recording", () => {
  for (const [failure, code, completed] of [
    ["incomplete-finish", "upstream_incomplete", false],
    ["provider-error", "upstream_failed", false],
    ["incomplete-read", "upstream_incomplete", false],
    ["tool-overflow", "result_size_limit", true],
  ] as const) {
    it(`returns one terminal for ${failure} and accounts only completed rounds exactly once`, async () => {
      process.env.PAYWALL_ENABLED = "true";
      process.env.STRIPE_SECRET_KEY = "sk_test";
      _setStripeClient(mockStripe(null));
      const restore = stubCatalogFetch();
      let models = 0, dispatches = 0, endCount = 0;
      const entries: unknown[] = [], logs: unknown[] = [], traces: unknown[] = [];
      const fetchImpl = (async (url) => {
        if (String(url).includes("/tools/")) { dispatches++; return new Response(sizedToolJson(65537)); }
        if (String(url).endsWith("/capabilities")) throw new Error("Unexpected capability request");
        models++;
        if (failure === "provider-error") return new Response("PRIVATE PROVIDER SENTINEL", { status: 429 });
        const name = "web_search";
        const argumentsJson = "{}";
        const round = dataFrame({ id: "private-completion-id", choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name, arguments: argumentsJson } }] }, finish_reason: failure === "incomplete-finish" ? "length" : "tool_calls" }] })
          + dataFrame({ usage: { prompt_tokens: 17, completion_tokens: 5 } });
        return new Response(round + (failure === "incomplete-read" ? "" : "data: [DONE]\n\n"));
      }) as typeof fetch;
      try {
        const { req, res } = makeReqRes();
        const end = res.end.bind(res);
        res.end = (() => { endCount++; end(); return res; }) as typeof res.end;
        await createAgentChatHandler({
          ...baseConfig(fetchImpl),
          meetingTrace: trace => traces.push(trace),
          streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: summary => logs.push(summary) },
          flusher: { enqueue: entry => entries.push(entry) } as AgentChatConfig["flusher"],
        })(req, res);
        const text = res.chunks.join("");
        const rounds = 1;
        expect(models).toBe(rounds);
        expect(dispatches).toBe(failure === "tool-overflow" ? 1 : 0);
        expect(text.match(/"stream_error":/g)).toHaveLength(1);
        expect(text).toContain(`"stream_error":{"code":"${code}"}`);
        expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
        expect(endCount).toBe(1);
        expect(text).not.toMatch(/"usage"|"id"|private-completion-id|PRIVATE PROVIDER|OVERSIZED PRIVATE/);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ outcome: code });
        expect(traces).toEqual([]);
        expect(JSON.stringify({ logs, traces })).not.toMatch(/PRIVATE|invalid JSON|private-completion-id/);
        expect(entries).toHaveLength(completed ? 1 : 0);
        expect(getUsage(ADDR, TIERS.free, null).used).toBe(completed ? rounds : 0);
        if (completed) expect(entries[0]).toMatchObject({ prompt_tokens: 17 * rounds, completion_tokens: 5 * rounds, credits: rounds });
      } finally { restore(); }
    });
  }

  function makeCompletionFetch(opts?: { id?: string; content?: string; promptTokens?: number; completionTokens?: number }): typeof fetch {
    const id = opts?.id ?? "cmpl-test";
    const content = opts?.content ?? "Hello";
    const pt = opts?.promptTokens ?? 10;
    const ct = opts?.completionTokens ?? 5;
    return (async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        dataFrame({ id, choices: [{ delta: { content }, finish_reason: "stop" }] }),
        dataFrame({ choices: [], usage: { prompt_tokens: pt, completion_tokens: ct } }),
      ]),
    })) as unknown as typeof fetch;
  }

  it("all four exact offered IDs pass the agent gate without pricing", async () => {
    process.env.PAYWALL_ENABLED = "false";
    for (const { id } of OFFERED_CHAT_MODELS) {
      const { req, res } = makeReqRes();
      req.body.model = id;
      let called = false;
      const handler = createAgentChatHandler({
        ...baseConfig((async (...args: Parameters<typeof fetch>) => {
          called = true;
          expect(JSON.parse(args[1]!.body as string).model).toBe(id);
          return makeCompletionFetch()(...args);
        }) as typeof fetch),
        isModelOffered: isOfferedModel,
      });
      await handler(req, res);
      expect(called).toBe(true);
    }
  });

  for (const gate of ["auth", "input", "model"] as const) {
    it(`preserves the pre-SSE ${gate} HTTP gate`, async () => {
      process.env.PAYWALL_ENABLED = "false";
      const { req, res } = makeReqRes();
      if (gate === "auth") req.user = undefined;
      if (gate === "input") req.body.messages = [];
      let calls = 0;
      await createAgentChatHandler({
        ...baseConfig((async () => { calls++; throw new Error("Unexpected provider request"); }) as typeof fetch),
        isModelOffered: () => gate !== "model",
      })(req, res);
      expect(calls).toBe(0);
      expect(res.statusCode).toBe(gate === "auth" ? 401 : gate === "input" ? 400 : 403);
      expect(res.headersSent).toBe(false);
      expect(res.chunks).toHaveLength(0);
    });
  }

  it("resolves entity identity before opening SSE", async () => {
    process.env.PAYWALL_ENABLED = "false";
    const { req, res } = makeReqRes();
    const handler = createAgentChatHandler({ ...baseConfig(makeCompletionFetch()), entityIdFor: () => { throw new Error("synthetic identity setup failure"); } });
    await expect(Promise.resolve(handler(req, res))).rejects.toThrow("synthetic identity setup failure");
    expect(res.headersSent).toBe(false); expect(res.chunks).toHaveLength(0);
  });

  it("does not log raw failures in either post-stream accounting catch", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    _setStripeClient(mockStripe(null));
    const restore = stubCatalogFetch();
    const logged: unknown[] = [];
    const error = spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
    try {
      const { req, res } = makeReqRes();
      await createAgentChatHandler({
        ...baseConfig(makeCompletionFetch()),
        flusher: { enqueue: () => { throw new Error("sentinel-accounting-error-with-secret"); } } as AgentChatConfig["flusher"],
      })(req, res);
      expect(logged).toHaveLength(2);
      expect(JSON.stringify(logged)).not.toContain("sentinel");
      expect(res.chunks.join("").match(/data: \[DONE\]/g)).toHaveLength(1);
    } finally { error.mockRestore(); restore(); }
  });

  for (const failure of ["content", "id", "usage", "done", "end"] as const) {
    it(`keeps completed usage ineligible when ${failure} delivery throws`, async () => {
      process.env.PAYWALL_ENABLED = "true";
      process.env.STRIPE_SECRET_KEY = "sk_test";
      _setStripeClient(mockStripe(null));
      const restore = stubCatalogFetch();
      try {
        const { req, res } = makeReqRes();
        const write = res.write.bind(res);
        res.write = ((chunk: string | Uint8Array) => {
          const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          if ((failure === "content" && text.includes('"content"')) || (failure === "id" && text.includes('"id"')) || (failure === "usage" && text.includes('"usage"')) || (failure === "done" && text.includes("[DONE]"))) throw new Error("synthetic write exception");
          return write(chunk);
        }) as typeof res.write;
        if (failure === "end") res.end = (() => { throw new Error("synthetic end exception"); }) as typeof res.end;
        await createAgentChatHandler(baseConfig(makeCompletionFetch()))(req, res);
        expect(getUsage(ADDR, TIERS.free, null).used).toBe(0);
        expect(res.destroyed).toBe(true);
      } finally { restore(); }
    });
  }

  for (const transport of ["close", "backpressure"] as const) {
    it(`retains completed-result accounting for terminal ${transport} without a write exception`, async () => {
      process.env.PAYWALL_ENABLED = "true";
      process.env.STRIPE_SECRET_KEY = "sk_test";
      _setStripeClient(mockStripe(null));
      const restore = stubCatalogFetch();
      try {
        const { req, res } = makeReqRes();
        const write = res.write.bind(res);
        res.write = ((chunk: string | Uint8Array) => {
          const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          const result = write(chunk);
          if (text.includes('"id"')) {
            if (transport === "close") res.destroy();
            else { queueMicrotask(() => res.emit("drain")); return false; }
          }
          return result;
        }) as typeof res.write;
        await createAgentChatHandler(baseConfig(makeCompletionFetch()))(req, res);
        expect(getUsage(ADDR, TIERS.free, null).used).toBeGreaterThan(0);
      } finally { restore(); }
    });
  }

  for (const secondRound of ["exception", "http-error"] as const) {
    it(`preserves prior-round accounting disposition for ${secondRound}`, async () => {
      process.env.PAYWALL_ENABLED = "true";
      process.env.STRIPE_SECRET_KEY = "sk_test";
      _setStripeClient(mockStripe(null));
      const restore = stubCatalogFetch();
      let rounds = 0;
      const fetchImpl = (async (url: string) => {
        if (url.includes("/tools/")) return new Response(JSON.stringify({ result: { text: "tool result" } }));
        if (++rounds === 1) return {
          ok: true, status: 200, body: sseStream([
            dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
            dataFrame({ usage: { prompt_tokens: 10, completion_tokens: 3 } }),
          ]),
        };
        if (secondRound === "exception") throw new Error("synthetic failure after observed usage");
        return new Response("failed", { status: 503 });
      }) as typeof fetch;
      try {
        const { req, res } = makeReqRes();
        await createAgentChatHandler(baseConfig(fetchImpl))(req, res);
        if (secondRound === "exception") expect(getUsage(ADDR, TIERS.free, null).used).toBe(0);
        else expect(getUsage(ADDR, TIERS.free, null).used).toBeGreaterThan(0);
        expect(res.chunks.join("")).toContain('"stream_error":{"code":"upstream_failed"}');
      } finally { restore(); }
    });
  }

  it("A5c: recordUsage is called with summed credits when paywall is on", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    _setStripeClient(mockStripe(null)); // free tier

    const restoreGlobalFetch = stubCatalogFetch();
    try {
      const { req, res } = makeReqRes();
      const handler = createAgentChatHandler(baseConfig(makeCompletionFetch({ promptTokens: 10, completionTokens: 5 })));
      await handler(req, res);

      const usage = getUsage(ADDR, TIERS.free, null);
      expect(usage.used).toBeGreaterThan(0);
    } finally {
      restoreGlobalFetch();
    }
  });

  it("A5c: recordUsage is NOT called when paywall is off", async () => {
    // backend/.env sets PAYWALL_ENABLED=true (auto-loaded into ORIGINAL_ENV), so
    // disable it explicitly to exercise the default-deployment paywall-off path
    // (mirrors chat-gating.test.ts) — paywall off ⇒ no recording.
    process.env.PAYWALL_ENABLED = "false";
    const { req, res } = makeReqRes();
    const handler = createAgentChatHandler(baseConfig(makeCompletionFetch()));
    await handler(req, res);

    const usage = getUsage(ADDR, TIERS.free, null);
    expect(usage.used).toBe(0);
  });

  it("A5d: 402 model_not_allowed when paywall on and model not allowed for tier", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    _setStripeClient(mockStripe(null)); // free tier

    // The tier model-allowance gate is now permissive by default (modelPatterns:
    // [""] — the offered-model gate does the real restriction). To still exercise
    // the model_not_allowed branch, temporarily restrict the free tier so the
    // requested model fails isModelAllowed, then restore it. We inject
    // isModelOffered: () => true so the request clears the offered gate and reaches
    // the billing isModelAllowed gate.
    const originalFreePatterns = TIERS.free.modelPatterns;
    TIERS.free.modelPatterns = ["z-ai/"]; // free disallows non-z-ai/ models
    try {
      const { req, res } = makeReqRes({ body: { model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] } });
      const config: AgentChatConfig = {
        ...baseConfig(makeCompletionFetch()),
        isModelOffered: () => true, // passes the offered gate
      };
      const handler = createAgentChatHandler(config);
      await handler(req, res);

      expect((res as unknown as { lastStatus: number }).lastStatus).toBe(402);
      const body = (res as unknown as { lastJson: { status: number; body: unknown } }).lastJson?.body as { error: string };
      expect(body?.error).toBe("model_not_allowed");
    } finally {
      TIERS.free.modelPatterns = originalFreePatterns;
    }
  });

  it("A5d: 402 credit_budget_exceeded when paywall on and budget exhausted", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.CREDIT_BUDGET_FREE = "10";
    _setStripeClient(mockStripe(null)); // free tier

    // Exhaust the free budget before the request
    recordUsage(ADDR, TIERS.free, 10, null);

    const restoreGlobalFetch = stubCatalogFetch();
    try {
      const { req, res } = makeReqRes();
      const handler = createAgentChatHandler(baseConfig(makeCompletionFetch()));
      await handler(req, res);

      expect((res as unknown as { lastStatus: number }).lastStatus).toBe(402);
      const body = (res as unknown as { lastJson: { status: number; body: unknown } }).lastJson?.body as {
        error: string;
        source: string;
      };
      expect(body?.error).toBe("credit_budget_exceeded");
      expect(body?.source).toBe("local");
    } finally {
      restoreGlobalFetch();
    }
  });
});

// ── LEDGER_AUTHORITATIVE gate for agent-chat (Phase 2) ────────────────────────

describe("createAgentChatHandler LEDGER_AUTHORITATIVE gate", () => {
  // Minimal fetch that never gets called (402 paths short-circuit before upstream)
  const noopFetch = (() => Promise.resolve({ ok: true, status: 200, body: null } as unknown as Response)) as unknown as typeof fetch;

  function makeAgentRehydrator(opts: {
    atLimit?: boolean;
    entitlement: {
      credit_limit: number | null;
      committed_credits: number | null;
      isOutage: boolean;
      period_anchor?: string | null;
    };
  }) {
    return {
      rehydrateIfNeeded: async () => opts.atLimit ?? false,
      getEntitlement: async () => ({
        credit_limit: opts.entitlement.credit_limit,
        committed_credits: opts.entitlement.committed_credits,
        period_anchor: opts.entitlement.period_anchor ?? "utc_day",
        isOutage: opts.entitlement.isOutage,
      }),
      get unrehydratedServesCount() { return 0; },
    };
  }

  it("flag-OFF: local isOverBudget governs — exhausted local budget → 402", async () => {
    delete process.env.LEDGER_AUTHORITATIVE;
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    process.env.CREDIT_BUDGET_FREE = "10";
    _setStripeClient(mockStripe(null)); // free tier
    recordUsage(ADDR, TIERS.free, 10, null);

    const rehydrator = makeAgentRehydrator({
      atLimit: false,
      // Ledger says under limit — flag is OFF so local path wins
      entitlement: { credit_limit: 1000, committed_credits: 0, isOutage: false },
    });
    const { req, res } = makeReqRes();
    const handler = createAgentChatHandler({
      ...baseConfig(noopFetch),
      rehydrator: rehydrator as any,
    });
    await handler(req, res);

    expect((res as unknown as { lastStatus: number }).lastStatus).toBe(402);
    const body = (res as unknown as { lastJson: { status: number; body: unknown } }).lastJson?.body as {
      error: string;
      source: string;
    };
    expect(body?.error).toBe("credit_budget_exceeded");
    expect(body?.source).toBe("local");
  });

  it("flag-ON: clean ledger read at limit → 402 (ledger-sourced; local tally is 0)", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    _setStripeClient(mockStripe(null)); // free tier, local tally = 0

    const rehydrator = makeAgentRehydrator({
      atLimit: false,
      entitlement: { credit_limit: 1000, committed_credits: 1000, isOutage: false },
    });
    const { req, res } = makeReqRes();
    const handler = createAgentChatHandler({
      ...baseConfig(noopFetch),
      rehydrator: rehydrator as any,
    });
    await handler(req, res);

    expect((res as unknown as { lastStatus: number }).lastStatus).toBe(402);
    const body = (res as unknown as { lastJson: { status: number; body: unknown } }).lastJson?.body as {
      error: string;
      source: string;
    };
    expect(body?.error).toBe("credit_budget_exceeded");
    expect(body?.source).toBe("ledger");
  });

  it("flag-ON: exhausted K + bounded_k → k-degrade 402", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "bounded_k";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    _setStripeClient(mockStripe(null));

    const rehydrator = makeAgentRehydrator({
      atLimit: true,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const { req, res } = makeReqRes();
    const handler = createAgentChatHandler({
      ...baseConfig(noopFetch),
      rehydrator: rehydrator as any,
    });
    await handler(req, res);

    expect((res as unknown as { lastStatus: number }).lastStatus).toBe(402);
    const body = (res as unknown as { lastJson: { body: unknown } }).lastJson?.body as { source: string };
    expect(body.source).toBe("k_degrade");
  });

  it("flag-ON: exhausted K + fail_closed → outage-policy 402", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_closed";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    _setStripeClient(mockStripe(null));

    const rehydrator = makeAgentRehydrator({
      atLimit: true,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const { req, res } = makeReqRes();
    const handler = createAgentChatHandler({
      ...baseConfig(noopFetch),
      rehydrator: rehydrator as any,
    });
    await handler(req, res);

    expect((res as unknown as { lastStatus: number }).lastStatus).toBe(402);
    const body = (res as unknown as { lastJson: { body: unknown } }).lastJson?.body as { source: string };
    expect(body.source).toBe("outage_policy");
  });

  it("flag-ON: exhausted K + fail_open → serves", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_open";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    _setStripeClient(mockStripe(null));

    const rehydrator = makeAgentRehydrator({
      atLimit: true,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const completionFetch = (async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        dataFrame({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        dataFrame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      ]),
    })) as unknown as typeof fetch;
    const restoreGlobalFetch = stubCatalogFetch();
    try {
      const { req, res } = makeReqRes();
      const handler = createAgentChatHandler({
        ...baseConfig(completionFetch),
        rehydrator: rehydrator as any,
      });
      await handler(req, res);

      expect((res as unknown as { lastStatus: number }).lastStatus).toBe(200);
      expect((res as unknown as { lastJson?: unknown }).lastJson).toBeUndefined();
    } finally {
      restoreGlobalFetch();
    }
  });

  it("flag-ON: a local weekly tier without an anchor is a hard outage before either ledger window read", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_closed";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test";
    _setStripeClient(mockStripe("price_plus_m", null));

    let rehydrateCalls = 0;
    let entitlementCalls = 0;
    const rehydrator = {
      rehydrateIfNeeded: async () => {
        rehydrateCalls++;
        return false;
      },
      getEntitlement: async () => {
        entitlementCalls++;
        return {
          credit_limit: 12_000,
          committed_credits: 0,
          period_anchor: "anchored_week",
          isOutage: false,
        };
      },
    };
    const { req, res } = makeReqRes();
    const handler = createAgentChatHandler({
      ...baseConfig(noopFetch),
      rehydrator: rehydrator as any,
    });
    await handler(req, res);

    expect((res as unknown as { lastStatus: number }).lastStatus).toBe(402);
    expect(rehydrateCalls).toBe(0);
    expect(entitlementCalls).toBe(0);
    const body = (res as unknown as { lastJson: { body: unknown } }).lastJson?.body as {
      usage?: unknown;
      source?: string;
    };
    expect(body).not.toHaveProperty("usage");
    expect(body.source).toBe("config_outage");
  });
});
