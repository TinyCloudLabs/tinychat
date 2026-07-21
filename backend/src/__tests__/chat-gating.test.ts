import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type Stripe from "stripe";
import { _resetCatalogCache, isBlocklistedModel, isOfferedModel } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { isModelAllowed, TIERS } from "../billing/tiers.js";
import { _resetUsage, getUsage, recordUsage } from "../billing/usage.js";
import type { LedgerRehydrator } from "../billing/ledger-rehydrate.js";
import { createChatRouter, defaultModel } from "../routes/chat.js";

// Mirror of the frontend memory-extraction model id (frontend/src/chat/runtime.tsx
// MEMORY_EXTRACTION_MODEL). Kept in sync here so ST3 regresses if either drifts
// off the offered-model tier gate. The product is single-model, so this is the
// single offered model.
const MEMORY_EXTRACTION_MODEL = "deepseek/deepseek-v4-pro";

// R3 ruling: 402 bodies hide `source` unless LEDGER_EXPOSE_SOURCE=true. This
// suite asserts on the tag, so opt in BEFORE the ORIGINAL_ENV snapshot (the
// afterEach env restore would otherwise erase it). The default-hidden behavior
// has its own dedicated test below, which deletes the var.
process.env.LEDGER_EXPOSE_SOURCE = "true";
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
function mockStripe(priceId: string | null, anchorEpochSec?: number | null): Stripe {
  return {
    customers: { search: async () => ({ data: priceId ? [{ id: "cus_1" }] : [] }) },
    subscriptions: {
      list: async () => ({
        data: priceId
          ? [
              {
                status: "active",
                current_period_end: 1_800_000_000,
                billing_cycle_anchor: anchorEpochSec === undefined ? 1_700_000_000 : anchorEpochSec,
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
  test("ST2: 403 model_not_offered for a non-offered model (authoritative gate, paywall on)", async () => {
    // Verifiable-inference product: only the curated picker lineup is offered.
    // The ST2 offered-model gate runs BEFORE the paywall block and returns 403
    // model_not_offered (not the redundant 402 model_not_allowed).
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("anthropic/claude-opus-4.8"),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("model_not_offered");
    expect(typeof body.message).toBe("string");
    assertNoDollarLeak(body);
  });

  test("ST2: 403 model_not_offered even for the highest (pro) tier requesting a non-offered model", async () => {
    // A non-offered model is not offered on ANY tier, including pro — the
    // offered-model gate is paywall- and tier-independent.
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe("price_pro_m")); // pro tier
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("openai/gpt-5"),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.error).toBe("model_not_offered");
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
    // Use an offered model so the request passes the model-allowance gate and
    // reaches the credit-budget check.
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.source).toBe("local");
    expect(typeof body.message).toBe("string");
    expect(body.message.toLowerCase()).toContain("credit");
    expect(body.tier).toBe("free");
    expect(body.usage).toMatchObject({ used: 10, limit: 10 });
    expect(typeof body.usage.resetsAt).toBe("string");
    assertNoDollarLeak(body);
  });

  test("402 body omits `source` by default — diagnostics are opt-in via LEDGER_EXPOSE_SOURCE (ruling R3)", async () => {
    delete process.env.LEDGER_EXPOSE_SOURCE;
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.CREDIT_BUDGET_FREE = "10";
    _setStripeClient(mockStripe(null)); // free tier
    const { recordUsage } = await import("../billing/usage.js");
    recordUsage(ADDR, TIERS.free, 10);
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect("source" in body).toBe(false);
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
    // Use an offered model so the request reaches the credit-budget check.
    const res = await request(createApp(), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.source).toBe("local");
    expect(body.tier).toBe("plus");
    expect(body.usage).toMatchObject({ used: 12_000, limit: 12_000 });
    expect(body.usage.resetsAt).toBe(expectedReset);
    assertNoDollarLeak(body);
  });
});

describe("POST /api/chat offered-model gate, paywall OFF (ST2)", () => {
  test("non-offered model is rejected 403 model_not_offered with NO upstream fetch", async () => {
    // The default deployment has PAYWALL_ENABLED unset. The offered-model gate
    // must STILL reject a non-offered model before any upstream proxy.
    delete process.env.PAYWALL_ENABLED;
    let upstreamCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.redpill.ai")) upstreamCalled = true;
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("openai/gpt-4o"),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error).toBe("model_not_offered");
      expect(upstreamCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an offered model still streams 200 with the paywall off", async () => {
    delete process.env.PAYWALL_ENABLED;
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubRedPillFetch({
      models: [{ id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }],
      sseChunks,
    });
    try {
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("deepseek/deepseek-v4-pro"),
      });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      restore();
    }
  });
});

