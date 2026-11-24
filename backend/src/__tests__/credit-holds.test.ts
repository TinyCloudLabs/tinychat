import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import express, { type Request, type Response as ExpressResponse } from "express";
import type Stripe from "stripe";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { createChatRouter } from "../routes/chat.js";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage, getUsage, heldCredits, holdCredits, recordUsage, takeFreeTimeout } from "../billing/usage.js";
import { estimateTextTokens } from "../billing/credits.js";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import { timeCappedOutputTokens } from "../model-output-speed.js";
import type { LedgerFlusher, LedgerUsageRecordInput } from "../billing/ledger-flusher.js";
import { TIERS } from "../billing/tiers.js";

// TC-3487 (a Stop is charged for what it used), TC-3488 (credits are held at admission), and TC-4203 (a timeout is free
// unless the client stopped reading).

const address = "0xcredit-holds";
const model = "z-ai/glm-5.2";
const LIMIT = 1000;
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let info: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;
let enqueued: LedgerUsageRecordInput[];
const flusher = { enqueue: (record: LedgerUsageRecordInput) => { enqueued.push(record); } } as unknown as LedgerFlusher;

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_local_test";
  process.env.REDPILL_API_KEY = "local_catalog_test";
  process.env.LEDGER_CREDIT_GATE_ENABLED = "false";
  process.env.CREDIT_BUDGET_FREE = String(LIMIT);
  process.env.AGENT_CHAT_BUDGET_STOP_MODE = "off";
  delete process.env.AGENT_CHAT_BUDGET_PREFLIGHT;
  enqueued = [];
  _resetUsage(); _resetCache(); _resetCatalogCache();
  _setStripeClient({ customers: { search: async () => ({ data: [] }) } } as unknown as Stripe);
  // 10 credits per 1K tokens each way.
  globalThis.fetch = (async (input: unknown) => {
    if (!String(input).endsWith("/models")) throw new Error("Unexpected global network request");
    return Response.json({ data: [{ id: model, context_length: 100_000, pricing: { prompt: "0.000001", completion: "0.000001" } }] });
  }) as typeof fetch;
  info = spyOn(console, "info").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  info.mockRestore(); error.mockRestore(); warn.mockRestore();
  _setStripeClient(null); _resetCache(); _resetUsage(); _resetCatalogCache();
});

function seedRemaining(remaining: number) {
  _resetUsage();
  if (LIMIT - remaining > 0) recordUsage(address, TIERS.free, LIMIT - remaining);
}
const used = () => getUsage(address, TIERS.free).used;
const held = () => heldCredits(address, TIERS.free, null, Date.now());
/** A ledger, authoritative under LEDGER_AUTHORITATIVE, that has recorded only `committed` of the limit. */
const ledgerWith = (committed: number) => ({
  rehydrateIfNeeded: async () => false,
  getEntitlement: async () => ({ credit_limit: LIMIT, committed_credits: committed, period_anchor: "utc_day", isOutage: false }),
  get unrehydratedServesCount() { return 0; },
}) as unknown as LedgerRehydrator;

function browser() {
  const chunks: string[] = [];
  const req = Object.assign(new EventEmitter(), { user: { address }, body: { model, messages: [{ role: "user", content: "Hello" }] } }) as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; }, flushHeaders() {},
    write(value: Uint8Array | string) { chunks.push(typeof value === "string" ? value : new TextDecoder().decode(value)); return true; },
    end() { this.emit("finish"); return this; },
    destroy() { this.destroyed = true; this.emit("close"); return this; },
  });
  return { req, res: res as unknown as ExpressResponse & { body: unknown }, stream: () => chunks.join("") };
}

function agentConfig(fetchImpl: typeof fetch, over: Partial<AgentChatConfig> = {}): AgentChatConfig {
  return {
    agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a", entityIdFor: () => "8ed637c2-9747-4d8e-a36f-803e1c24bc10",
    streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 300_000, drainGraceMs: 100 },
    elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "local-test", redpillApiKey: "unused", redpillBaseUrl: "https://provider.test/v1",
    defaultModel: () => model, isModelOffered: value => value === model, fetchImpl, redpillFetch: fetchImpl, flusher,
    streamRuntime: { now: () => performance.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), log: () => {} },
    ...over,
  };
}

