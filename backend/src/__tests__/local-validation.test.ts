import { describe, expect, it } from "bun:test";
import express from "express";
import { localValidationFromEnv, localValidationGuard } from "../local-validation.js";
import { createTinychatBackendIdentity } from "../startup.js";

const localEnv = {
  TINYCHAT_LOCAL_VALIDATION: "true",
  NODE_ENV: "development",
  FRONTEND_URL: "http://localhost:5186",
  ELIZA_SERVICE_URL: "http://127.0.0.1:3015",
};

describe("local production-data validation isolation", () => {
  it("is opt-in and refuses production or nonlocal service configuration", () => {
    expect(localValidationFromEnv({})).toBe(false);
    expect(localValidationFromEnv(localEnv)).toBe(true);
    for (const override of [
      { NODE_ENV: "production" },
      { FRONTEND_URL: "https://tinycloud.chat" },
      { ELIZA_SERVICE_URL: "https://eliza.example" },
      { LEDGER_SERVICE_URL: "https://ledger.example" },
      { LEDGER_SERVICE_SECRET: "configured" },
      { LEDGER_AUTHORITATIVE: "true" },
      { CONNECTOR_WEBHOOKS_ENABLED: "true" },
      { GOOGLE_MEET_OAUTH_ENABLED: "true" },
      { TRANSCRIPTION_API_URL: "https://transcriber.example" },
      { STRIPE_SECRET_KEY: "configured" },
    ]) {
      expect(() => localValidationFromEnv({ ...localEnv, ...override })).toThrow();
    }
  });

  it("constructs a local backend identity without sign-in or space hosting", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (() => { requests++; throw new Error("Unexpected storage request"); }) as typeof fetch;
    try {
      const identity = await createTinychatBackendIdentity({
        privateKey: `0x${"01".repeat(32)}`,
        host: "https://production-node.example",
        localValidation: true,
      });
      expect(identity.did).toMatch(/^did:pkh:eip155:1:0x[0-9a-f]{40}$/i);
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("blocks persistent backend surfaces while retaining authenticated chat routes", async () => {
    const app = express();
    app.use(localValidationGuard);
    app.use((_req, res) => res.json({ reached: true }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      for (const path of ["/api/delegations", "/api/delegations/status", "/api/connectors/google/oauth/token", "/api/transcriber/meetings", "/api/billing/checkout", "/api/billing/webhook"]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" })).status).toBe(403);
      }
      for (const path of ["/api/auth/verify", "/api/agent/session", "/api/agent/chat", "/api/chat"]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" })).status).toBe(200);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