describe("defaultModel() override validation (ST11)", () => {
  test("an unoffered REDPILL_DEFAULT_MODEL override falls back to the baseline and warns", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    try {
      // openai/gpt-5-mini is a valid id but NOT in the picker allowlist, so it
      // is unoffered — the default must heal to the curated baseline.
      process.env.REDPILL_DEFAULT_MODEL = "openai/gpt-5-mini";
      const value = defaultModel();
      expect(value).toBe("deepseek/deepseek-v4-pro");
      expect(isBlocklistedModel(value)).toBe(false);
      expect(warnings.some((w) => w.includes("REDPILL_DEFAULT_MODEL"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a blocklisted phala override also falls back to the baseline", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      // phala/glm-4.7 is on the mislabeled blocklist (see ST7 tests below).
      process.env.REDPILL_DEFAULT_MODEL = "phala/glm-4.7";
      expect(isBlocklistedModel("phala/glm-4.7")).toBe(true);
      expect(defaultModel()).toBe("deepseek/deepseek-v4-pro");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a non-allowlisted override falls back to the baseline (not a now-unoffered model)", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      // phala/gpt-oss-120b is a valid TEE model but NOT in the picker allowlist,
      // so it is no longer offered — the default must not resolve to it.
      process.env.REDPILL_DEFAULT_MODEL = "phala/gpt-oss-120b";
      expect(isBlocklistedModel("phala/gpt-oss-120b")).toBe(false);
      expect(defaultModel()).toBe("deepseek/deepseek-v4-pro");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a valid (allowlisted) override is returned unchanged", () => {
    process.env.REDPILL_DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
    expect(defaultModel()).toBe("deepseek/deepseek-v4-pro");
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
        { id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }, // default → baseline anchor + requested offered model
        { id: "anthropic/claude-opus-4.1", pricing: OPUS_PRICING },
      ],
      sseChunks,
    });
    try {
      // offered model priced at mini rates: 2.5 in / 20 out per 1K. 1000/1000*2.5 + 500/1000*20 = 12.5 → ceil = 13.
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("deepseek/deepseek-v4-pro"),
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
      models: [
        { id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }, // default → baseline anchor + requested offered model
      ],
      sseChunks,
    });
    try {
      // offered model priced at mini rates: 1000/1000*2.5 + 1000/1000*20 = 22.5 → ceil = 23.
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("deepseek/deepseek-v4-pro", promptContent),
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
  test("only the single offered model is listed (non-offered filtered out); allowed:true when paywall disabled; rates always present", async () => {
    process.env.PAYWALL_ENABLED = "false";
    // The multiplier anchor is the default model (deepseek/deepseek-v4-pro). Price
    // it at the MINI baseline so it anchors multiplier 1. The non-TEE
    // openai/gpt-5-mini and the unoffered phala/gpt-oss-120b must be filtered OUT
    // of the /models output (only the single offered model is listed).
    const restore = stubRedPillFetch({
      models: [
        { id: "openai/gpt-5-mini", pricing: MINI_PRICING }, // non-TEE (filtered out)
        { id: "phala/gpt-oss-120b", pricing: MINI_PRICING }, // unoffered (filtered out)
        { id: "moonshotai/kimi-k2.6", pricing: OPUS_PRICING }, // formerly offered, now unoffered (filtered out)
        { id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }, // the single offered model → baseline anchor (multiplier 1)
      ],
    });
    try {
      const res = await request(createApp(), "/api/chat/models");
      const body = (await res.json()) as any;
      const byId = Object.fromEntries(body.models.map((m: any) => [m.id, m]));
      // Non-TEE, unoffered phala/*, and formerly-offered models are filtered out.
      expect("openai/gpt-5-mini" in byId).toBe(false);
      expect("phala/gpt-oss-120b" in byId).toBe(false);
      expect("moonshotai/kimi-k2.6" in byId).toBe(false);
      expect(body.models.every((m: any) => isOfferedModel(m.id))).toBe(true);
      expect(body.models.every((m: any) => m.allowed === true)).toBe(true);
      expect(body.models.some((m: any) => "requiredTier" in m)).toBe(false);
      // Rates always present, even with paywall off (spec §4.5).
      for (const m of body.models) {
        expect(typeof m.creditsPerKInput).toBe("number");
        expect(typeof m.creditsPerKOutput).toBe("number");
        expect(typeof m.multiplier).toBe("number");
      }
      // The single offered model is the default → baseline rates → multiplier 1.
      expect(byId["deepseek/deepseek-v4-pro"].creditsPerKInput).toBe(2.5);
      expect(byId["deepseek/deepseek-v4-pro"].creditsPerKOutput).toBe(20);
      expect(byId["deepseek/deepseek-v4-pro"].multiplier).toBe(1);
      // Spec §2.1 invariant — no dollar fields ever leak from /models either.
      assertNoDollarLeak(body);
    } finally {
      restore();
    }
  });

  test("the model list returns EXACTLY the single offered model (extras filtered out)", async () => {
    process.env.PAYWALL_ENABLED = "false";
    // Upstream catalog: the single offered id plus a bunch of extras (non-TEE,
    // non-allowlisted phala/*, and formerly-offered models). The list must return
    // exactly the one offered model regardless of upstream ordering.
    const restore = stubRedPillFetch({
      models: [
        { id: "moonshotai/kimi-k2.6", pricing: MINI_PRICING }, // formerly offered
        { id: "openai/gpt-5-mini", pricing: MINI_PRICING }, // non-TEE extra
        { id: "qwen/qwen3.5-27b", pricing: MINI_PRICING }, // formerly offered
        { id: "google/gemma-3-27b-it", pricing: MINI_PRICING }, // formerly offered
        { id: "phala/gpt-oss-120b", pricing: MINI_PRICING }, // unoffered extra
        { id: "qwen/qwen-2.5-7b-instruct", pricing: MINI_PRICING }, // formerly offered
        { id: "qwen/qwen3-vl-30b-a3b-instruct", pricing: MINI_PRICING }, // formerly offered
        { id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }, // the single offered model
      ],
    });
    try {
      const res = await request(createApp(), "/api/chat/models");
      const body = (await res.json()) as any;
      const ids = body.models.map((m: any) => m.id);
      expect(ids).toEqual(["deepseek/deepseek-v4-pro"]);
    } finally {
      restore();
    }
  });

  test("annotates the offered model as allowed (no requiredTier) and filters out non-offered for free tier when paywall enabled", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free
    const restore = stubRedPillFetch({
      models: [
        { id: "openai/gpt-5-mini", pricing: MINI_PRICING }, // legacy non-TEE (filtered out)
        { id: "openai/gpt-5", pricing: { prompt: "0.0000025", completion: "0.00002" } }, // non-TEE (filtered out)
        { id: "phala/gpt-oss-120b", pricing: MINI_PRICING }, // unoffered (filtered out)
        { id: "qwen/qwen-2.5-7b-instruct", pricing: MINI_PRICING }, // formerly offered (filtered out)
        { id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }, // the single offered model → baseline anchor (multiplier 1)
      ],
    });
    try {
      const res = await request(createApp(), "/api/chat/models");
      const body = (await res.json()) as any;
      const byId = Object.fromEntries(body.models.map((m: any) => [m.id, m]));
      // Non-offered models (non-TEE, unoffered phala, formerly offered) are filtered out.
      expect("openai/gpt-5-mini" in byId).toBe(false);
      expect("openai/gpt-5" in byId).toBe(false);
      expect("phala/gpt-oss-120b" in byId).toBe(false);
      expect("qwen/qwen-2.5-7b-instruct" in byId).toBe(false);
      expect(body.models.every((m: any) => isOfferedModel(m.id))).toBe(true);
      // Free tier allows the offered model → allowed:true with no requiredTier.
      expect(byId["deepseek/deepseek-v4-pro"]).toMatchObject({
        id: "deepseek/deepseek-v4-pro",
        allowed: true,
        creditsPerKInput: 2.5,
        creditsPerKOutput: 20,
        multiplier: 1,
      });
      expect("requiredTier" in byId["deepseek/deepseek-v4-pro"]).toBe(false);
      assertNoDollarLeak(body);
    } finally {
      restore();
    }
  });
});

describe("GET /api/chat/models graceful degradation (catalog unavailable)", () => {
  /**
   * Stub that fails every RedPill /models fetch (simulating the latency-spike /
   * hang that trips the timeout) while passing localhost through. getCatalog has
   * no prior cache here (reset each test) → it throws CatalogFetchError after its
   * single retry, and the handler degrades to the curated allowlist (PICKER_MODELS).
   */
  function stubModelsFetchFailing(): () => void {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.redpill.ai") && url.endsWith("/models")) {
        throw new Error("simulated catalog hang/network failure");
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  const CURATED_MODELS = ["deepseek/deepseek-v4-pro"];

  test("returns the curated allowlist (allowed, no rate fields) as a 200 when the catalog is unavailable (paywall off)", async () => {
    process.env.PAYWALL_ENABLED = "false";
    const restore = stubModelsFetchFailing();
    try {
      const res = await request(createApp(), "/api/chat/models");
      // Degraded but USABLE — not a 502/500 error.
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const ids = body.models.map((m: any) => m.id);
      expect(ids).toEqual(CURATED_MODELS);
      // Paywall off → all allowed; rate fields OMITTED (pricing unavailable).
      for (const m of body.models) {
        expect(m.allowed).toBe(true);
        expect("multiplier" in m).toBe(false);
        expect("creditsPerKInput" in m).toBe(false);
        expect("creditsPerKOutput" in m).toBe(false);
        expect("requiredTier" in m).toBe(false);
      }
      assertNoDollarLeak(body);
    } finally {
      restore();
    }
  });

  test("degraded list still applies tier gating when the paywall is on", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    const restore = stubModelsFetchFailing();
    try {
      const res = await request(createApp(), "/api/chat/models");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      const ids = body.models.map((m: any) => m.id);
      expect(ids).toEqual(CURATED_MODELS);
      // Every entry carries an `allowed` boolean and no rate fields.
      for (const m of body.models) {
        expect(typeof m.allowed).toBe("boolean");
        expect("multiplier" in m).toBe(false);
      }
      assertNoDollarLeak(body);
    } finally {
      restore();
    }
  });

  test("missing REDPILL_API_KEY is still a 500 no_api_key (real misconfig, not flakiness)", async () => {
    delete process.env.REDPILL_API_KEY;
    const res = await request(createApp(), "/api/chat/models");
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toBe("no_api_key");
  });
});

describe("POST /api/chat default + memory-extraction models (ST3, ST6)", () => {
  test("ST3: memory-extraction model is tier-allowed under the paywall (no 402)", async () => {
    // The id is a verifiable, offered model: in the picker allowlist (offered),
    // tier-allowed, and not blocklisted, so the extraction POST passes the gate
    // instead of 402'ing and silently leaving memory un-updated.
    expect(isOfferedModel(MEMORY_EXTRACTION_MODEL)).toBe(true);
    expect(isModelAllowed("free", MEMORY_EXTRACTION_MODEL)).toBe(true);
    expect(isBlocklistedModel(MEMORY_EXTRACTION_MODEL)).toBe(false);

    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubRedPillFetch({
      models: [{ id: MEMORY_EXTRACTION_MODEL, pricing: MINI_PRICING }],
      sseChunks,
    });
    try {
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody(MEMORY_EXTRACTION_MODEL),
      });
      expect(res.status).not.toBe(402);
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      restore();
    }
  });

  test("ST6: defaultModel() is offered and tier-allowed; a model-less POST is not 402", async () => {
    // Test the built-in default, independent of any REDPILL_DEFAULT_MODEL override
    // a local .env may carry.
    delete process.env.REDPILL_DEFAULT_MODEL;
    expect(isOfferedModel(defaultModel())).toBe(true);
    expect(isModelAllowed("free", defaultModel())).toBe(true);
    expect(isBlocklistedModel(defaultModel())).toBe(false);

    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubRedPillFetch({
      models: [{ id: defaultModel(), pricing: MINI_PRICING }],
      sseChunks,
    });
    try {
      // No `model` field → resolves to defaultModel() server-side.
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).not.toBe(402);
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      restore();
    }
  });
});

