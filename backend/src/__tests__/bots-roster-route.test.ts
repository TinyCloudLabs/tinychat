import { describe, expect, test } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import type { RequestHandler } from "express";
import type { CapMode, PlanName } from "../bot-caps.js";
import { BotsRegistry } from "../bots-registry.js";
import { botsFromEnv, createBotsRouter, type BotsConfig } from "../routes/bots.js";
import { NonceGuard, verifyCall } from "../bots-signed-call.js";
import { fakeRegistryStore, type FakeRegistryStore } from "./helpers/fake-registry-store.js";

const sessionKey = `0x${"03".repeat(32)}`;
const owner = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const stranger = "0x2222222222222222222222222222222222222222";
const secret = "bots-test-secret-not-real";
const T0 = new Date("2026-11-19T00:00:00.000Z");

interface UpstreamCall { method: string; url: string; headers: Headers; body: string | undefined }
type Upstream = (call: UpstreamCall) => Response | Promise<Response>;

/**
 * Who a recorded call to the service was signed for. Undefined unless it verifies with the service's secret for
 * exactly the method, path and body that were sent.
 */
const signedFor = (call: UpstreamCall): { owner: string; bot: string } | undefined => {
  const { pathname, search } = new URL(call.url);
  const claims = verifyCall(call.headers.get("authorization"), { method: call.method, path: pathname + search, body: call.body }, { secret, direction: "to-service", environment: "private", nonces: new NonceGuard() });
  return claims ? { owner: claims.owner, bot: claims.bot } : undefined;
};
const ownerDid = `did:pkh:eip155:1:${owner.toLowerCase()}`;

/** The real router on a local port, with real session tokens, a registry over a fake store, and a recording stand-in for the bots service. */
async function setup(upstream: Upstream = () => Response.json({}), extra: Partial<BotsConfig> = {}, paidLimiter?: RequestHandler, rule: { capMode?: CapMode; planOf?: (address: string) => Promise<PlanName | undefined>; onDeleting?: (address: string, key: string) => void } = {}) {
  const seen: UpstreamCall[] = [];
  const fetchImpl = (async (input, init) => {
    const call = { method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : undefined };
    seen.push(call);
    return upstream(call);
  }) as typeof fetch;
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: `${owner},${stranger}`, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: secret })!;
  const kv = fakeRegistryStore();
  let next = 0;
  const registry = new BotsRegistry(kv, { now: () => T0, newKey: () => (++next).toString(16).repeat(32) });
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  app.use("/api/bots", createBotsRouter({ config: { ...config, ...extra, fetchImpl }, authMiddleware: createAuthMiddleware(sessionKey), registry, paidLimiter, ...rule }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}/api/bots`;
  const headersFor = async (account: string) => ({ "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(account, sessionKey)).token}` });
  return { seen, kv, registry, base, headersFor, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const main = { key: "main", name: "Main", shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0.toISOString() };

describe("an owner's bots", () => {
  test("a new account's list holds Main, the flat limit of 3 and room to create", async () => {
    const run = await setup();
    try {
      const response = await fetch(run.base, { headers: await run.headersFor(owner) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        bots: [main],
        deleted: [],
        limits: { private: { max: 3, used: 1 }, regular: { max: 0, used: 0 } },
        canCreate: { private: true, regular: false },
        capMode: "flat3",
      });
      expect(run.seen).toHaveLength(0);
    } finally { await run.close(); }
  });

  test("the list answers 503 when the record cannot be read", async () => {
    const run = await setup();
    try {
      run.kv.down = true;
      const response = await fetch(run.base, { headers: await run.headersFor(owner) });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "bots_unavailable" });
    } finally { await run.close(); }
  });
});