const sse = (...frames: string[]) => new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
const usageFrame = (prompt: number, completion: number) => frame({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });
/** Streams `frames`, then stays open until the reader cancels it. */
const stalled = (...frames: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) { for (const chunk of frames) controller.enqueue(encoder.encode(chunk)); },
}), { headers: { "Content-Type": "text/event-stream" } });
/** Streams `frames`, then stays open until the request is aborted, as a provider's response does. */
const stalledUntilAbort = (signal: AbortSignal | null | undefined, ...frames: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
    signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
  },
}), { headers: { "Content-Type": "text/event-stream" } });

/** Makes the browser stop reading (write returns false) at the first write containing `marker`; it drains after `drainAfterMs`, or never. */
function stopReadingAt(local: ReturnType<typeof browser>, marker: string, drainAfterMs?: number) {
  const res = local.res as unknown as EventEmitter & { write: (value: Uint8Array | string) => boolean };
  const write = res.write.bind(res);
  let stopped = false;
  res.write = value => {
    write(value);
    if (stopped || !(typeof value === "string" ? value : new TextDecoder().decode(value)).includes(marker)) return true;
    stopped = true;
    if (drainAfterMs !== undefined) setTimeout(() => res.emit("drain"), drainAfterMs);
    return false;
  };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
}

function manualClock() {
  let time = 0, id = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  return {
    flush,
    runtime: {
      now: () => time,
      setTimeout: (fn: () => void, ms: number) => { const key = ++id; tasks.set(key, { at: time + ms, fn }); return key; },
      clearTimeout: (key: unknown) => { tasks.delete(key as number); },
      log: () => {},
    },
    async advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; tasks.delete(next[0]); next[1].fn(); await flush();
      }
      time = end; await flush();
    },
  };
}

// 40,000 chars of output are 10,000 tokens by the 4 bytes per token estimate: 100 credits.
const LONG = "x".repeat(40_000);

describe("a Stop is charged for what the reply used up to it (TC-3487)", () => {
  test("a Stop after content but before the usage frame charges the streamed round", async () => {
    seedRemaining(500);
    const local = browser();
    const requests: string[] = [];
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      return stalled(frame({ id: "c", choices: [{ delta: { content: LONG } }] }));
    }) as typeof fetch);
    const reply = createAgentChatHandler(config)(local.req, local.res, () => {});
    await until(() => local.stream().includes(LONG));
    local.req.emit("aborted");
    await reply;
    const prompt = Math.ceil(requests[0].length / 4);
    // creditsFor rounds the reply's total up: 10 credits per 1K tokens each way.
    const expected = Math.ceil(((prompt + 10_000) / 1000) * 10);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBe(expected);
    expect(used()).toBe(LIMIT - 500 + expected);
  });

  test("a Stop after the usage frame charges the reported usage, not the estimate", async () => {
    seedRemaining(500);
    const local = browser();
    // The usage frame leads, so it has been read by the time the content shows.
    const config = agentConfig((async () => stalled(usageFrame(2_000, 3_000), frame({ id: "c", choices: [{ delta: { content: LONG } }] }))) as typeof fetch);
    const reply = createAgentChatHandler(config)(local.req, local.res, () => {});
    await until(() => local.stream().includes(LONG));
    local.req.emit("aborted");
    await reply;
    expect(enqueued[0].credits).toBe(50);
  });

  test("a Stop is still clamped to what the reply held", async () => {
    seedRemaining(60);
    const local = browser();
    const config = agentConfig((async () => stalled(frame({ id: "c", choices: [{ delta: { content: LONG } }] }))) as typeof fetch);
    const reply = createAgentChatHandler(config)(local.req, local.res, () => {});
    await until(() => local.stream().includes(LONG));
    local.req.emit("aborted");
    await reply;
    expect(enqueued[0].credits).toBe(60);
    expect(used()).toBe(LIMIT);
  });

  test("a Stop meters UTF-8 bytes, so CJK output is not undercharged", async () => {
    seedRemaining(500);
    const local = browser();
    const requests: string[] = [];
    // 10,000 CJK chars are 30,000 bytes: 7,500 tokens at 4 bytes per token, but at least one per non-ASCII char makes 10,000.
    const cjk = "你".repeat(10_000);
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      return stalled(frame({ id: "c", choices: [{ delta: { content: cjk } }] }));
    }) as typeof fetch);
    const reply = createAgentChatHandler(config)(local.req, local.res, () => {});
    // The test browser decodes each 16 KiB slice on its own, so the frame's full text never matches; its start does.
    await until(() => local.stream().includes("你你你"));
    local.req.emit("aborted");
    await reply;
    const prompt = Math.ceil(Buffer.byteLength(requests[0]) / 4);
    expect(enqueued[0].credits).toBe(Math.ceil(((prompt + 10_000) / 1000) * 10));
  });
});

