import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type Stripe from "stripe";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings, PEG_USD } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { createBillingRouter } from "../routes/billing.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ADDR = "0xabc";

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: ADDR };
  next();
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/billing", createBillingRouter({ authMiddleware: authStub }));
  return app;
}

/**
 * Stub RedPill /models so /rates can answer deterministically. Any non-RedPill
 * URL (e.g. our own localhost test server) falls through to the real fetch.
 */
function stubRedPillModels(models: Array<{ id: string; pricing?: unknown }>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.redpill.ai") && url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return ORIGINAL_FETCH(input, init);
  }) as typeof fetch;
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

function mockStripe(subPriceId: string | null, anchorEpochSec = 1_700_000_000): Stripe {
  return {
    customers: {
      search: async () => ({ data: subPriceId ? [{ id: "cus_1" }] : [{ id: "cus_1" }] }),
      create: async () => ({ id: "cus_new" }),
    },
    subscriptions: {
      list: async () => ({
        data: subPriceId
          ? [
              {
                status: "active",
                current_period_end: 1_800_000_000,
                billing_cycle_anchor: anchorEpochSec,
                items: { data: [{ price: { id: subPriceId }, current_period_end: 1_800_000_000 }] },
              },
            ]
          : [],
      }),
    },
    checkout: {
      sessions: { create: async () => ({ url: "https://checkout.stripe.test/session" }) },
    },
    billingPortal: {
      sessions: { create: async () => ({ url: "https://portal.stripe.test/session" }) },
    },
  } as unknown as Stripe;
}

beforeEach(() => {
  process.env.STRIPE_PRICE_PLUS_MONTHLY = "price_plus_m";
  process.env.STRIPE_PRICE_PLUS_YEARLY = "price_plus_y";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_y";
  _resetCache();
  _resetCatalogCache();
  _resetCreditsWarnings();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  _setStripeClient(null);
  _resetCache();
  _resetCatalogCache();
  _resetCreditsWarnings();
});

describe("GET /api/billing/config (public)", () => {
  test("returns paywall flag + tiers with cents prices", async () => {
    process.env.PAYWALL_ENABLED = "false";
    const res = await request(createApp(), "/api/billing/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.paywallEnabled).toBe(false);
    expect(body.tiers.map((t: any) => t.id)).toEqual(["free", "plus", "pro"]);
    const plus = body.tiers.find((t: any) => t.id === "plus");
    expect(plus.priceMonthly).toBe(1000);
    expect(plus.priceYearly).toBe(9600);
    expect(plus.creditBudget).toBe(12_000);
    expect(plus.budgetWindow).toBe("week");
    expect(Array.isArray(plus.modelPatterns)).toBe(true);
    const pro = body.tiers.find((t: any) => t.id === "pro");
    expect(pro.creditBudget).toBe(28_000);
    expect(pro.budgetWindow).toBe("week");
  });

  test("reflects paywall enabled", async () => {
    process.env.PAYWALL_ENABLED = "true";
    const res = await request(createApp(), "/api/billing/config");
    expect((await res.json()).paywallEnabled).toBe(true);
  });
});

describe("GET /api/billing/status", () => {
  test("free tier when paywall disabled", async () => {
    process.env.PAYWALL_ENABLED = "false";
    const res = await request(createApp(), "/api/billing/status");
    const body = (await res.json()) as any;
    expect(body.tier).toBe("free");
    expect(body.usage).toMatchObject({ used: 0, limit: 500 });
    expect(body.subscription).toBeNull();
  });

  test("plus tier with subscription when paywall enabled", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe("price_plus_m"));
    const res = await request(createApp(), "/api/billing/status");
    const body = (await res.json()) as any;
    expect(body.tier).toBe("plus");
    expect(body.usage).toMatchObject({ limit: 12_000 });
    expect(body.subscription).toMatchObject({ status: "active", interval: "monthly" });
  });

  test("paid tier resetsAt matches the next anchored-week boundary", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const anchorEpochSec = 1_700_000_000;
    const anchorMs = anchorEpochSec * 1000;
    _setStripeClient(mockStripe("price_plus_m", anchorEpochSec));
    const { startOfNextAnchoredWeek } = await import("../billing/usage.js");
    const expectedReset = new Date(
      startOfNextAnchoredWeek(anchorMs, Date.now()),
    ).toISOString();
    const res = await request(createApp(), "/api/billing/status");
    const body = (await res.json()) as any;
    expect(body.tier).toBe("plus");
    expect(body.usage.resetsAt).toBe(expectedReset);
    expect(body.subscription.anchor).toBe(new Date(anchorMs).toISOString());
  });
});

describe("POST /api/billing/checkout", () => {
  test("503 when billing not configured", async () => {
    process.env.PAYWALL_ENABLED = "true";
    delete process.env.STRIPE_SECRET_KEY;
    const res = await request(createApp(), "/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "plus", interval: "monthly" }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("billing_not_configured");
  });

  test("400 on invalid tier", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null));
    const res = await request(createApp(), "/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "gold", interval: "monthly" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns checkout url on success", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe(null));
    const res = await request(createApp(), "/api/billing/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "plus", interval: "monthly" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://checkout.stripe.test/session");
  });
});