describe("creating a bot", () => {
  test("stores it, announces it to the service as active with the record's counter, and answers 201 with the bot", async () => {
    const run = await setup(() => Response.json({ state: "active" }));
    try {
      const headers = await run.headersFor(owner);
      const response = await fetch(run.base, { method: "POST", headers, body: JSON.stringify({ name: "Research", shape: "sprout", colour: "teal" }) });
      const key = "1".repeat(32);
      const bot = { key, name: "Research", shape: "sprout", colour: "teal", environment: "private", state: "active", createdAt: T0.toISOString() };
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ bot });
      expect(run.seen).toHaveLength(1);
      // The service is told the bot's state under the counter of the record that now holds it.
      const { seq } = await run.registry.read(owner);
      expect(run.seen[0]).toMatchObject({ method: "PUT", url: `http://bots.test/v1/bots/${key}`, body: JSON.stringify({ state: "active", seq }) });
      // The call is signed for the signed-in owner and this bot, and no header names an owner.
      expect(signedFor(run.seen[0]!)).toEqual({ owner: ownerDid, bot: key });
      expect(run.seen[0]!.headers.get("x-tinycloud-owner")).toBeNull();
      expect((await (await fetch(run.base, { headers })).json()).bots).toEqual([main, bot]);
    } finally { await run.close(); }
  });
});

describe("refusing to create a bot", () => {
  const wanted = { name: "Research", shape: "sprout", colour: "teal" };

  test("a bad name, shape or colour, or a name already used, answers with its code and creates nothing", async () => {
    const run = await setup(() => Response.json({ state: "active" }));
    try {
      const headers = await run.headersFor(owner);
      const cases: Array<[body: unknown, status: number, answer: unknown]> = [
        [{ ...wanted, name: "" }, 400, { error: "invalid_name" }],
        [{ ...wanted, name: "x".repeat(25) }, 400, { error: "invalid_name" }],
        [{}, 400, { error: "invalid_name" }],
        [{ ...wanted, shape: "square" }, 400, { error: "invalid_shape" }],
        [{ ...wanted, colour: "#ffffff" }, 400, { error: "invalid_colour" }],
        [{ ...wanted, name: "main" }, 409, { error: "name_taken" }],
      ];
      for (const [body, status, answer] of cases) {
        const response = await fetch(run.base, { method: "POST", headers, body: JSON.stringify(body) });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(answer);
      }
      expect(run.seen).toHaveLength(0);
      expect((await run.registry.read(owner)).bots).toHaveLength(1);
    } finally { await run.close(); }
  });

  test("with Main and two more, the next bot is refused with the limit and the list says nothing more can be created", async () => {
    const run = await setup(() => Response.json({ state: "active" }));
    try {
      const headers = await run.headersFor(owner);
      const create = (name: string) => fetch(run.base, { method: "POST", headers, body: JSON.stringify({ ...wanted, name }) });
      expect((await create("One")).status).toBe(201);
      expect((await create("Two")).status).toBe(201);
      const refused = await create("Three");
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "bot_limit", environment: "private" });
      const list = await (await fetch(run.base, { headers })).json();
      expect(list.limits).toEqual({ private: { max: 3, used: 3 }, regular: { max: 0, used: 0 } });
      expect(list.canCreate).toEqual({ private: false, regular: false });
      expect(run.seen).toHaveLength(2);
    } finally { await run.close(); }
  });

  test("nothing in the request chooses the owner, the key, the environment or the state", async () => {
    const run = await setup(() => Response.json({ state: "active" }));
    try {
      const forged = { ...wanted, key: "f".repeat(32), owner: stranger, ownerDid: `did:pkh:eip155:1:${stranger}`, address: stranger, environment: "regular", state: "deleting", createdAt: "1999-01-01T00:00:00.000Z" };
      const response = await fetch(run.base, { method: "POST", headers: { ...(await run.headersFor(owner)), "x-tinycloud-owner": `did:pkh:eip155:1:${stranger}` }, body: JSON.stringify(forged) });
      expect(response.status).toBe(201);
      expect((await response.json()).bot).toEqual({ key: "1".repeat(32), ...wanted, environment: "private", state: "active", createdAt: T0.toISOString() });
      // The owner header the browser forged is not passed on, and the call is signed for the signed-in owner.
      expect(run.seen[0]!.headers.get("x-tinycloud-owner")).toBeNull();
      expect(signedFor(run.seen[0]!)).toEqual({ owner: ownerDid, bot: "1".repeat(32) });
      expect(run.kv.rows.has(`bots/registry/${stranger}`)).toBe(false);
    } finally { await run.close(); }
  });
});

