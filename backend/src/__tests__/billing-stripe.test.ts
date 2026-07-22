import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  _resetCache,
  _setStripeClient,
  addressForCustomer,
  addressFromMetadata,
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

/**
 * Build a mock Stripe whose `customers.search` returns a customer only for the
 * query it is keyed to (`did` or `address`), recording each query it sees. Lets
 * us assert the did-first / address-fallback ordering in findCustomerByAddress.
 */
function mockByQuery(
  seen: string[],
  hits: {
    did?: { customer: { id: string }; priceId: string };
    address?: { customer: { id: string }; priceId: string };
  },
): Stripe {
  return {
    customers: {
      search: async ({ query }: { query: string }) => {
        seen.push(query);
        const hit = query.startsWith("metadata['did']") ? hits.did : hits.address;
        return { data: hit ? [hit.customer] : [] };
      },
    },
    subscriptions: {
      list: async ({ customer }: { customer: string }) => {
        const hit =
          hits.did?.customer.id === customer
            ? hits.did
            : hits.address?.customer.id === customer
              ? hits.address
              : null;
        if (!hit) return { data: [] };
        return {
          data: [
            {
              status: "active",
              current_period_end: 1_800_000_000,
              billing_cycle_anchor: 1_700_000_000,
              items: { data: [{ price: { id: hit.priceId }, current_period_end: 1_800_000_000 }] },
            },
          ],
        };
      },
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

  test("resolves via metadata.did query (post-cutover customers)", async () => {
    const seen: string[] = [];
    _setStripeClient(
      mockByQuery(seen, {
        did: { customer: { id: "cus_did" }, priceId: "price_plus_m" },
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("plus");
    expect(res.customerId).toBe("cus_did");
    // Only the DID query runs — it hits, so the legacy query is never reached.
    expect(seen).toEqual([`metadata['did']:'did:pkh:eip155:1:${ADDR.toLowerCase()}'`]);
  });

  test("falls back to legacy metadata.address query when DID misses", async () => {
    const seen: string[] = [];
    _setStripeClient(
      mockByQuery(seen, {
        address: { customer: { id: "cus_legacy" }, priceId: "price_pro_m" },
      }),
    );
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("pro");
    expect(res.customerId).toBe("cus_legacy");
    // DID query first (miss), then the legacy address query (hit).
    expect(seen).toEqual([
      `metadata['did']:'did:pkh:eip155:1:${ADDR.toLowerCase()}'`,
      `metadata['address']:'${ADDR.toLowerCase()}'`,
    ]);
  });

  test("neither DID nor address query hits => free", async () => {
    const seen: string[] = [];
    _setStripeClient(mockByQuery(seen, {}));
    const res = await resolveTier(ADDR);
    expect(res.tier).toBe("free");
    expect(res.customerId).toBeNull();
    expect(seen).toHaveLength(2);
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

/** Mock Stripe exposing only `customers.retrieve`, as addressForCustomer uses. */
function mockRetrieve(customer: {
  deleted?: boolean;
  metadata?: Record<string, string> | null;
}): Stripe {
  return {
    customers: {
      retrieve: async () => ({ deleted: false, ...customer }),
    },
  } as unknown as Stripe;
}

describe("addressFromMetadata (pure, did-first)", () => {
  test("parses the address out of a chain-1 DID (lowercased)", () => {
    expect(
      addressFromMetadata({ did: "did:pkh:eip155:1:0xABC0000000000000000000000000000000000009" }),
    ).toBe("0xabc0000000000000000000000000000000000009");
  });

  test("falls back to legacy metadata.address when no DID (lowercased)", () => {
    expect(
      addressFromMetadata({ address: "0xABC0000000000000000000000000000000000009" }),
    ).toBe("0xabc0000000000000000000000000000000000009");
  });

  test("DID wins over a legacy address key", () => {
    expect(
      addressFromMetadata({
        did: "did:pkh:eip155:1:0xAAA0000000000000000000000000000000000001",
        address: "0xBBB0000000000000000000000000000000000002",
      }),
    ).toBe("0xaaa0000000000000000000000000000000000001");
  });

  test("multi-chain DID is ignored, falling through to the address key", () => {
    expect(
      addressFromMetadata({
        did: "did:pkh:eip155:137:0xCCC0000000000000000000000000000000000003",
        address: "0xDDD0000000000000000000000000000000000004",
      }),
    ).toBe("0xddd0000000000000000000000000000000000004");
  });

  test("multi-chain DID with no address key => null", () => {
    expect(
      addressFromMetadata({ did: "did:pkh:eip155:137:0xCCC0000000000000000000000000000000000003" }),
    ).toBeNull();
  });

  test("empty / null / undefined metadata => null", () => {
    expect(addressFromMetadata({})).toBeNull();
    expect(addressFromMetadata(null)).toBeNull();
    expect(addressFromMetadata(undefined)).toBeNull();
  });
});

describe("addressForCustomer (customer → address, did-first)", () => {
  test("did-only customer (no address key) => parsed lowercase address", async () => {
    const addr = "0xabcdef0000000000000000000000000000000001";
    _setStripeClient(mockRetrieve({ metadata: { did: `did:pkh:eip155:1:${addr}` } }));
    expect(await addressForCustomer("cus_x")).toBe(addr);
  });

  test("uppercase address inside the DID is returned lowercased", async () => {
    const upper = "0xABCDEF0000000000000000000000000000000001";
    _setStripeClient(mockRetrieve({ metadata: { did: `did:pkh:eip155:1:${upper}` } }));
    expect(await addressForCustomer("cus_x")).toBe(upper.toLowerCase());
  });

  test("no did + legacy metadata.address => that address (lowercased)", async () => {
    _setStripeClient(
      mockRetrieve({ metadata: { address: "0xABC0000000000000000000000000000000000009" } }),
    );
    expect(await addressForCustomer("cus_x")).toBe("0xabc0000000000000000000000000000000000009");
  });

  test("neither did nor address => null", async () => {
    _setStripeClient(mockRetrieve({ metadata: {} }));
    expect(await addressForCustomer("cus_x")).toBeNull();
  });

  test("deleted customer => null", async () => {
    _setStripeClient(mockRetrieve({ deleted: true }));
    expect(await addressForCustomer("cus_x")).toBeNull();
  });

  test("returns null when Stripe is not configured (no retrieve call)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(await addressForCustomer("cus_x")).toBeNull();
  });
});
