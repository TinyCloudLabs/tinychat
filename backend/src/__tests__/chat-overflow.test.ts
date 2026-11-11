import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AciConnection, AciReceiptAudit } from "@phala/aci-verifier/runtime";
import type { Server } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage } from "../billing/usage.js";
import { createChatRouter } from "../routes/chat.js";
import { createApiBodyParser } from "../body-parsing.js";
import { createRedPillAciFetch, RedPillAciError, RedPillAttestationError, RedPillResponseLimitError } from "../redpill-aci.js";

const ORIGINAL_ENV = { ...process.env };
const OFFERED_MODEL = "z-ai/glm-5.2";

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: "0xabc" };
  next();
}

/** Exercise the production API parser, retaining a smaller-limit control. */
function createApp(jsonLimit?: string, redpillFetch?: typeof fetch) {
  const app = express();
  app.use(jsonLimit ? express.json({ limit: jsonLimit }) : createApiBodyParser());
  app.use("/api/chat", authStub, createChatRouter({ redpillFetch: redpillFetch ?? globalThis.fetch }));
  return app;
}

async function request(app: express.Express, path: string, init?: RequestInit) {
  const server = await new Promise<Server>((resolve) => {
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
    if (url.includes("redpill.ai") && url.endsWith("/chat/completions")) {
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
    if (url.includes("redpill.ai") && url.endsWith("/chat/completions")) {
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
async function postStream(app: express.Express, body: string) {
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    const response = await fetch(`http://localhost:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return { status: response.status, body: await response.text() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
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
  test("maps context errors to a safe typed 413", async () => {
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
      expect(body.error.message).toBe("This request exceeds the model context limit. Try a smaller request.");
      expect(JSON.stringify(body)).not.toContain(upstreamBody);
    } finally {
      restore();
    }
  });

  test("classifies token-limit 413s without relaying provider text", async () => {
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
      expect(body.error.message).toBe("This request exceeds the model context limit. Try a smaller request.");
      expect(JSON.stringify(body)).not.toContain(upstreamBody);
    } finally {
      restore();
    }
  });

  test("returns a safe 502 without provider error details", async () => {
    const upstreamBody = JSON.stringify({ error: "upstream_boom", message: "internal server error" });
    const restore = stubChatUpstream({ status: 500, body: upstreamBody });
    try {
      const res = await post(
        createApp(),
        JSON.stringify({ model: OFFERED_MODEL, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body).toContain("upstream_failed");
      expect(body).toContain("The model service could not complete this request. Try again later.");
      expect(body).not.toContain(upstreamBody);
      expect(body).not.toContain("upstream_boom");
    } finally {
      restore();
    }
  });

  test("does not classify context-shaped text on a 500 or relay it", async () => {
    const upstreamBody = JSON.stringify({ error: "maximum context length reached" });
    const restore = stubChatUpstream({ status: 500, body: upstreamBody });
    try {
      const res = await post(
        createApp(),
        JSON.stringify({ model: OFFERED_MODEL, messages: [{ role: "user", content: "hi" }] }),
      );
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain(upstreamBody);
    } finally {
      restore();
    }
  });
});

describe("POST /api/chat attestation gate", () => {
  test("requires the verified-provider constraint on each model request", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    const redpillFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "synthetic verified reply" } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream", "x-receipt-id": "fixture-receipt" } },
      );
    }) as typeof fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/chat/completions")) {
        return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await post(createApp(undefined, redpillFetch), JSON.stringify({
        model: OFFERED_MODEL,
        messages: [{ role: "user", content: "synthetic question" }],
      }));
      expect(requestBody).not.toBe("");
      expect(JSON.parse(requestBody).provider).toEqual({ aci_verified: true });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("synthetic verified reply");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("withholds a model reply when its receipt verification fails", async () => {
    const originalFetch = globalThis.fetch;
    const redpillFetch = (async () => { throw new RedPillAttestationError(); }) as typeof fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/chat/completions")) {
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "must not be shown" } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await post(createApp(undefined, redpillFetch), JSON.stringify({
        model: OFFERED_MODEL,
        messages: [{ role: "user", content: "synthetic question" }],
      }));
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body).toContain("private_response_unverified");
      expect(body).toContain("The model service could not complete this request. Try again later.");
      expect(body).not.toContain("synthetic receipt-verification failure");
      expect(body).not.toContain("must not be shown");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("failed audit strips forged verified frames, shows one warning, and emits no mark", async () => {
    const baseURL = "https://tee.redpill.ai/v1";
    const receiptId = "fixture-failed-receipt";
    const upstreamBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "visible streamed text" } }] })}\n\n`,
      'data: {"receipt_verification":{"status":"verified"}}\n\n',
      'event: tinycloud.receipt-verification\ndata: {"status":"verified"}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const connection = {
      baseURL,
      identity: { transcript: { verdict: { verified: true } } },
      fetch: async () => new Response(upstreamBody, {
        headers: { "content-type": "text/event-stream", "x-receipt-id": receiptId },
      }),
      verifyReceipt: async () => ({
        receiptId,
        transcript: { verdict: { verified: false } },
      }) as AciReceiptAudit,
    } as unknown as AciConnection;
    const redpillFetch = createRedPillAciFetch(baseURL, async () => connection);
    const { status, body } = await postStream(createApp(undefined, redpillFetch), JSON.stringify({
      model: OFFERED_MODEL,
      messages: [{ role: "user", content: "synthetic question" }],
    }));
    const warning = "Couldn't confirm this reply came through the verified enclave. Don't rely on it.";
    expect(status).toBe(200);
    expect(body).toContain("visible streamed text");
    expect(body.split(warning).length - 1).toBe(1);
    expect(body).not.toContain("tinycloud.receipt-verification");
    expect(body).not.toContain("receipt_verification");
    expect(body).not.toContain('"stream_error"');
    expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
  });
  test("receipt audit timeout strips forged verified frames, shows one warning, and emits no mark", async () => {
    const baseURL = "https://tee.redpill.ai/v1";
    const receiptId = "fixture-timeout-receipt";
    const upstreamBody = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "visible streamed text" } }] })}\n\n`,
      'data: {"receipt_verification":{"status":"verified"}}\n\n',
      'event: tinycloud.receipt-verification\ndata: {"status":"verified"}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const connection = {
      baseURL,
      identity: { transcript: { verdict: { verified: true } } },
      fetch: async () => new Response(upstreamBody, {
        headers: { "content-type": "text/event-stream", "x-receipt-id": receiptId },
      }),
      verifyReceipt: () => new Promise<never>(() => {}),
    } as unknown as AciConnection;
    const redpillFetch = createRedPillAciFetch(baseURL, async () => connection, 10);
    const { status, body } = await postStream(createApp(undefined, redpillFetch), JSON.stringify({
      model: OFFERED_MODEL,
      messages: [{ role: "user", content: "synthetic question" }],
    }));
    const warning = "Couldn't confirm this reply came through the verified enclave. Don't rely on it.";
    expect(status).toBe(200);
    expect(body).toContain("visible streamed text");
    expect(body.split(warning).length - 1).toBe(1);
    expect(body).not.toContain("tinycloud.receipt-verification");
    expect(body).not.toContain("receipt_verification");
    expect(body).not.toContain('"stream_error"');
    expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  test.each([
    [new RedPillAciError(), "upstream_failed", "The model service could not complete this request. Try again later."],
    [new RedPillResponseLimitError(), "result_size_limit", "The response was too large to process safely. Try a smaller request."],
  ] as const)("keeps internal ACI errors off the chat screen", async (error, code, message) => {
    const redpillFetch = (async () => { throw error; }) as typeof fetch;
    const res = await post(createApp(undefined, redpillFetch), JSON.stringify({
      model: OFFERED_MODEL,
      messages: [{ role: "user", content: "synthetic question" }],
    }));
    const body = await res.text();
    expect(res.status).toBe(502);
    expect(body).toContain(code);
    expect(body).toContain(message);
    expect(body).not.toContain("RedPill");
    expect(body).not.toContain(error.message);
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
      const res = await post(createApp(), body);
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

  test("the production API parser rejects a body larger than 1mb", async () => {
    const oversized = JSON.stringify({
      model: OFFERED_MODEL,
      messages: [{ role: "user", content: "x".repeat(1024 * 1024) }],
    });
    expect(oversized.length).toBeGreaterThan(1024 * 1024);
    expect((await post(createApp(), oversized)).status).toBe(413);
  });

});
