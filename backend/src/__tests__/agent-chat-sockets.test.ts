import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { createConnection, createServer as createTcpServer, type Socket } from "node:net";
import { createAgentChatHandler, type AgentChatConfig } from "../routes/agent-chat.js";
import { AgentStreamError, streamAgentChat } from "../../../frontend/src/lib/agentChatApi.js";
import { streamChat } from "../../../frontend/src/lib/chatApi.js";

// These thresholds belong only to the loopback fixture, never production policy.
const HEARTBEAT_MS = 15;
const IDLE_MS = 100;
const SILENCE_MS = 320;
const encoder = new TextEncoder();
const frame = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const done = encoder.encode("data: [DONE]\n\n");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const providerUrl = "https://provider.invalid/v1/chat/completions";
const toolUrl = "https://eliza.invalid/tools/tinycloud_find_meetings";
type Phase = "model" | "tool" | "synthesis" | "repair";

function response(body: AsyncIterable<Uint8Array>) {
  return { ok: true, status: 200, body } as Response;
}

function config(fetchImpl: typeof fetch, timeoutMs = 2_000): AgentChatConfig {
  return {
    agentId: "synthetic-agent", entityIdFor: () => "synthetic-entity",
    elizaServiceUrl: "https://eliza.invalid", elizaServiceSecret: "synthetic-placeholder",
    redpillApiKey: "synthetic-placeholder", redpillBaseUrl: "https://provider.invalid/v1",
    defaultModel: () => "moonshotai/kimi-k3", isModelOffered: () => true,
    fetchImpl, maxRounds: 3,
    streamPolicy: { heartbeatMs: HEARTBEAT_MS, turnTimeoutMs: timeoutMs, drainGraceMs: 100 },
    streamRuntime: {
      now: () => performance.now(),
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      log: () => {},
    },
  } as AgentChatConfig;
}

function syntheticProvider(phase: Phase) {
  let round = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    expect([providerUrl, toolUrl]).toContain(url);
    signals.push(init?.signal);
    if (url === toolUrl) {
      if (phase === "tool") await pause(SILENCE_MS);
      return new Response(JSON.stringify({ result: { text: "Synthetic evidence [M1]", data: { citation: "[M1]" } } }));
    }
    round++;
    expect(round).toBeLessThanOrEqual(3);
    if (round === 1) {
      if (phase === "model") await pause(SILENCE_MS);
      return response({ async *[Symbol.asyncIterator]() {
        yield frame({ choices: [{ delta: { content: "Synthetic lookup started." } }] });
        if (phase !== "model") {
          yield frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "synthetic-call", function: { name: "tinycloud_find_meetings", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
        } else yield frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
        yield done;
      } });
    }
    const thisRound = round;
    return response({ async *[Symbol.asyncIterator]() {
      const pieces = phase === "repair" && thisRound === 2
        ? ["UNCHECKED_DRAFT_MUST_STAY_PRIVATE"]
        : ["Synthetic ", "cited ", "answer [M1]"];
      for (const piece of pieces) {
        if (phase === "synthesis" || (phase === "repair" && thisRound === 3)) await pause(SILENCE_MS / pieces.length);
        yield frame({ choices: [{ delta: { content: piece } }] });
      }
      yield frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
      yield frame({ usage: { prompt_tokens: 4, completion_tokens: 5 } });
      yield done;
    } });
  }) as typeof fetch;
  return { fetchImpl, signals };
}

