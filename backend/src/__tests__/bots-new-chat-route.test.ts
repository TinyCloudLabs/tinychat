// TC-3808: the owner's "Start a new chat" with Main. Only a signed-in, enabled owner reaches it; the call to the
// service is signed for that owner and Main, and only the contract fields come back.
import { describe, expect, it } from "bun:test";
import express from "express";
import { once } from "node:events";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { NonceGuard, verifyCall } from "../bots-signed-call.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { botsFromEnv, createBotsRouter } from "../routes/bots.js";

const key = `0x${"04".repeat(32)}`;
const enabled = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";
const other = "0x3333333333333333333333333333333333333333";
const secret = "bots-new-chat-secret-not-real";

async function setup(upstream: () => Response) {
  const seen: { url: string; method?: string; headers: Headers; body?: BodyInit | null }[] = [];
  const fetchImpl = (async (input, init) => {
    seen.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body });
    return upstream();
  }) as typeof fetch;
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: enabled, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: secret })!;
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  app.use("/api/bots", createBotsRouter({ config: { ...config, fetchImpl }, authMiddleware: createAuthMiddleware(key) }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots/main/new-chat`;
  const post = async (address = enabled) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(address, key)).token}` },
    body: "{}",
  });
  const close = async () => {
    server.close();
    await once(server, "close");
  };
  return { seen, url, post, close };
}

describe("the owner's new chat route", () => {
  it("needs a session and an enabled account, and reaches nothing otherwise", async () => {
    const run = await setup(() => Response.json({ outcome: "cleared" }));
    try {
      expect((await fetch(run.url, { method: "POST", headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest" }, body: "{}" })).status).toBe(401);
      expect((await run.post(other)).status).toBe(404);
      expect(run.seen).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("asks the service for the session owner's Main, signed, and answers only the outcome", async () => {
    const run = await setup(() => Response.json({ outcome: "cleared", extra: "x" }));
    try {
      const response = await run.post();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "cleared" });
      expect(run.seen[0]!.url).toBe("http://bots.test/v1/bots/main/new-chat");
      expect(run.seen[0]!.method).toBe("POST");
      const claims = verifyCall(run.seen[0]!.headers.get("authorization"), { method: "POST", path: "/v1/bots/main/new-chat" }, { secret, direction: "to-service", environment: "private", nonces: new NonceGuard() });
      expect(claims && { owner: claims.owner, bot: claims.bot }).toEqual({ owner: `did:pkh:eip155:1:${enabled.toLowerCase()}`, bot: "main" });
    } finally { await run.close(); }
  });

  it("passes on a refusal while a turn runs or messages wait to be saved, and anything else as unavailable", async () => {
    for (const error of ["busy", "archive_pending"]) {
      const run = await setup(() => Response.json({ error }, { status: 409 }));
      try {
        const response = await run.post();
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error });
      } finally { await run.close(); }
    }
    const failing = await setup(() => Response.json({ error: "bot_unavailable", message: "internal detail" }, { status: 503 }));
    try {
      const response = await failing.post();
      expect(response.status).toBe(502);
      expect(JSON.stringify(await response.json())).not.toContain("internal detail");
    } finally { await failing.close(); }
  });
});
