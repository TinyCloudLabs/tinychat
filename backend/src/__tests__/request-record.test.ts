import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
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

/** Run the emitted stdout line through the real Vector pipeline (redact -> allowlist -> caps) and return what reaches the sink. */
async function shipThroughVector(line: string): Promise<Record<string, unknown>[]> {
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
  const gelf = JSON.stringify({ message: line, level: 6, "_tc.logship": "tinychat-backend" });
  const proc = Bun.spawn([process.env.VECTOR_BIN!, "--quiet", "--config", path], {
    env: { PATH: process.env.PATH ?? "", HOME: tmpRoot, VECTOR_LOG: "error" },
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
        const shipped = await shipThroughVector(emitted);
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
});
