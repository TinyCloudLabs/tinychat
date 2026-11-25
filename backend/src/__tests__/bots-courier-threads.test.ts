import { expect, test } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { NonceGuard, verifyCall } from "../../../bots/src/signed-call";
import { createAuthMiddleware } from "../middleware/auth";
import { botsFromEnv } from "../routes/bots";
import { createBotsCourierRouter } from "../routes/bots-courier";

const address = `0x${"ab".repeat(20)}`;
const owner = `did:pkh:eip155:1:${address}`;
const tokenKey = `0x${"03".repeat(32)}`;
const secret = "s".repeat(64);
const id = "a".repeat(64);
test("thread listing, reading and deletion are signed for the session owner; dark and other owners are hidden", async () => {
  const calls: string[] = [];
  const nonces = new NonceGuard();
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: address, BOTS_SERVICE_URL: "http://bots.test", BOTS_SERVICE_SECRET: secret })!;
  config.fetchImpl = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const claims = verifyCall(new Headers(init?.headers).get("authorization"), { method: init?.method ?? "GET", path }, { secret, direction: "to-service", environment: "private", nonces });
    expect(claims?.owner).toBe(owner); expect(claims?.bot).toBe("main");
    calls.push(`${init?.method} ${path}`);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(path.endsWith(`/${id}`) ? { id, peer: "cli", title: "cli (Courier)", messages: [] } : { threads: [{ id, peer: "cli", title: "cli (Courier)", updatedAt: 1 }] });
  }) as typeof fetch;
  const app = express(); app.use(createCsrfMiddleware());
  app.use("/api/bots/main/courier", createBotsCourierRouter({ config, auth: createAuthMiddleware(tokenKey), enabled: true }));
  app.use("/dark", createBotsCourierRouter({ config, auth: createAuthMiddleware(tokenKey), enabled: false }));
  const server = app.listen(0, "127.0.0.1");
  const listening = Promise.withResolvers<void>(); server.once("listening", listening.resolve); await listening.promise;
  const bound = server.address(); if (!bound || typeof bound === "string") throw new Error("missing_test_address");
  const base = `http://127.0.0.1:${bound.port}`;
  const headers = { authorization: `Bearer ${(await issueSessionToken(address, tokenKey)).token}`, "X-Requested-With": "XMLHttpRequest" };
  try {
    const listed = await fetch(`${base}/api/bots/main/courier/threads?owner=other`, { headers });
    expect(listed.status).toBe(200); expect((await listed.json()).threads[0].id).toBe(id); expect(listed.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${base}/api/bots/main/courier/threads/${id}`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/bots/main/courier/threads/${id}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await fetch(`${base}/dark/threads`, { headers })).status).toBe(404);
    const foreign = { ...headers, authorization: `Bearer ${(await issueSessionToken(`0x${"cd".repeat(20)}`, tokenKey)).token}` };
    expect((await fetch(`${base}/api/bots/main/courier/threads`, { headers: foreign })).status).toBe(404);
    expect(calls).toEqual(["GET /v1/bots/main/courier/threads", `GET /v1/bots/main/courier/threads/${id}`, `DELETE /v1/bots/main/courier/threads/${id}`]);
  } finally { server.closeAllConnections(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; }
});
