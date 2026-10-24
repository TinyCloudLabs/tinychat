import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Server } from "http";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage } from "../billing/usage.js";
import { createApiBodyParser } from "../body-parsing.js";
import { createChatRouter } from "../routes/chat.js";

const ORIGINAL_ENV = { ...process.env };
const MESSAGES = [{ role: "user", content: "Extract durable memory." }];

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

async function request(app: express.Express, body: Record<string, unknown>) {
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function stubUpstream(): { bodies: Record<string, unknown>[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = originalFetch; } };
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

describe("POST /api/chat extraction reasoning control", () => {
  test.each([
    ["z-ai/glm-5.2", "off", { effort: "none" }],
    ["z-ai/glm-5.3", "minimal", { effort: "low" }],
    ["moonshotai/kimi-k3", "minimal", { effort: "low" }],
  ])("forwards %s %s through RedPill's catalog-supported reasoning field", async (model, reasoning, expected) => {
    const upstream = stubUpstream();
    try {
      const res = await request(createApp(), { model, messages: MESSAGES, reasoning });
      expect(res.status).toBe(200);
      await res.text();
      expect(upstream.bodies).toHaveLength(1);
      expect(upstream.bodies[0]?.reasoning).toEqual(expected);
      expect(upstream.bodies[0]).not.toHaveProperty("reasoning_effort");
    } finally {
      upstream.restore();
    }
  });

  test("uses Qwen's prompt-level no-think control when its RedPill catalog entry has no reasoning parameter", async () => {
    const upstream = stubUpstream();
    try {
      const res = await request(createApp(), {
        model: "qwen/qwen3.6-35b-a3b",
        messages: MESSAGES,
        reasoning: "off",
      });
      expect(res.status).toBe(200);
      await res.text();
      const body = upstream.bodies[0] as { messages?: Array<{ role: string; content: string }> };
      expect(body).not.toHaveProperty("reasoning");
      expect(body.messages?.at(-1)?.content).toBe("/no_think\nExtract durable memory.");
    } finally {
      upstream.restore();
    }
  });

  test.each([["none"], ["low"], [true], [0], [{}], [[]]])("rejects non-allow-listed reasoning value %p before upstream", async (reasoning) => {
    const upstream = stubUpstream();
    try {
      const res = await request(createApp(), {
        model: "z-ai/glm-5.2",
        messages: MESSAGES,
        reasoning,
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toEqual(expect.objectContaining({ error: "invalid_body" }));
      expect(upstream.bodies).toHaveLength(0);
    } finally {
      upstream.restore();
    }
  });

  test("leaves visible requests without the optional setting unchanged", async () => {
    const upstream = stubUpstream();
    try {
      const res = await request(createApp(), { model: "z-ai/glm-5.2", messages: MESSAGES });
      expect(res.status).toBe(200);
      await res.text();
      expect(upstream.bodies[0]).not.toHaveProperty("reasoning");
      expect(upstream.bodies[0]?.messages).toEqual(MESSAGES);
    } finally {
      upstream.restore();
    }
  });
});
