import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  _resetCache,
  _setStripeClient,
  invalidateAddress,
  paywallEnabled,
  resolveTier,
  stripeConfigured,
} from "../billing/stripe.js";

const ORIGINAL_ENV = { ...process.env };
const ADDR = "0xABCdef0000000000000000000000000000000001";

/** Build a mock Stripe client exposing only the methods resolveTier uses. */
function mockStripe(opts: {
  customer?: { id: string } | null;
  subscriptions?: Array<{
    status: string;
    priceId: string;
    billing_cycle_anchor?: number | null;
    current_period_start?: number | null;
    itemCurrentPeriodStart?: number | null;
    created?: number | null;
  }>;
  onSearch?: () => void;
}): Stripe {
  const subData = (opts.subscriptions ?? []).map((s) => {
    const sub: Record<string, unknown> = {
      status: s.status,
      current_period_end: 1_800_000_000,
      items: { data: [{ price: { id: s.priceId }, current_period_end: 1_800_000_000 }] },
    };
    if (s.billing_cycle_anchor !== null) {
      sub.billing_cycle_anchor = s.billing_cycle_anchor ?? 1_700_000_000;
    }
    if (s.current_period_start !== null && s.current_period_start !== undefined) {
      sub.current_period_start = s.current_period_start;
    }
    if (s.itemCurrentPeriodStart !== null && s.itemCurrentPeriodStart !== undefined) {
      (sub.items as { data: Array<Record<string, unknown>> }).data[0].current_period_start =
        s.itemCurrentPeriodStart;
    }
    if (s.created !== null && s.created !== undefined) {
      sub.created = s.created;
    }
    return sub;
  });
  return {
    customers: {
      search: async () => {
        opts.onSearch?.();
        return { data: opts.customer ? [opts.customer] : [] };
      },
    },
    subscriptions: {
      list: async () => ({ data: subData }),
    },
  } as unknown as Stripe;
}

beforeEach(() => {
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_PRICE_PLUS_MONTHLY = "price_plus_m";
  process.env.STRIPE_PRICE_PLUS_YEARLY = "price_plus_y";
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_m";
  process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_y";
  _resetCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _setStripeClient(null);
  _resetCache();
});

describe("paywall flags", () => {
  test("paywallEnabled reads the env flag", () => {
    process.env.PAYWALL_ENABLED = "false";
    expect(paywallEnabled()).toBe(false);
    process.env.PAYWALL_ENABLED = "true";
    expect(paywallEnabled()).toBe(true);
  });

  test("stripeConfigured reflects the secret key", () => {
    expect(stripeConfigured()).toBe(true);
    delete process.env.STRIPE_SECRET_KEY;
    expect(stripeConfigured()).toBe(false);
  });
});

describe("resolveTier (stateless, mocked Stripe)", () => {
  test("returns free when paywall disabled (no Stripe call)", async () => {
    process.env.PAYWALL_ENABLED = "false";
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_1" },
        subscriptions: [{ status: "active", priceId: "price_pro_m" }],
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("free");
  });

  test("returns free when Stripe not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("free");
  });

  test("no customer => free", async () => {
    _setStripeClient(mockStripe({ customer: null }));
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("free");
    expect(res.subscription).toBeNull();
  });

  test("active plus subscription => plus tier + subscription info", async () => {
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_1" },
        subscriptions: [
          { status: "active", priceId: "price_plus_m", billing_cycle_anchor: 1_700_000_000 },
        ],
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("plus");
    expect(res.customerId).toBe("cus_1");
    expect(res.subscription).toMatchObject({ status: "active", interval: "monthly" });
    expect(res.subscription?.currentPeriodEnd).toBe(new Date(1_800_000_000 * 1000).toISOString());
    expect(res.subscription?.anchor).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  test("trialing pro yearly => pro tier", async () => {
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_2" },
        subscriptions: [{ status: "trialing", priceId: "price_pro_y" }],
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("pro");
    expect(res.subscription).toMatchObject({ status: "trialing", interval: "yearly" });
  });

  test("canceled subscription is ignored => free", async () => {
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_3" },
        subscriptions: [{ status: "canceled", priceId: "price_pro_m" }],
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("free");
  });

  test("caches resolution (one Stripe search within TTL)", async () => {
    let searches = 0;
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_1" },
        subscriptions: [{ status: "active", priceId: "price_plus_m" }],
        onSearch: () => {
          searches += 1;
        },
      }),
    );
    await resolveTier(ADDR);
    await resolveTier(ADDR);
    expect(searches).toBe(1);

    invalidateAddress(ADDR);
    await resolveTier(ADDR);
    expect(searches).toBe(2);
  });

  test("anchor falls back to current_period_start when billing_cycle_anchor missing", async () => {
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_a" },
        subscriptions: [
          {
            status: "active",
            priceId: "price_plus_m",
            billing_cycle_anchor: null,
            current_period_start: 1_650_000_000,
            created: 1_500_000_000,
          },
        ],
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.subscription?.anchor).toBe(new Date(1_650_000_000 * 1000).toISOString());
  });

  test("anchor falls back to item-level current_period_start when sub-level missing", async () => {
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_item" },
        subscriptions: [
          {
            status: "active",
            priceId: "price_plus_m",
            billing_cycle_anchor: null,
            itemCurrentPeriodStart: 1_620_000_000,
            created: 1_500_000_000,
          },
        ],
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.subscription?.anchor).toBe(new Date(1_620_000_000 * 1000).toISOString());
  });

  test("anchor falls back to created when only created is present", async () => {
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_b" },
        subscriptions: [
          {
            status: "active",
            priceId: "price_pro_y",
            billing_cycle_anchor: null,
            created: 1_500_000_000,
          },
        ],
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.subscription?.anchor).toBe(new Date(1_500_000_000 * 1000).toISOString());
  });

  test("cache round-trips anchor on second call without re-search", async () => {
    let searches = 0;
    _setStripeClient(
      mockStripe({
        customer: { id: "cus_c" },
        subscriptions: [
          {
            status: "active",
            priceId: "price_plus_m",
            billing_cycle_anchor: 1_710_000_000,
          },
        ],
        onSearch: () => {
          searches += 1;
        },
      }),
    );
    const first = await resolveTier(ADDR);
    const second = await resolveTier(ADDR);
    expect(searches).toBe(1);
    expect(second.subscription?.anchor).toBe(new Date(1_710_000_000 * 1000).toISOString());
    expect(second.subscription?.anchor).toBe(first.subscription?.anchor);
  });
});