describe("messages of a bot other than Main", () => {
  const wanted = { name: "Research", shape: "sprout", colour: "teal" };
  const KEY = "1".repeat(32);
  const messages = { messages: [{ id: "m1", role: "assistant", text: "hello" }] };

  test("reading them asks the service for that bot, as the signed-in owner", async () => {
    const run = await setup(call => (call.method === "PUT" ? Response.json({ state: "active" }) : Response.json(messages)));
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const response = await fetch(`${run.base}/${KEY}/messages`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(messages);
      const call = run.seen.at(-1)!;
      expect(call).toMatchObject({ method: "GET", url: `http://bots.test/v1/bots/${KEY}/messages` });
      expect(signedFor(call)).toEqual({ owner: ownerDid, bot: KEY });
    } finally { await run.close(); }
  });

  test("a key that is malformed, unknown, or another owner's is refused before the service is called", async () => {
    const run = await setup(call => (call.method === "PUT" ? Response.json({ state: "active" }) : Response.json(messages)));
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const before = run.seen.length;
      const theirs = await run.headersFor(stranger);
      for (const [who, key] of [[headers, "9".repeat(32)], [headers, "Research"], [headers, "A".repeat(32)], [headers, `${KEY}0`], [headers, "..%2Fmain"], [theirs, KEY]] as const) {
        const response = await fetch(`${run.base}/${key}/messages`, { headers: who });
        // The key is part of what is compared, so a failure says which case it was.
        expect([key, response.status, await response.json()]).toEqual([key, 404, { error: "not_found" }]);
      }
      expect(run.seen).toHaveLength(before);
    } finally { await run.close(); }
  });

  test("reading answers 503 when the owner's record cannot be read, without calling the service", async () => {
    const run = await setup(() => Response.json(messages));
    try {
      run.kv.down = true;
      const response = await fetch(`${run.base}/${KEY}/messages`, { headers: await run.headersFor(owner) });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "bots_unavailable" });
      expect(run.seen).toHaveLength(0);
    } finally { await run.close(); }
  });
});

