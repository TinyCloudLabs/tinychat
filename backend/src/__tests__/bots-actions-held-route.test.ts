// TC-3792: the bots service refuses a Send while the chat holds the owner's meeting data; the route says `held`, which
// the card words, and keeps it apart from a request that is simply no longer pending.
import { expect, test } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { BotsRegistry } from "../bots-registry.js";
import { botsFromEnv, createBotsRouter } from "../routes/bots.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";

const sessionKey = `0x${"03".repeat(32)}`;
const owner = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const ID = "0123456789abcdef01234567";
const BINDING = "c".repeat(64);

async function send(upstream: () => Response) {
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: owner, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: "bots-test-secret-not-real" })!;
  const registry = new BotsRegistry(fakeRegistryStore(), { now: () => new Date("2026-11-19T00:00:00.000Z"), newKey: () => "1".repeat(32) });
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  const listForTurn = (_ownerDid: string, sourceKey: string) => registry.listForTurn(owner, sourceKey);
  app.use("/api/bots", createBotsRouter({ config: { ...config, listForTurn, fetchImpl: (async () => upstream()) as unknown as typeof fetch }, authMiddleware: createAuthMiddleware(sessionKey), registry }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    return await fetch(`http://127.0.0.1:${address.port}/api/bots/main/requests/${ID}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(owner, sessionKey)).token}` },
      body: JSON.stringify({ decision: "approve", binding: BINDING }),
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("a Send the service refuses as held is a 409 held, and any other 409 stays not_pending", async () => {
  const held = await send(() => Response.json({ error: "held" }, { status: 409 }));
  expect([held.status, await held.json()]).toEqual([409, { error: "held" }]);
  const decided = await send(() => Response.json({ error: "not_pending" }, { status: 409 }));
  expect([decided.status, await decided.json()]).toEqual([409, { error: "not_pending" }]);
});