describe("a timeout is free unless the client stopped reading (TC-4203)", () => {
  test("even after content was delivered and usage reported", async () => {
    seedRemaining(500);
    const local = browser();
    const config = agentConfig((async () => stalled(frame({ id: "c", choices: [{ delta: { content: "Partial" } }] }), usageFrame(10_000, 5_000))) as typeof fetch,
      { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 80, drainGraceMs: 100 } });
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(local.stream()).toContain("Partial");
    expect(local.stream()).toContain('"stream_error":{"code":"turn_timeout"}');
    expect(used()).toBe(LIMIT - 500);
    expect(enqueued).toEqual([]);
  });

  test("the turn clock stops while the client is not reading", async () => {
    seedRemaining(500);
    const local = browser();
    // The client stops reading at the second frame for 120 ms, past the 80 ms turn timeout but inside the 160 ms wall cap.
    stopReadingAt(local, "Second", 120);
    const config = agentConfig((async () => sse(frame({ id: "c", choices: [{ delta: { content: "First" } }] }), frame({ id: "c", choices: [{ delta: { content: "Second" }, finish_reason: "stop" }] }), usageFrame(1_000, 1_000), "data: [DONE]\n\n")) as typeof fetch,
      { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 80, drainGraceMs: 100 } });
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(local.stream()).toContain("Second");
    expect(local.stream()).not.toContain("turn_timeout");
    expect(local.stream()).toContain("data: [DONE]");
    expect(enqueued.map(record => record.credits)).toEqual([20]);
  });

  test("a turn that reaches the wall cap with the client not reading is charged as a Stop, for its metered usage", async () => {
    seedRemaining(500);
    const local = browser();
    // Content reaches the client, then it stops reading for good.
    stopReadingAt(local, LONG.slice(0, 100));
    const requests: string[] = [];
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      return stalled(frame({ id: "c", choices: [{ delta: { content: "First" } }] }), frame({ id: "c", choices: [{ delta: { content: LONG } }] }));
    }) as typeof fetch, { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 80, drainGraceMs: 50 } });
    const started = performance.now();
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    // The wall cap is twice the turn timeout.
    expect(performance.now() - started).toBeGreaterThanOrEqual(160);
    const prompt = Math.ceil(Buffer.byteLength(requests[0]) / 4);
    const completion = Math.ceil(("First".length + LONG.length) / 4);
    expect(enqueued.map(record => record.credits)).toEqual([Math.ceil(((prompt + completion) / 1000) * 10)]);
  });

  test("content counts as delivered once the socket took its frame, even when the client never reads it", async () => {
    seedRemaining(500);
    const local = browser();
    // The only content frame is the one the client stops reading at; the turn then runs to the wall cap.
    stopReadingAt(local, "Only");
    const requests: string[] = [];
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      return stalled(frame({ id: "c", choices: [{ delta: { content: "Only" } }] }));
    }) as typeof fetch, { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 80, drainGraceMs: 50 } });
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(enqueued.map(record => record.credits)).toEqual([Math.ceil(((estimateTextTokens(requests[0]) + 1) / 1000) * 10)]);
  });

  test("each provider call's output is capped to what the model streams in the turn time left", async () => {
    seedRemaining(500);
    const local = browser();
    const requests: Array<Record<string, unknown>> = [];
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(10, 5), "data: [DONE]\n\n");
    }) as typeof fetch, { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 } });
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    // The 500 credits left would allow about 50,000 output tokens; 5 s of GLM 5.2 at 74 tok/s and the 0.8 share is 296.
    expect(requests[0].max_tokens).toBeLessThanOrEqual(timeCappedOutputTokens(model, 5_000));
    expect(requests[0].max_tokens).toBeGreaterThanOrEqual(timeCappedOutputTokens(model, 4_000));
  });

  test("a provider that streams past its time cap is cut: nothing more is forwarded, and the usage frame read after the cut is charged", async () => {
    seedRemaining(500);
    const local = browser();
    const requests: string[] = [];
    // 4,000 chars are 1,000 tokens, past the ~296-token cap of a 5 s turn. The provider goes on, then reports usage.
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      return sse(frame({ id: "c", choices: [{ delta: { content: "x".repeat(4_000) } }] }), frame({ id: "c", choices: [{ delta: { content: "AFTER" } }] }), usageFrame(1_000, 1_200), "data: [DONE]\n\n");
    }) as typeof fetch, { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 5000, drainGraceMs: 100 } });
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(requests).toHaveLength(1);
    expect(local.stream()).not.toContain("AFTER");
    expect(local.stream()).not.toContain("stream_error");
    expect(local.stream()).toContain("data: [DONE]");
    // The provider's count, 1,000 prompt and 1,200 completion tokens, at 10 credits per 1K each way.
    expect(enqueued.map(record => record.credits)).toEqual([22]);
  });

  test("a cut call with no usage frame is read for 3 s more, then charged its estimate", async () => {
    seedRemaining(500);
    const clock = manualClock();
    const local = browser();
    const requests: string[] = [];
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      return stalled(frame({ id: "c", choices: [{ delta: { content: "x".repeat(4_000) } }] }), frame({ id: "c", choices: [{ delta: { content: "AFTER" } }] }));
    }) as typeof fetch, { streamPolicy: { heartbeatMs: 10_000, turnTimeoutMs: 5000, drainGraceMs: 100 }, streamRuntime: clock.runtime });
    let done = false;
    const reply = createAgentChatHandler(config)(local.req, local.res, () => {}).then(() => { done = true; });
    await clock.flush();
    await clock.advance(2_999);
    expect(done).toBe(false);
    await clock.advance(1);
    await reply;
    expect(local.stream()).not.toContain("AFTER");
    expect(local.stream()).toContain("data: [DONE]");
    // 4,005 streamed chars, "AFTER" included: 1,002 tokens.
    expect(enqueued.map(record => record.credits)).toEqual([Math.ceil(((estimateTextTokens(requests[0]) + 1_002) / 1000) * 10)]);
  });

  test("a call streaming at the model's normal speed is cut at its time cap and settles before the deadline, charged", async () => {
    seedRemaining(500);
    const clock = manualClock();
    const local = browser();
    const requests: string[] = [];
    // 30 chars (7.5 tokens) every 100 ms: 75 tokens/s, GLM 5.2's speed. A 5 s turn caps the call at 296 tokens, passed at
    // 4 s; the provider never stops and never reports usage.
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      let stopped = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull: controller => new Promise<void>(resolve => {
          clock.runtime.setTimeout(() => { if (!stopped) controller.enqueue(encoder.encode(frame({ id: "c", choices: [{ delta: { content: "x".repeat(30) } }] }))); resolve(); }, 100);
        }),
        cancel: () => { stopped = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch, { streamPolicy: { heartbeatMs: 10_000, turnTimeoutMs: 5000, drainGraceMs: 100 }, streamRuntime: clock.runtime });
    let done = false;
    const reply = createAgentChatHandler(config)(local.req, local.res, () => {}).then(() => { done = true; });
    await clock.flush();
    await clock.advance(4_600);
    expect(done).toBe(true);
    await reply;
    expect(local.stream()).toContain("data: [DONE]");
    expect(local.stream()).not.toContain("stream_error");
    // Cut at 40 frames (1,200 chars, 300 tokens), drained to 500 ms before the deadline, charged its estimate: not a free timeout.
    expect(enqueued.map(record => record.credits)).toEqual([Math.ceil(((estimateTextTokens(requests[0]) + 300) / 1000) * 10)]);
  });

  test("output within twice the budget's cap is not cut, as the estimate counts CJK high", async () => {
    seedRemaining(100);
    const local = browser();
    let maxTokens = 0, chars = 0;
    // The provider honours max_tokens by its own count, streaming 1.5 CJK chars per token: 1.5× the cap by the estimate.
    // Its last frame, "TAIL", is forwarded only if the call was not cut before it.
    const config = agentConfig((async (_input: unknown, init?: RequestInit) => {
      maxTokens = JSON.parse(String(init?.body)).max_tokens;
      chars = Math.floor(maxTokens * 1.5);
      return sse(frame({ id: "c", choices: [{ delta: { content: "你".repeat(chars) } }] }), frame({ id: "c", choices: [{ delta: { content: "TAIL" }, finish_reason: "stop" }] }), usageFrame(100, maxTokens - 1), "data: [DONE]\n\n");
    }) as typeof fetch);
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    // The budget, not the 300 s turn clock, set the cap.
    expect(maxTokens).toBeGreaterThan(0);
    expect(maxTokens).toBeLessThan(timeCappedOutputTokens(model, 300_000));
    expect(local.stream()).not.toContain("stream_error");
    expect(local.stream()).toContain("TAIL");
    expect(enqueued.map(record => record.credits)).toEqual([Math.ceil((100 + maxTokens - 1) * 10 / 1000)]);
  });
});

