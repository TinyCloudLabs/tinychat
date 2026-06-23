import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { TIERS, type TierId } from "../billing/tiers.js";
import { _resetUsage, getUsage, recordUsage } from "../billing/usage.js";
import {
  accumulateToolCalls,
  buildCleanSynthesisMessages,
  createAgentChatHandler,
  orchestrateToolCalling,
  parseInlineToolCalls,
  parseSseJson,
  type AgentChatConfig,
} from "../routes/agent-chat.js";
import type { Request, Response } from "express";

const AGENT_ID = "92361e74-91ed-43a2-9656-5cc37ff3a07a";
const ADDR = "0xabc";

const ORIGINAL_ENV = { ...process.env };

function sseStream(frames: string[]): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const f of frames) yield enc.encode(f);
    },
  };
}

function dataFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
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
    entityIdFor: () => "entity-1",
    elizaServiceUrl: "https://eliza.test",
    elizaServiceSecret: "svc",
    redpillApiKey: "rp-key",
    redpillBaseUrl: "https://redpill.test/v1",
    defaultModel: () => "phala/gpt-oss-120b",
    isModelOffered: (m) => m.startsWith("phala/"),
    fetchImpl,
    maxRounds: 3,
  };
}

/** Mock Stripe resolving the caller to a given tier via its price id. */
function mockStripe(priceId: string | null, anchorEpochSec?: number): Stripe {
  return {
    customers: { search: async () => ({ data: priceId ? [{ id: "cus_1" }] : [] }) },
    subscriptions: {
      list: async () => ({
        data: priceId
          ? [
              {
                status: "active",
                current_period_end: 1_800_000_000,
                billing_cycle_anchor: anchorEpochSec ?? 1_700_000_000,
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
  return () => { globalThis.fetch = original; };
}

/** Build mock req/res objects for direct handler invocation. */
function makeReqRes(opts?: { body?: object; address?: string }) {
  const body = opts?.body ?? { messages: [{ role: "user", content: "hi" }] };
  const address = opts?.address ?? ADDR;
  let statusCode = 200;
  const jsonResponses: Array<{ status: number; body: unknown }> = [];
  const writtenChunks: string[] = [];
  let ended = false;

  const req = {
    user: { address },
    body,
    on: (_evt: string, _fn: unknown) => {},
  } as unknown as Request;

  const res = {
    get statusCode() { return statusCode; },
    status(code: number) { statusCode = code; return res; },
    json(responseBody: unknown) { jsonResponses.push({ status: statusCode, body: responseBody }); return res; },
    setHeader() { return res; },
    flushHeaders() {},
    write(chunk: string) { writtenChunks.push(chunk); return true; },
    end() { ended = true; },
    on(_evt: string, _fn: unknown) { return res; },
    get writableEnded() { return ended; },
    // test helpers
    get lastJson() { return jsonResponses[jsonResponses.length - 1]; },
    get chunks() { return writtenChunks; },
    get isEnded() { return ended; },
    get lastStatus() { return statusCode; },
  } as unknown as Response & {
    lastJson: { status: number; body: unknown } | undefined;
    chunks: string[];
    isEnded: boolean;
    lastStatus: number;
  };

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

describe("orchestrateToolCalling", () => {
  it("streams a plain answer through when the model emits no tool calls", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 200 }) && {
        ok: true,
        status: 200,
        body: sseStream([
          dataFrame({ choices: [{ delta: { content: "Hello" } }] }),
          dataFrame({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] }),
        ]),
      }) as unknown as typeof fetch;

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
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
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
    });

    // The final answer streamed through, and a tool_activity frame was emitted.
    const text = frames
      .map((f) => {
        try {
          return JSON.parse(f.replace(/^data: /, "").trim())?.choices?.[0]?.delta?.content ?? "";
        } catch {
          return "";
        }
      })
      .join("");
    expect(text).toBe("The capital is Paris.");
    expect(frames.some((f) => f.includes("tool_activity"))).toBe(true);
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  // Leaked-markup guard: a single GLM-style inline tool_call in delta.content
  // (finish "stop") is never forwarded, gets parsed + dispatched, and the synthesis
  // round's answer streams through.
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
    // (d) usage/[DONE] frames still present.
    expect(frames.some((f) => f.includes('"usage"'))).toBe(true);
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  // Leaked-markup guard: two concatenated inline tool_calls are both dispatched.
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
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  // Regression: a plain answer that does NOT lead with markup streams through with
  // no false leak detection and no spurious dispatch — even if it mentions tools.
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
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
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
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  // Issue B: on the forced final round with gathered tool results, issue a CLEAN
  // SYNTHESIS request (no tools / no tool_choice, results inlined as user text) so
  // gpt-oss-* — which ignores tool_choice:"none" and keeps re-calling — must answer.
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

    // (b) the synthesized content is forwarded; (d) usage + [DONE] present.
    expect(forwardedContent(frames)).toBe("Lisbon (https://example.com/pt).");
    expect(frames.some((f) => f.includes('"usage"'))).toBe(true);
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  // Issue B regression: forced round reached with NO tool results (model answered
  // directly) keeps the normal tool-enabled request and never reshapes.
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
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  });

  describe("buildCleanSynthesisMessages", () => {
    it("inlines question + results into a system/user pair with no tool messages", () => {
      const msgs = buildCleanSynthesisMessages("Q?", "result A\n\nresult B");
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("system");
      expect(msgs[1].role).toBe("user");
      expect(msgs[1].content).toContain("Q?");
      expect(msgs[1].content).toContain("result A");
      expect(msgs[1].content).toContain("result B");
      expect(msgs.some((m) => m.role === "tool")).toBe(false);
    });
  });

  // A1: the final answer round's completion id is forwarded via idFrame
  it("A1: emits idFrame with the final round's completion id", async () => {
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

    // An id frame must appear before [DONE]
    const idFrame = frames.find((f) => {
      try {
        const parsed = JSON.parse(f.replace(/^data: /, "").trim()) as Record<string, unknown>;
        return typeof parsed.id === "string" && parsed.id === "cmpl-abc123";
      } catch {
        return false;
      }
    });
    expect(idFrame).toBeDefined();

    // The id frame must come before [DONE]
    const idFrameIdx = frames.indexOf(idFrame!);
    const doneIdx = frames.indexOf("data: [DONE]\n\n");
    expect(idFrameIdx).toBeLessThan(doneIdx);

    // A3: return value carries the completion id
    expect(result.completionId).toBe("cmpl-abc123");
  });

  // A1: tool-only rounds must NOT emit an id frame (only the answer round does)
  it("A1: does not emit idFrame for tool-only round, only for the answer round", async () => {
    let round = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
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

    // Only one id frame total, and it carries the ANSWER round's id (not the tool round's)
    const idFrames = frames.filter((f) => {
      try {
        const parsed = JSON.parse(f.replace(/^data: /, "").trim()) as Record<string, unknown>;
        return typeof parsed.id === "string";
      } catch {
        return false;
      }
    });
    expect(idFrames).toHaveLength(1);
    const parsedId = JSON.parse(idFrames[0].replace(/^data: /, "").trim()) as { id: string };
    expect(parsedId.id).toBe("cmpl-answer");
    expect(result.completionId).toBe("cmpl-answer");
  });

  // A2: a summed usage frame is emitted covering all rounds
  it("A2: emits a usageFrame with summed tokens across all rounds", async () => {
    let round = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
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
    expect(usageFrames).toHaveLength(1);

    const usageData = (JSON.parse(usageFrames[0].replace(/^data: /, "").trim()) as { usage: { prompt_tokens: number; completion_tokens: number } }).usage;
    expect(usageData.prompt_tokens).toBe(25);   // 10 + 15
    expect(usageData.completion_tokens).toBe(8); // 3 + 5

    // A3: return value has summed totals
    expect(result.promptTokens).toBe(25);
    expect(result.completionTokens).toBe(8);

    // Usage frame must appear before [DONE]
    const usageFrameIdx = frames.indexOf(usageFrames[0]);
    const doneIdx = frames.indexOf("data: [DONE]\n\n");
    expect(usageFrameIdx).toBeLessThan(doneIdx);
  });

  // A3: single-round return value carries correct totals
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
      const body = (res as unknown as { lastJson: { status: number; body: unknown } }).lastJson?.body as { error: string };
      expect(body?.error).toBe("credit_budget_exceeded");
    } finally {
      restoreGlobalFetch();
    }
  });
});
