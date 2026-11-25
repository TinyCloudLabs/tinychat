import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Server } from "http";
import type Stripe from "stripe";
import { BACKGROUND_CHAT_MODELS, OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { _resetCatalogCache, isOfferedModel } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { TIERS } from "../billing/tiers.js";
import { _resetUsage, getUsage } from "../billing/usage.js";
import { createApiBodyParser } from "../body-parsing.js";
import { createAgentChatHandler } from "../routes/agent-chat.js";
import { createBillingRouter } from "../routes/billing.js";
import { createChatRouter } from "../routes/chat.js";

// The model the app calls to suggest speaker names. It is not in the picker.
const NAMING_MODEL = "moonshotai/kimi-k3.1-pro";
// RedPill's prices for it on 25 Nov 2026, in dollars per token.
const NAMING_PRICING = { prompt: "0.000002", completion: "0.00001" };
const OFFERED_PRICING = { prompt: "0.00000025", completion: "0.000002" };

const ORIGINAL_ENV = { ...process.env };
const ADDR = "0xabc";
const MESSAGES = [{ role: "user", content: "Who is speaking?" }];

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: ADDR };
  next();
}

function createApp() {
  const app = express();
  app.use(createApiBodyParser());
  app.use("/api/chat", authStub, createChatRouter({ redpillFetch: (input, init) => globalThis.fetch(input, init) }));
  app.use("/api/billing", createBillingRouter({ authMiddleware: authStub }));
  return app;
}

