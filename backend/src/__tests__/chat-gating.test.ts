import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type Stripe from "stripe";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { TIERS } from "../billing/tiers.js";
import { _resetUsage, getUsage } from "../billing/usage.js";
import { createChatRouter } from "../routes/chat.js";

const ORIGINAL_ENV = { ...process.env };
const ADDR = "0xabc";

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: ADDR };
  next();
}

function createApp() {
  const app = express();
  app.use(express.json());
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

/** Mock Stripe resolving the caller to a given tier via its price id. */
function mockStripe(priceId: string | null, anchorEpochSec?: number): Stripe {
  return {
    customers: { search: async () => ({ data: priceId ? [{ id: "cus_1" }] : [] }) },
    subscriptions: {
      list: async () => ({
        data: priceId
          ? [
              {
                status: "active",
                current_period_end: 1_800_000_000,
                billing_cycle_anchor: anchorEpochSec ?? 1_700_000_000,
                items: { data: [{ price: { id: priceId } }] },
              },
            ]
          : [],
      }),
    },
  } as unknown as Stripe;
}

function chatBody(model: string, content = "hi") {
  return JSON.stringify({ model, messages: [{ role: "user", content }] });
}

/**
 * Walk every key + value of `body` and throw if any dollar-denominated field
 * leaks through. Mirror of the assertion in billing-routes.test.ts; spec §2.1
 * forbids dollar amounts in any API response, including 402 paywall bodies.
 */
function assertNoDollarLeak(body: unknown): void {
  const DOLLAR_KEY_RE = /usd|dollar|price.*usd|peg/i;
  function walk(obj: unknown, path = "$"): void {
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (DOLLAR_KEY_RE.test(k)) {
          throw new Error(`Dollar-denominated key "${k}" at ${path}`);
        }
        if (typeof v === "string" && (/\busd\b/i.test(v) || /dollar/i.test(v) || v.includes("$"))) {
          throw new Error(`Dollar-denominated string at ${path}.${k}: ${v}`);
        }
        walk(v, `${path}.${k}`);
      }
    }
  }
  walk(body);
}

/** A pricing fixture matching the spec §2.2 table; gpt-5-mini is baseline. */
const MINI_PRICING = { prompt: "0.00000025", completion: "0.000002" };
const OPUS_PRICING = { prompt: "0.000015", completion: "0.000075" };

/**
 * Install a fetch stub that handles RedPill /models (catalog) and
 * /chat/completions (SSE stream) and passes localhost requests through.
 */
function stubRedPillFetch(opts: {
  models?: Array<{ id: string; pricing?: unknown }>;
  sseChunks?: string[];
}): () => void {
  const originalFetch = globalThis.fetch;
  const models = opts.models ?? [];
  const sseChunks = opts.sseChunks ?? [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.redpill.ai") && url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("api.redpill.ai") && url.endsWith("/chat/completions")) {
      const body = sseChunks.join("");
      return new Response(body, {
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

beforeEach(() => {
  process.env.REDPILL_API_KEY = "sk-rp-test";
  process.env.STRIPE_PRICE_PLUS_MONTHLY = "price_plus_m";
  process.env.STRIPE_PRICE_PLUS_YEARLY = "price_plus_y";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_y";
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

describe("POST /api/chat gating", () => {
  test("402 model_not_allowed with tier + requiredTier", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("phala/glm-5"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("model_not_allowed");
    expect(typeof body.message).toBe("string");
    expect(body.tier).toBe("free");
    expect(body.requiredTier).toBe("pro");
    assertNoDollarLeak(body);
  });

  test("402 model_not_allowed when free requests a plus model", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null));
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("openai/gpt-5"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("model_not_allowed");
    expect(body.requiredTier).toBe("plus");
    assertNoDollarLeak(body);
  });

  test("402 credit_budget_exceeded shape (spec §6, §4.5)", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.CREDIT_BUDGET_FREE = "10";
    _setStripeClient(mockStripe(null)); // free tier
    // Exhaust the free budget before issuing the request.
    const { recordUsage } = await import("../billing/usage.js");
    recordUsage(ADDR, TIERS.free, 10);
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("openai/gpt-5-mini"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(typeof body.message).toBe("string");
    expect(body.message.toLowerCase()).toContain("credit");
    expect(body.tier).toBe("free");
    expect(body.usage).toMatchObject({ used: 10, limit: 10 });
    expect(typeof body.usage.resetsAt).toBe("string");
    assertNoDollarLeak(body);
  });

  test("paid tier 402 credit_budget_exceeded carries anchored-week resetsAt", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const anchorEpochSec = 1_700_000_000;
    const anchorMs = anchorEpochSec * 1000;
    _setStripeClient(mockStripe("price_plus_m", anchorEpochSec)); // plus tier
    const { recordUsage, startOfNextAnchoredWeek } = await import("../billing/usage.js");
    recordUsage(ADDR, TIERS.plus, 12_000, anchorMs);
    const expectedReset = new Date(
      startOfNextAnchoredWeek(anchorMs, Date.now()),
    ).toISOString();
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("openai/gpt-5"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.tier).toBe("plus");
    expect(body.usage).toMatchObject({ used: 12_000, limit: 12_000 });
    expect(body.usage.resetsAt).toBe(expectedReset);
    assertNoDollarLeak(body);
  });
});

describe("POST /api/chat recording", () => {
  test("uses prompt/completion split via the SSE usage chunk", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    // SSE stream with one content delta and a final usage chunk carrying
    // explicit prompt_tokens / completion_tokens (spec §2.3).
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubRedPillFetch({
      models: [
        { id: "openai/gpt-5-mini", pricing: MINI_PRICING },
        { id: "anthropic/claude-opus-4.1", pricing: OPUS_PRICING },
      ],
      sseChunks,
    });
    try {
      // mini rates: 2.5 in / 20 out per 1K. 1000/1000*2.5 + 500/1000*20 = 12.5 → ceil = 13.
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("openai/gpt-5-mini"),
      });
      expect(res.status).toBe(200);
      await res.text(); // drain
      const snap = getUsage(ADDR, TIERS.free);
      expect(snap.used).toBe(13);
    } finally {
      restore();
    }
  });

  test("falls back to chars/4 estimate when the stream omits a usage chunk", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null));
    // Stream a single content delta with no usage chunk. The completion text
    // accumulates; the prompt chars come from the request body's messages.
    const completion = "b".repeat(4000); // 1000 completion tokens at chars/4
    const promptContent = "a".repeat(4000); // 1000 prompt tokens at chars/4
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: completion } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubRedPillFetch({
      models: [{ id: "openai/gpt-5-mini", pricing: MINI_PRICING }],
      sseChunks,
    });
    try {
      // mini rates: 1000/1000*2.5 + 1000/1000*20 = 22.5 → ceil = 23.
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("openai/gpt-5-mini", promptContent),
      });
      expect(res.status).toBe(200);
      await res.text();
      const snap = getUsage(ADDR, TIERS.free);
      expect(snap.used).toBe(23);
    } finally {
      restore();
    }
  });
});

