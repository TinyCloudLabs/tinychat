import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { load as loadYaml } from "js-yaml";
import type Stripe from "stripe";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage } from "../billing/usage.js";
import {
  configureRequestLogAccountHash,
  createRequestContextMiddleware,
  recordAfterHandler,
  recordMountTemplates,
  type RequestEvent,
} from "../request-context.js";
import { createChatRouter } from "../routes/chat.js";

// TC-2537: the per-request record that ships to Better Stack. A representative chat turn carries every kind of
// sensitive value in its URL, headers, body and streamed reply; none of them may appear in the record the backend
// emits, nor in what the Vector allowlist passes to the sink.

const HMAC_KEY = "c2537e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d";
const ADDRESS = "0xAbC1230000000000000000000000000000dEf456";
const REQUEST_ID = "0b6f2c1e-9d4a-4e7b-8c3f-2a1d5e6f7a8b";

const CANARY = {
  prompt: "PROMPT-CANARY-what-did-the-board-decide",
  reply: "REPLY-CANARY-the-board-decided-nothing",
  bearer: "BEARER-CANARY-session-token-7f3a",
  apiKey: "sk-live-APIKEYCANARY0123456789",
  cookie: "COOKIE-CANARY-sid-5521",
  queryToken: "QUERYTOKENCANARY42",
  pathToken: "PATHTOKENCANARY99",
  email: "alice.canary@example.com",
  ip: "203.0.113.77",
};
const FORBIDDEN = [...Object.values(CANARY), ADDRESS, ADDRESS.toLowerCase(), ADDRESS.slice(2).toLowerCase()];

/** Every field the shipped tinychat_request record may carry (TC-2537 allow-list plus the svc/event/level/ts envelope). */
const SHIPPED_FIELDS = [
  "account_hash", "code", "credits", "duration_ms", "event", "level", "method", "request_id", "route_template", "status", "stream", "svc", "ts",
];

const ORIGINAL_ENV = { ...process.env };
const tmpRoot = mkdtempSync(join("/var/tmp", "tc2537."));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

beforeEach(() => {
  process.env.REDPILL_API_KEY = "sk-rp-test";
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  _setStripeClient({
    customers: { search: async () => ({ data: [] }) },
    subscriptions: { list: async () => ({ data: [] }) },
  } as unknown as Stripe); // free tier
  _resetCache();
  _resetUsage();
  _resetCatalogCache();
  _resetCreditsWarnings();
  configureRequestLogAccountHash(HMAC_KEY);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _setStripeClient(null);
  _resetCache();
  _resetUsage();
  _resetCatalogCache();
  configureRequestLogAccountHash(undefined);
});

function stubUpstream(body: (signal?: AbortSignal) => ReadableStream<Uint8Array> | string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.redpill.ai") && url.endsWith("/models")) {
      return Response.json({ data: [{ id: "z-ai/glm-5.2", pricing: { prompt: "0.00000025", completion: "0.000002" } }] });
    }
    if (url.includes("api.redpill.ai") && url.endsWith("/chat/completions")) {
      return new Response(body(init?.signal ?? undefined), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

type RequestRecord = Extract<RequestEvent, { event: "tinychat_request" }>;

/** Collects emitted events; `record` settles with the first request record (emission can follow the response). */
function recorder() {
  const events: RequestEvent[] = [];
  let settle!: (record: RequestRecord) => void;
  const record = new Promise<RequestRecord>(done => { settle = done; });
  const sink = (event: RequestEvent) => {
    events.push(event);
    if (event.event === "tinychat_request") settle(event);
  };
  return { events, record, sink };
}

function createApp(sink: (event: RequestEvent) => void) {
  const app = express();
  app.use(createRequestContextMiddleware(sink));
  recordMountTemplates(app);
  app.use(express.json());
  const auth = (req: Request, _res: Response, next: NextFunction) => {
    req.user = { address: ADDRESS };
    next();
  };
  app.use("/api/chat", auth, createChatRouter());
  // A mount whose path carries a credential, like the connector webhook mount.
  const hooks = express.Router();
  hooks.get("/ping", (_req, res) => { res.json({ ok: true }); });
  app.use("/api/hooks/:source/:token", hooks);
  return app;
}

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>(done => { const s = app.listen(0, () => done(s)); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done, fail) => server.close(error => (error ? fail(error) : done()))),
  };
}

