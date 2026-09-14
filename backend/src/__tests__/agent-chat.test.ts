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
  buildCleanSynthesisMessages,
  buildMeetingAgentGuidance,
  createAgentChatHandler,
  orchestrateToolCalling,
  parseInlineToolCalls,
  parseSseJson,
  type AgentChatConfig,
} from "../routes/agent-chat.js";
import type { Request, Response } from "express";
import { compactLegacyMeetingResult } from "../transcripts/legacy-meeting-projection.js";
import { parseMeetingToolData } from "../transcripts/meeting-evidence.js";

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
    fetchImpl,
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

describe("orchestrateToolCalling", () => {
  describe("legacy result size limits", () => {
    for (const adapter of ["stream", "bodyless"] as const) {
      for (const length of [65536, 65537]) {
        it(`${adapter} accepts 65536 characters and rejects one over (${length})`, async () => {
          const json = sizedToolJson(length);
          expect(json.length).toBe(length);
          const bytes = new TextEncoder().encode(json);
          expect(bytes.length).toBeGreaterThan(length);
          let models = 0, dispatches = 0;
          const requests: string[] = [], frames: string[] = [];
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              // Split inside the butterfly, then cross the decoded-character cap.
              const multibyteSplit = bytes.indexOf(0xf0) + 2;
              const capSplit = new TextEncoder().encode(json.slice(0, 65536)).length;
              controller.enqueue(bytes.slice(0, multibyteSplit));
              controller.enqueue(bytes.slice(multibyteSplit, capSplit));
              if (capSplit < bytes.length) controller.enqueue(bytes.slice(capSplit));
              controller.close();
            },
          });
          const fetchImpl = (async (url, init) => {
            if (String(url).includes("/tools/")) {
              dispatches++;
              return adapter === "stream" ? new Response(body) : { ok: true, status: 200, body: null, json: async () => JSON.parse(json) };
            }
            requests.push(init!.body as string);
            models++;
            return { ok: true, body: sseStream([
              models === 1
                ? dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "size", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })
                : dataFrame({ id: "answer-id", choices: [{ delta: { content: "Safe answer." }, finish_reason: "stop" }] }),
              dataFrame({ usage: { prompt_tokens: 7, completion_tokens: 3 } }),
            ]) };
          }) as typeof fetch;
          const result = await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "synthetic question" }], entityId: "e", write: (f) => frames.push(f) });
          expect(dispatches).toBe(1);
          expect(body.locked).toBe(false);
          if (length === 65536) {
            expect(result).toEqual({ completionId: "answer-id", promptTokens: 14, completionTokens: 6 });
            expect(models).toBe(2);
            expect(forwardedContent(frames)).toBe("Safe answer.");
          } else {
            expect(result).toEqual({ completionId: "", promptTokens: 7, completionTokens: 3, errorCode: "result_size_limit" });
            expect(models).toBe(1);
            expect(JSON.stringify({ requests, frames })).not.toContain("OVERSIZED PRIVATE SENTINEL");
            expect(forwardedContent(frames)).toBe("");
            expect(frames.filter(f => f.includes('"status":"done"'))).toHaveLength(0);
          }
        });
      }
    }

    it("checks the final decoder flush before parsing tool JSON", async () => {
      const json = sizedToolJson(65536);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(json));
        // Incomplete UTF-8 contributes one replacement character only on flush.
        controller.enqueue(Uint8Array.of(0xf0));
        controller.close();
      } });
      let models = 0;
      const frames: string[] = [];
      const fetchImpl = (async (url) => {
        if (String(url).includes("/tools/")) return new Response(body);
        models++;
        return { ok: true, body: sseStream([models === 1
          ? dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "flush", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })
          : dataFrame({ choices: [{ delta: { content: "Must not synthesize." }, finish_reason: "stop" }] }),
        ]) };
      }) as typeof fetch;
      const result = await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "synthetic question" }], entityId: "e", write: f => frames.push(f) });
      expect(result.errorCode).toBe("result_size_limit");
      expect(result.completionId).toBe("");
      expect(models).toBe(1);
      expect(body.locked).toBe(false);
      expect(forwardedContent(frames)).toBe("");
    });

    for (const cleanup of ["reject", "pending"] as const) {
      it(`stops after overflow without reusing prior results or dispatching queued tools (${cleanup} cleanup)`, async () => {
        let cancelled = 0, models = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode(sizedToolJson(65537))); },
          cancel() { cancelled++; return cleanup === "reject" ? Promise.reject(new Error("PRIVATE CLEANUP SENTINEL")) : new Promise<void>(() => {}); },
        });
        const dispatches: string[] = [], requests: string[] = [], frames: string[] = [];
        const fetchImpl = (async (url, init) => {
          if (String(url).includes("/tools/")) {
            const name = String(url).split("/").at(-1)!;
            dispatches.push(name);
            return name === "tinycloud_read_meeting" ? new Response(body) : Response.json({ result: { text: "EARLIER PRIVATE SENTINEL" } });
          }
          requests.push(init!.body as string);
          if (++models > 1) return { ok: true, body: sseStream([dataFrame({ id: "unwanted-answer", choices: [{ delta: { content: "Must not synthesize." }, finish_reason: "stop" }] })]) };
          return { ok: true, body: sseStream([
            dataFrame({ id: "tool-round", choices: [{ delta: { content: "Already streamed partial text.", tool_calls: [
              { index: 0, id: "first", function: { name: "web_search", arguments: "{" } },
              { index: 1, id: "overflow", function: { name: "tinycloud_read_meeting", arguments: "{}" } },
              { index: 2, id: "queued", function: { name: "tinycloud_find_meetings", arguments: "{}" } },
            ] } }] }),
            dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: "}" } }] }, finish_reason: "tool_calls" }] }),
            dataFrame({ usage: { prompt_tokens: 17, completion_tokens: 5 } }),
          ]) };
        }) as typeof fetch;
        const result = await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "synthetic question" }], entityId: "e", write: f => frames.push(f) });
        expect(result).toEqual({ completionId: "", promptTokens: 17, completionTokens: 5, errorCode: "result_size_limit" });
        expect(models).toBe(1);
        expect(dispatches).toEqual(["web_search", "tinycloud_read_meeting"]);
        expect(cancelled).toBe(1);
        expect(body.locked).toBe(false);
        expect(forwardedContent(frames)).toBe("Already streamed partial text.");
        expect(frames.filter(f => f.includes("tool_activity")).map(f => JSON.parse(f.slice(6)).tool_activity)).toEqual([
          { name: "web_search", status: "running" }, { name: "web_search", status: "done" },
          { name: "tinycloud_read_meeting", status: "running" }, { name: "tinycloud_read_meeting", status: "error" },
        ]);
        expect(JSON.stringify({ requests, frames })).not.toMatch(/OVERSIZED PRIVATE|EARLIER PRIVATE|PRIVATE CLEANUP/);
      }, 500);
    }

    it("keeps a genuine unreachable tool eligible for the existing bounded continuation", async () => {
      let models = 0, dispatches = 0;
      const requests: string[] = [], frames: string[] = [];
      const fetchImpl = (async (url, init) => {
        if (String(url).includes("/tools/")) { dispatches++; throw new TypeError("PRIVATE FETCH SENTINEL"); }
        requests.push(init!.body as string);
        return { ok: true, body: sseStream([++models === 1
          ? dataFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "unreachable", function: { name: "web_search", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })
          : dataFrame({ id: "safe-answer", choices: [{ delta: { content: "Search is unavailable." }, finish_reason: "stop" }] }),
        ]) };
      }) as typeof fetch;
      const result = await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "synthetic question" }], entityId: "e", write: f => frames.push(f) });
      expect(result.errorCode).toBeUndefined();
      expect(result.completionId).toBe("safe-answer");
      expect(models).toBe(2);
      expect(dispatches).toBe(1);
      expect(requests[1]).toContain("(tool web_search unreachable)");
      expect(JSON.stringify({ requests, frames })).not.toContain("PRIVATE FETCH SENTINEL");
      expect(forwardedContent(frames)).toBe("Search is unavailable.");
    });
  });

  it("offers the composable meeting toolkit with local-calendar agent guidance", async () => {
    let body: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(init!.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        body: sseStream([dataFrame({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]),
      } as unknown as Response;
    }) as typeof fetch;
    await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "What was my last meeting?" }],
      entityId: "e",
      turnContext: { localDate: "2026-08-26", timeZone: "America/Los_Angeles" },
      write: () => {},
    });
    const names = (body!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(names).toEqual([
      "web_search",
      "tinycloud_find_meetings",
      "tinycloud_read_meeting",
      "tinycloud_search_transcripts",
      "tinycloud_list_meeting_actions",
    ]);
    const system = (body!.messages as ChatMsg[])[0]?.content ?? "";
    expect(system).toContain("2026-08-26");
    expect(system).toContain("tinycloud_find_meetings");
    expect(system).toContain("never substitute web search");
    expect(system).toContain("Citations are required answer syntax");
    expect(system).toContain("what next?");
    expect(system).toContain("citation such as [M1] is never a meetingRef");
    expect(system).toContain("never use it for an immediate follow-up");
    expect(system).toContain("tools are read-only");
  });

  it("requires a concrete date when no local calendar context is available", () => {
    expect(buildMeetingAgentGuidance()).toContain("ask for a concrete date");
  });
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

  it("chains metadata selection to a selected-meeting read before synthesis", async () => {
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    let round = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        const name = String(url).split("/").at(-1)!;
        const body = JSON.parse(init!.body as string) as { args: Record<string, unknown> };
        dispatched.push({ name, args: body.args });
        const result = name === "tinycloud_find_meetings"
          ? { text: "Found one.", data: { meetings: [{ meetingRef: "meeting-1", citation: "[M1]", title: "Latest" }] } }
          : { text: "Read actions.", data: { actionItems: [{ citation: "[M1:A1]", text: "Sam will send the memo." }] } };
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      }
      round += 1;
      if (round === 1) {
        return { ok: true, status: 200, body: sseStream([dataFrame({ choices: [{
          delta: { tool_calls: [{ index: 0, id: "find-1", function: { name: "tinycloud_find_meetings", arguments: '{"sort":"newest","selectFirst":true}' } }] },
          finish_reason: "tool_calls",
        }] })]) } as unknown as Response;
      }
      if (round === 2) {
        return { ok: true, status: 200, body: sseStream([dataFrame({ choices: [{
          delta: { tool_calls: [{ index: 0, id: "read-1", function: { name: "tinycloud_read_meeting", arguments: '{"focus":"actions"}' } }] },
          finish_reason: "tool_calls",
        }] })]) } as unknown as Response;
      }
      return { ok: true, status: 200, body: sseStream([dataFrame({ choices: [{ delta: { content: "Sam will send the memo. [M1:A1]" }, finish_reason: "stop" }] })]) } as unknown as Response;
    }) as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "What are we going to do next after my last meeting?" }],
      entityId: "entity-1",
      roomId: "thread-1",
      write: (frame) => frames.push(frame),
    });
    expect(dispatched).toEqual([
      { name: "tinycloud_find_meetings", args: { sort: "newest", selectFirst: true } },
      { name: "tinycloud_read_meeting", args: { focus: "actions" } },
    ]);
    expect(forwardedContent(frames)).toContain("[M1:A1]");
  });

  it("separates standalone private-tool progress from a cited summary", async () => {
    let round = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/tools/")) {
        return Response.json({ result: {
          text: "Read the meeting.",
          data: { summary: { citation: "[M1:S]", text: "The launch is Friday." } },
        } });
      }
      round += 1;
      if (round === 1) {
        return { ok: true, body: sseStream([
          dataFrame({ choices: [{ delta: { content: "I'll look up the meeting" } }] }),
          dataFrame({ choices: [{ delta: { content: " and its summary." } }] }),
          dataFrame({ choices: [{
            delta: { tool_calls: [{ index: 0, id: "read-1", function: { name: "tinycloud_read_meeting", arguments: '{"focus":"summary"}' } }] },
            finish_reason: "tool_calls",
          }] }),
        ]) } as unknown as Response;
      }
      return { ok: true, body: sseStream([dataFrame({ id: "cited-summary", choices: [{
        delta: { content: "The launch is Friday. [M1:S]" }, finish_reason: "stop",
      }] })]) } as unknown as Response;
    }) as typeof fetch;

    const frames: string[] = [];
    const result = await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "When is the launch?" }],
      entityId: "entity-1",
      write: frame => { frames.push(frame); },
    });

    expect(forwardedContent(frames)).toBe("I'll look up the meeting and its summary.\n\nThe launch is Friday. [M1:S]");
    expect(result.completionId).toBe("cited-summary");
  });

  it("separates standalone private-tool progress from the safe fallback", async () => {
    let round = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/tools/")) {
        return Response.json({ result: {
          text: "Read the meeting.",
          data: { summary: { citation: "[M1:S]", text: "Supported evidence." } },
        } });
      }
      round += 1;
      if (round === 1) {
        return { ok: true, body: sseStream([
          dataFrame({ choices: [{ delta: { content: "I'll check the meeting" } }] }),
          dataFrame({ choices: [{ delta: { content: " before answering." } }] }),
          dataFrame({ choices: [{
            delta: { tool_calls: [{ index: 0, id: "read-1", function: { name: "tinycloud_read_meeting", arguments: '{"focus":"summary"}' } }] },
            finish_reason: "tool_calls",
          }] }),
        ]) } as unknown as Response;
      }
      return { ok: true, body: sseStream([dataFrame({ id: `uncited-${round}`, choices: [{
        delta: { content: "An unsupported claim." }, finish_reason: "stop",
      }] })]) } as unknown as Response;
    }) as typeof fetch;

    const frames: string[] = [];
    const result = await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "What happened?" }],
      entityId: "entity-1",
      write: frame => { frames.push(frame); },
    });

    expect(round).toBe(3);
    expect(forwardedContent(frames)).toBe("I'll check the meeting before answering.\n\nI found matching private meeting evidence, but could not produce a safely cited answer. Please try again.");
    expect(result.completionId).toBe("uncited-3");
  });

  it("buffers an uncited meeting draft and repairs it with clean synthesis", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    let round = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        return new Response(JSON.stringify({
          ok: true,
          result: { text: "Found one.", data: { summary: { citation: "[M1:S]", text: "Latest" } } },
        }), { status: 200 });
      }
      upstreamBodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      round += 1;
      if (round === 1) {
        return { ok: true, status: 200, body: sseStream([dataFrame({ choices: [{
          delta: { tool_calls: [{ index: 0, id: "find-1", function: { name: "tinycloud_find_meetings", arguments: '{"sort":"newest","selectFirst":true}' } }] },
          finish_reason: "tool_calls",
        }] })]) } as unknown as Response;
      }
      if (round === 2) {
        return { ok: true, status: 200, body: sseStream([dataFrame({ choices: [{
          delta: { content: "Your latest meeting was Latest." }, finish_reason: "stop",
        }] })]) } as unknown as Response;
      }
      return { ok: true, status: 200, body: sseStream([dataFrame({ choices: [{
        delta: { content: "Your latest meeting was Latest [M1:S]." }, finish_reason: "stop",
      }] })]) } as unknown as Response;
    }) as typeof fetch;

    const frames: string[] = [];
    await orchestrateToolCalling({
      config: { ...baseConfig(fetchImpl), maxRounds: 4 },
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "What was my last meeting?" }],
      entityId: "entity-1",
      roomId: "thread-1",
      write: (frame) => frames.push(frame),
    });

    expect(upstreamBodies).toHaveLength(3);
    expect(upstreamBodies[2].tools).toBeUndefined();
    expect(forwardedContent(frames)).toBe("Your latest meeting was Latest [M1:S].");
    expect(forwardedContent(frames)).not.toContain("Your latest meeting was Latest.Your");
  });

  it("repairs an uncited synthesis after find-to-read fan-out without publishing progress", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const dispatched: string[] = [];
    let round = 0;
    const meetings = Array.from({ length: 4 }, (_, index) => ({
      meetingRef: `hunter-${index + 1}`,
      citation: `[M${index + 1}]`,
      title: `Hunter sync ${index + 1}`,
    }));
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/tools/")) {
        const name = String(url).split("/").at(-1)!;
        const body = JSON.parse(String(init?.body)) as { args: { meetingRef?: string } };
        dispatched.push(`${name}:${body.args.meetingRef ?? "range"}`);
        if (name === "tinycloud_find_meetings") {
          return Response.json({ result: { text: "Found 4 meetings with Hunter from Sep 4–10.", data: { meetings } } });
        }
        const index = meetings.findIndex((meeting) => meeting.meetingRef === body.args.meetingRef);
        const citation = `[M${index + 1}:S]`;
        return Response.json({ result: { text: `Read ${meetings[index].title}.`, data: { summary: { citation, text: `Summary ${index + 1}` } } } });
      }
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      round += 1;
      if (round === 1) {
        return { ok: true, status: 200, body: sseStream([dataFrame({ usage: { prompt_tokens: 10, completion_tokens: 2 }, choices: [{
          delta: {
            content: "I'll find your meetings with Hunter from last week (Sep 4–10), then pull each summary.",
            tool_calls: [{ index: 0, id: "find", function: { name: "tinycloud_find_meetings", arguments: '{"participant":"Hunter","from":"2026-09-04","to":"2026-09-10"}' } }],
          },
          finish_reason: "tool_calls",
        }] })]) } as unknown as Response;
      }
      if (round === 2) {
        return { ok: true, status: 200, body: sseStream([dataFrame({ usage: { prompt_tokens: 20, completion_tokens: 4 }, choices: [{
          delta: {
            content: "Found 4 meetings with Hunter from Sep 4–10. Let me pull up the summaries for each.",
            tool_calls: meetings.map((meeting, index) => ({ index, id: `read-${index + 1}`, function: { name: "tinycloud_read_meeting", arguments: JSON.stringify({ meetingRef: meeting.meetingRef, focus: "summary" }) } })),
          },
          finish_reason: "tool_calls",
        }] })]) } as unknown as Response;
      }
      if (round === 3) {
        return { ok: true, status: 200, body: sseStream([dataFrame({ id: "uncited", usage: { prompt_tokens: 30, completion_tokens: 6 }, choices: [{
          delta: { content: "Hunter covered four project updates." }, finish_reason: "stop",
        }] })]) } as unknown as Response;
      }
      return { ok: true, status: 200, body: sseStream([dataFrame({ id: "cited", usage: { prompt_tokens: 40, completion_tokens: 8 }, choices: [{
        delta: { content: meetings.map((meeting, index) => `${meeting.title}: Summary ${index + 1} [M${index + 1}:S].`).join("\n") }, finish_reason: "stop",
      }] })]) } as unknown as Response;
    }) as typeof fetch;

    const frames: string[] = [];
    const result = await orchestrateToolCalling({
      config: { ...baseConfig(fetchImpl), maxRounds: 3 },
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "Summarize my meetings with Hunter from September 4 through September 10, 2026." }],
      entityId: "entity-1",
      roomId: "thread-1",
      turnContext: { localDate: "2026-09-11", timeZone: "UTC" },
      write: frame => { frames.push(frame); },
    });

    expect(upstreamBodies).toHaveLength(4);
    expect(upstreamBodies.slice(2).every(body => body.tools === undefined)).toBe(true);
    expect(dispatched).toEqual([
      "tinycloud_find_meetings:range",
      ...meetings.map(meeting => `tinycloud_read_meeting:${meeting.meetingRef}`),
    ]);
    expect(forwardedContent(frames)).toBe(meetings.map((meeting, index) => `${meeting.title}: Summary ${index + 1} [M${index + 1}:S].`).join("\n"));
    expect(result).toEqual({ promptTokens: 100, completionTokens: 20, completionId: "cited" });
  });

  it("still rejects unsupported multi-meeting synthesis after its bounded repair", async () => {
    let round = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/tools/")) {
        return Response.json({ result: { text: "Found one meeting.", data: { summary: { citation: "[M1:S]", text: "Supported fact" } } } });
      }
      round += 1;
      if (round <= 2) {
        const name = round === 1 ? "tinycloud_find_meetings" : "tinycloud_read_meeting";
        return { ok: true, status: 200, body: sseStream([dataFrame({ choices: [{
          delta: { content: `progress ${round}`, tool_calls: [{ index: 0, id: `call-${round}`, function: { name, arguments: "{}" } }] },
          finish_reason: "tool_calls",
        }], usage: { prompt_tokens: round * 10, completion_tokens: round * 2 } })]) } as unknown as Response;
      }
      return { ok: true, status: 200, body: sseStream([dataFrame({ id: round === 3 ? "unsupported-draft" : "unsupported-repair", choices: [{
        delta: { content: "An unsupported claim without a citation." }, finish_reason: "stop",
      }], usage: { prompt_tokens: round * 10, completion_tokens: round * 2 } })]) } as unknown as Response;
    }) as typeof fetch;

    const frames: string[] = [];
    const result = await orchestrateToolCalling({
      config: { ...baseConfig(fetchImpl), maxRounds: 3 },
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "Summarize my meetings" }],
      entityId: "entity-1",
      write: frame => { frames.push(frame); },
    });

    expect(round).toBe(4);
    expect(forwardedContent(frames)).toBe("I found matching private meeting evidence, but could not produce a safely cited answer. Please try again.");
    expect(result).toEqual({ promptTokens: 100, completionTokens: 20, completionId: "unsupported-repair" });
  });

  it("does not start the extended citation repair after cancellation at its round boundary", async () => {
    let round = 0;
    let boundaries = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/tools/")) {
        return Response.json({ result: { text: "Private evidence [M1:S]." } });
      }
      round += 1;
      if (round <= 2) {
        const name = round === 1 ? "tinycloud_find_meetings" : "tinycloud_read_meeting";
        return { ok: true, body: sseStream([dataFrame({ choices: [{
          delta: { tool_calls: [{ index: 0, id: `call-${round}`, function: { name, arguments: "{}" } }] },
          finish_reason: "tool_calls",
        }], usage: { prompt_tokens: round * 10, completion_tokens: round * 2 } })]) } as unknown as Response;
      }
      return { ok: true, body: sseStream([dataFrame({ id: "uncited-draft", choices: [{
        delta: { content: "Unsupported uncited draft." }, finish_reason: "stop",
      }], usage: { prompt_tokens: 30, completion_tokens: 6 } })]) } as unknown as Response;
    }) as typeof fetch;

    const frames: string[] = [];
    const result = await orchestrateToolCalling({
      config: baseConfig(fetchImpl),
      model: "phala/gpt-oss-120b",
      messages: [{ role: "user", content: "Summarize my meetings" }],
      entityId: "entity-1",
      write: frame => { frames.push(frame); },
      isAborted: () => ++boundaries >= 4,
    });

    expect(round).toBe(3);
    expect(forwardedContent(frames)).toBe("");
    expect(result).toEqual({ promptTokens: 60, completionTokens: 12, completionId: "" });
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
    // The lifecycle owner emits usage and terminal frames.
    expect(frames.some((f) => f.includes('"usage"'))).toBe(false);
    expect(frames).not.toContain("data: [DONE]\n\n");
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
    expect(frames).not.toContain("data: [DONE]\n\n");
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

    // Synthesized content is forwarded; the owner controls terminal metadata.
    expect(forwardedContent(frames)).toBe("Lisbon (https://example.com/pt).");
    expect(frames.some((f) => f.includes('"usage"'))).toBe(false);
    expect(frames).not.toContain("data: [DONE]\n\n");
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
    expect(frames).not.toContain("data: [DONE]\n\n");
  });

  describe("transcript tool delegation failures", () => {
    function transcriptTurn(toolStatus: number, toolBody: unknown) {
      const upstreamBodies: unknown[] = [];
      let round = 0;
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (String(url).includes("/tools/")) {
          return new Response(JSON.stringify(toolBody), { status: toolStatus });
        }
        upstreamBodies.push(JSON.parse(init!.body as string));
        round += 1;
        if (round === 1) {
          return {
            ok: true, status: 200,
            body: sseStream([dataFrame({
              choices: [{
                delta: { tool_calls: [{ index: 0, id: "call_t", function: { name: "tinycloud_search_transcripts", arguments: '{"query":"cobalt"}' } }] },
                finish_reason: "tool_calls",
              }],
            })]),
          } as unknown as Response;
        }
        return {
          ok: true, status: 200,
          body: sseStream([dataFrame({ choices: [{ delta: { content: "You need to reconnect transcript access." }, finish_reason: "stop" }] })]),
        } as unknown as Response;
      }) as unknown as typeof fetch;
      return { fetchImpl, upstreamBodies };
    }

    function activityFrames(frames: string[]) {
      return frames.flatMap((frame) => {
        try {
          const activity = JSON.parse(frame.replace(/^data: /, "").trim())?.tool_activity;
          return activity ? [activity as { name: string; status: string }] : [];
        } catch { return []; }
      });
    }

    function delegationErrorFrames(frames: string[]) {
      return frames.flatMap((frame) => {
        try {
          const error = JSON.parse(frame.replace(/^data: /, "").trim())?.delegation_error;
          return error ? [error as { code: string }] : [];
        } catch { return []; }
      });
    }

    for (const code of ["delegation_required", "delegation_expired"]) {
      it(`reports ${code} as a tool error and forbids substituting another source`, async () => {
        const { fetchImpl, upstreamBodies } = transcriptTurn(409, { error: code });
        const frames: string[] = [];
        await orchestrateToolCalling({
          config: baseConfig(fetchImpl),
          model: "phala/gpt-oss-120b",
          messages: [{ role: "user", content: "what replaced cobalt in my meeting?" }],
          entityId: "entity-9",
          write: (f) => frames.push(f),
        });

        // The browser must see a failed transcript activity, not a completed one.
        expect(activityFrames(frames)).toEqual([
          { name: "tinycloud_search_transcripts", status: "running" },
          { name: "tinycloud_search_transcripts", status: "error" },
        ]);
        expect(delegationErrorFrames(frames)).toEqual([{ code }]);

        // And the model must be told, in the tool result, not to fall back.
        const toolMessage = (upstreamBodies[1] as { messages: Array<{ role: string; content: string }> })
          .messages.find((message) => message.role === "tool");
        expect(toolMessage?.content).toContain(code);
        expect(toolMessage?.content).toContain("reconnect transcript access");
        expect(toolMessage?.content).toContain("Do NOT");
      });
    }

    it("forwards a successful transcript result's structured citations to synthesis", async () => {
      const data = {
        corpus: { candidateCount: 1, examinedCount: 1, matchedCount: 1, truncated: false, partial: false },
        matches: [{
          citation: "[T1]", source: "fireflies", sourceId: "canary-1", title: "Agent Retrieval Canary",
          startedAt: "2026-08-26T10:00:00.000Z",
          excerpts: [{ citation: "[T1:E1, Avery, 00:01:12]", speaker: "Avery", startSecs: 72, text: "the final choice is ember compass" }],
        }],
      };
      const { fetchImpl, upstreamBodies } = transcriptTurn(200, {
        ok: true, tool: "TINYCLOUD_SEARCH_TRANSCRIPTS",
        result: { text: "Found cited evidence in 1 of 1 examined transcripts.", data },
      });
      const frames: string[] = [];
      await orchestrateToolCalling({
        config: baseConfig(fetchImpl),
        model: "phala/gpt-oss-120b",
        messages: [{ role: "user", content: "what replaced cobalt?" }],
        entityId: "entity-9",
        write: (f) => frames.push(f),
      });

      expect(activityFrames(frames).at(-1)).toEqual({ name: "tinycloud_search_transcripts", status: "done" });
      const toolMessage = (upstreamBodies[1] as { messages: Array<{ role: string; content: string }> })
        .messages.find((message) => message.role === "tool");
      expect(toolMessage?.content).toContain("[T1:E1, Avery, 00:01:12]");
      expect(toolMessage?.content).toContain("ember compass");
    });

    it("repairs an uncited legacy transcript answer with the exact supplied T citation", async () => {
      const upstreamBodies: Array<Record<string, unknown>> = [];
      let round = 0;
      const citation = "[T1:E1, Avery, 00:01:12]";
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        if (String(url).includes("/tools/")) {
          return Response.json({ result: {
            text: "Found cited transcript evidence.",
            data: { matches: [{ citation: "[T1]", excerpts: [{ citation, speaker: "Avery", startSecs: 72, text: "the final choice is ember compass" }] }] },
          } });
        }
        upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        round += 1;
        if (round === 1) {
          return { ok: true, body: sseStream([dataFrame({ choices: [{
            delta: { tool_calls: [{ index: 0, id: "search", function: { name: "tinycloud_search_transcripts", arguments: '{"query":"cobalt"}' } }] },
            finish_reason: "tool_calls",
          }] })]) } as unknown as Response;
        }
        const content = round === 2
          ? "Avery chose ember compass."
          : `Avery chose ember compass ${citation}.`;
        return { ok: true, body: sseStream([dataFrame({ id: `transcript-${round}`, choices: [{ delta: { content }, finish_reason: "stop" }] })]) } as unknown as Response;
      }) as typeof fetch;

      const frames: string[] = [];
      const result = await orchestrateToolCalling({
        config: baseConfig(fetchImpl),
        model: "phala/gpt-oss-120b",
        messages: [{ role: "user", content: "what replaced cobalt?" }],
        entityId: "entity-9",
        write: frame => { frames.push(frame); },
      });

      expect(upstreamBodies).toHaveLength(3);
      expect(upstreamBodies[2].tools).toBeUndefined();
      expect(forwardedContent(frames)).toBe(`Avery chose ember compass ${citation}.`);
      expect(result.completionId).toBe("transcript-3");
    });
  });

  describe("buildCleanSynthesisMessages", () => {
    it("inlines question + results into a system/user pair with no tool messages", () => {
      const msgs = buildCleanSynthesisMessages("Q?", "result A\n\nresult B");
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("system");
      expect(msgs[0].content).toContain("Do not infer a decision or action item");
      expect(msgs[1].role).toBe("user");
      expect(msgs[1].content).toContain("Q?");
      expect(msgs[1].content).toContain("result A");
      expect(msgs[1].content).toContain("result B");
      expect(msgs.some((m) => m.role === "tool")).toBe(false);
    });
  });

  // A1: the final answer round's completion id is returned for terminal delivery
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

  // A1: tool-only rounds must NOT emit an id frame (only the answer round does)
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

  // A2: summed usage is returned covering all completed rounds
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
  for (const [failure, code, completed] of [
    ["invalid-plan", "interpretation_failed", true],
    ["incomplete-finish", "upstream_incomplete", true],
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
        const name = failure === "tool-overflow" ? "web_search" : "prepare_meeting_turn";
        const argumentsJson = failure === "invalid-plan" ? "{invalid JSON" : "{}";
        const round = dataFrame({ id: "private-completion-id", choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name, arguments: argumentsJson } }] }, finish_reason: failure === "incomplete-finish" ? "length" : "tool_calls" }] })
          + dataFrame({ usage: { prompt_tokens: 17, completion_tokens: 5 } });
        return new Response(round + (failure === "incomplete-read" ? "" : "data: [DONE]\n\n"));
      }) as typeof fetch;
      try {
        const { req, res } = makeReqRes();
        const end = res.end.bind(res);
        res.end = (() => { endCount++; end(); return res; }) as typeof res.end;
        await createAgentChatHandler({
          ...baseConfig(fetchImpl), meetingContentRetrievalEnabled: failure !== "tool-overflow",
          meetingTrace: trace => traces.push(trace),
          streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: summary => logs.push(summary) },
          flusher: { enqueue: entry => entries.push(entry) } as AgentChatConfig["flusher"],
        })(req, res);
        const text = res.chunks.join("");
        const rounds = failure === "invalid-plan" ? 2 : 1;
        expect(models).toBe(rounds);
        expect(dispatches).toBe(failure === "tool-overflow" ? 1 : 0);
        expect(text.match(/"stream_error":/g)).toHaveLength(1);
        expect(text).toContain(`"stream_error":{"code":"${code}"}`);
        expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
        expect(endCount).toBe(1);
        expect(text).not.toMatch(/"usage"|"id"|private-completion-id|PRIVATE PROVIDER|OVERSIZED PRIVATE/);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toMatchObject({ outcome: code });
        if (failure !== "tool-overflow") expect(traces).toEqual([expect.objectContaining({ terminal: code })]);
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


