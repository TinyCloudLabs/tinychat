import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
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
});