describe("sending a message to a bot other than Main", () => {
  const wanted = { name: "Research", shape: "sprout", colour: "teal" };
  const KEY = "1".repeat(32);
  const stream = 'event: status\ndata: {"state":"working"}\n\nevent: delta\ndata: {"text":"pong"}\n\nevent: done\ndata: {"messageId":"m1"}\n\n';
  const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
  /** A service that takes announcements and answers every send with `stream`. */
  const service: Upstream = call => (call.method === "PUT" ? Response.json({ state: "active" }) : sse(stream));

  test("streams the service's events for that bot back to the owner", async () => {
    const run = await setup(service);
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const response = await fetch(`${run.base}/${KEY}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "ping" }) });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(await response.text()).toBe(stream);
      const call = run.seen.at(-1)!;
      expect(call).toMatchObject({ method: "POST", url: `http://bots.test/v1/bots/${KEY}/messages`, body: JSON.stringify({ text: "ping" }) });
      expect(signedFor(call)).toEqual({ owner: ownerDid, bot: KEY });
    } finally { await run.close(); }
  });

  const SUSPENDED = "5".repeat(32);
  const DELETING = "d".repeat(32);
  /** Puts a record straight into the store: Main, one suspended bot and one that is being deleted. */
  const seedStates = (kv: FakeRegistryStore) => kv.rows.set(`bots/registry/${owner.toLowerCase()}`, {
    version: 1,
    value: JSON.stringify({ v: 1, seq: 4, deleted: [], bots: [main, { ...main, key: SUSPENDED, name: "Paused", state: "suspended" }, { ...main, key: DELETING, name: "Leaving", state: "deleting", deletingSince: T0.toISOString() }] }),
  });

  test("a bot that is suspended or being deleted takes no message, and the service is not called", async () => {
    const run = await setup(service);
    try {
      seedStates(run.kv);
      const headers = await run.headersFor(owner);
      for (const [key, state] of [[SUSPENDED, "suspended"], [DELETING, "deleting"]] as const) {
        const response = await fetch(`${run.base}/${key}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "ping" }) });
        expect([state, response.status, await response.json()]).toEqual([state, 409, { error: "bot_not_active", state }]);
      }
      expect(run.seen).toHaveLength(0);
    } finally { await run.close(); }
  });

  test("a suspended bot's messages can still be read, and a bot that is being deleted answers 409", async () => {
    const run = await setup(() => Response.json({ messages: [] }));
    try {
      seedStates(run.kv);
      const headers = await run.headersFor(owner);
      const suspended = await fetch(`${run.base}/${SUSPENDED}/messages`, { headers });
      expect([suspended.status, await suspended.json()]).toEqual([200, { messages: [] }]);
      const deleting = await fetch(`${run.base}/${DELETING}/messages`, { headers });
      expect([deleting.status, await deleting.json()]).toEqual([409, { error: "bot_not_active", state: "deleting" }]);
      expect(run.seen.map(call => call.url)).toEqual([`http://bots.test/v1/bots/${SUSPENDED}/messages`]);
    } finally { await run.close(); }
  });
});

describe("a bot the record says is active but the service does not know", () => {
  const KEY = "1".repeat(32);
  const stream = 'event: delta\ndata: {"text":"pong"}\n\nevent: done\ndata: {"messageId":"m1"}\n\n';
  const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
  /** A record holding Main and one active bot that was never announced, at counter 7. */
  const seedUnannounced = (kv: FakeRegistryStore) => kv.rows.set(`bots/registry/${owner.toLowerCase()}`, {
    version: 1,
    value: JSON.stringify({ v: 1, seq: 7, deleted: [], bots: [main, { ...main, key: KEY, name: "Research" }] }),
  });
  const calls = (seen: UpstreamCall[]) => seen.map(call => `${call.method} ${call.url.replace("http://bots.test", "")}`);

  test("is announced again, once, and the message is then sent", async () => {
    let sends = 0;
    const run = await setup(call => {
      if (call.method === "PUT") return Response.json({ state: "active" });
      sends += 1;
      return sends === 1 ? new Response(null, { status: 404 }) : sse(stream);
    });
    try {
      seedUnannounced(run.kv);
      const response = await fetch(`${run.base}/${KEY}/messages`, { method: "POST", headers: await run.headersFor(owner), body: JSON.stringify({ text: "ping" }) });
      expect(await response.text()).toBe(stream);
      expect(calls(run.seen)).toEqual([`POST /v1/bots/${KEY}/messages`, `PUT /v1/bots/${KEY}`, `POST /v1/bots/${KEY}/messages`]);
      expect(run.seen[1]!.body).toBe(JSON.stringify({ state: "active", seq: 7 }));
    } finally { await run.close(); }
  });

  test("is reported unavailable if the service still does not know it, and is not asked a third time", async () => {
    const run = await setup(call => (call.method === "PUT" ? Response.json({ state: "active" }) : new Response(null, { status: 404 })));
    try {
      seedUnannounced(run.kv);
      const response = await fetch(`${run.base}/${KEY}/messages`, { method: "POST", headers: await run.headersFor(owner), body: JSON.stringify({ text: "ping" }) });
      expect(await response.text()).toContain("event: error");
      expect(calls(run.seen)).toEqual([`POST /v1/bots/${KEY}/messages`, `PUT /v1/bots/${KEY}`, `POST /v1/bots/${KEY}/messages`]);
    } finally { await run.close(); }
  });

  test("is announced again, once, when its messages are read", async () => {
    let reads = 0;
    const run = await setup(call => {
      if (call.method === "PUT") return Response.json({ state: "active" });
      reads += 1;
      return reads === 1 ? new Response(null, { status: 404 }) : Response.json({ messages: [] });
    });
    try {
      seedUnannounced(run.kv);
      const response = await fetch(`${run.base}/${KEY}/messages`, { headers: await run.headersFor(owner) });
      expect([response.status, await response.json()]).toEqual([200, { messages: [] }]);
      expect(calls(run.seen)).toEqual([`GET /v1/bots/${KEY}/messages`, `PUT /v1/bots/${KEY}`, `GET /v1/bots/${KEY}/messages`]);
    } finally { await run.close(); }
  });

  test("Main is never announced: a 404 for Main is simply unavailable", async () => {
    const run = await setup(() => new Response(null, { status: 404 }));
    try {
      const response = await fetch(`${run.base}/main/messages`, { headers: await run.headersFor(owner) });
      expect(response.status).toBe(502);
      expect(calls(run.seen)).toEqual(["GET /v1/bots/main/messages"]);
    } finally { await run.close(); }
  });
});

describe("the bots a turn may message", () => {
  const KEY = "1".repeat(32);
  const OTHER = "2".repeat(32);
  const sse = () => new Response('event: done\ndata: {"messageId":"m1"}\n\n', { headers: { "content-type": "text/event-stream" } });
  const service: Upstream = call => (call.method === "PUT" ? Response.json({ state: "active" }) : sse());
  const sent = (seen: UpstreamCall[]): unknown[] => seen.filter(call => call.method === "POST").map(call => JSON.parse(call.body ?? "null"));

  test("are listed by the backend in what it sends the service, for Main and for any other bot", async () => {
    const asked: Array<[ownerDid: string, sourceKey: string]> = [];
    const run = await setup(service, { listForTurn: async (ownerDid, sourceKey) => { asked.push([ownerDid, sourceKey]); return sourceKey === "main" ? [KEY] : ["main"]; } });
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify({ name: "Research", shape: "sprout", colour: "teal" }) })).status).toBe(201);
      await (await fetch(`${run.base}/main/messages`, { method: "POST", headers, body: JSON.stringify({ text: "to main" }) })).text();
      await (await fetch(`${run.base}/${KEY}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "to research" }) })).text();
      const did = `did:pkh:eip155:1:${owner.toLowerCase()}`;
      expect(asked).toEqual([[did, "main"], [did, KEY]]);
      expect(sent(run.seen)).toEqual([{ text: "to main", messageableBotKeys: [KEY] }, { text: "to research", messageableBotKeys: ["main"] }]);
    } finally { await run.close(); }
  });

  test("cannot be named by the browser: a list in the request is not passed on", async () => {
    const run = await setup(service, { listForTurn: async () => [] });
    try {
      const headers = await run.headersFor(owner);
      await (await fetch(`${run.base}/main/messages`, { method: "POST", headers, body: JSON.stringify({ text: "hi", messageableBotKeys: [OTHER], owner: stranger }) })).text();
      expect(sent(run.seen)).toEqual([{ text: "hi" }]);
    } finally { await run.close(); }
  });

  test("are left out, and the message still goes, when the list cannot be made", async () => {
    const run = await setup(service, { listForTurn: async () => { throw new Error("record unreadable"); } });
    try {
      const response = await fetch(`${run.base}/main/messages`, { method: "POST", headers: await run.headersFor(owner), body: JSON.stringify({ text: "hi" }) });
      expect(await response.text()).toContain("event: done");
      expect(sent(run.seen)).toEqual([{ text: "hi" }]);
    } finally { await run.close(); }
  });
});

describe("the paid-send limit", () => {
  test("is applied to a send to any bot, and to nothing else on these routes", async () => {
    const KEY = "1".repeat(32);
    const limited: string[] = [];
    const service: Upstream = call => {
      if (call.method === "PUT") return Response.json({ state: "active" });
      if (call.method === "POST") return new Response('event: done\ndata: {"messageId":"m1"}\n\n', { headers: { "content-type": "text/event-stream" } });
      return Response.json({ messages: [] });
    };
    const run = await setup(service, {}, (req, _res, next) => { limited.push(`${req.method} ${req.path}`); next(); });
    try {
      const headers = await run.headersFor(owner);
      await fetch(run.base, { headers });
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify({ name: "Research", shape: "sprout", colour: "teal" }) })).status).toBe(201);
      await fetch(`${run.base}/${KEY}/messages`, { headers });
      await fetch(`${run.base}/main/messages`, { headers });
      expect(limited).toEqual([]);
      await (await fetch(`${run.base}/main/messages`, { method: "POST", headers, body: JSON.stringify({ text: "hi" }) })).text();
      await (await fetch(`${run.base}/${KEY}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "hi" }) })).text();
      expect(limited).toEqual(["POST /main/messages", `POST /${KEY}/messages`]);
    } finally { await run.close(); }
  });
});