describe("an account's free timeouts are capped at 10 per rolling 24 h (TC-4203)", () => {
  const timingOut = (content?: string) => agentConfig((async () => stalled(...(content ? [frame({ id: "c", choices: [{ delta: { content } }] })] : []), usageFrame(10_000, 5_000))) as typeof fetch,
    { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 80, drainGraceMs: 100 } });

  test("the 11th timeout that delivered content is charged as a Stop, for its metered usage", async () => {
    seedRemaining(500);
    for (let i = 0; i < 10; i++) {
      const local = browser();
      await createAgentChatHandler(timingOut("Partial"))(local.req, local.res, () => {});
      expect(local.stream()).toContain('"stream_error":{"code":"turn_timeout"}');
    }
    expect(enqueued).toEqual([]);
    const local = browser();
    await createAgentChatHandler(timingOut("Partial"))(local.req, local.res, () => {});
    expect(local.stream()).toContain('"stream_error":{"code":"turn_timeout"}');
    // 10,000 prompt and 5,000 completion tokens at 10 credits per 1K each.
    expect(enqueued.map(record => record.credits)).toEqual([150]);
    expect(info.mock.calls.some(([line, fields]) => line === "[billing] reply settled" && (fields as { freeTimeoutCapped?: boolean }).freeTimeoutCapped === true)).toBe(true);
  });

  test("past the cap, a timeout that delivered nothing stays free", async () => {
    seedRemaining(500);
    for (let i = 0; i < 10; i++) takeFreeTimeout(address, Date.now());
    const local = browser();
    await createAgentChatHandler(timingOut())(local.req, local.res, () => {});
    expect(local.stream()).toContain('"stream_error":{"code":"turn_timeout"}');
    expect(enqueued).toEqual([]);
    expect(used()).toBe(LIMIT - 500);
  });

  test("the window rolls: a free timeout returns 24 h after it was used", () => {
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) expect(takeFreeTimeout(address, 1_000_000 + i)).toBe(true);
    expect(takeFreeTimeout(address, 1_000_000 + day - 1)).toBe(false);
    expect(takeFreeTimeout(address, 1_000_000 + day)).toBe(true);
    expect(takeFreeTimeout(address, 1_000_000 + day)).toBe(false);
  });
});