describe("legacy meeting projection under the tool context cap", () => {
  function v2Result(refs: string[], read = false) {
    const outcomes = refs.map((meetingRef, index) => {
      const meeting = { meetingRef, source: "fireflies", title: `Synthetic meeting ${index + 1}`, startedAt: "2026-09-08T12:00:00Z", participants: Array.from({ length: 8 }, (_, n) => `Synthetic attendee ${n} with a bounded display name`), organizerEmail: null };
      const text = read ? `Supported finding for ${meetingRef}. ` + "Synthetic detail. ".repeat(210) : "Synthetic metadata only.";
      return { meetingRef, source: "fireflies", meeting, state: read ? "read" : "metadata",
        body: { state: "not_requested" }, search: { state: "not_requested", storedFieldsExamined: read, bodyExamined: false, examinedMatches: 0, retainedMatches: 0 },
        evidence: [{ id: read ? "summary" : "metadata", meetingRef, source: "fireflies", kind: read ? "summary" : "metadata", text, truncated: false, ...(!read ? { metadata: meeting } : {}) }],
        coverage: { purpose: read ? "summary" : "metadata", overviewPresent: read, actionsPresent: false, bodyAttempted: false, bodyRequired: false, evidenceRetained: 1, omittedEvidenceCount: 0, omissionReasons: [], support: "sufficient" },
      };
    });
    const projected = outcomes.map((outcome, index) => ({ ...outcome.meeting, citation: `[M${index + 1}]` }));
    return { result: { text: read ? "Retrieved one purpose-supported meeting outcome." : `Found ${refs.length} matching meetings; returned ${refs.length} metadata records.`, data: {
      contractVersion: 2, outcomes,
      ...(!read ? { discovery: { matchedCount: refs.length, countKind: "exact", returnedCount: refs.length, scanLimited: false, excludedUndatedCount: 0, orderProven: true, interval: { from: "2026-09-04", to: "2026-09-10", timeZone: "Europe/Lisbon" }, observedAt: "2026-09-13T12:00:00Z", omittedMeetingRefs: [] } } : {}),
      meeting: projected[0], meetings: read ? [] : projected,
      summary: read ? { citation: "[M1:S]", text: outcomes[0].evidence[0].text } : null,
      actionItems: [], excerpts: [], matches: [],
      corpus: { candidateCount: refs.length, returnedCount: refs.length, transcriptRead: false, truncated: false, partial: false },
    } } };
  }


  it("preserves validated attendee and organizer metadata when it fits", () => {
    const fixture = v2Result(["metadata-fixture"]);
    const typed = parseMeetingToolData(fixture.result.data)!;
    typed.outcomes[0].meeting.participants = ["Synthetic Alice", "Synthetic Bob"];
    typed.outcomes[0].meeting.organizerEmail = "synthetic-organizer@example.test";
    fixture.result.data.meetings[0].participants = ["UNSUPPORTED_PARTICIPANT_SENTINEL"];
    const text = compactLegacyMeetingResult(fixture.result.data, typed)!;
    const meeting = JSON.parse(text).meetings[0];
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(meeting.participants).toEqual(typed.outcomes[0].meeting.participants);
    expect(meeting.organizerEmail).toBe("synthetic-organizer@example.test");
    expect(meeting.citation).toBe("[M1]");
    expect(meeting.coverage).toMatchObject({ support: "sufficient", contextTruncated: false, omittedParticipantCount: 0, organizerEmailOmitted: false });
    expect(text).not.toContain("UNSUPPORTED_PARTICIPANT_SENTINEL");
  });

  it("omits whole oversized metadata values with explicit coverage while retaining cited evidence", () => {
    const fixture = v2Result(["oversized-metadata-fixture"], true);
    const typed = parseMeetingToolData(fixture.result.data)!;
    const oversizedName = 'Synthetic "quoted" \\ attendee 😃 '.repeat(300);
    typed.outcomes[0].meeting.participants = ["Synthetic Alice", oversizedName, "Synthetic Bob"];
    typed.outcomes[0].meeting.organizerEmail = "synthetic".repeat(1500) + "@example.test";
    const text = compactLegacyMeetingResult(fixture.result.data, typed)!;
    const meeting = JSON.parse(text).meetings[0];
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(meeting.participants).toEqual(["Synthetic Alice", "Synthetic Bob"]);
    expect(meeting.organizerEmail).toBeNull();
    expect(meeting.summary.citation).toBe("[M1:S]");
    expect(meeting.summary.text).toContain("Supported finding for oversized-metadata-fixture.");
    expect(meeting.coverage).toMatchObject({ support: "limited", contextTruncated: true, omittedParticipantCount: 1, organizerEmailOmitted: true });
    expect(meeting.coverage.omissionReasons).toContain("metadata_budget");
    expect(text).not.toContain('Synthetic \\"quoted\\"');
  });

  it("budgets attendee metadata before dropping discovery meeting references", () => {
    const refs = ["metadata-1", "metadata-2", "metadata-3", "metadata-4"];
    const fixture = v2Result(refs);
    const typed = parseMeetingToolData(fixture.result.data)!;
    for (const outcome of typed.outcomes) outcome.meeting.participants = Array.from({ length: 12 }, (_, index) => `Synthetic attendee ${index} ${"with a long bounded display name ".repeat(3)}`);
    const text = compactLegacyMeetingResult(fixture.result.data, typed)!;
    const data = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(data.omittedMeetingCount).toBe(0);
    expect(data.meetings.map((meeting: { meetingRef: string }) => meeting.meetingRef)).toEqual(refs);
    expect(data.meetings.some((meeting: { coverage: { omittedParticipantCount: number } }) => meeting.coverage.omittedParticipantCount > 0)).toBe(true);
    for (const [index, meeting] of data.meetings.entries()) {
      expect(meeting.citation).toBe(`[M${index + 1}]`);
      expect(meeting.participants.length + meeting.coverage.omittedParticipantCount).toBe(12);
      if (meeting.coverage.omittedParticipantCount) {
        expect(meeting.coverage).toMatchObject({ support: "limited", contextTruncated: true });
        expect(meeting.coverage.omissionReasons).toContain("metadata_budget");
      }
    }
  });

  it("keeps four discovery references and associated summary citations in bounded valid synthesis JSON", async () => {
    const refs = ["fixture-1", "fixture-2", "fixture-3", "fixture-4"];
    const providerBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchImpl = (async (url, init) => {
      if (String(url).includes("/tools/")) {
        const args = JSON.parse(String(init?.body)).args;
        return Response.json(v2Result(args.meetingRef ? [args.meetingRef] : refs, Boolean(args.meetingRef)));
      }
      providerBodies.push(JSON.parse(String(init?.body)));
      const round = providerBodies.length;
      const calls = round === 1 ? [{ index: 0, id: "find", function: { name: "tinycloud_find_meetings", arguments: "{}" } }]
        : refs.map((meetingRef, index) => ({ index, id: `read-${index}`, function: { name: "tinycloud_read_meeting", arguments: JSON.stringify({ meetingRef, focus: "summary" }) } }));
      return new Response(dataFrame({ choices: [{ delta: round < 3 ? { tool_calls: calls } : { content: round === 3 ? "An uncited synthetic draft." : "Supported findings [M1:S]." }, finish_reason: round < 3 ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
    }) as typeof fetch;
    await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "Summarize four synthetic meetings." }], entityId: "fixture", write: () => {} });
    expect(providerBodies).toHaveLength(4);
    expect(providerBodies[3].messages).toEqual(providerBodies[2].messages);
    expect(providerBodies[2].messages[0].content).toContain("Disclose partial or truncated coverage");
    expect(providerBodies[2].messages[0].content).toContain("complete transcript coverage");
    const discovered = providerBodies[1].messages.find(message => message.role === "tool")!.content;
    for (const [index, ref] of refs.entries()) { expect(discovered).toContain(ref); expect(discovered).toContain(`[M${index + 1}]`); }
    const synthesis = providerBodies[2].messages[1].content.split("\n\nTool results:\n")[1].split("\n\nAnswer concisely")[0];
    expect(synthesis).toContain("[M1:S]");
    for (const ref of refs) expect(synthesis).toContain(`Supported finding for ${ref}.`);
    const packed = synthesis.split("\n\n");
    expect(packed).toHaveLength(5);
    for (const text of packed) { expect(text.length).toBeLessThanOrEqual(4000); expect(() => JSON.parse(text)).not.toThrow(); expect(text).not.toContain("[...truncated...]"); }
    const discovery = JSON.parse(packed[0]);
    expect(discovery.discovery).toMatchObject({ matchedCount: 4, returnedCount: 4, countKind: "exact", scanLimited: false, interval: { from: "2026-09-04", to: "2026-09-10" } });
    for (const text of packed.slice(1)) {
      const meeting = JSON.parse(text).meetings[0];
      expect(meeting.summary.citation).toBe("[M1:S]");
      expect(meeting.summary.text.length).toBeGreaterThan(80);
      expect(meeting.coverage).toMatchObject({ bodyAttempted: false, bodyState: "not_requested", contextTruncated: true, support: "limited" });
    }
  });

  it("preserves reader coverage flags and rejects unsupported legacy evidence text", () => {
    const fixture = v2Result(["paired-fixture"], true);
    fixture.result.data.outcomes[0].coverage.bodyRequired = true;
    fixture.result.data.outcomes[0].coverage.actionsPresent = true;
    const typed = parseMeetingToolData(fixture.result.data)!;
    typed.outcomes[0].body.reasonCode = "body_unavailable";
    fixture.result.data.summary!.text = "UNSUPPORTED_PROJECTION_SENTINEL";
    const projected = JSON.parse(compactLegacyMeetingResult(fixture.result.data, typed)!);
    expect(projected.meetings[0].coverage).toMatchObject({ overviewPresent: true, actionsPresent: true, bodyRequired: true, bodyReasonCode: "body_unavailable", support: "none", evidenceRetained: 0, omittedEvidenceCount: 1 });
    expect(projected.meetings[0].summary).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain("UNSUPPORTED_PROJECTION_SENTINEL");
    expect(JSON.stringify(projected)).not.toContain("[M1:S]");
    const found = v2Result(["ordered-fixture"]);
    expect(JSON.parse(compactLegacyMeetingResult(found.result.data, parseMeetingToolData(found.result.data)!)!).discovery.orderProven).toBe(true);
  });

  it("budgets escaped metadata without discarding all cited supporting text", () => {
    const fixture = v2Result(["escaped-fixture"], true);
    fixture.result.data.outcomes[0].meeting.title = 'Synthetic "quoted" \\ title 😃 '.repeat(400);
    const projected = compactLegacyMeetingResult(fixture.result.data, parseMeetingToolData(fixture.result.data)!)!;
    expect(projected.length).toBeLessThanOrEqual(4000);
    const data = JSON.parse(projected);
    expect(data.meetings[0].summary.citation).toBe("[M1:S]");
    expect(data.meetings[0].summary.text).toContain("Supported finding for escaped-fixture.");
    expect(data.meetings[0].coverage.contextTruncated).toBe(true);
  });

  it.each(["context", "omission"])("never upgrades unavailable decision support for %s", (cause) => {
    const fixture = v2Result(["unsupported-decisions"], true);
    const outcome = fixture.result.data.outcomes[0];
    outcome.coverage.purpose = "decisions";
    outcome.coverage.bodyRequired = true;
    outcome.coverage.support = "none";
    outcome.body.state = "missing";
    if (cause === "omission") {
      fixture.result.data.summary!.text = outcome.evidence[0].text = "Stored overview without decision evidence. ".repeat(4);
      outcome.evidence.push({ ...outcome.evidence[0], id: "action", kind: "action", text: "A stored task does not establish a decision." });
      outcome.coverage.evidenceRetained = 2;
    }
    const projected = JSON.parse(compactLegacyMeetingResult(fixture.result.data, parseMeetingToolData(fixture.result.data)!)!);
    expect(projected.meetings[0].coverage.contextTruncated).toBe(true);
    expect(projected.meetings[0].summary.text.length).toBeGreaterThan(80);
    expect(projected.meetings[0].coverage.support).toBe("none");
  });

  it("retains full typed evidence for the structured controller", async () => {
    const fixture = v2Result(["structured-fixture"], true);
    const sourceText = fixture.result.data.outcomes[0].evidence[0].text;
    const upstreamBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchImpl = (async (url, init) => {
      if (String(url).endsWith("/capabilities")) return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "synthetic-compatible-reader" });
      if (String(url).includes("/tools/")) return Response.json(fixture);
      upstreamBodies.push(JSON.parse(String(init?.body)));
      const first = upstreamBodies.length === 1;
      return new Response(dataFrame({ choices: [{ delta: first ? { tool_calls: [{ index: 0, id: "plan", function: { name: "prepare_meeting_turn", arguments: JSON.stringify({ kind: "meeting_content", scope: "exact", meetingRef: "structured-fixture", purpose: "summary", evidenceRequirement: "overview" }) } }] } : { content: JSON.stringify({ claims: [{ text: "Supported finding.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] }) }, finish_reason: first ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
    }) as typeof fetch;
    await orchestrateToolCalling({ config: { ...baseConfig(fetchImpl), meetingContentRetrievalEnabled: true, meetingTrace: () => {} }, model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "Summarize this synthetic meeting." }], entityId: "fixture", write: () => {} });
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[1].messages[1].content).toContain(sourceText);
  });
});


describe("every meeting citation must match supplied evidence", () => {
  const fullCitation = "[M1:E1, Synthetic Speaker, 00:01:12]";
  function mixedCitationScenario(invalid: string, repairValid: boolean, extraCitation?: string) {
    const providerBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url, init) => {
      if (String(url).includes("/tools/")) return Response.json({ result: { data: {
        summary: { citation: "[M1:S]", text: "Supported synthetic summary." },
        excerpts: [{ citation: fullCitation, text: "Supported synthetic quotation." }, ...(extraCitation ? [{ citation: extraCitation, text: "Another supported synthetic quotation." }] : [])],
      } } });
      providerBodies.push(JSON.parse(String(init?.body)));
      const round = providerBodies.length;
      const content = `Supported summary [M1:S]. Supported quotation ${round === 3 && repairValid ? fullCitation : invalid}.`;
      return new Response(dataFrame({ choices: [{ delta: round === 1 ? { tool_calls: [{ index: 0, id: "read", function: { name: "tinycloud_read_meeting", arguments: '{"focus":"summary"}' } }] } : { content }, finish_reason: round === 1 ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
    }) as typeof fetch;
    return { fetchImpl, providerBodies };
  }
  it("expands a uniquely supplied abbreviated citation without another model round", async () => {
    const { fetchImpl, providerBodies } = mixedCitationScenario("[M1:E1]", false);
    const frames: string[] = [];
    await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "Summarize this synthetic meeting." }], entityId: "fixture", write: frame => { frames.push(frame); } });
    expect(providerBodies).toHaveLength(2);
    expect(forwardedContent(frames)).toBe(`Supported summary [M1:S]. Supported quotation ${fullCitation}.`);
  });
  it("keeps an already exact supplied citation even when a longer attributed form also exists", async () => {
    const { fetchImpl, providerBodies } = mixedCitationScenario("[M1:E1]", false, "[M1:E1]");
    const frames: string[] = [];
    await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "Summarize this synthetic meeting." }], entityId: "fixture", write: frame => { frames.push(frame); } });
    expect(providerBodies).toHaveLength(2);
    expect(forwardedContent(frames)).toBe("Supported summary [M1:S]. Supported quotation [M1:E1].");
  });
  it.each(["[M1:E1]", "[T99:E1]", "[M1:invalid]"])("hides mixed valid and unsupported citation %s before exact repair", async (invalid) => {
    const { fetchImpl, providerBodies } = mixedCitationScenario(invalid, true, invalid === "[M1:E1]" ? "[M1:E1, Another Speaker, 00:02:00]" : undefined);
    const frames: string[] = [];
    await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "Summarize this synthetic meeting." }], entityId: "fixture", write: frame => { frames.push(frame); } });
    expect(providerBodies).toHaveLength(3);
    expect(providerBodies[2].tools).toBeUndefined();
    expect(forwardedContent(frames)).toBe(`Supported summary [M1:S]. Supported quotation ${fullCitation}.`);
    expect(forwardedContent(frames)).not.toContain(invalid);
  });
  it("falls back after the one repair still mixes a known citation with a shortened citation", async () => {
    const { fetchImpl, providerBodies } = mixedCitationScenario("[M1:E1]", false, "[M1:E1, Another Speaker, 00:02:00]");
    const frames: string[] = [];
    await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "Summarize this synthetic meeting." }], entityId: "fixture", write: frame => { frames.push(frame); } });
    expect(providerBodies).toHaveLength(3);
    expect(providerBodies[2].tools).toBeUndefined();
    expect(forwardedContent(frames)).toBe("I found matching private meeting evidence, but could not produce a safely cited answer. Please try again.");
  });
});