describe("limits per plan, when that rule is switched on", () => {
  const wanted = { name: "Research", shape: "sprout", colour: "teal" };
  const announced: Upstream = () => Response.json({ state: "active" });

  test("the list shows the plan's numbers", async () => {
    const run = await setup(announced, {}, undefined, { capMode: "table", planOf: async () => "tier3" });
    try {
      const list = await (await fetch(run.base, { headers: await run.headersFor(owner) })).json();
      expect(list.capMode).toBe("table");
      expect(list.limits).toEqual({ private: { max: 3, used: 1 }, regular: { max: 5, used: 0 } });
      expect(list.canCreate).toEqual({ private: true, regular: false });
    } finally { await run.close(); }
  });

  test("an account whose private limit Main already fills cannot create a bot", async () => {
    const run = await setup(announced, {}, undefined, { capMode: "table", planOf: async () => "tier2" });
    try {
      const headers = await run.headersFor(owner);
      const refused = await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) });
      expect([refused.status, await refused.json()]).toEqual([409, { error: "bot_limit", environment: "private" }]);
      expect((await (await fetch(run.base, { headers })).json()).canCreate).toEqual({ private: false, regular: false });
      expect(run.seen).toHaveLength(0);
    } finally { await run.close(); }
  });

  test("the account's plan is asked for by its signed-in address", async () => {
    const asked: string[] = [];
    const run = await setup(announced, {}, undefined, { capMode: "table", planOf: async address => { asked.push(address); return "tier3"; } });
    try {
      await fetch(run.base, { headers: await run.headersFor(owner) });
      expect(asked.map(address => address.toLowerCase())).toEqual([owner.toLowerCase()]);
    } finally { await run.close(); }
  });

  test("when the plan cannot be read, the list has the bots and no numbers, and creating answers 503", async () => {
    for (const planOf of [async () => undefined, async () => { throw new Error("billing unreachable"); }]) {
      const run = await setup(announced, {}, undefined, { capMode: "table", planOf });
      try {
        const headers = await run.headersFor(owner);
        const list = await (await fetch(run.base, { headers })).json();
        expect(list).toEqual({ bots: [main], deleted: [], limits: null, canCreate: { private: false, regular: false }, capMode: "table" });
        const refused = await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) });
        expect([refused.status, await refused.json()]).toEqual([503, { error: "bots_unavailable" }]);
        expect((await run.registry.read(owner)).bots).toHaveLength(1);
      } finally { await run.close(); }
    }
  });
});