async function request(app: express.Express, path: string, body?: Record<string, unknown>) {
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(
      `http://localhost:${port}${path}`,
      body === undefined
        ? undefined
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

/**
 * Stand in for RedPill: a catalog that prices the naming model and the offered
 * models, and a completion stream. Records every completion request body.
 */
function stubRedPill(usage?: { prompt_tokens: number; completion_tokens: number }): {
  bodies: Record<string, unknown>[];
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  const models = [
    { id: NAMING_MODEL, pricing: NAMING_PRICING },
    ...OFFERED_CHAT_MODELS.map(({ id }) => ({ id, pricing: OFFERED_PRICING })),
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("tee.redpill.ai") && url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("tee.redpill.ai") && url.endsWith("/chat/completions")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "{}" } }] })}\n\n`,
        ...(usage ? [`data: ${JSON.stringify({ choices: [], usage })}\n\n`] : []),
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = originalFetch; } };
}

/** Stripe with no customer: the caller is on the free tier. */
function freeTierStripe(): Stripe {
  return {
    customers: { search: async () => ({ data: [] }) },
    subscriptions: { list: async () => ({ data: [] }) },
  } as unknown as Stripe;
}

beforeEach(() => {
  process.env.REDPILL_API_KEY = "sk-rp-test";
  delete process.env.PAYWALL_ENABLED;
  delete process.env.REDPILL_DEFAULT_MODEL;
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

describe("POST /api/chat with a background model", () => {
  test("the naming model is the background list", () => {
    expect(BACKGROUND_CHAT_MODELS.map(({ id }) => id)).toEqual([NAMING_MODEL]);
  });

  test("a call with an output cap and a reasoning preference reaches the enclave capped and at low effort", async () => {
    const upstream = stubRedPill();
    try {
      const res = await request(createApp(), "/api/chat", {
        model: NAMING_MODEL,
        messages: MESSAGES,
        max_output_tokens: 4096,
        reasoning: "minimal",
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(upstream.bodies).toHaveLength(1);
      expect(upstream.bodies[0]).toMatchObject({
        model: NAMING_MODEL,
        messages: MESSAGES,
        max_tokens: 4096,
        reasoning: { effort: "low" },
        provider: { aci_verified: true },
      });
    } finally {
      upstream.restore();
    }
  });

  test.each([
    ["only an output cap", { max_output_tokens: 4096 }],
    ["only a reasoning preference", { reasoning: "minimal" }],
    ["neither", {}],
    ["a null output cap", { max_output_tokens: null, reasoning: "minimal" }],
    ["a null reasoning preference", { max_output_tokens: 4096, reasoning: null }],
  ])("a call with %s is refused like any model that is not offered", async (_name, fields) => {
    const upstream = stubRedPill();
    try {
      const res = await request(createApp(), "/api/chat", {
        model: NAMING_MODEL,
        messages: MESSAGES,
        ...fields,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "model_not_offered",
        message: `Model ${NAMING_MODEL} is not offered. Only the curated confidential model is available.`,
      });
      expect(upstream.bodies).toHaveLength(0);
    } finally {
      upstream.restore();
    }
  });

  test("an output cap and a reasoning preference do not admit a model that is on neither list", async () => {
    const upstream = stubRedPill();
    try {
      const res = await request(createApp(), "/api/chat", {
        model: "openai/gpt-5",
        messages: MESSAGES,
        max_output_tokens: 4096,
        reasoning: "minimal",
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("model_not_offered");
      expect(upstream.bodies).toHaveLength(0);
    } finally {
      upstream.restore();
    }
  });

  test("an offered model is still served without either field, uncapped and with no reasoning setting", async () => {
    const upstream = stubRedPill();
    try {
      const res = await request(createApp(), "/api/chat", { model: "z-ai/glm-5.2", messages: MESSAGES });
      expect(res.status).toBe(200);
      await res.text();
      expect(upstream.bodies[0]?.model).toBe("z-ai/glm-5.2");
      expect(upstream.bodies[0]).not.toHaveProperty("max_tokens");
      expect(upstream.bodies[0]).not.toHaveProperty("reasoning");
    } finally {
      upstream.restore();
    }
  });

  test("with the paywall on, one reading is charged at the catalog's price, not the fallback", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(freeTierStripe());
    const upstream = stubRedPill({ prompt_tokens: 7000, completion_tokens: 540 });
    try {
      const res = await request(createApp(), "/api/chat", {
        model: NAMING_MODEL,
        messages: MESSAGES,
        max_output_tokens: 4096,
        reasoning: "minimal",
      });
      expect(res.status).toBe(200);
      await res.text();
      // 20 credits per 1K in, 100 per 1K out: 140 + 54. The fallback would be 1,940.
      expect(getUsage(ADDR, TIERS.free).used).toBe(194);
    } finally {
      upstream.restore();
    }
  });
});

describe("a background model outside POST /api/chat", () => {
  test("GET /api/chat/models lists the four offered models only", async () => {
    const upstream = stubRedPill();
    try {
      const res = await request(createApp(), "/api/chat/models");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: Array<{ id: string }> };
      expect(body.models.map(({ id }) => id)).toEqual(OFFERED_CHAT_MODELS.map(({ id }) => id));
    } finally {
      upstream.restore();
    }
  });

  // The app's usage meter looks a model up in this answer and shows nothing
  // for a model that is missing from it, so the naming model has to be here.
  test("GET /api/billing/rates carries the naming model's rates", async () => {
    const upstream = stubRedPill();
    try {
      const res = await request(createApp(), "/api/billing/rates");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { models: Array<{ id: string }> };
      expect(body.models.find(({ id }) => id === NAMING_MODEL)).toMatchObject({
        id: NAMING_MODEL,
        creditsPerKInput: 20,
        creditsPerKOutput: 100,
      });
    } finally {
      upstream.restore();
    }
  });

  test("/api/agent/chat refuses it even with an output cap and a reasoning preference", async () => {
    let statusCode = 200;
    let answer: unknown;
    let providerCalls = 0;
    const req = Object.assign(new EventEmitter(), {
      user: { address: ADDR },
      body: { model: NAMING_MODEL, messages: MESSAGES, max_output_tokens: 4096, reasoning: "minimal" },
    }) as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      status(code: number) { statusCode = code; return res; },
      json(body: unknown) { answer = body; return res; },
    }) as unknown as Response;
    const fetchImpl = (async () => {
      providerCalls++;
      throw new Error("Unexpected provider request");
    }) as unknown as typeof fetch;

    await createAgentChatHandler({
      agentId: "92361e74-91ed-43a2-9656-5cc37ff3a07a",
      streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 10000, drainGraceMs: 100 },
      entityIdFor: () => "entity-1",
      elizaServiceUrl: "https://eliza.test",
      elizaServiceSecret: "svc",
      redpillApiKey: "rp-key",
      redpillBaseUrl: "https://redpill.test/v1",
      defaultModel: () => "z-ai/glm-5.2",
      // The predicate the server gives this route (index.ts).
      isModelOffered: isOfferedModel,
      redpillFetch: fetchImpl,
      fetchImpl,
    })(req, res);

    expect(statusCode).toBe(403);
    expect((answer as { error: string }).error).toBe("model_not_offered");
    expect(providerCalls).toBe(0);
  });
});
