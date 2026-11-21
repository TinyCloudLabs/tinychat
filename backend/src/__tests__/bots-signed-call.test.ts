// Signed calls between the backend and the bots service: the backend's router and history drain call a stand-in
// service that checks each call with the service's own copy of the signing module (the real service app is tested
// in bots/src/__tests__/signed-call.test.ts), and each copy verifies what the other signs. Only the dependency-free
// signing module is imported from bots/.
import { describe, expect, it } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import type { BotHistory } from "../bot-history.js";
import * as backendCalls from "../bots-signed-call.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { startBotHistoryDrain } from "../routes/bot-history.js";
import { botsFromEnv, createBotsRouter, type BotsConfig } from "../routes/bots.js";
import * as serviceCalls from "../../../bots/src/signed-call";

const key = `0x${"03".repeat(32)}`;
const enabled = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const other = "0x2222222222222222222222222222222222222222";
const owner = `did:pkh:eip155:1:${enabled.toLowerCase()}`;
const secret = "b".repeat(64);

type Route = (body: unknown) => Response | Promise<Response>;

/**
 * A stand-in service reached through the backend's fetchImpl: it accepts a call only as the service does (verifyCall
 * plus the bot in the path), records the signed owner, and answers from `routes` keyed by `METHOD path`.
 */
function service(routes: Record<string, Route>) {
  const owners: string[] = [];
  const upstream: Headers[] = [];
  const nonces = new serviceCalls.NonceGuard();
  const fetchImpl = (async (input, init) => {
    const headers = new Headers(init?.headers);
    upstream.push(headers);
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const claims = serviceCalls.verifyCall(headers.get("authorization"), { method, path: url.pathname + url.search, body }, { secret, direction: "to-service", environment: "private", nonces });
    if (!claims || !url.pathname.startsWith(`/v1/bots/${claims.bot}/`)) return new Response(null, { status: 401 });
    owners.push(claims.owner);
    const route = routes[`${method} ${url.pathname}`];
    return route ? route(body === undefined ? undefined : JSON.parse(body)) : new Response(null, { status: 404 });
  }) as typeof fetch;
  return { owners, upstream, fetchImpl };
}

describe("signed calls from the backend to the bots service", () => {
  it("the session owner reaches their bot; forged owners and the secret never travel", async () => {
    const svc = service({
      "GET /v1/bots/main/messages": () => Response.json({ messages: [] }),
      "POST /v1/bots/main/messages": () => new Response('event: done\ndata: {"messageId":"m1"}\n\n', { headers: { "content-type": "text/event-stream" } }),
    });
    const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: enabled, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: secret })!;
    const app = express();
    app.use(express.json()); app.use(createCsrfMiddleware());
    app.use("/api/bots", createBotsRouter({ config: { ...config, fetchImpl: svc.fetchImpl }, authMiddleware: createAuthMiddleware(key) }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots`;
      const headers = { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(enabled, key)).token}`, "x-tinycloud-owner": `did:pkh:eip155:1:${other}` };
      const list = await fetch(`${base}/main/messages`, { headers });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ messages: [] });
      const turn = await fetch(`${base}/main/messages`, { method: "POST", headers, body: JSON.stringify({ text: "ping", owner: other }) });
      expect(await turn.text()).toContain("event: done");
      expect(svc.owners).toEqual([owner, owner]);
      for (const sent of svc.upstream) {
        expect(sent.get("x-tinycloud-owner")).toBeNull();
        expect(sent.get("authorization")?.startsWith(backendCalls.SIGNED_SCHEME)).toBe(true);
        expect([...sent.values()].join(" ")).not.toContain(secret);
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("the history drain's fetch, stage and receipt calls are each signed for the drained owner", async () => {
    const staged: unknown[] = [];
    const { promise: received, resolve: receive } = Promise.withResolvers<unknown>();
    let pending: unknown = { seq: 1 };
    const svc = service({
      "GET /v1/bots/main/history": () => Response.json({ batch: pending }),
      "POST /v1/bots/main/history/stage": value => { staged.push(value); return new Response(null, { status: 204 }); },
      "POST /v1/bots/main/history": value => { pending = null; receive(value); return new Response(null, { status: 204 }); },
    });
    const history = {
      owners: async () => [enabled],
      archive: async (_address: string, _batch: unknown, stage: (value: unknown) => Promise<void>) => { await stage({ seq: 1 }); return { receipt: 1 }; },
    } as unknown as BotHistory;
    const config: BotsConfig = { serviceUrl: "http://bots.test", serviceSecret: secret, accountAllowed: () => true, postTimeoutMs: 1000, fetchImpl: svc.fetchImpl };
    // The drain's first pass starts on its own.
    const drain = startBotHistoryDrain(history, config);
    try {
      expect(await received).toEqual({ receipt: 1 });
      expect(staged).toEqual([{ seq: 1 }]);
      // The batch, its stage and its receipt.
      expect(svc.owners.slice(0, 3)).toEqual([owner, owner, owner]);
      for (const sent of svc.upstream) expect(sent.get("x-tinycloud-owner")).toBeNull();
    } finally { drain.stop(); }
  });
});

describe("the two copies of the signing module agree", () => {
  const call = (direction: "to-service" | "to-backend") => ({ direction, environment: "private" as const, owner, bot: "ab".repeat(16), method: "POST", path: "/api/internal/bots/admit", body: '{"x":1}' });
  const options = (direction: "to-service" | "to-backend", nonces: backendCalls.NonceGuard) => ({ secret, direction, environment: "private" as const, nonces });

  it("the service signs a call to the backend and the backend verifies it, once", () => {
    const header = serviceCalls.signedCallHeader(secret, call("to-backend"));
    const nonces = new backendCalls.NonceGuard();
    const request = { method: "POST", path: "/api/internal/bots/admit", body: '{"x":1}' };
    expect(backendCalls.verifyCall(header, request, options("to-backend", nonces))).toMatchObject({ owner, bot: "ab".repeat(16), env: "private" });
    expect(backendCalls.verifyCall(header, request, options("to-backend", nonces))).toBeNull();
  });

  it("each copy refuses a call signed in the other direction or under the other key", () => {
    const request = { method: "POST", path: "/api/internal/bots/admit", body: '{"x":1}' };
    expect(backendCalls.verifyCall(serviceCalls.signedCallHeader(secret, call("to-service")), request, options("to-backend", new backendCalls.NonceGuard()))).toBeNull();
    expect(backendCalls.verifyCall(serviceCalls.signedCallHeader("c".repeat(64), call("to-backend")), request, options("to-backend", new backendCalls.NonceGuard()))).toBeNull();
    expect(serviceCalls.verifyCall(backendCalls.signedCallHeader(secret, call("to-backend")), request, options("to-service", new serviceCalls.NonceGuard()))).toBeNull();
    expect(serviceCalls.verifyCall(backendCalls.signedCallHeader(secret, call("to-service")), request, options("to-service", new serviceCalls.NonceGuard()))).not.toBeNull();
  });
});