describe("the flat limit", () => {
  test("never asks for the account's plan", async () => {
    const asked: string[] = [];
    const run = await setup(() => Response.json({ state: "active" }), {}, undefined, { planOf: async address => { asked.push(address); return "tier1"; } });
    try {
      const headers = await run.headersFor(owner);
      await fetch(run.base, { headers });
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify({ name: "Research", shape: "sprout", colour: "teal" }) })).status).toBe(201);
      expect(asked).toEqual([]);
    } finally { await run.close(); }
  });
});

describe("renaming and restyling a bot through the routes", () => {
  const wanted = { name: "Research", shape: "sprout", colour: "teal" };
  const KEY = "1".repeat(32);
  const announced: Upstream = () => Response.json({ state: "active" });
  const created = { key: KEY, ...wanted, environment: "private", state: "active", createdAt: T0.toISOString() };

  test("a bot's new name and look are answered, and then listed", async () => {
    const run = await setup(announced);
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const changed = { ...created, name: "Reading", shape: "moon", colour: "indigo" };
      const response = await fetch(`${run.base}/${KEY}`, { method: "PATCH", headers, body: JSON.stringify({ name: "Reading", shape: "moon", colour: "indigo" }) });
      expect([response.status, await response.json()]).toEqual([200, { bot: changed }]);
      expect((await (await fetch(run.base, { headers })).json()).bots).toEqual([main, changed]);
      // The service knows a bot by its key, not by its name or look: it is told nothing.
      expect(run.seen.filter(call => call.method !== "PUT" || !call.url.endsWith(KEY))).toEqual([]);
      expect(run.seen).toHaveLength(1);
    } finally { await run.close(); }
  });

  test("Main can be renamed and restyled, and keeps its key", async () => {
    const run = await setup(announced);
    try {
      const headers = await run.headersFor(owner);
      const response = await fetch(`${run.base}/main`, { method: "PATCH", headers, body: JSON.stringify({ name: "Home base", colour: "red" }) });
      expect([response.status, await response.json()]).toEqual([200, { bot: { ...main, name: "Home base", colour: "red" } }]);
    } finally { await run.close(); }
  });

  test("a refusal answers with its code and changes nothing", async () => {
    const run = await setup(announced);
    try {
      const headers = await run.headersFor(owner);
      const theirs = await run.headersFor(stranger);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const cases: Array<[who: Record<string, string>, key: string, body: unknown, status: number, error: string]> = [
        [headers, KEY, {}, 400, "invalid"],
        [headers, KEY, { name: "" }, 400, "invalid_name"],
        [headers, KEY, { shape: "square" }, 400, "invalid_shape"],
        [headers, KEY, { colour: "#ffffff" }, 400, "invalid_colour"],
        [headers, KEY, { name: "main" }, 409, "name_taken"],
        [headers, "9".repeat(32), { name: "New" }, 404, "not_found"],
        [headers, "Research", { name: "New" }, 404, "not_found"],
        [theirs, KEY, { name: "New" }, 404, "not_found"],
      ];
      for (const [who, key, body, status, error] of cases) {
        const response = await fetch(`${run.base}/${key}`, { method: "PATCH", headers: who, body: JSON.stringify(body) });
        expect([key, body, response.status, await response.json()]).toEqual([key, body, status, { error }]);
      }
      expect((await run.registry.read(owner)).bots).toEqual([main, created]);
    } finally { await run.close(); }
  });

  test("only the name, shape and colour are taken from the request", async () => {
    const run = await setup(announced);
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const forged = { name: "Reading", key: "f".repeat(32), state: "deleting", environment: "regular", createdAt: "1999-01-01T00:00:00.000Z", owner: stranger };
      const response = await fetch(`${run.base}/${KEY}`, { method: "PATCH", headers, body: JSON.stringify(forged) });
      expect([response.status, await response.json()]).toEqual([200, { bot: { ...created, name: "Reading" } }]);
    } finally { await run.close(); }
  });
});

