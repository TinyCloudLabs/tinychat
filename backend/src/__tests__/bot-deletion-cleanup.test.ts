// Deleting a bot, end to end in the backend (TC-3325).
//
// Real here: the routes, the record of bots, how a grant is stored, and the deletion runner wired as startup wires
// it. Stand-ins: the node (its storage is a map) and the bots service (it records what it is sent and answers that
// the bot's working state is gone).
import { describe, expect, test } from "bun:test";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { makeSignedTranscriptGrant, computeDelegationCid } from "./helpers/transcript-grant";
import { BotDeletions } from "../bot-deletion.js";
import { BotHistory, HISTORY_PREFIX, historyBotId } from "../bot-history";
import { BotsRegistry } from "../bots-registry.js";
import { botsFromEnv, createBotsRouter, removeBotFromService, type BotsConfig } from "../routes/bots.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";

const ownerKey = `0x${"11".repeat(32)}` as const;
const backendKey = `0x${"22".repeat(32)}` as const;
const SERVICE_KEY = "bots-service-test-value-0123456789";
const address = privateKeyToAccount(ownerKey).address;
const session = address.toLowerCase();
const backendDid = "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810";
const host = "http://127.0.0.1:9137";
const KEY = "1".repeat(32);
const space = makePkhSpaceId(address, 1, "applications");
const actions = { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] };
const uri = (key?: string) => `${space}/kv/${HISTORY_PREFIX}${historyBotId(address, key)}/`;
const storedAt = (key?: string) => `bot-history/grants/${session}${key ? `/${key}` : ""}`;
const missing = (key: string) => ({ ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } });
const NEW_BOT = { name: "Research", shape: "sprout", colour: "teal" };

async function grantFor(key?: string) {
  const grant = await makeSignedTranscriptGrant({ privateKey: ownerKey, att: { [uri(key)]: actions } });
  return { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature };
}

/** Everything printed while `run` is under way. */
async function withOutputCaptured<T>(run: () => Promise<T>): Promise<{ result: T; printed: string }> {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const original = methods.map(method => console[method]);
  const lines: string[] = [];
  methods.forEach(method => {
    console[method] = (...args: unknown[]) => { lines.push(args.map(arg => (typeof arg === "string" ? arg : arg instanceof Error ? `${arg.stack ?? arg.message}` : JSON.stringify(arg))).join(" ")); };
  });
  try {
    return { result: await run(), printed: lines.join("\n") };
  } finally {
    methods.forEach((method, index) => { console[method] = original[index]!; });
  }
}

