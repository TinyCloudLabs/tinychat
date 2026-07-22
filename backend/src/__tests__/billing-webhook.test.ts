import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type Stripe from "stripe";
import { _resetCache, _setStripeClient, resolveTier } from "../billing/stripe.js";
import { createBillingWebhookHandler } from "../routes/billing-webhook.js";

const ORIGINAL_ENV = { ...process.env };

function createApp() {
  const app = express();
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    createBillingWebhookHandler(),
  );
  return app;
}

async function post(app: express.Express, path: string, init: RequestInit) {
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

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/billing/webhook", () => {
  test("503 when webhook secret missing", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await post(createApp(), "/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" },
      body: JSON.stringify({ type: "customer.subscription.updated" }),
    });
    expect(res.status).toBe(503);
  });

  test("400 when signature header missing", async () => {
    const res = await post(createApp(), "/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "customer.subscription.updated" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_signature");
  });

  test("400 when signature is invalid (verification fails)", async () => {
    const res = await post(createApp(), "/api/billing/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=deadbeef",
      },
      body: JSON.stringify({ type: "customer.subscription.updated" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_signature");
  });

  test("subscription.updated for a did-only customer invalidates the parsed address", async () => {
    // Post-cutover: the customer carries metadata.did (no address key) and the
    // subscription has no address in its own metadata, so the handler must
    // resolve the address via addressForCustomer → the DID parse.
    const ADDR = "0xabcdef0000000000000000000000000000000042";
    let searches = 0;
    process.env.PAYWALL_ENABLED = "true";
    process.env.STRIPE_PRICE_PLUS_MONTHLY = "price_plus_m";
    _resetCache();
    _setStripeClient({
      // constructWebhookEvent delegates to the injected client's webhooks —
      // returning our event directly makes a real signature unnecessary.
      webhooks: {
        constructEventAsync: async () => ({
          type: "customer.subscription.updated",
          data: { object: { customer: "cus_did", metadata: {} } },
        }),
      },
      customers: {
        retrieve: async () => ({ deleted: false, metadata: { did: `did:pkh:eip155:1:${ADDR}` } }),
        search: async () => {
          searches += 1;
          return { data: [{ id: "cus_did" }] };
        },
      },
      subscriptions: {
        list: async () => ({
          data: [
            {
              status: "active",
              current_period_end: 1_800_000_000,
              billing_cycle_anchor: 1_700_000_000,
              items: {
                data: [{ price: { id: "price_plus_m" }, current_period_end: 1_800_000_000 }],
              },
            },
          ],
        }),
      },
    } as unknown as Stripe);

    // Prime the tier cache for ADDR (one Stripe search).
    await resolveTier(ADDR);
    expect(searches).toBe(1);

    const res = await post(createApp(), "/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=mock" },
      body: JSON.stringify({ type: "customer.subscription.updated" }),
    });
    expect(res.status).toBe(200);

    // The handler parsed ADDR from metadata.did and invalidated its cache entry,
    // so the next resolution re-searches. Wrong/absent parse would leave the
    // entry cached and searches stuck at 1.
    await resolveTier(ADDR);
    expect(searches).toBe(2);

    _setStripeClient(null);
    _resetCache();
  });
});
