import { describe, expect, test } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { BotsRegistry } from "../bots-registry.js";
import { botsFromEnv, createBotsRouter } from "../routes/bots.js";
import { fakeRegistryStore, type FakeRegistryStore } from "./helpers/fake-registry-store.js";

const sessionKey = `0x${"03".repeat(32)}`;
const owner = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const stranger = "0x2222222222222222222222222222222222222222";
const secret = "bots-test-secret-not-real";
const T0 = new Date("2026-11-19T00:00:00.000Z");

interface UpstreamCall { method: string; url: string; headers: Headers; body: string | undefined }
type Upstream = (call: UpstreamCall) => Response | Promise<Response>;

/** The real router on a local port, with real session tokens, a registry over a fake store, and a recording stand-in for the bots service. */
async function setup(upstream: Upstream = () => Response.json({})) {
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
  app.use("/api/bots", createBotsRouter({ config: { ...config, fetchImpl }, authMiddleware: createAuthMiddleware(sessionKey), registry }));
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
      expect(run.seen[0]!.headers.get("x-tinycloud-owner")).toBe(`did:pkh:eip155:1:${owner.toLowerCase()}`);
      expect(run.seen[0]!.headers.get("authorization")).toBe(`Bearer ${secret}`);
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
      expect(run.seen[0]!.headers.get("x-tinycloud-owner")).toBe(`did:pkh:eip155:1:${owner.toLowerCase()}`);
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
      expect(call.headers.get("x-tinycloud-owner")).toBe(`did:pkh:eip155:1:${owner.toLowerCase()}`);
      expect(call.headers.get("authorization")).toBe(`Bearer ${secret}`);
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
      expect(call.headers.get("x-tinycloud-owner")).toBe(`did:pkh:eip155:1:${owner.toLowerCase()}`);
      expect(call.headers.get("authorization")).toBe(`Bearer ${secret}`);
    } finally { await run.close(); }
  });

  const SUSPENDED = "5".repeat(32);
  const DELETING = "d".repeat(32);
  /** Puts a record straight into the store: Main, one suspended bot and one that is being deleted. */
  const seedStates = (kv: FakeRegistryStore) => kv.rows.set(`bots/registry/${owner.toLowerCase()}`, {
    version: 1,
    value: JSON.stringify({ v: 1, seq: 4, deleted: [], bots: [main, { ...main, key: SUSPENDED, name: "Paused", state: "suspended" }, { ...main, key: DELETING, name: "Leaving", state: "deleting" }] }),
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