describe("GET /api/chat/models annotation", () => {
  test("all allowed:true when paywall disabled; rates always present", async () => {
    process.env.PAYWALL_ENABLED = "false";
    const restore = stubRedPillFetch({
      models: [
        { id: "openai/gpt-5-mini", pricing: MINI_PRICING },
        { id: "anthropic/claude-opus-4.1", pricing: OPUS_PRICING },
      ],
    });
    try {
      const res = await request(createApp(), "/api/chat/models");
      const body = (await res.json()) as any;
      expect(body.models.every((m: any) => m.allowed === true)).toBe(true);
      expect(body.models.some((m: any) => "requiredTier" in m)).toBe(false);
      // Rates always present, even with paywall off (spec §4.5).
      for (const m of body.models) {
        expect(typeof m.creditsPerKInput).toBe("number");
        expect(typeof m.creditsPerKOutput).toBe("number");
        expect(typeof m.multiplier).toBe("number");
      }
      const byId = Object.fromEntries(body.models.map((m: any) => [m.id, m]));
      // gpt-5-mini is the baseline (REDPILL_DEFAULT_MODEL) → multiplier 1.
      expect(byId["openai/gpt-5-mini"].creditsPerKInput).toBe(2.5);
      expect(byId["openai/gpt-5-mini"].creditsPerKOutput).toBe(20);
      expect(byId["openai/gpt-5-mini"].multiplier).toBe(1);
      // opus snaps to 150/800 with 800/20 = 40 → multiplier 50.
      expect(byId["anthropic/claude-opus-4.1"].creditsPerKInput).toBe(150);
      expect(byId["anthropic/claude-opus-4.1"].creditsPerKOutput).toBe(800);
      expect(byId["anthropic/claude-opus-4.1"].multiplier).toBe(50);
      // Spec §2.1 invariant — no dollar fields ever leak from /models either.
      assertNoDollarLeak(body);
    } finally {
      restore();
    }
  });

  test("annotates allowed + requiredTier + rates for free tier when paywall enabled", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free
    const restore = stubRedPillFetch({
      models: [
        { id: "openai/gpt-5-mini", pricing: MINI_PRICING },
        { id: "openai/gpt-5", pricing: { prompt: "0.0000025", completion: "0.00002" } },
        { id: "phala/glm-5", pricing: MINI_PRICING },
      ],
    });
    try {
      const res = await request(createApp(), "/api/chat/models");
      const body = (await res.json()) as any;
      const byId = Object.fromEntries(body.models.map((m: any) => [m.id, m]));
      expect(byId["openai/gpt-5-mini"]).toMatchObject({
        id: "openai/gpt-5-mini",
        allowed: true,
        creditsPerKInput: 2.5,
        creditsPerKOutput: 20,
        multiplier: 1,
      });
      expect("requiredTier" in byId["openai/gpt-5-mini"]).toBe(false);
      expect(byId["openai/gpt-5"]).toMatchObject({
        id: "openai/gpt-5",
        allowed: false,
        requiredTier: "plus",
      });
      // Rates always present even on disallowed models.
      expect(typeof byId["openai/gpt-5"].creditsPerKInput).toBe("number");
      expect(typeof byId["openai/gpt-5"].multiplier).toBe("number");
      expect(byId["phala/glm-5"]).toMatchObject({
        id: "phala/glm-5",
        allowed: false,
        requiredTier: "pro",
      });
      expect(typeof byId["phala/glm-5"].multiplier).toBe("number");
      assertNoDollarLeak(body);
    } finally {
      restore();
    }
  });
});
