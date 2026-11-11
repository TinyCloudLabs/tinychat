import { describe, expect, it } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { botsFromEnv, createBotsRouter } from "../routes/bots.js";

const key = `0x${"03".repeat(32)}`;
const enabled = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const other = "0x2222222222222222222222222222222222222222";
const secret = "bots-test-secret-not-real";

type Upstream = (init: RequestInit) => Response | Promise<Response>;

async function setup(upstream: Upstream, postTimeoutMs = 120_000) {
  const seen: { url: string; headers: Headers; signal?: AbortSignal | null }[] = [];
  const fetchImpl = (async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), signal: init?.signal });
    return upstream(init ?? {});
  }) as typeof fetch;
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: enabled, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: secret })!;
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  app.use("/api/bots", createBotsRouter({ config: { ...config, postTimeoutMs, fetchImpl }, authMiddleware: createAuthMiddleware(key) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots`;
  const headersFor = async (address: string) => ({ "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(address, key)).token}` });
  return { seen, base, headersFor, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });

describe("bots routes", () => {
  it("is off unless every setting is present", () => {
    expect(botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: "*", BOTS_SERVICE_URL: "http://bots.test" })).toBeUndefined();
    expect(botsFromEnv({ BOTS_ENABLED: "1", BOTS_TEST_ACCOUNTS: "*", BOTS_SERVICE_URL: "http://bots.test", BOTS_SERVICE_SECRET: secret })).toBeUndefined();
  });

  it("returns 404 for accounts not listed and 200 for listed ones", async () => {
    const run = await setup(() => Response.json({ messages: [] }));
    try {
      const off = await run.headersFor(other);
      expect(await (await fetch(`${run.base}/status`, { headers: off })).json()).toEqual({ enabled: false });
      expect((await fetch(`${run.base}/main/messages`, { headers: off })).status).toBe(404);
      expect((await fetch(`${run.base}/main/messages`, { method: "POST", headers: off, body: JSON.stringify({ text: "hi" }) })).status).toBe(404);
      expect(run.seen).toHaveLength(0);

      const on = await run.headersFor(enabled);
      expect(await (await fetch(`${run.base}/status`, { headers: on })).json()).toEqual({ enabled: true });
      const list = await fetch(`${run.base}/main/messages`, { headers: on });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ messages: [] });
      expect((await fetch(`${run.base}/status`)).status).toBe(401);
    } finally { await run.close(); }
  });

  it("sends the session owner DID and the secret upstream, ignoring forged owners, and never returns the secret", async () => {
    const stream = 'event: status\ndata: {"state":"working"}\n\nevent: delta\ndata: {"text":"pong"}\n\nevent: done\ndata: {"messageId":"m1"}\n\n';
    const run = await setup(() => sse(stream));
    try {
      const headers = { ...(await run.headersFor(enabled)), "x-tinycloud-owner": `did:pkh:eip155:1:${other}` };
      const response = await fetch(`${run.base}/main/messages`, { method: "POST", headers, body: JSON.stringify({ text: "ping", owner: other, ownerDid: `did:pkh:eip155:1:${other}` }) });
      const body = await response.text();
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(body).toBe(stream);
      expect(body).not.toContain(secret);
      expect([...response.headers.values()].join(" ")).not.toContain(secret);
      expect(run.seen[0]!.url).toBe("http://bots.test/v1/bots/main/messages");
      expect(run.seen[0]!.headers.get("x-tinycloud-owner")).toBe(`did:pkh:eip155:1:${enabled.toLowerCase()}`);
      expect(run.seen[0]!.headers.get("authorization")).toBe(`Bearer ${secret}`);
    } finally { await run.close(); }
  });

  it("rejects empty and oversized text before forwarding", async () => {
    const run = await setup(() => sse(""));
    try {
      const headers = await run.headersFor(enabled);
      for (const text of ["", "x".repeat(8001)]) {
        expect((await fetch(`${run.base}/main/messages`, { method: "POST", headers, body: JSON.stringify({ text }) })).status).toBe(400);
      }
      expect(run.seen).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("maps upstream failure to a single bot_unavailable error event", async () => {
    for (const upstream of [() => { throw new Error("connect ECONNREFUSED"); }, () => new Response("provider says no", { status: 500 })] as Upstream[]) {
      const run = await setup(upstream);
      try {
        const response = await fetch(`${run.base}/main/messages`, { method: "POST", headers: await run.headersFor(enabled), body: JSON.stringify({ text: "ping" }) });
        const body = await response.text();
        expect(body.match(/event: error/g)).toHaveLength(1);
        expect(body).toContain('"code":"bot_unavailable"');
        expect(body).not.toContain("provider says no");
        expect(body).not.toContain("ECONNREFUSED");
      } finally { await run.close(); }
    }
  });

  it("aborts a stalled upstream at the overall timeout and reports bot_unavailable once", async () => {
    const { promise: upstreamAborted, resolve: aborted } = Promise.withResolvers<void>();
    const run = await setup(init => {
      init.signal?.addEventListener("abort", () => aborted());
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: status\ndata: {"state":"working"}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
    }, 50);
    try {
      const response = await fetch(`${run.base}/main/messages`, { method: "POST", headers: await run.headersFor(enabled), body: JSON.stringify({ text: "ping" }) });
      const body = await response.text();
      await upstreamAborted;
      expect(body.startsWith("event: status")).toBe(true);
      expect(body.match(/event: error/g)).toHaveLength(1);
      expect(body).toContain('"code":"bot_unavailable"');
    } finally { await run.close(); }
  });

  it("aborts the upstream fetch when the client disconnects", async () => {
    const { promise: upstreamAborted, resolve: aborted } = Promise.withResolvers<void>();
    const run = await setup(init => {
      init.signal?.addEventListener("abort", () => aborted());
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: status\ndata: {"state":"starting"}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
    });
    try {
      const client = new AbortController();
      const response = await fetch(`${run.base}/main/messages`, { method: "POST", headers: await run.headersFor(enabled), body: JSON.stringify({ text: "ping" }), signal: client.signal });
      const reader = response.body!.getReader();
      await reader.read();
      client.abort();
      await upstreamAborted;
      expect(run.seen[0]!.signal?.aborted).toBe(true);
    } finally { await run.close(); }
  });
});
