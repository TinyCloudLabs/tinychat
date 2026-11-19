import { describe, expect, it } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { botsFromEnv, createBotsRouter } from "../routes/bots.js";

const key = `0x${"03".repeat(32)}`;
const enabled = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";

async function setup(upstream: () => Response) {
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: enabled, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: "bots-test-secret-not-real" })!;
  const app = express();
  app.use(express.json());
  app.use(createCsrfMiddleware());
  app.use("/api/bots", createBotsRouter({ config: { ...config, fetchImpl: (async () => upstream()) as typeof fetch }, authMiddleware: createAuthMiddleware(key) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots`;
  const headers = { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(enabled, key)).token}` };
  return { base, headers, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe("a bot that cannot start because the service is full", () => {
  it("reaches the browser as the service's at_capacity event, not as bot_unavailable", async () => {
    const event = 'event: status\ndata: {"state":"starting"}\n\nevent: error\ndata: {"code":"at_capacity","message":"Main can\'t start right now."}\n\n';
    const run = await setup(() => new Response(event, { headers: { "content-type": "text/event-stream" } }));
    try {
      const response = await fetch(`${run.base}/main/messages`, { method: "POST", headers: run.headers, body: JSON.stringify({ text: "hi" }) });
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe(event);
      expect(body).not.toContain("bot_unavailable");
    } finally { await run.close(); }
  });
});