async function listen(server: Server | ReturnType<typeof createTcpServer>) {
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function fixture(
  fetchImpl: typeof fetch, proxyMode: "idle" | "buffer" | "none", timeoutMs = 2_000,
  interceptWrite?: (chunk: string | Uint8Array, res: ServerResponse) => boolean | undefined,
) {
  const sockets = new Set<Socket>();
  const writes: { at: number; bytes: number }[] = [];
  let backpressuredWrites = 0;
  const start = performance.now();
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  let proxyClosed = false;
  let handlerError: unknown;
  const handler = createAgentChatHandler(config(fetchImpl, timeoutMs));
  const server = createServer(async (req, res) => {
    const write = res.write.bind(res);
    res.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      writes.push({ at: performance.now() - start, bytes: Buffer.byteLength(chunk) });
      const accepted = (write as (...args: unknown[]) => boolean)(chunk, ...args);
      if (!accepted) backpressuredWrites++;
      return interceptWrite?.(chunk, res) ?? accepted;
    }) as ServerResponse["write"];
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      Object.assign(req, { body: JSON.parse(Buffer.concat(chunks).toString()), user: { address: "synthetic-account" } });
      await handler(req as never, res as never, () => {});
    } catch (error) {
      handlerError = error;
      res.destroy();
    } finally { settle(); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const backendPort = await listen(server);
  const proxy = proxyMode === "none" ? undefined : createTcpServer((downstream) => {
    const upstream = createConnection({ host: "127.0.0.1", port: backendPort });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    let headers = Buffer.alloc(0);
    let headersSeen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        proxyClosed = true;
        downstream.destroy(); upstream.destroy();
      }, IDLE_MS);
    };
    downstream.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => {
      if (!headersSeen) {
        headers = Buffer.concat([headers, chunk]);
        const end = headers.indexOf("\r\n\r\n");
        if (end < 0) return;
        headersSeen = true;
        reset();
        downstream.write(headers.subarray(0, end + 4));
        chunk = headers.subarray(end + 4);
      }
      if (chunk.length && proxyMode === "idle") {
        reset();
        downstream.write(chunk);
      }
      // Buffer mode deliberately withholds body bytes to demonstrate that server
      // writes alone cannot establish client delivery. Its client-idle timer wins.
    });
    upstream.on("end", () => { clearTimeout(timer); downstream.end(); });
    upstream.on("close", () => clearTimeout(timer));
    upstream.on("error", () => { clearTimeout(timer); downstream.destroy(); });
    downstream.on("error", () => upstream.destroy());
    downstream.on("close", () => { clearTimeout(timer); upstream.destroy(); });
  });
  const port = proxy ? await listen(proxy) : backendPort;
  return {
    port, writes, settled,
    get proxyClosed() { return proxyClosed; },
    get backpressuredWrites() { return backpressuredWrites; },
    get handlerError() { return handlerError; },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (proxy) await new Promise<void>((resolve) => proxy.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function consume(port: number, stopAfterFirstChunk = false) {
  let body = "";
  let ended = false;
  let readError = false;
  const arrivals: number[] = [];
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const client = request({ host: "127.0.0.1", port, path: "/api/agent/chat", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.on("data", (chunk: Buffer) => {
        chunks.push(Buffer.from(chunk)); body += chunk.toString(); arrivals.push(performance.now());
        if (stopAfterFirstChunk) { res.destroy(); client.destroy(); }
      });
      res.on("end", () => { ended = true; });
      res.on("error", () => { readError = true; });
      res.on("close", resolve);
    });
    client.on("error", reject);
    client.setTimeout(3_000, () => client.destroy(new Error("Loopback fixture timed out")));
    client.end(JSON.stringify({ messages: [{ role: "user", content: "Summarize the synthetic fixture." }] }));
  });
  return { body, bytes: Buffer.concat(chunks), ended, readError, arrivals };
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Loopback operation failed to settle")), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

let originalPaywall: string | undefined;
beforeEach(() => { originalPaywall = process.env.PAYWALL_ENABLED; process.env.PAYWALL_ENABLED = "false"; });
afterEach(() => {
  if (originalPaywall === undefined) delete process.env.PAYWALL_ENABLED;
  else process.env.PAYWALL_ENABLED = originalPaywall;
});

describe("agent stream over real loopback sockets", () => {
  for (const phase of ["model", "tool", "synthesis", "repair"] as const) {
    test(`comments keep ${phase} silence alive across repeated proxy idle periods`, async () => {
      const provider = syntheticProvider(phase);
      const run = await fixture(provider.fetchImpl, "idle");
      try {
        const received = await consume(run.port);
        await run.settled;
        expect(run.handlerError).toBeUndefined();
        expect(run.proxyClosed).toBe(false);
        expect(received.body.startsWith(": keepalive\n\n")).toBe(true);
        expect(received.body.match(/: keepalive\n\n/g)!.length).toBeGreaterThan(4);
        expect(received.body.match(/data: \[DONE\]/g)).toHaveLength(1);
        expect(received.ended).toBe(true);
        expect(received.readError).toBe(false);
        expect(provider.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
        expect(received.body).not.toContain("UNCHECKED_DRAFT_MUST_STAY_PRIVATE");
        if (phase !== "model") expect(received.body).toContain("answer [M1]");
      } finally { await run.close(); }
    });
  }

  test("buffering proxy can lose the client despite regular backend writes", async () => {
    const run = await fixture(syntheticProvider("model").fetchImpl, "buffer");
    try {
      const received = await consume(run.port);
      await run.settled;
      expect(run.proxyClosed).toBe(true);
      expect(run.writes.length).toBeGreaterThan(4);
      expect(received.body).toBe("");
      expect(received.ended).toBe(false);
      expect(received.readError).toBe(true);
    } finally { await run.close(); }
  });

  test("a permanent provider stall is aborted by the deadline while comments arrive", async () => {
    let aborted = false;
    const fetchImpl = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(init.signal!.reason); }, { once: true });
    })) as typeof fetch;
    const run = await fixture(fetchImpl, "idle", 240);
    try {
      const received = await consume(run.port);
      await run.settled;
      expect(aborted).toBe(true);
      expect(run.proxyClosed).toBe(false);
      expect(received.body).toContain('"stream_error":{"code":"turn_timeout"}');
      expect(received.body.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(received.ended).toBe(true);
    } finally { await run.close(); }
  }, 4_000);

  test("client Stop aborts provider work and settles without terminal writes", async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = ((_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    }) as typeof fetch;
    const run = await fixture(fetchImpl, "none", 1_500);
    try {
      const received = await consume(run.port, true);
      await within(run.settled, 500);
      expect(signal?.aborted).toBe(true);
      expect(received.body).not.toContain("[DONE]");
      const settledWrites = run.writes.length;
      await pause(50);
      expect(run.writes.length).toBe(settledWrites);
      expect(run.handlerError).toBeUndefined();
    } finally { await run.close(); }
  }, 3_000);

  test("deadline cancels an active provider body read", async () => {
    let providerAborted = false;
    let cancelled = false;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame({ choices: [{ delta: { content: "Partial synthetic answer." } }] }));
          init?.signal?.addEventListener("abort", () => { providerAborted = true; controller.error(init.signal!.reason); }, { once: true });
        },
        cancel() { cancelled = true; },
      });
      return new Response(body);
    }) as typeof fetch;
    const run = await fixture(fetchImpl, "idle", 240);
    try {
      const received = await consume(run.port);
      await within(run.settled, 500);
      expect(providerAborted || cancelled).toBe(true);
      expect(received.body).toContain("Partial synthetic answer.");
      expect(received.body).toContain('"stream_error":{"code":"turn_timeout"}');
      expect(received.ended).toBe(true);
      expect(run.proxyClosed).toBe(false);
    } finally { await run.close(); }
  });

  for (const stall of ["provider_headers", "provider_body", "tool_json"] as const) {
    test(`deadline aborts native fetch at ${stall} over an actual upstream socket`, async () => {
      const nativeFetch = globalThis.fetch;
      let upstreamRequests = 0;
      let noteFetchRejected!: () => void;
      const nativeFetchRejected = new Promise<void>((resolve) => { noteFetchRejected = resolve; });
      let observedSignal: AbortSignal | null | undefined;
      const upstreamSockets = new Set<Socket>();
      const upstream = createServer(async (req, res) => {
        upstreamRequests++;
        for await (const _ of req) { /* consume request before testing response silence */ }
        if (stall === "provider_headers") return;
        if (stall === "tool_json" && req.url === "/provider") {
          res.setHeader("Content-Type", "text/event-stream");
          res.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "synthetic-call", function: { name: "tinycloud_find_meetings", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
          res.end(done);
          return;
        }
        res.setHeader("Content-Type", stall === "tool_json" ? "application/json" : "text/event-stream");
        res.flushHeaders();
        res.write(stall === "tool_json" ? '{"result":' : frame({ choices: [{ delta: { content: "Partial native response." } }] }));
        // Keep the native response open until its caller aborts or fixture cleanup.
      });
      upstream.on("connection", (socket) => { upstreamSockets.add(socket); socket.on("close", () => upstreamSockets.delete(socket)); });
      const upstreamPort = await listen(upstream);
      const fetchImpl = (async (input: unknown, init?: RequestInit) => {
        expect([providerUrl, toolUrl]).toContain(String(input));
        observedSignal = init?.signal;
        const localPath = String(input) === toolUrl ? "/tool" : "/provider";
        try { return await nativeFetch(`http://127.0.0.1:${upstreamPort}${localPath}`, init); }
        catch (error) { noteFetchRejected(); throw error; }
      }) as typeof fetch;
      const run = await fixture(fetchImpl, "idle", 240);
      try {
        const received = await consume(run.port);
        await within(run.settled, 500);
        expect(observedSignal?.aborted).toBe(true);
        if (stall === "provider_headers") await within(nativeFetchRejected, 500);
        expect(upstreamRequests).toBe(stall === "tool_json" ? 2 : 1);
        expect(received.body).toContain('"stream_error":{"code":"turn_timeout"}');
        expect(received.body.match(/data: \[DONE\]/g)).toHaveLength(1);
        expect(received.ended).toBe(true);
        expect(run.handlerError).toBeUndefined();
      } finally {
        await run.close();
        for (const socket of upstreamSockets) socket.destroy();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    });
  }

  test("both client versions decode the actual partial-frame timeout bytes", async () => {
    // Put a multibyte scalar across the first 16KiB transport slice, inside an
    // intentionally abandoned JSON event. Earlier complete text must survive.
    const prefixBytes = encoder.encode('data: {"choices":[{"delta":{"content":"').length;
    const largeAnswer = "x".repeat(16_384 - prefixBytes - 1) + "🙂" + "y".repeat(20_000);
    const fetchImpl = (async () => response({ async *[Symbol.asyncIterator]() {
      yield frame({ choices: [{ delta: { content: "Earlier answer." } }] });
      yield frame({ choices: [{ delta: { content: largeAnswer } }] });
      yield done;
    } })) as typeof fetch;
    let stalled = false;
    const run = await fixture(fetchImpl, "none", 90, (chunk, res) => {
      if (!stalled && Buffer.byteLength(chunk) === 16_384) {
        stalled = true;
        setTimeout(() => res.emit("drain"), 120);
        return false;
      }
      return undefined;
    });
    const nativeFetch = globalThis.fetch;
    try {
      const received = await consume(run.port);
      await within(run.settled, 500);
      expect(stalled).toBe(true);
      expect(received.ended).toBe(true);
      expect(received.body.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(received.body).toContain('\n\ndata: {"stream_error":{"code":"turn_timeout"}');
      globalThis.fetch = (async () => new Response(received.bytes)) as typeof fetch;
      const modern: string[] = [];
      let failure: unknown;
      try {
        for await (const text of streamAgentChat({ backendUrl: "https://synthetic.invalid", getToken: () => "synthetic", messages: [] })) modern.push(text);
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AgentStreamError);
      expect((failure as AgentStreamError).code).toBe("turn_timeout");
      expect(modern).toEqual(["Earlier answer."]);
      const legacy: string[] = [];
      for await (const text of streamChat({
        backendUrl: "https://synthetic.invalid", model: "synthetic", messages: [],
        sessionStore: { getToken: () => "synthetic", isExpired: () => false } as Parameters<typeof streamChat>[0]["sessionStore"],
      })) legacy.push(text);
      expect(legacy.at(-1)).toBe("Earlier answer.\n\nThis reply was interrupted before it finished. Please try again.");
      expect(legacy).toHaveLength(2);
    } finally { globalThis.fetch = nativeFetch; await run.close(); }
  });

  test("a nonreading socket bounds writes of a large citation-validated answer", async () => {
    let calls = 0;
    const largeAnswer = "Synthetic cited answer [M1]. " + "x".repeat(8 * 1024 * 1024);
    const fetchImpl = (async (input: unknown) => {
      expect([providerUrl, toolUrl]).toContain(String(input));
      if (String(input) === toolUrl) return new Response(JSON.stringify({ result: { text: "Evidence [M1]" } }));
      calls++;
      if (calls === 1) return response({ async *[Symbol.asyncIterator]() {
        yield frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "synthetic", function: { name: "tinycloud_find_meetings", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
        yield done;
      } });
      return response({ async *[Symbol.asyncIterator]() {
        yield frame({ choices: [{ delta: { content: largeAnswer } }] });
        yield frame({ choices: [{ delta: {}, finish_reason: "stop" }] });
        yield done;
      } });
    }) as typeof fetch;
    const run = await fixture(fetchImpl, "none", 300);
    const client = createConnection({ host: "127.0.0.1", port: run.port });
    client.on("error", () => { /* expected when the bounded response is destroyed */ });
    client.pause();
    try {
      await new Promise<void>((resolve) => client.on("connect", resolve));
      const body = JSON.stringify({ messages: [{ role: "user", content: "Synthetic question." }] });
      client.write(`POST /api/agent/chat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      await within(run.settled, 2_000);
      expect(run.backpressuredWrites).toBeGreaterThan(0);
      expect(run.writes.every((write) => write.bytes <= 16_384)).toBe(true);
      expect(run.writes.reduce((total, write) => total + write.bytes, 0)).toBeLessThan(largeAnswer.length);
      expect(calls).toBe(2);
      expect(run.handlerError).toBeUndefined();
      const writeCount = run.writes.length;
      await pause(50);
      expect(run.writes.length).toBe(writeCount);
    } finally { client.destroy(); await run.close(); }
  });
});
