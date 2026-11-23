import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { signedCallHeader } from "../bots-signed-call.js";
import { createTrustBotReadsInternalRouter, createTrustBotReadsRouter, TRUSTBOT_READS_INTERNAL_PREFIX } from "../routes/trustbot-reads.js";
import type { BotsConfig } from "../routes/bots.js";
import { areaResources } from "../trustbot-reads/areas.js";
import { THREADS_DATABASE } from "../trustbot-reads/feed-chat.js";
import { TrustBotReadGrants, TRUSTBOT_READ_GRANT_KEY_PREFIX } from "../trustbot-reads/grants.js";
import { backendGrantStore } from "../trustbot-reads/setup.js";
import { fakeBackendNode } from "./helpers/fake-backend-node";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const now = Date.parse("2026-11-23T12:00:00Z");
const day = 86_400_000;
const secret = "c".repeat(64);
const did = "did:pkh:eip155:1:0x" + "22".repeat(20);
const { node, values } = fakeBackendNode();
const db = new Database(":memory:");
const reached: string[] = [];
const options = {
  reader: { did, computeDelegationCid } as Pick<TinyCloudNode, "did" | "useDelegation" | "computeDelegationCid">,
  store: backendGrantStore(node), host: "http://127.0.0.1:9137", sealSecret: new Uint8Array(32).fill(7), now: () => now,
  activate: async () => ({ sql: { db: (database: string) => ({ query: async (sql: string, params: Array<string | number | null>) => {
    expect(database).toBe(THREADS_DATABASE);
    reached.push(sql);
    return { ok: true, data: { columns: [], rows: db.query(sql).values(...params), rowCount: 0 } };
  } }) } }) as never,
};
const grants = new TrustBotReadGrants(options);
let address: string;
let spaceId: string;
let base: string;
let server: Server;
const sign = (days: number) => makeSignedTranscriptGrant({
  now, audience: did, expiresAt: (now + days * day) / 1000,
  att: Object.fromEntries(areaResources(["feed_chats"]).map(({ service, path, actions }) => [
    `${spaceId}/${service}/${path}`, Object.fromEntries(actions.map(action => [action, [{}]])),
  ])),
}).then(({ serialized, siwe, signature }) => ({ serialized, siwe, signature }));

beforeAll(async () => {
  ({ address, spaceId } = await makeSignedTranscriptGrant({ now }));
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT)");
  db.run("CREATE TABLE messages (thread_id TEXT, position INTEGER, payload TEXT, created_at TEXT)");
  for (const [id, title, updated] of [["denied", "private search phrase", "2026-11-23"], ["allowed", "allowed search phrase", "2026-11-22"]]) {
    db.run("INSERT INTO threads VALUES (?, ?, ?)", [id!, title!, updated!]);
    db.run("INSERT INTO messages VALUES (?, 0, ?, ?)", [id!, JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `${id} content` }] } }), updated!]);
  }
  await grants.enable(address, "feed_chats", await sign(1));
  const config = { serviceUrl: "http://bots.test", serviceSecret: "s", postTimeoutMs: 1000,
    accountAllowed: (who: string) => who.toLowerCase() === address.toLowerCase(), fetchImpl: async () => new Response(null, { status: 204 }) } as BotsConfig;
  const app = express();
  app.use("/owner", createTrustBotReadsRouter({ grants, config, auth: (req, _res, next) => { req.user = { address } as never; next(); } }));
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX, createTrustBotReadsInternalRouter({ grants, config, callSecret: secret }));
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); db.close(); });

