// Loopback-only exercise of the record of an owner's bots against a real TinyCloud node (TC-3325): the conditional
// writes it depends on, with the node's real versions, through the same storage lane the backend uses. It writes only
// the backend's own record of bots: no permission and no history record. No production accounts, services or keys.
// Needs a local TinyCloud node: BOTS_REGISTRY_TEST_NODE=http://127.0.0.1:<port>.
//
// A client library may contact hosts of its own choosing. Left to its default, this one looks every session owner up
// in the public location registry, which is not on this machine, and with no registry at all it refuses to sign in.
// So this test gives it a stand-in registry on this machine that knows no owner, and every request this process
// makes is checked: one to anything but 127.0.0.1 is refused, and the test fails.
import { afterAll, expect, test } from "bun:test";
import express from "express";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BotsRegistry, type RegistryKv } from "../bots-registry.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { botsFromEnv, createBotsRouter } from "../routes/bots.js";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { loopbackOnly } from "./helpers/loopback-only.js";
import { emptyLocationRegistry } from "./helpers/empty-location-registry.js";

const host = process.env.BOTS_REGISTRY_TEST_NODE;
const wanted = (name: string) => ({ name, shape: "sprout", colour: "teal" });
const realFetch = globalThis.fetch;
const guard = loopbackOnly(realFetch);
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const cleanup of cleanups) await cleanup();
  // Said here too, so that a run which failed early still shows whether anything tried to leave this machine.
  if (guard.refused.length > 0) console.error(`requests refused because they were not to this machine: ${guard.refused.join(", ")}`);
});

test.skipIf(!host)("real TinyCloud: an owner's record is created once, creates at the same moment stay within the limit, and the routes work on it", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  globalThis.fetch = guard.fetch;
  const registry = await emptyLocationRegistry();
  cleanups.push(registry.close);
  const backend = new TinyCloudNode({ privateKey: generatePrivateKey(), host, prefix: "bots-registry-test", includeAccountRegistryPermissions: false, tinycloudRegistryUrl: registry.url });
  await backend.signIn();
  await backend.hostOwnedSpace("bots-registry-test");
  // As in the backend's startup: reads go straight to the node, writes through the one storage lane.
  const lane = new BackendStorageLane();
  const kv: RegistryKv = { get: (key, options) => backend.kv.get(key, options), put: (key, value, options) => lane.run(() => backend.kv.put(key, value, options)) };
  // Two registries over the same space, as two backend processes would be.
  const a = new BotsRegistry(kv);
  const b = new BotsRegistry(kv);

  // 1. The record itself.
  const owner = privateKeyToAccount(generatePrivateKey()).address;
  const [fromA, fromB] = await Promise.all([a.read(owner), b.read(owner)]);
  expect(fromA).toEqual(fromB);
  expect(fromA.bots.map(bot => bot.key)).toEqual(["main"]);
  const results = await Promise.all([a.create(owner, wanted("One"), 3), b.create(owner, wanted("Two"), 3), a.create(owner, wanted("Three"), 3), b.create(owner, wanted("Four"), 3)]);
  const created = results.flatMap(result => (result.ok ? [result.bot.key] : []));
  expect(created).toHaveLength(2);
  expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "bot_limit" }, { ok: false, error: "bot_limit" }]);
  const after = await b.read(owner);
  expect(after.bots).toHaveLength(3);
  expect(after.bots.slice(1).map(bot => bot.key).sort()).toEqual([...created].sort());
  // One write for the first record and one for each bot that was created; a refused create writes nothing.
  expect(after.seq).toBe(3);
  expect(await a.admit(owner, "main", created[0]!)).toEqual({ admitted: true });
  expect(await a.listForTurn(owner, "main")).toHaveLength(2);

  // 2. The routes, over the same real record store, with a stand-in for the bots service.
  const sessionKey = generatePrivateKey();
  const account = privateKeyToAccount(generatePrivateKey()).address;
  const seen: Array<{ method: string; url: string; body: string | undefined }> = [];
  const fetchImpl = (async (input, init) => {
    const method = init?.method ?? "GET";
    seen.push({ method, url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    if (method === "PUT") return Response.json({ state: "active" });
    if (method === "POST") return new Response('event: done\ndata: {"messageId":"m1"}\n\n', { headers: { "content-type": "text/event-stream" } });
    return Response.json({ messages: [] });
  }) as typeof fetch;
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: "*", BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: "bots-test-secret-not-real" })!;
  const app = express();
  app.use(express.json());
  app.use(createCsrfMiddleware());
  app.use("/api/bots", createBotsRouter({ config: { ...config, fetchImpl }, authMiddleware: createAuthMiddleware(sessionKey), registry: a }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}/api/bots`;
    const headers = { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(account, sessionKey)).token}` };
    const create = (name: string) => fetch(base, { method: "POST", headers, body: JSON.stringify(wanted(name)) });

    const empty = await (await fetch(base, { headers })).json();
    expect(empty.bots.map((bot: { key: string }) => bot.key)).toEqual(["main"]);
    expect(empty.limits).toEqual({ private: { max: 3, used: 1 }, regular: { max: 0, used: 0 } });
    expect(empty.canCreate).toEqual({ private: true, regular: false });
    expect(empty.capMode).toBe("flat3");

    const one = await create("Research");
    const two = await create("Notes");
    expect([one.status, two.status]).toEqual([201, 201]);
    const research = (await one.json()).bot as { key: string; name: string };
    expect(research.name).toBe("Research");
    expect(research.key).toMatch(/^[0-9a-f]{32}$/);
    const refused = await create("Third");
    expect([refused.status, await refused.json()]).toEqual([409, { error: "bot_limit", environment: "private" }]);

    const full = await (await fetch(base, { headers })).json();
    expect(full.bots.map((bot: { name: string }) => bot.name)).toEqual(["Main", "Research", "Notes"]);
    expect(full.limits.private).toEqual({ max: 3, used: 3 });
    expect(full.canCreate.private).toBe(false);

    expect((await fetch(`${base}/${research.key}/messages`, { headers })).status).toBe(200);
    const sent = await fetch(`${base}/${research.key}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "ping" }) });
    expect(await sent.text()).toContain("event: done");
    expect((await fetch(`${base}/${"9".repeat(32)}/messages`, { headers })).status).toBe(404);

    // The service was told about each new bot, as active, under a rising counter, and the turn listed the bots it may message.
    const announced = seen.filter(call => call.method === "PUT").map(call => JSON.parse(call.body ?? "{}") as { state: string; seq: number });
    expect(announced.map(entry => entry.state)).toEqual(["active", "active"]);
    expect(announced[1]!.seq).toBeGreaterThan(announced[0]!.seq);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: `http://bots.test/v1/bots/${research.key}/messages`, body: JSON.stringify({ text: "ping" }) });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  // Nothing this test did tried to reach a host other than this machine, and the registry it consulted was the stand-in.
  expect(guard.refused).toEqual([]);
  expect(registry.asked.length).toBeGreaterThan(0);
  console.info(`location registry stand-in was asked ${registry.asked.length} time(s): ${[...new Set(registry.asked.map(line => line.replace(/did[^/?]*/g, "<owner>")))].join(", ")}`);
}, 120_000);