function sensitiveTurn(base: string, signal?: AbortSignal): Promise<globalThis.Response> {
  return fetch(`${base}/api/chat?email=${encodeURIComponent(CANARY.email)}&token=${CANARY.queryToken}`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CANARY.bearer}`,
      "x-api-key": CANARY.apiKey,
      cookie: `sid=${CANARY.cookie}`,
      "x-forwarded-for": CANARY.ip,
      "x-request-id": REQUEST_ID,
    },
    body: JSON.stringify({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: `${CANARY.prompt} mail ${CANARY.email} from ${CANARY.ip} key ${CANARY.apiKey}` }],
    }),
  });
}

const expectedHash = createHmac("sha256", HMAC_KEY).update(`account\0${ADDRESS.toLowerCase()}`).digest("hex");

/** Run emitted lines through the real Vector pipeline and return what reaches the sink. */
async function shipThroughVector(lines: readonly { message: string; level: number }[]): Promise<Record<string, unknown>[]> {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const shipped = loadYaml(await Bun.file(resolve(repoRoot, "log-shipper/vector.yaml")).text()) as {
    transforms: Record<string, { inputs: string[] }>;
    sinks: { betterstack: { inputs: string[] } };
  };
  shipped.transforms.redact.inputs = ["stdin"];
  const config = {
    sources: { stdin: { type: "stdin", decoding: { codec: "json" } } },
    transforms: shipped.transforms,
    sinks: { out: { type: "console", inputs: shipped.sinks.betterstack.inputs, encoding: { codec: "json" } } },
  };
  const path = join(tmpRoot, `vector-${crypto.randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(config));
  const gelf = lines.map(line => JSON.stringify({ ...line, "_tc.logship": "tinychat-backend" })).join("\n");
  const proc = Bun.spawn([process.env.VECTOR_BIN!, "--quiet", "--config", path], {
    env: { PATH: process.env.PATH ?? "", HOME: tmpRoot, TC_HOME: tmpRoot, VECTOR_LOG: "error" },
    stdin: new Blob([gelf + "\n"]), stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(0);
  return out.split("\n").filter(Boolean).map(text => JSON.parse(text) as Record<string, unknown>);
}

describe("TC-2537 request record", () => {
  test("a paid chat turn full of sensitive values emits only fixed metadata", async () => {
    const restore = stubUpstream(() => [
      `data: ${JSON.stringify({ choices: [{ delta: { content: CANARY.reply } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
    const turn = recorder();
    const server = await listen(createApp(turn.sink));
    try {
      const res = await sensitiveTurn(server.base);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(CANARY.reply);
      const record = await turn.record;
      // 1000/1000*2.5 + 500/1000*20 = 12.5 -> 13 credits, recorded after the stream ended.
      expect(record).toEqual({
        event: "tinychat_request", request_id: REQUEST_ID, request_id_replaced: false, method: "POST",
        route: "/api/chat", status: 200, duration_ms: expect.any(Number), stream: "done", credits: 13,
        account_hash: expectedHash,
      });
      const line = JSON.stringify(record);
      for (const value of FORBIDDEN) expect(line).not.toContain(value);
      // "finish" and "close" both end the request; it still has exactly one record.
      expect(turn.events.filter(event => event.event === "tinychat_request")).toHaveLength(1);
    } finally {
      await server.close();
      restore();
    }
  });

  test("a client that leaves mid-stream gets an aborted record with the credits charged for it", async () => {
    // Like the real upstream fetch, the stub's body fails with an AbortError once the backend aborts it.
    const restore = stubUpstream(signal => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: CANARY.reply } }] })}\n\n`));
        signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }));
    const turn = recorder();
    const server = await listen(createApp(turn.sink));
    const client = new AbortController();
    try {
      const res = await sensitiveTurn(server.base, client.signal);
      const reader = res.body!.getReader();
      await reader.read();
      client.abort();
      const record = await turn.record;
      expect(record).toMatchObject({ route: "/api/chat", status: 200, stream: "aborted", account_hash: expectedHash });
      expect(record.credits).toBeGreaterThan(0);
      const line = JSON.stringify(record);
      for (const value of FORBIDDEN) expect(line).not.toContain(value);
    } finally {
      await server.close();
      restore();
    }
  });

  test("a mount path value is never copied: the record names the template", async () => {
    const turn = recorder();
    const server = await listen(createApp(turn.sink));
    try {
      const res = await fetch(`${server.base}/api/hooks/github/${CANARY.pathToken}/ping`);
      expect(res.status).toBe(200);
      const record = await turn.record;
      expect(record.route).toBe("/api/hooks/:source/:token/ping");
      expect(record.account_hash).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain(CANARY.pathToken);
    } finally {
      await server.close();
    }
  });

  /** A response that ends while a streaming handler still owes its charge; fake timers expose the hold timer. */
  function heldStream() {
    const turn = recorder();
    const res = Object.assign(new EventEmitter(), {
      headersSent: true, statusCode: 200, setHeader: () => {}, getHeader: () => undefined,
    });
    // Synthetic Express objects: the middleware and wrapper read only the members defined here.
    const expressReq = { method: "POST", baseUrl: "", route: { path: "/stream" }, get: () => undefined } as unknown as Request;
    const expressRes = res as unknown as Response;
    createRequestContextMiddleware(turn.sink)(expressReq, expressRes, () => {});
    let settle!: () => void;
    const handled = recordAfterHandler(() => new Promise<void>(done => { settle = done; }))(expressReq, expressRes, () => {});
    res.emit("finish");
    return { turn, res, settle: () => { settle(); return handled; } };
  }

  test("a handler that settles after the response ends leaves no hold timer behind", async () => {
    vi.useFakeTimers();
    try {
      const held = heldStream();
      expect(held.turn.events).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(1);
      await held.settle();
      expect(held.turn.events).toHaveLength(1);
      // Nothing outside the response still references the request once its record is out.
      expect(vi.getTimerCount()).toBe(0);
      expect(held.res.listenerCount("finish") + held.res.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a handler that never settles still gets its record after 30 seconds, once", async () => {
    vi.useFakeTimers();
    try {
      const held = heldStream();
      vi.advanceTimersByTime(29_999);
      expect(held.turn.events).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(held.turn.events).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      await held.settle();
      expect(held.turn.events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test.skipIf(!process.env.VECTOR_BIN)("what reaches the Better Stack sink is exactly the allow-list", async () => {
    const restore = stubUpstream(() => [
      `data: ${JSON.stringify({ choices: [{ delta: { content: CANARY.reply } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""));
    const turn = recorder();
    const server = await listen(createApp(turn.sink));
    try {
      await (await sensitiveTurn(server.base)).text();
      const line = JSON.stringify(await turn.record);
      // The same line with every kind of sensitive value injected as extra keys: the allowlist must drop them.
      const injected = JSON.stringify({
        ...JSON.parse(line), body: CANARY.prompt, reply: CANARY.reply, authorization: `Bearer ${CANARY.bearer}`,
        api_key: CANARY.apiKey, cookie: CANARY.cookie, email: CANARY.email, ip: CANARY.ip, address: ADDRESS,
        correlation_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
      for (const emitted of [line, injected]) {
        const shipped = await shipThroughVector([{ message: emitted, level: 6 }]);
        expect(shipped).toHaveLength(1);
        expect(Object.keys(shipped[0]).sort()).toEqual(SHIPPED_FIELDS.filter(key => key !== "code"));
        expect(shipped[0]).toMatchObject({
          svc: "backend", event: "tinychat_request", level: "info", request_id: REQUEST_ID, method: "POST",
          route_template: "/api/chat", status: 200, stream: "done", credits: 13, account_hash: expectedHash,
        });
        const text = JSON.stringify(shipped[0]);
        for (const value of FORBIDDEN) expect(text).not.toContain(value);
      }
    } finally {
      await server.close();
      restore();
    }
  }, 120_000);

  test.skipIf(!process.env.VECTOR_BIN)("lane and calendar diagnostics reach the real sink without hostile fields", async () => {
    const shipped = await shipThroughVector([
      { message: `[storage-lane] op=slow-wait priority=background waitedMs=1500 code=CANARY account=${ADDRESS} key=PRIVATE-KEY value=PRIVATE-VALUE`, level: 3 },
      { message: "[storage-lane] op=wait-timeout priority=foreground waitedMs=12000", level: 3 },
      { message: JSON.stringify({
        event: "backend_log_error", component: "calendar-autojoin", phase: "tenant_reconcile",
        error_name: "KvResultError", code: "unavailable_retryable", status: 503,
        account: ADDRESS, key: "PRIVATE-KEY", value: "PRIVATE-VALUE", body: CANARY.prompt,
      }), level: 3 },
    ]);
    const waits = shipped.filter(row => row.event === "backend_storage_lane_wait");
    expect(waits).toHaveLength(2);
    for (const row of waits) {
      expect(Object.keys(row).sort()).toEqual(["component", "event", "level", "op", "priority", "svc", "ts", "waited_ms"]);
    }
    expect(waits.find(row => row.op === "slow-wait")).toMatchObject({ level: "warn", priority: "background", waited_ms: 1500 });
    expect(waits.find(row => row.op === "wait-timeout")).toMatchObject({ level: "error", priority: "foreground", waited_ms: 12000 });
    const calendar = shipped.find(row => row.component === "calendar-autojoin");
    expect(Object.keys(calendar!).sort()).toEqual(["code", "component", "error_name", "event", "level", "phase", "status", "svc", "ts"]);
    expect(calendar).toMatchObject({ phase: "tenant_reconcile", error_name: "KvResultError", code: "unavailable_retryable", status: 503 });
    const text = JSON.stringify(shipped);
    for (const value of [...FORBIDDEN, "PRIVATE-KEY", "PRIVATE-VALUE", "CANARY"]) expect(text).not.toContain(value);
  }, 120_000);

  test.skipIf(!process.env.VECTOR_BIN)("the real sink keeps request rate caps while passing typed diagnostics", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({
      message: JSON.stringify({
        event: "tinychat_request", request_id: crypto.randomUUID(), method: "GET",
        route: "/api/chat", status: i < 25 ? 200 : 503, duration_ms: 1,
      }),
      level: 6,
    }));
    lines.push({ message: "[storage-lane] op=slow-wait priority=background waitedMs=1500", level: 3 });
    lines.push({ message: JSON.stringify({
      event: "backend_log_error", component: "calendar-autojoin", phase: "tick",
      error_name: "BackendStorageLaneTimeout", code: "storage_lane_timeout",
    }), level: 3 });
    const shipped = await shipThroughVector(lines);
    expect(shipped.filter(row => row.event === "tinychat_request" && row.status === 200)).toHaveLength(20);
    expect(shipped.filter(row => row.event === "tinychat_request" && row.status === 503)).toHaveLength(10);
    expect(shipped.filter(row => row.event === "backend_storage_lane_wait")).toHaveLength(1);
    expect(shipped.filter(row => row.component === "calendar-autojoin")).toHaveLength(1);
  }, 120_000);
});