describe("POST /api/chat blocklist enforcement (ST7)", () => {
  const BLOCKED = "phala/glm-4.7";

  test("isBlocklistedModel flags the mislabeled id, not a legitimate one", () => {
    expect(isBlocklistedModel(BLOCKED)).toBe(true);
    expect(isBlocklistedModel("phala/gpt-oss-20b")).toBe(false);
  });

  /** Run a blocklisted POST under a fetch spy; assert rejected + no upstream. */
  async function expectBlocked() {
    let upstreamCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.redpill.ai")) upstreamCalled = true;
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody(BLOCKED),
      });
      expect(res.status).not.toBe(200);
      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.error).toBe("model_blocklisted");
      assertNoDollarLeak(body);
      expect(upstreamCalled).toBe(false);
      expect(getUsage(ADDR, TIERS.free).used).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("rejects a blocklisted model with the paywall enabled (no upstream, no usage)", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    await expectBlocked();
  });

  test("rejects a blocklisted model even with the paywall disabled", async () => {
    process.env.PAYWALL_ENABLED = "false";
    await expectBlocked();
  });
});

// ── LEDGER_AUTHORITATIVE gate (Phase 2) ────────────────────────────────────────

function makeMockRehydrator(opts: {
  atLimit?: boolean;
  entitlement: {
    credit_limit: number | null;
    committed_credits: number | null;
    isOutage: boolean;
    period_anchor?: string | null;
  };
}): LedgerRehydrator {
  return {
    rehydrateIfNeeded: async () => opts.atLimit ?? false,
    getEntitlement: async () => ({
      credit_limit: opts.entitlement.credit_limit,
      committed_credits: opts.entitlement.committed_credits,
      period_anchor: opts.entitlement.period_anchor ?? "utc_day",
      isOutage: opts.entitlement.isOutage,
    }),
    get unrehydratedServesCount() { return 0; },
  } as unknown as LedgerRehydrator;
}