describe("deleting a bot through the routes", () => {
  const wanted = { name: "Research", shape: "sprout", colour: "teal" };
  const KEY = "1".repeat(32);
  const announced: Upstream = () => Response.json({ state: "active" });
  const leaving = { key: KEY, ...wanted, environment: "private", state: "deleting", createdAt: T0.toISOString(), deletingSince: T0.toISOString() };
  const puts = (seen: UpstreamCall[]) => seen.filter(call => call.method === "PUT").map(call => [call.url.replace("http://bots.test", ""), JSON.parse(call.body ?? "null")]);

  test("the bot is marked as being deleted, the service is told under the record's counter, and the work is handed on", async () => {
    const handed: Array<[string, string]> = [];
    const run = await setup(announced, {}, undefined, { onDeleting: (address, key) => { handed.push([address, key]); } });
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const response = await fetch(`${run.base}/${KEY}`, { method: "DELETE", headers });
      expect([response.status, await response.json()]).toEqual([202, { bot: leaving }]);
      const row = await run.registry.read(owner);
      expect(row.bots[1]).toEqual(leaving);
      expect(puts(run.seen).at(-1)).toEqual([`/v1/bots/${KEY}`, { state: "deleting", seq: row.seq }]);
      // The address handed on is the session's own, which is lower-case whatever case the account signed in with.
      expect(handed).toEqual([[owner.toLowerCase(), KEY]]);
      // Asked again, the answer is the same and nothing is written.
      const again = await fetch(`${run.base}/${KEY}`, { method: "DELETE", headers });
      expect([again.status, await again.json()]).toEqual([202, { bot: leaving }]);
      expect((await run.registry.read(owner)).seq).toBe(row.seq);
    } finally { await run.close(); }
  });

  test("the owner's list shows when the deletion began and none of its bookkeeping, and a deleted bot by key and name only", async () => {
    const run = await setup(announced);
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      expect((await fetch(`${run.base}/${KEY}`, { method: "DELETE", headers })).status).toBe(202);
      await run.registry.closeGrant(owner, KEY, "cid-1");
      const during = await (await fetch(run.base, { headers })).json();
      expect(during.bots).toEqual([main, leaving]);
      // Asked again while its permission is closed, the answer still carries none of it.
      expect(await (await fetch(`${run.base}/${KEY}`, { method: "DELETE", headers })).json()).toEqual({ bot: leaving });
      expect(await run.registry.finishDelete(owner, KEY)).toBe(true);
      const after = await (await fetch(run.base, { headers })).json();
      expect([after.bots, after.deleted]).toEqual([[main], [{ key: KEY, name: "Research" }]]);
      expect(JSON.stringify([during, after])).not.toContain("cid-1");
    } finally { await run.close(); }
  });

  test("a refusal answers with its code and changes nothing", async () => {
    const run = await setup(announced);
    try {
      const headers = await run.headersFor(owner);
      const theirs = await run.headersFor(stranger);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const before = (await run.registry.read(owner)).seq;
      const cases: Array<[who: Record<string, string>, key: string, status: number, error: string]> = [
        [headers, "main", 409, "main_fixed"],
        [headers, "9".repeat(32), 404, "not_found"],
        [headers, "Research", 404, "not_found"],
        [theirs, KEY, 404, "not_found"],
      ];
      for (const [who, key, status, error] of cases) {
        const response = await fetch(`${run.base}/${key}`, { method: "DELETE", headers: who });
        expect([key, response.status, await response.json()]).toEqual([key, status, { error }]);
      }
      expect((await run.registry.read(owner)).seq).toBe(before);
      expect(puts(run.seen)).toHaveLength(1);
    } finally { await run.close(); }
  });

  test("with three deletions under way a fourth is refused", async () => {
    const run = await setup(announced);
    try {
      const headers = await run.headersFor(owner);
      const bot = (digit: string, state: string) => ({ ...main, key: digit.repeat(32), name: `Bot ${digit}`, state, ...(state === "deleting" ? { deletingSince: T0.toISOString() } : {}) });
      run.kv.rows.set(`bots/registry/${owner.toLowerCase()}`, { version: 1, value: JSON.stringify({ v: 1, seq: 9, deleted: [], bots: [main, bot("1", "deleting"), bot("2", "deleting"), bot("3", "deleting"), bot("4", "active")] }) });
      const response = await fetch(`${run.base}/${"4".repeat(32)}`, { method: "DELETE", headers });
      expect([response.status, await response.json()]).toEqual([409, { error: "delete_limit" }]);
      expect(run.seen).toEqual([]);
    } finally { await run.close(); }
  });

  test("a deletion stands when the service cannot be told", async () => {
    const handed: string[] = [];
    const run = await setup(call => (call.method === "PUT" && call.body?.includes("deleting") ? Promise.reject(new Error("down")) : Response.json({ state: "active" })), {}, undefined, { onDeleting: (_address, key) => { handed.push(key); } });
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify(wanted) })).status).toBe(201);
      const response = await fetch(`${run.base}/${KEY}`, { method: "DELETE", headers });
      expect([response.status, await response.json()]).toEqual([202, { bot: leaving }]);
      expect((await run.registry.read(owner)).bots[1]).toEqual(leaving);
      expect(handed).toEqual([KEY]);
    } finally { await run.close(); }
  });
});

describe("a bot that cannot be reached", () => {
  test("a bot other than Main answers in these exact words, and Main keeps its own", async () => {
    const run = await setup(call => (call.method === "PUT" ? Response.json({ state: "active" }) : new Response("no", { status: 500 })));
    try {
      const headers = await run.headersFor(owner);
      expect((await fetch(run.base, { method: "POST", headers, body: JSON.stringify({ name: "Research", shape: "sprout", colour: "teal" }) })).status).toBe(201);
      const other = await fetch(`${run.base}/${"1".repeat(32)}/messages`, { headers });
      expect([other.status, await other.json()]).toEqual([502, { error: "bot_unavailable", message: "This bot can't be reached right now. Try again shortly." }]);
      const mainBot = await fetch(`${run.base}/main/messages`, { headers });
      expect([mainBot.status, await mainBot.json()]).toEqual([502, { error: "bot_unavailable", message: "Main isn't available. Try again later." }]);
    } finally { await run.close(); }
  });
});