async function post(tool: string, args: unknown) {
  const path = `${TRUSTBOT_READS_INTERNAL_PREFIX}/${tool}`;
  const body = JSON.stringify({ args });
  const authorization = signedCallHeader(secret, { direction: "to-backend", environment: "private", owner: `did:pkh:eip155:1:${address.toLowerCase()}`, bot: "main", method: "POST", path, body });
  return fetch(`${base}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body }).then(response => response.json());
}
async function deny(chat: string, denied: boolean) {
  const response = await fetch(`${base}/owner/chats/${encodeURIComponent(chat)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ denied }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

test("owner denial removes chat titles from list and search before gateway text, without hiding allowed chats", async () => {
  expect(await deny("denied", true)).toEqual({ deniedChatIds: ["denied"] });
  for (const args of [{ limit: 1 }, { query: "search phrase", limit: 1 }]) {
    const answer = await post("list_chats", args);
    expect(answer.ok).toBe(true);
    expect(JSON.parse(answer.text).chats).toEqual([{ chat: "allowed", title: "allowed search phrase", updated_at: "2026-11-22" }]);
    expect(JSON.stringify(answer)).not.toContain("private");
    expect(JSON.stringify(answer)).not.toContain("denied");
  }
});

test("direct denied reads are not_found before any chat SQL; allowed reads retain their messages", async () => {
  await deny("denied", true);
  reached.length = 0;
  expect(await post("read_chat", { chat: "denied" })).toEqual({ ok: false, error: "not_found", code: "not_found" });
  expect(reached).toEqual([]);
  const answer = await post("read_chat", { chat: "allowed" });
  expect(JSON.parse(answer.text).messages[0].text).toBe("allowed content");
  expect(answer.text).not.toContain("denied content");
});

test("denials share the sealed settings key and survive renewal, area-off, re-enable and backend restart", async () => {
  await deny("denied", true);
  const prior = (await grants.status(address)).grantCid!;
  await grants.renew(address, prior, await sign(2));
  await grants.disable(address, "feed_chats");
  expect((await grants.status(address)).areas.feed_chats).toBe("off");
  const restarted = new TrustBotReadGrants(options);
  expect(await restarted.deniedChatIds(address)).toEqual(new Set(["denied"]));
  expect([...values.keys()]).toEqual([`${TRUSTBOT_READ_GRANT_KEY_PREFIX}${address.toLowerCase()}`]);
  expect(JSON.stringify([...values.values()])).not.toContain("denied");
  await restarted.enable(address, "feed_chats", await sign(3));
  expect(await restarted.deniedChatIds(address)).toEqual(new Set(["denied"]));
  await restarted.setChatDenied(address, "denied", false);
  expect(await grants.deniedChatIds(address)).toEqual(new Set());
  expect((await post("read_chat", { chat: "denied" })).text).toContain("denied content");
});

test("a new owner can deny a chat before enabling reads and other owners have separate defaults", async () => {
  const other = "0x" + "33".repeat(20);
  await grants.setChatDenied(other, "before-on", true);
  expect(await new TrustBotReadGrants(options).deniedChatIds(other)).toEqual(new Set(["before-on"]));
  expect((await grants.status(other)).grantCid).toBeNull();
  expect(await grants.deniedChatIds("0x" + "44".repeat(20))).toEqual(new Set());
  expect(await grants.deniedChatIds(address)).not.toContain("before-on");
});

test("unreadable deny settings fail closed instead of leaking chat content", async () => {
  const key = `${TRUSTBOT_READ_GRANT_KEY_PREFIX}${address.toLowerCase()}`;
  const saved = values.get(key)!;
  values.set(key, "corrupt");
  try {
    for (const [tool, args] of [["list_chats", {}], ["read_chat", { chat: "denied" }]] as const) {
      expect(await post(tool, args)).toEqual({ ok: false, error: "unavailable" });
    }
  } finally { values.set(key, saved); }
});

test("concurrent per-chat changes preserve both owner decisions", async () => {
  const owner = "0x" + "55".repeat(20);
  await Promise.all([
    grants.setChatDenied(owner, "first", true),
    grants.setChatDenied(owner, "second", true),
  ]);
  expect(await new TrustBotReadGrants(options).deniedChatIds(owner)).toEqual(new Set(["first", "second"]));
});

test("the owner settings and signed gateway lookup return the same fresh deny list", async () => {
  await deny("denied", true);
  const ownerSettings = await fetch(`${base}/owner/chats/denied`).then(response => response.json());
  expect(ownerSettings).toEqual({ deniedChatIds: ["denied"] });
  expect(await post("read_status", {})).toEqual({ ...ownerSettings, enabledReadAreas: ["feed_chats"] });
  await grants.disable(address, "feed_chats");
  expect(await post("read_status", {})).toEqual({ ...ownerSettings, enabledReadAreas: [] });
  const response = await fetch(`${base}${TRUSTBOT_READS_INTERNAL_PREFIX}/read_status`, { method: "POST" });
  expect(response.status).toBe(401);
});
