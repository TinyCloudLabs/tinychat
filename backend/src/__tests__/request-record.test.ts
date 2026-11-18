import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { setSystemTime } from "bun:test";
import { EventEmitter } from "node:events";
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
import { noteRequestRecord, requestLogAccountHash, requestLogCreditsBucket } from "../request-context.js";
import { REQUEST_LOG_ROUTE_TEMPLATES } from "../request-log-routes.js";

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

// TC-3031: account_hash depends on the UTC month the record is emitted in, so every test runs at a fixed instant.
beforeEach(() => setSystemTime(new Date("2026-11-14T12:00:00.000Z")));
afterEach(() => setSystemTime());

function stubUpstream(body: (signal?: AbortSignal) => ReadableStream<Uint8Array> | string): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("tee.redpill.ai") && url.endsWith("/models")) {
      return Response.json({ data: [{ id: "z-ai/glm-5.2", pricing: { prompt: "0.00000025", completion: "0.000002" } }] });
    }
    if (url.includes("tee.redpill.ai") && url.endsWith("/chat/completions")) {
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
  app.use("/api/chat", auth, createChatRouter({ redpillFetch: (input, init) => globalThis.fetch(input, init) }));
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

const expectedHash = "370d57055617fdb38bcf25e9d5257c2cf1549b1048b14ff6aa2af2e244cdddf8";

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
        route: "/api/chat", status: 200, duration_ms: expect.any(Number), stream: "done", credits: "10-99",
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
      expect(["1-9", "10-99", "100-999", "1000+"]).toContain(record.credits);
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
          route_template: "/api/chat", status: 200, stream: "done", credits: "10-99", account_hash: expectedHash,
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

  test.skipIf(!process.env.VECTOR_BIN)("native diagnostic floods are capped while one summary retains every outcome count", async () => {
    const phases = ["tick", "tenant_reconcile", "due_timer", "dispatch_lag_status"];
    const lines = Array.from({ length: 1000 }, (_, i) => [
      { message: `[storage-lane] op=${i % 2 ? "wait-timeout" : "slow-wait"} priority=background waitedMs=1500`, level: 3 },
      { message: JSON.stringify({
        event: "backend_log_error", component: "calendar-autojoin", phase: phases[i % phases.length],
        error_name: "BackendStorageLaneTimeout", code: "storage_lane_timeout",
      }), level: 3 },
      { message: "[unmatched-probe] code=synthetic_failure", level: 3 },
    ]).flat();
    const shipped = await shipThroughVector(lines);
    expect(shipped.filter(row => row.event === "backend_storage_lane_wait")).toHaveLength(10);
    expect(shipped.filter(row => row.component === "calendar-autojoin")).toHaveLength(10);
    expect(shipped.filter(row => row.component === "unmatched-probe")).toHaveLength(10);
    const summaries = shipped.filter(row => row.event === "backend_diagnostic_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      slow_wait_count: 500, wait_timeout_count: 500,
      calendar_tick_count: 250, calendar_tenant_reconcile_count: 250,
      calendar_due_timer_count: 250, calendar_dispatch_lag_status_count: 250,
      other_count: 1000, counts_saturated: false,
    });
    expect(Object.keys(summaries[0]).sort()).toEqual([
      "calendar_dispatch_lag_status_count", "calendar_due_timer_count", "calendar_tenant_reconcile_count",
      "calendar_tick_count", "counts_saturated", "event", "level", "other_count",
      "slow_wait_count", "svc", "ts", "wait_timeout_count",
    ]);
  }, 120_000);

  test.skipIf(!process.env.VECTOR_BIN)("maximum-width sink records fit the conservative monthly byte envelope", async () => {
    const shipped = await shipThroughVector([
      { message: JSON.stringify({
        event: "tinychat_request", request_id: REQUEST_ID, method: "CONNECT",
        route: `/${"a".repeat(63)}`, status: 599, duration_ms: 86399999.9,
        stream: "aborted", code: "a".repeat(60), credits: "1000+", account_hash: "a".repeat(64),
      }), level: 6 },
      { message: "[storage-lane] op=wait-timeout priority=foreground waitedMs=3600000", level: 3 },
      { message: JSON.stringify({
        event: "backend_log_error", component: "calendar-autojoin", phase: "dispatch_lag_status",
        error_name: "BackendStorageLaneTimeout", code: "calendar_invalid_response", status: 599,
      }), level: 3 },
      { message: `[${"a.".repeat(20)}] route=${"a".repeat(40)} status=599 upstream_status=599 code=${"a".repeat(60)} reason=${"a".repeat(40)} cid=${REQUEST_ID} alert=true`, level: 3 },
    ]);
    for (const [event, bound] of [
      ["tinychat_request", 576], ["backend_storage_lane_wait", 224],
      ["backend_log_error", 320], ["backend_alert", 512], ["backend_diagnostic_summary", 512],
    ] as const) {
      const row = shipped.find(record => record.event === event);
      expect(row).toBeDefined();
      // Two bytes reserve JSON-array delimiters/newline framing beyond the encoded record.
      expect(Buffer.byteLength(JSON.stringify(row)) + 2).toBeLessThanOrEqual(bound);
    }
  }, 120_000);

  test.skipIf(!process.env.VECTOR_BIN)("the longest listed route template and credits bucket fit the request envelope", async () => {
    const longest = REQUEST_LOG_ROUTE_TEMPLATES.reduce((a, b) => (b.length > a.length ? b : a));
    const shipped = await shipThroughVector([{ message: JSON.stringify({
      event: "tinychat_request", request_id: REQUEST_ID, method: "CONNECT", route: longest, status: 599,
      duration_ms: 86399999.9, stream: "aborted", code: "a".repeat(60), credits: "100-999", account_hash: "a".repeat(64),
    }), level: 6 }]);
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toMatchObject({ route_template: longest, credits: "100-999" });
    expect(Buffer.byteLength(JSON.stringify(shipped[0])) + 2).toBeLessThanOrEqual(576);
  }, 120_000);
});