function createAppWithRehydrator(rehydrator: LedgerRehydrator) {
  const app = express();
  app.use(express.json());
  app.use("/api/chat", authStub, createChatRouter({ rehydrator }));
  return app;
}

describe("POST /api/chat LEDGER_AUTHORITATIVE gate", () => {
  test("flag-OFF (unset): local isOverBudget governs — exhausted local budget → 402 even when ledger says under limit", async () => {
    delete process.env.LEDGER_AUTHORITATIVE;
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.CREDIT_BUDGET_FREE = "10";
    _setStripeClient(mockStripe(null)); // free tier
    recordUsage(ADDR, TIERS.free, 10);

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      // Ledger says plenty of credits — flag is OFF so local path wins
      entitlement: { credit_limit: 1000, committed_credits: 0, isOutage: false },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.source).toBe("local");
    assertNoDollarLeak(body);
  });

  test("flag-OFF (false): local isOverBudget governs — parity with today's path", async () => {
    process.env.LEDGER_AUTHORITATIVE = "false";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.CREDIT_BUDGET_FREE = "10";
    _setStripeClient(mockStripe(null)); // free tier
    recordUsage(ADDR, TIERS.free, 10);

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: { credit_limit: 1000, committed_credits: 0, isOutage: false },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.source).toBe("local");
    assertNoDollarLeak(body);
  });

  test("flag-ON: clean ledger read at limit → 402 (ledger-sourced; local tally is 0)", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    // Local tally = 0 (would serve under the local path alone)

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: { credit_limit: 1000, committed_credits: 1000, isOutage: false },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.source).toBe("ledger");
    assertNoDollarLeak(body);
  });

  test("flag-ON: K-degrade 402 is source-tagged", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "bounded_k";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null));

    const rehydrator = makeMockRehydrator({
      atLimit: true,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });

    expect(res.status).toBe(402);
    expect((await res.json() as { source: string }).source).toBe("k_degrade");
  });

  test("flag-ON: exhausted K + fail_closed → outage-policy 402", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_closed";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null));

    const rehydrator = makeMockRehydrator({
      atLimit: true,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });

    expect(res.status).toBe(402);
    expect((await res.json() as { source: string }).source).toBe("outage_policy");
  });

  test("flag-ON: exhausted K + fail_open → serves", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_open";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null));

    const rehydrator = makeMockRehydrator({
      atLimit: true,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const restore = stubRedPillFetch({
      models: [{ id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }],
      sseChunks: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ],
    });
    try {
      const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("deepseek/deepseek-v4-pro"),
      });

      expect(res.status).toBe(200);
      await res.text();
    } finally {
      restore();
    }
  });

  test("flag-ON: mismatched authority 402 is source-tagged", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_closed";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null));

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: {
        credit_limit: 1000,
        committed_credits: 0,
        period_anchor: "anchored_week",
        isOutage: false,
      },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });

    expect(res.status).toBe(402);
    expect((await res.json() as { source: string }).source).toBe("authority_mismatch");
  });

  test("flag-ON: clean ledger read under limit → serves (local tally exhausted but ledger is authoritative)", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.CREDIT_BUDGET_FREE = "10";
    _setStripeClient(mockStripe(null)); // free tier
    recordUsage(ADDR, TIERS.free, 10); // local exhausted

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: { credit_limit: 1000, committed_credits: 500, isOutage: false },
    });
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubRedPillFetch({
      models: [{ id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }],
      sseChunks,
    });
    try {
      const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("deepseek/deepseek-v4-pro"),
      });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      restore();
    }
  });

  test("flag-ON + outage + fail_closed → 402 immediately", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_closed";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.source).toBe("outage_policy");
    assertNoDollarLeak(body);
  });

  test("flag-ON + outage + fail_open → serves despite outage", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_open";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubRedPillFetch({
      models: [{ id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }],
      sseChunks,
    });
    try {
      const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("deepseek/deepseek-v4-pro"),
      });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      restore();
    }
  });

  test("flag-ON + outage + bounded_k (default) + local budget exhausted → 402 via local path", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    // LEDGER_OUTAGE_POLICY unset → defaults to bounded_k
    delete process.env.LEDGER_OUTAGE_POLICY;
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.CREDIT_BUDGET_FREE = "10";
    _setStripeClient(mockStripe(null)); // free tier
    recordUsage(ADDR, TIERS.free, 10); // local exhausted

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.source).toBe("outage_policy");
    assertNoDollarLeak(body);
  });

  test("flag-ON + outage + bounded_k + local budget NOT exhausted → serves", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    delete process.env.LEDGER_OUTAGE_POLICY;
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier
    // local tally = 0, local budget not exhausted

    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: { credit_limit: null, committed_credits: null, isOutage: true },
    });
    const sseChunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const restore = stubRedPillFetch({
      models: [{ id: "deepseek/deepseek-v4-pro", pricing: MINI_PRICING }],
      sseChunks,
    });
    try {
      const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody("deepseek/deepseek-v4-pro"),
      });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      restore();
    }
  });

  test("flag-ON: null committed_credits with window → isOutage (null-vs-zero: cannot be read as 0)", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_closed";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null)); // free tier

    // committed_credits=null with a credit_limit present → getEntitlement returns isOutage=true
    const rehydrator = makeMockRehydrator({
      atLimit: false,
      entitlement: { credit_limit: 1000, committed_credits: null, isOutage: true },
    });
    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });
    // fail_closed under outage → 402 (not served, proving null !== 0)
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.error).toBe("credit_budget_exceeded");
    expect(body.source).toBe("outage_policy");
    assertNoDollarLeak(body);
  });

  test("flag-ON: a local weekly tier without an anchor is a hard outage before either ledger window read", async () => {
    process.env.LEDGER_AUTHORITATIVE = "true";
    process.env.LEDGER_OUTAGE_POLICY = "fail_closed";
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe("price_plus_m", null));

    let rehydrateCalls = 0;
    let entitlementCalls = 0;
    const rehydrator = {
      rehydrateIfNeeded: async () => {
        rehydrateCalls++;
        return false;
      },
      getEntitlement: async () => {
        entitlementCalls++;
        return {
          credit_limit: 12_000,
          committed_credits: 0,
          period_anchor: "anchored_week",
          isOutage: false,
        };
      },
    } as unknown as LedgerRehydrator;

    const res = await request(createAppWithRehydrator(rehydrator), "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chatBody("deepseek/deepseek-v4-pro"),
    });

    expect(res.status).toBe(402);
    expect(rehydrateCalls).toBe(0);
    expect(entitlementCalls).toBe(0);
    const body = (await res.json()) as { usage?: unknown; source?: string };
    expect(body).not.toHaveProperty("usage");
    expect(body.source).toBe("config_outage");
  });
});
