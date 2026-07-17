import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage } from "../billing/usage.js";
import { createChatRouter } from "../routes/chat.js";

const ORIGINAL_ENV = { ...process.env };
const OFFERED_MODEL = "deepseek/deepseek-v3.2";

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: "0xabc" };
  next();
}

/** Build the chat app with a configurable JSON body limit (mirrors index.ts). */
function createApp(jsonLimit = "1mb") {
  const app = express();
  app.use(express.json({ limit: jsonLimit }));
  app.use("/api/chat", authStub, createChatRouter());
  return app;
}

async function request(app: express.Express, path: string, init?: RequestInit) {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

/**
 * Stub RedPill /chat/completions with a caller-supplied status + body (used to
 * exercise the upstream-error branch). Localhost requests pass through so the
 * in-process express server the test spins up still works.
 */
function stubChatUpstream(opts: {
  status: number;
  body: string;
  contentType?: string;
}): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.redpill.ai") && url.endsWith("/chat/completions")) {
      return new Response(opts.body, {
        status: opts.status,
        headers: { "content-type": opts.contentType ?? "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/** Stub RedPill /chat/completions with a successful SSE stream. */
function stubChatSse(sseChunks: string[]): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.redpill.ai") && url.endsWith("/chat/completions")) {
      return new Response(sseChunks.join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function post(app: express.Express, body: string) {
  return request(app, "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  process.env.REDPILL_API_KEY = "sk-rp-test";
  delete process.env.PAYWALL_ENABLED; // paywall off → offered model streams straight through
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

describe("POST /api/chat upstream context-overflow classification (§C.12)", () => {
  test("upstream_context_error_maps_to_413_context_overflow", async () => {
    // A 400 whose body reads like a context-length failure → typed 413.
    const upstreamBody = JSON.stringify({
      error: { message: "This model's maximum context length is 64000 tokens." },
    });
    const restore = stubChatUpstream({ status: 400, body: upstreamBody });
    try {
      const res = await post(
        createApp(),
        JSON.stringify({ model: OFFERED_MODEL, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(413);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("context_overflow");
      // The upstream detail is surfaced verbatim as the message.
      expect(body.error.message).toBe(upstreamBody);
    } finally {
      restore();
    }
  });

  test("a 413 upstream with a token-limit body is also classified as context_overflow", async () => {
    const upstreamBody = JSON.stringify({ error: "tokens exceed limit for this request" });
    const restore = stubChatUpstream({ status: 413, body: upstreamBody });
    try {
      const res = await post(
        createApp(),
        JSON.stringify({ model: OFFERED_MODEL, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(413);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("context_overflow");
      expect(body.error.message).toBe(upstreamBody);
    } finally {
      restore();
    }
  });

  test("upstream_non_context_error_still_502_passthrough", async () => {
    // A non-context upstream error keeps the baseline 502 passthrough shape (§F.11).
    const upstreamBody = JSON.stringify({
      error: "upstream_boom",
      message: "internal server error",
    });
    const restore = stubChatUpstream({ status: 500, body: upstreamBody });
    try {
      const res = await post(
        createApp(),
        JSON.stringify({ model: OFFERED_MODEL, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(502);
      const body = (await res.json()) as any;
      // Baseline passthrough: the upstream JSON is echoed verbatim, NOT wrapped
      // in the { error: { code: "context_overflow" } } shape.
      expect(body.error).toBe("upstream_boom");
      expect(body.message).toBe("internal server error");
    } finally {
      restore();
    }
  });

  test("a context-shaped body on a NON-4xx status still passes through as 502", async () => {
    // Only 400/413 are reclassified; a 500 mentioning "context" is still a 502.
    const upstreamBody = JSON.stringify({ error: "maximum context length reached" });
    const restore = stubChatUpstream({ status: 500, body: upstreamBody });
    try {
      const res = await post(
        createApp(),
        JSON.stringify({ model: OFFERED_MODEL, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(502);
    } finally {
      restore();
    }
  });
});

describe("global body limit raised 64kb → 1mb (Wall A, §C.4a)", () => {
  test("chat_body_over_64kb_reaches_handler", async () => {
    // A ~100 KB body (>64 KB, <1 MB) must reach the handler under the 1 MB limit
    // that index.ts now configures — i.e. NOT rejected by the body parser.
    const bigContent = "a".repeat(100_000);
    const body = JSON.stringify({
      model: OFFERED_MODEL,
      messages: [{ role: "user", content: bigContent }],
    });
    expect(body.length).toBeGreaterThan(64 * 1024);
    expect(body.length).toBeLessThan(1024 * 1024);

    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubChatSse(sse);
    try {
      // Raised (1 MB) limit → the oversize body reaches the handler and streams 200.
      const res = await post(createApp("1mb"), body);
      expect(res.status).toBe(200);
      await res.text();

      // Control: the OLD 64 KB limit would have rejected the same body at the
      // parser (413 PayloadTooLargeError), proving the raise is load-bearing.
      const rejected = await post(createApp("64kb"), body);
      expect(rejected.status).toBe(413);
    } finally {
      restore();
    }
  });

  test("index.ts configures the global JSON parser at the 1mb limit", () => {
    // Direct regression on the real source: the global parser must be raised.
    const source = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
    expect(source).toContain('express.json({ limit: "1mb" })');
    expect(source).not.toContain('express.json({ limit: "64kb" })');
  });
});