describe("TC-3031 monthly account hash and credit buckets", () => {
  // Literal vectors, computed once with openssl, not with this code:
  // hex(HMAC-SHA256(HMAC_KEY, "account\0" + UTC "YYYY-MM" + "\0" + lowercase ADDRESS)).
  const NOVEMBER = expectedHash;
  const DECEMBER = "61a5e61c20025dbdb1aca1e23b2602eb188f45b6ded250a23ce93b517b68db86";

  test("the hash changes at the UTC month boundary and holds within a month", () => {
    expect(requestLogAccountHash(ADDRESS, new Date("2026-11-30T23:59:59.000Z"))).toBe(NOVEMBER);
    expect(requestLogAccountHash(ADDRESS, new Date("2026-12-01T00:00:00.000Z"))).toBe(DECEMBER);
    expect(requestLogAccountHash(ADDRESS, new Date("2026-11-01T00:00:00.000Z"))).toBe(NOVEMBER);
    expect(requestLogAccountHash(ADDRESS.toLowerCase(), new Date("2026-11-14T12:00:00.000Z"))).toBe(NOVEMBER);
    // The month is UTC: 00:30 on 1 December at UTC+1 is still November.
    expect(requestLogAccountHash(ADDRESS, new Date("2026-12-01T00:30:00.000+01:00"))).toBe(NOVEMBER);
  });

  /** An app whose one route authenticates ADDRESS and charges each credit amount in `?charge=`. */
  function chargingApp(sink: (event: RequestEvent) => void) {
    const app = express();
    app.use(createRequestContextMiddleware(sink));
    app.get("/charge", (req, res) => {
      req.user = { address: ADDRESS };
      for (const credits of String(req.query.charge ?? "").split(",").filter(Boolean)) {
        noteRequestRecord(res, { credits: Number(credits) });
      }
      res.json({ ok: true });
    });
    return app;
  }

  test("a record takes its month from when it is emitted", async () => {
    setSystemTime(new Date("2026-12-01T00:00:00.000Z"));
    const turn = recorder();
    const server = await listen(chargingApp(turn.sink));
    try {
      expect((await fetch(`${server.base}/charge`)).status).toBe(200);
      expect((await turn.record).account_hash).toBe(DECEMBER);
    } finally {
      await server.close();
    }
  });

  test("each credits bucket edge lands on its side", () => {
    const edges = [[0, "0"], [1, "1-9"], [9, "1-9"], [10, "10-99"], [99, "10-99"], [100, "100-999"], [999, "100-999"], [1000, "1000+"]] as const;
    expect(edges.map(([credits]) => requestLogCreditsBucket(credits))).toEqual(edges.map(([, bucket]) => bucket));
  });

  test("a value that is not a count of credits ships as \"0\"", () => {
    expect([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5].map(requestLogCreditsBucket))
      .toEqual(["0", "0", "0", "0", "0"]);
  });

  test("the record sums every charge, then ships only its bucket", async () => {
    const turn = recorder();
    const server = await listen(chargingApp(turn.sink));
    try {
      expect((await fetch(`${server.base}/charge?charge=5,4,1`)).status).toBe(200);
      expect((await turn.record).credits).toBe("10-99");
    } finally {
      await server.close();
    }
  });
});