describe("the stall rule's boundary: stalled for exactly half the turn is not most of it (TC-4203)", () => {
  // Turn timeout 100, wall cap 200. The client stops reading at "Second" from t=0 and reads again at `drainAt`; the
  // provider then goes quiet, so the turn runs to the wall cap.
  async function stallUntil(drainAt: number) {
    seedRemaining(500);
    const clock = manualClock();
    const local = browser();
    stopReadingAt(local, "Second");
    const config = agentConfig((async () => stalled(frame({ id: "c", choices: [{ delta: { content: "First" } }] }), frame({ id: "c", choices: [{ delta: { content: "Second" } }] }))) as typeof fetch,
      { streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 100, drainGraceMs: 20 }, streamRuntime: clock.runtime });
    const reply = createAgentChatHandler(config)(local.req, local.res, () => {});
    await clock.flush();
    expect(local.stream()).toContain("Second");
    await clock.advance(drainAt);
    local.res.emit("drain");
    await clock.flush();
    await clock.advance(300 - drainAt);
    await reply;
    expect(local.stream()).toContain('"stream_error":{"code":"turn_timeout"}');
  }

  test("stalled for exactly half: a free timeout", async () => {
    await stallUntil(100);
    expect(enqueued).toEqual([]);
  });

  test("stalled for just over half: charged as a Stop", async () => {
    await stallUntil(101);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].credits).toBeGreaterThan(0);
  });
});