describe("GET /api/billing/rates (public)", () => {
  test("returns baseline and per-model credit rates without auth", async () => {
    process.env.REDPILL_API_KEY = "sk-rp-test";
    stubRedPillModels([
      { id: "openai/gpt-5-mini", pricing: { prompt: "0.00000025", completion: "0.000002" } },
      { id: "anthropic/claude-opus-4.1", pricing: { prompt: "0.000015", completion: "0.000075" } },
    ]);
    const res = await request(createApp(), "/api/billing/rates");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.baseline).toBe("openai/gpt-5-mini");
    expect(Array.isArray(body.models)).toBe(true);
    const byId = Object.fromEntries(body.models.map((m: any) => [m.id, m]));
    expect(byId["openai/gpt-5-mini"]).toMatchObject({
      creditsPerKInput: 2.5,
      creditsPerKOutput: 20,
      multiplier: 1,
    });
    expect(byId["anthropic/claude-opus-4.1"].multiplier).toBe(50);
  });

  test("500 when REDPILL_API_KEY is not configured", async () => {
    delete process.env.REDPILL_API_KEY;
    const res = await request(createApp(), "/api/billing/rates");
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toBe("internal_error");
  });

  test("502 when RedPill returns a non-ok status", async () => {
    process.env.REDPILL_API_KEY = "sk-rp-test";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.redpill.ai")) {
        return new Response("rate limited", { status: 429 });
      }
      return ORIGINAL_FETCH(input, init);
    }) as typeof fetch;
    const res = await request(createApp(), "/api/billing/rates");
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.error).toBe("upstream_error");
  });
});

describe("no dollar-denominated fields leak across billing responses (spec §2.1)", () => {
  // Walk every key + value in the response objects. Any key matching the
  // dollar/peg regex (other than the cents-denominated list prices, which are
  // explicitly allowed) is a violation. Any string value mentioning USD or "$"
  // is a violation. Any number equal to a known credit value * PEG_USD is a
  // violation (would mean we're publishing COGS dollars derived from the peg).
  const DOLLAR_KEY_RE = /usd|dollar|price.*usd|peg/i;
  const ALLOWED_DOLLAR_KEYS = new Set(["priceMonthly", "priceYearly"]);

  function walk(
    obj: unknown,
    visit: (key: string | null, val: unknown, path: string) => void,
    path = "$",
  ): void {
    visit(null, obj, path);
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, visit, `${path}[${i}]`));
    } else if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        visit(k, v, `${path}.${k}`);
        walk(v, visit, `${path}.${k}`);
      }
    }
  }

  function assertNoDollarLeak(body: unknown): void {
    const creditValues: number[] = [];
    walk(body, (key, val) => {
      if (typeof key === "string" && /credit/i.test(key) && typeof val === "number") {
        creditValues.push(val);
      }
    });
    walk(body, (key, val, path) => {
      if (key !== null && !ALLOWED_DOLLAR_KEYS.has(key) && DOLLAR_KEY_RE.test(key)) {
        throw new Error(`Dollar-denominated key "${key}" at ${path}`);
      }
      if (typeof val === "string" && (/\busd\b/i.test(val) || /dollar/i.test(val) || val.includes("$"))) {
        throw new Error(`Dollar-denominated string at ${path}: ${val}`);
      }
      if (typeof val === "number") {
        for (const credits of creditValues) {
          if (val === credits * PEG_USD) {
            throw new Error(
              `Value at ${path} (${val}) equals credits×PEG_USD (${credits} * ${PEG_USD})`,
            );
          }
        }
      }
    });
  }

  test("/rates, /config, /status responses carry no dollar fields or peg-derived values", async () => {
    process.env.PAYWALL_ENABLED = "false";
    process.env.REDPILL_API_KEY = "sk-rp-test";
    stubRedPillModels([
      { id: "openai/gpt-5-mini", pricing: { prompt: "0.00000025", completion: "0.000002" } },
      { id: "anthropic/claude-opus-4.1", pricing: { prompt: "0.000015", completion: "0.000075" } },
    ]);
    const app = createApp();
    const rates = await (await request(app, "/api/billing/rates")).json();
    const config = await (await request(app, "/api/billing/config")).json();
    const status = await (await request(app, "/api/billing/status")).json();
    assertNoDollarLeak(rates);
    assertNoDollarLeak(config);
    assertNoDollarLeak(status);
  });
});

describe("POST /api/billing/portal", () => {
  test("returns portal url on success", async () => {
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    _setStripeClient(mockStripe("price_plus_m"));
    const res = await request(createApp(), "/api/billing/portal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://portal.stripe.test/session");
  });

  test("503 when not configured", async () => {
    process.env.PAYWALL_ENABLED = "false";
    const res = await request(createApp(), "/api/billing/portal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
  });
});
