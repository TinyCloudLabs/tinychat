import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "http";
import type { NextFunction, Request, Response } from "express";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage } from "../billing/usage.js";
import { createChatRouter } from "../routes/chat.js";
import { createApiBodyParser } from "../body-parsing.js";

const ORIGINAL_ENV = { ...process.env };
const OFFERED_MODEL = "z-ai/glm-5.2";
const MESSAGES = [{ role: "user", content: "Summarise." }];

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: "0xabc" };
  next();
}

function createApp() {
  const app = express();
  app.use(createApiBodyParser());
  app.use("/api/chat", authStub, createChatRouter());
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

/** Stub RedPill /chat/completions with an empty successful stream and record every upstream body. */
function stubUpstream(): { bodies: Record<string, unknown>[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.redpill.ai") && url.endsWith("/chat/completions")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return {
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function post(app: express.Express, body: Record<string, unknown>) {
  return request(app, "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.REDPILL_API_KEY = "sk-rp-test";
  delete process.env.PAYWALL_ENABLED;
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

describe("POST /api/chat optional max_output_tokens", () => {
  test("max_output_tokens is forwarded upstream as max_tokens and not under its own name", async () => {
    const upstream = stubUpstream();
    try {
      const res = await post(createApp(), {
        model: OFFERED_MODEL,
        messages: MESSAGES,
        max_output_tokens: 800,
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(upstream.bodies).toHaveLength(1);
      expect(upstream.bodies[0]).toEqual({
        model: OFFERED_MODEL,
        messages: MESSAGES,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 800,
      });
    } finally {
      upstream.restore();
    }
  });

  test("the bounds 1 and 4096 are accepted", async () => {
    for (const value of [1, 4096]) {
      const upstream = stubUpstream();
      try {
        const res = await post(createApp(), {
          model: OFFERED_MODEL,
          messages: MESSAGES,
          max_output_tokens: value,
        });
        expect(res.status).toBe(200);
        await res.text();
        expect(upstream.bodies[0]?.max_tokens).toBe(value);
      } finally {
        upstream.restore();
      }
    }
  });

  test.each([0, -1, 4097, 1.5, "800", true, { cap: 800 }])(
    "invalid max_output_tokens %p is rejected with 400 and no upstream call",
    async (value) => {
      const upstream = stubUpstream();
      try {
        const res = await post(createApp(), {
          model: OFFERED_MODEL,
          messages: MESSAGES,
          max_output_tokens: value,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("invalid_body");
        expect(upstream.bodies).toHaveLength(0);
      } finally {
        upstream.restore();
      }
    },
  );

  test("absent or null max_output_tokens gives the same upstream body as before", async () => {
    for (const extra of [{}, { max_output_tokens: null }]) {
      const upstream = stubUpstream();
      try {
        const res = await post(createApp(), { model: OFFERED_MODEL, messages: MESSAGES, ...extra });
        expect(res.status).toBe(200);
        await res.text();
        expect(upstream.bodies[0]).toEqual({
          model: OFFERED_MODEL,
          messages: MESSAGES,
          stream: true,
          stream_options: { include_usage: true },
        });
      } finally {
        upstream.restore();
      }
    }
  });

  test("the legacy max_tokens field is still not forwarded", async () => {
    const upstream = stubUpstream();
    try {
      const res = await post(createApp(), { model: OFFERED_MODEL, messages: MESSAGES, max_tokens: 2000 });
      expect(res.status).toBe(200);
      await res.text();
      expect(upstream.bodies[0]).not.toHaveProperty("max_tokens");
    } finally {
      upstream.restore();
    }
  });
});