describe("credits are held from admission to settlement (TC-3488)", () => {
  test("overlapping replies cannot spend the same allowance: N against R settle to at most R", async () => {
    seedRemaining(500);
    let providerCalls = 0;
    const config = agentConfig((async () => {
      providerCalls++;
      return stalled(frame({ id: "c", choices: [{ delta: { content: "Hi" } }] }), usageFrame(60_000, 22_000));
    }) as typeof fetch);
    const first = browser();
    const reply = createAgentChatHandler(config)(first.req, first.res, () => {});
    await until(() => first.stream().includes("Hi"));
    expect(held()).toBe(500);

    const others = [browser(), browser(), browser()];
    await Promise.all(others.map(other => createAgentChatHandler(config)(other.req, other.res, () => {})));
    for (const other of others) {
      expect(other.res.statusCode).toBe(402);
      expect(other.res.body).toMatchObject({ error: "credit_budget_exceeded" });
    }
    expect(providerCalls).toBe(1);

    first.req.emit("aborted");
    await reply;
    expect(enqueued.reduce((sum, record) => sum + record.credits, 0)).toBeLessThanOrEqual(500);
    expect(used()).toBe(LIMIT);
    expect(held()).toBe(0);
  });

  test("a settled reply releases its hold, so the next reply is admitted against what is left", async () => {
    seedRemaining(500);
    const config = agentConfig((async () => sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(10_000, 5_000), "data: [DONE]\n\n")) as typeof fetch);
    const first = browser();
    await createAgentChatHandler(config)(first.req, first.res, () => {});
    expect(held()).toBe(0);
    const second = browser();
    await createAgentChatHandler(config)(second.req, second.res, () => {});
    expect(second.res.statusCode).toBe(200);
    expect(enqueued.map(record => record.credits)).toEqual([150, 150]);
  });

  test("a reply that fails at the provider releases its hold", async () => {
    seedRemaining(500);
    const config = agentConfig((async () => { throw new Error("synthetic network failure"); }) as typeof fetch);
    const local = browser();
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(local.stream()).toContain('"stream_error"');
    expect(held()).toBe(0);
    expect(used()).toBe(LIMIT - 500);
  });

  test("with the ledger authoritative, a charge the ledger has not flushed yet still counts at admission: nothing left is a 402", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    // The local counter has the whole limit used; the ledger, a flush behind, says 800.
    seedRemaining(0);
    let providerCalls = 0;
    const config = agentConfig((async () => { providerCalls++; return sse(frame({ id: "c", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(10_000, 5_000), "data: [DONE]\n\n"); }) as typeof fetch,
      { rehydrator: ledgerWith(800) });
    const local = browser();
    await createAgentChatHandler(config)(local.req, local.res, () => {});
    expect(local.res.statusCode).toBe(402);
    expect(local.res.body).toMatchObject({ error: "credit_budget_exceeded" });
    expect(providerCalls).toBe(0);
    expect(enqueued).toEqual([]);
  });

  test("the same on the Eliza /tasks path: no task is started with nothing left", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    seedRemaining(0);
    let tasks = 0;
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/capabilities")) return Response.json({ chatTasks: { version: 1, enabled: true, cancellation: true, providerProfile: "tinychat-redpill", models: [model] } });
      if (url.endsWith("/tasks")) tasks++;
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const local = browser();
    await createAgentChatHandler(agentConfig(fetchImpl, { elizaTasksEnabled: true, rehydrator: ledgerWith(800) }))(local.req, local.res, () => {});
    expect(local.res.statusCode).toBe(402);
    expect(tasks).toBe(0);
    expect(enqueued).toEqual([]);
  });

  test("a hold that is never released lapses at its expiry", () => {
    const now = spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000_000);
      holdCredits(address, TIERS.free, null, 1_000_000, 300, 60_000);
      expect(heldCredits(address, TIERS.free, null, 1_000_000)).toBe(300);
      now.mockReturnValue(1_059_999);
      expect(heldCredits(address, TIERS.free, null, 1_000_000)).toBe(300);
      now.mockReturnValue(1_060_000);
      expect(heldCredits(address, TIERS.free, null, 1_000_000)).toBe(0);
    } finally { now.mockRestore(); }
  });

  test("a hold counts only against the window it was placed in", () => {
    const day = 24 * 60 * 60 * 1000;
    const at = Date.UTC(2026, 0, 10, 12);
    const release = holdCredits(address, TIERS.free, null, at, 300, 60_000);
    expect(heldCredits(address, TIERS.free, null, at)).toBe(300);
    expect(heldCredits(address, TIERS.free, null, at + day)).toBe(0);
    release(); release();
    expect(heldCredits(address, TIERS.free, null, at)).toBe(0);
  });
});