async function world() {
  const entries = new Map<string, unknown>();
  const node = { used: [] as string[], asked: [] as string[] };
  const fake = {
    did: backendDid,
    computeDelegationCid,
    useDelegation: async (delegation: { cid: string }) => { node.used.push(delegation.cid); return {}; },
    // Answers as a local node answered.
    revokeDelegation: async (cid: string) => { node.asked.push(cid); return { ok: false, error: { code: "REVOCATION_FAILED", message: "not carried out" } }; },
    kv: {
      put: async (key: string, value: unknown) => { entries.set(key, value); return { ok: true, data: {} }; },
      get: async (key: string) => (entries.has(key) ? { ok: true, data: { data: entries.get(key) } } : missing(key)),
      delete: async (key: string) => {
        if (!entries.has(key)) return missing(key);
        entries.delete(key);
        return { ok: true, data: undefined };
      },
      list: async (request: { prefix: string }) => ({ ok: true, data: { keys: [...entries.keys()].filter(key => key.startsWith(request.prefix)) } }),
    },
  } as unknown as TinyCloudNode;
  const history = new BotHistory(fake, backendKey, host);
  const kv = fakeRegistryStore();
  const registry = new BotsRegistry(kv, { now: () => new Date("2026-11-19T00:00:00.000Z"), newKey: () => KEY });

  const sentToService: string[] = [];
  const fetchImpl = (async (input, init) => {
    const method = init?.method ?? "GET";
    sentToService.push(`${method} ${String(input)} ${JSON.stringify(Object.fromEntries(new Headers(init?.headers)))} ${typeof init?.body === "string" ? init.body : ""}`);
    if (method === "DELETE") return Response.json({ outcome: "gone" });
    return Response.json({ state: "active" });
  }) as typeof fetch;
  const config: BotsConfig = { ...botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: "*", BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: SERVICE_KEY })!, fetchImpl };

  // The deletion runner, with the same wiring as the backend's startup.
  const deletions = new BotDeletions({
    registry,
    removeFromService: (owner, key, seq) => removeBotFromService(config, owner, key, seq),
    storedGrantCid: (owner, key) => history.storedGrantCid(owner, key),
    forgetGrant: (owner, key) => history.forget(owner, key),
    revoke: cid => history.revoke(cid),
  });
  const carried = { out: Promise.resolve<unknown>(undefined) };
  const auth: express.RequestHandler = (req, _res, next) => { req.user = { address: session } as typeof req.user; next(); };
  const app = express();
  app.use(express.json({ limit: "96kb" }));
  app.use("/api/bots", createBotsRouter({ config, authMiddleware: auth, registry, onDeleting: (owner, key) => { carried.out = deletions.run(owner, key); } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const listening = server.address();
  if (listening === null || typeof listening === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${listening.port}/api/bots`;
  const json = { "content-type": "application/json" };
  const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, { method, headers: json, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  /** Everything the backend has stored, in both of its stores, as one text. */
  const everythingStored = () => [...entries].map(([key, value]) => `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .concat([...kv.rows].map(([key, row]) => `${key} ${row.value}`)).join("\n");
  /** Deletes the bot through its route and waits for the deletion to be carried out. */
  const deleteBot = async () => {
    expect((await call("DELETE", `/${KEY}`)).status).toBe(202);
    expect(await carried.out).toBe("deleted");
  };
  return { entries, node, history, registry, sentToService, call, deleteBot, everythingStored, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** The texts looked for, by name. */
function partsOf(grant: { serialized: string; siwe: string; signature: string }) {
  const bundle = JSON.parse(grant.serialized) as { cid: string; delegationHeader: { Authorization: string } };
  return {
    cid: bundle.cid,
    named: {
      "the grant as presented": grant.serialized,
      "the grant's token": bundle.delegationHeader.Authorization.replace(/^Bearer /i, ""),
      "the sign-in message": grant.siwe,
      "the signature": grant.signature,
      "the backend's value": backendKey.slice(2),
      "the service's value": SERVICE_KEY,
    },
  };
}
const foundIn = (text: string, named: Record<string, string>) => Object.entries(named).filter(([, value]) => text.includes(value)).map(([name]) => name);

describe("deleting a bot that has a history grant", () => {
  test("deleting a bot removes its stored grant", async () => {
    const run = await world();
    try {
      const grant = await grantFor(KEY);
      const { cid, named } = partsOf(grant);
      // The search used below finds these texts where they are: here, in the grant itself, as it is and inside an
      // encoded body.
      expect(foundIn([grant.serialized, grant.siwe, grant.signature].join("\n"), named))
        .toEqual(["the grant as presented", "the grant's token", "the sign-in message", "the signature"]);
      expect(foundIn(JSON.stringify({ wrapped: grant }), named)).toEqual(["the grant's token", "the signature"]);

      const { printed } = await withOutputCaptured(async () => {
        expect((await run.call("POST", "", NEW_BOT)).status).toBe(201);
        await run.history.accept(address, grant, KEY);

        // Before: one stored copy, under this bot's own entry.
        expect([...run.entries.keys()]).toEqual([storedAt(KEY)]);
        expect(foundIn(run.everythingStored(), named)).toEqual([]);
        expect(run.node.used).toContain(cid);

        await run.deleteBot();
      });

      // After: the store of grants is empty.
      expect([...run.entries.keys()]).toEqual([]);
      expect(foundIn(run.everythingStored(), named)).toEqual([]);
      // The bots service was asked to remove the bot. The calls to it are searched for the same texts.
      expect(run.sentToService.some(call => call.startsWith(`DELETE http://bots.test/v1/bots/${KEY} `))).toBe(true);
      expect(foundIn(run.sentToService.join("\n"), named)).toEqual([]);
      // So is everything printed along the way.
      expect(foundIn(printed, named)).toEqual([]);
      // The list shows the bot as deleted, by key and name.
      const list = await (await run.call("GET", "")).text();
      expect(JSON.parse(list).deleted).toEqual([{ key: KEY, name: "Research" }]);
      expect(foundIn(list, { ...named, "its cid": cid })).toEqual([]);
    } finally { await run.close(); }
  });

  test("after deletion, saves with the bot's grant are refused", async () => {
    const run = await world();
    try {
      expect((await run.call("POST", "", NEW_BOT)).status).toBe(201);
      await run.history.accept(address, await grantFor(KEY), KEY);
      await run.deleteBot();

      const batch = { v: 1, generation: "0".repeat(32), seq: 1, challenge: "1".repeat(64), record: { type: "user", text: "hi" }, bot: KEY };
      await expect(run.history.archive(address, batch, async () => {}, KEY)).rejects.toThrow("history_grant_missing");
      expect(await run.history.storedGrantCid(address, KEY)).toBeUndefined();
    } finally { await run.close(); }
  });

  test("deletion marks the bot deleted in its record and asks the node once", async () => {
    const run = await world();
    try {
      const grant = await grantFor(KEY);
      const { cid } = partsOf(grant);
      expect((await run.call("POST", "", NEW_BOT)).status).toBe(201);
      await run.history.accept(address, grant, KEY);
      await run.deleteBot();

      expect(run.node.asked).toEqual([cid]);
      expect((await run.registry.read(session)).deleted).toEqual([{ key: KEY, name: "Research", revoke: { cid } }]);
    } finally { await run.close(); }
  });

  test("deleting a bot leaves Main's grant as it is", async () => {
    const run = await world();
    try {
      await run.history.accept(address, await grantFor());
      expect((await run.call("POST", "", NEW_BOT)).status).toBe(201);
      await run.history.accept(address, await grantFor(KEY), KEY);
      expect([...run.entries.keys()].sort()).toEqual([storedAt(), storedAt(KEY)].sort());
      await run.deleteBot();
      expect([...run.entries.keys()]).toEqual([storedAt()]);
    } finally { await run.close(); }
  });
});