describe("legacy authoritative last-week scope", () => {
  async function scenario(question: string, localDate: string, tool = "tinycloud_find_meetings", extraArgs: Record<string, unknown> = {}) {
    const providerBodies: Array<{ messages: Array<{ role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>; tools?: unknown }> = [];
    const dispatched: Array<{ name: string; args: Record<string, unknown>; context: unknown }> = [];
    const staleArgs = { from: "2026-09-04", to: "2026-09-10", participant: "Hunter", title: "Sync", source: "fireflies", ...extraArgs };
    const fetchImpl = (async (url, init) => {
      if (String(url).includes("/tools/")) {
        dispatched.push({ name: String(url).split("/").at(-1)!, ...JSON.parse(String(init?.body)) });
        return Response.json({ result: { data: { summary: { citation: "[M1:S]", text: "Supported synthetic summary." }, coverage: { contextTruncated: true, bodyAttempted: false } } } });
      }
      providerBodies.push(JSON.parse(String(init?.body)));
      const round = providerBodies.length;
      const delta = round === 1 ? { tool_calls: [{ index: 0, id: "find", function: { name: tool, arguments: JSON.stringify(staleArgs) } }] }
        : round === 2 ? { tool_calls: [{ index: 0, id: "read", function: { name: "tinycloud_read_meeting", arguments: '{"meetingRef":"synthetic-selected","focus":"summary"}' } }] }
        : { content: round === 3 ? "An uncited draft." : "Supported synthetic summary [M1:S]." };
      return new Response(dataFrame({ choices: [{ delta, finish_reason: round < 3 ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
    }) as typeof fetch;
    const frames: string[] = [];
    await orchestrateToolCalling({ config: baseConfig(fetchImpl), model: "phala/gpt-oss-120b",
      messages: [
        { role: "system", content: "Historical synthetic memory: last week was September 4 through September 10, 2026." },
        { role: "user", content: "Previously summarize my meetings last week." },
        { role: "assistant", content: "Historical synthetic interval: 2026-09-04 through 2026-09-10." },
        { role: "user", content: question },
      ], entityId: "fixture", roomId: "fixture-room", turnContext: { localDate, timeZone: "Europe/Lisbon" }, write: frame => { frames.push(frame); },
    });
    return { providerBodies, dispatched, staleArgs, output: forwardedContent(frames) };
  }

  it.each([
    ["2026-09-13", "2026-08-31", "2026-09-06"],
    ["2026-09-14", "2026-09-07", "2026-09-13"],
  ])("dispatches trusted last-week bounds on %s and carries them through final and repair", async (localDate, from, to) => {
    const result = await scenario("Summarize my meetings with Hunter last week.", localDate);
    expect(result.dispatched[0].args).toEqual({ ...result.staleArgs, from, to });
    expect(result.dispatched[0].context).toEqual({ localDate, timeZone: "Europe/Lisbon" });
    const recorded = result.providerBodies[1].messages.find(message => message.tool_calls)?.tool_calls?.[0];
    expect(JSON.parse(recorded!.function.arguments)).toEqual(result.dispatched[0].args);
    expect(result.dispatched[1].args).toEqual({ meetingRef: "synthetic-selected", focus: "summary" });
    expect(result.providerBodies).toHaveLength(4);
    for (const index of [0, 2, 3]) {
      const guidance = result.providerBodies[index].messages[0].content;
      expect(guidance).toContain(`Authoritative date scope for this request: ${from} through ${to}`);
      expect(guidance).toContain("Europe/Lisbon");
    }
    for (const body of result.providerBodies.slice(2)) {
      expect(body.tools).toBeUndefined();
      expect(body.messages[0].content).toContain("Disclose partial or truncated coverage");
      expect(body.messages[0].content).toContain("complete transcript coverage");
    }
    expect(result.output).toBe("Supported synthetic summary [M1:S].");
  });

  it.each(["tinycloud_search_transcripts", "tinycloud_list_meeting_actions"])("normalizes range dates on %s without changing filters", async tool => {
    const result = await scenario("Summarize my meetings with Hunter last week.", "2026-09-14", tool, { query: "synthetic topic" });
    expect(result.dispatched[0].args).toEqual({ ...result.staleArgs, from: "2026-09-07", to: "2026-09-13" });
  });

  it.each([
    "Summarize my meetings with Hunter from September 4 through September 10, 2026.",
    "Summarize my meetings about last week.",
    'Summarize my meetings titled "Last Week".',
    "Summarize my meetings last week and September 4 through September 10, 2026.",
    "Summarize the second meeting.",
  ])("does not derive a new interval from memory or ambiguous current wording: %s", async question => {
    const result = await scenario(question, "2026-09-14");
    expect(result.dispatched[0].args).toEqual(result.staleArgs);
    expect(result.providerBodies[0].messages[0].content).not.toContain("Authoritative date scope for this request:");
  });

  it.each([null, "", "   "])("does not treat an empty reference %s as a selected meeting", async meetingRef => {
    const result = await scenario("Summarize my meetings with Hunter last week.", "2026-09-14", "tinycloud_find_meetings", { meetingRef });
    expect(result.dispatched[0].args).toEqual({ ...result.staleArgs, from: "2026-09-07", to: "2026-09-13" });
  });

  it.each(["tinycloud_find_meetings", "tinycloud_search_transcripts", "tinycloud_read_meeting"])("preserves scoped %s arguments", async tool => {
    const result = await scenario("Summarize my meetings with Hunter last week.", "2026-09-14", tool, { meetingRef: "synthetic-selected" });
    expect(result.dispatched[0].args).toEqual(result.staleArgs);
  });
});