describe("/api/chat holds only what its capped request can cost (TC-3488)", () => {
  async function serve(respond: (signal?: AbortSignal | null) => Response, run: (post: (body: Record<string, unknown>) => Promise<globalThis.Response>) => Promise<void>, rehydrator?: LedgerRehydrator) {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/chat/completions")) { upstreamBodies.push(JSON.parse(String(init?.body))); return respond(init?.signal); }
      return Response.json({ data: [{ id: model, context_length: 100_000, pricing: { prompt: "0.000001", completion: "0.000001" } }] });
    }) as typeof fetch;
    const app = express();
    app.use(express.json());
    app.use("/api/chat", (req, _res, next) => { req.user = { address }; next(); }, createChatRouter({ flusher, redpillFetch: (input, init) => globalThis.fetch(input, init), ...(rehydrator ? { rehydrator } : {}) }));
    const server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    try {
      const { port } = server.address() as { port: number };
      await run(body => originalFetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }], ...body }) }));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
  const upstreamBodies: Array<Record<string, unknown>> = [];
  beforeEach(() => { upstreamBodies.length = 0; });

  test("a capped request (a background meeting summary) holds only its cost, so an agent reply is admitted alongside it", async () => {
    seedRemaining(500);
    await serve(signal => stalledUntilAbort(signal, frame({ choices: [{ delta: { content: "Hi" } }] })), async post => {
      const response = await post({ max_output_tokens: 1_000 });
      expect(response.status).toBe(200);
      expect(upstreamBodies[0].max_tokens).toBe(1_000);
      // The prompt at the token estimate every path uses, plus 1,000 output tokens, at 10 credits per 1K each way.
      const { max_tokens: _cap, ...priced } = upstreamBodies[0];
      const expected = Math.ceil((estimateTextTokens(JSON.stringify(priced)) + 1_000) * 10 / 1000);
      expect(held()).toBe(expected);

      const agent = browser();
      const config = agentConfig((async () => stalled(frame({ id: "c", choices: [{ delta: { content: "Agent" } }] }))) as typeof fetch);
      const reply = createAgentChatHandler(config)(agent.req, agent.res, () => {});
      await until(() => agent.stream().includes("Agent"));
      expect(agent.res.statusCode).toBe(200);
      // The agent reply holds the rest.
      expect(held()).toBe(500);
      agent.req.emit("aborted");
      await reply;
      expect(held()).toBe(expected);
      await response.body?.cancel();
      await until(() => held() === 0);
    });
  });

  test("an uncapped request is capped to what is left, and refused while an agent reply holds it all", async () => {
    seedRemaining(50);
    await serve(() => sse(frame({ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(100, 100), "data: [DONE]\n\n"), async post => {
      const response = await post({});
      await response.text();
      expect(typeof upstreamBodies[0].max_tokens).toBe("number");
      expect(upstreamBodies[0].max_tokens as number).toBeLessThanOrEqual(5_000);
      expect(enqueued.map(record => record.credits)).toEqual([2]);

      const agent = browser();
      const config = agentConfig((async () => stalled(frame({ id: "c", choices: [{ delta: { content: "Hi" } }] }))) as typeof fetch);
      const reply = createAgentChatHandler(config)(agent.req, agent.res, () => {});
      await until(() => agent.stream().includes("Hi"));
      const refused = await post({ max_output_tokens: 10 });
      expect(refused.status).toBe(402);
      expect(await refused.json()).toMatchObject({ error: "credit_budget_exceeded" });
      agent.req.emit("aborted");
      await reply;
    });
  });

  test("with the ledger authoritative and nothing left by the local counter, a request is refused before the provider", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    seedRemaining(0);
    await serve(() => sse(frame({ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(100, 100), "data: [DONE]\n\n"), async post => {
      const response = await post({});
      expect(response.status).toBe(402);
      expect(upstreamBodies).toEqual([]);
    }, ledgerWith(800));
    expect(enqueued).toEqual([]);
  });

  test("a Stop before the usage frame is charged its estimate, counting CJK by char and text inside content parts", async () => {
    seedRemaining(500);
    const cjk = "你".repeat(3_000);
    await serve(signal => stalledUntilAbort(signal, frame({ choices: [{ delta: { content: "Hi" } }] })), async post => {
      const response = await post({ messages: [{ role: "user", content: [{ type: "text", text: cjk }] }] });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await until(() => enqueued.length === 1);
    });
    // 3,000 prompt tokens (one per CJK char, where chars/4 said 750 and the old count skipped content parts) and 1 for "Hi".
    expect(enqueued[0].credits).toBe(Math.ceil((3_000 + 1) * 10 / 1000));
  });

  test("a Stop after reasoning, before any answer or the usage frame, is charged for the reasoning", async () => {
    seedRemaining(500);
    await serve(signal => stalledUntilAbort(signal, frame({ choices: [{ delta: { reasoning_content: "r".repeat(4_000) } }] })), async post => {
      const response = await post({});
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await until(() => enqueued.length === 1);
    });
    // 1,000 reasoning tokens (4,000 chars) and a few for "Hello", at 10 credits per 1K each way.
    expect(enqueued[0].credits).toBe(11);
  });

  test("a prompt the provider counts above its estimate is charged the full reported usage, not clamped to the hold", async () => {
    seedRemaining(500);
    await serve(() => sse(frame({ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }), usageFrame(5_000, 10), "data: [DONE]\n\n"), async post => {
      const response = await post({ max_output_tokens: 10 });
      await response.text();
      // The hold priced the prompt at its estimate (a few hundred tokens at most): a few credits.
      const { max_tokens: _cap, ...priced } = upstreamBodies[0];
      expect(Math.ceil((estimateTextTokens(JSON.stringify(priced)) + 10) * 10 / 1000)).toBeLessThan(51);
    });
    // 5,000 prompt and 10 completion tokens reported, at 10 credits per 1K each way.
    expect(enqueued.map(record => record.credits)).toEqual([51]);
  });

  test("parallel requests charged above their holds share what the window had left, even when the local counter trails the ledger", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    // The local counter is at 0 (as after a restart); the ledger has 800 of 1,000 committed, so 200 are left.
    seedRemaining(LIMIT);
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    await serve(() => {
      if (++arrived === 2) release();
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          await both;
          controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }) + usageFrame(15_000, 10) + "data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    }, async post => {
      const responses = await Promise.all([post({ max_output_tokens: 10 }), post({ max_output_tokens: 10 })]);
      await Promise.all(responses.map(response => response.text()));
      await until(() => enqueued.length === 2);
    }, ledgerWith(800));
    // Each reports 151 credits of usage, far above its hold: together they are charged the 200 left, not 302.
    expect(enqueued.map(record => record.credits).sort((a, b) => a - b)).toEqual([49, 151]);
  });
});
