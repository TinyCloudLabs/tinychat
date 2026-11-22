// History routes for bots other than Main (TC-3813): /api/bots/:key/history/{grant,notice,notice/ack}. The owner
// comes from the session and the key from the URL, checked against that owner's record; each call to the service is
// signed for exactly that bot. The service is a stand-in that checks calls with the service's own signing module.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { makeSignedTranscriptGrant, computeDelegationCid } from "./helpers/transcript-grant";
import { BotHistory, HISTORY_PREFIX, historyBotId } from "../bot-history";
import type { Bot, OwnerBots } from "../bots-registry";
import { createAuthMiddleware } from "../middleware/auth";
import { createBotHistoryRouter, createSiblingHistoryRouter } from "../routes/bot-history";
import { createBotsRouter, type BotsConfig } from "../routes/bots";
import * as serviceCalls from "../../../bots/src/signed-call";

const ownerKey = `0x${"11".repeat(32)}` as const;
const owner = privateKeyToAccount(ownerKey).address;
const other = privateKeyToAccount(`0x${"44".repeat(32)}`).address;
const notListed = privateKeyToAccount(`0x${"55".repeat(32)}`).address;
const jwtKey = `0x${"03".repeat(32)}`;
const secret = "b".repeat(64);
const backendDid = "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810";
const host = "http://127.0.0.1:9137";
const KEY_A = "ab".repeat(16);
const KEY_B = "cd".repeat(16);
const KEY_DELETING = "de".repeat(16);
const KEY_OTHERS = "ef".repeat(16);
const space = makePkhSpaceId(owner, 1, "applications");
const actions = { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] };
const uri = (key?: string) => `${space}/kv/${HISTORY_PREFIX}${historyBotId(owner, key)}/`;
const grantFor = async (key?: string) => {
  const grant = await makeSignedTranscriptGrant({ privateKey: ownerKey, att: { [uri(key)]: actions } });
  return { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature };
};
const bot = (key: string, state: Bot["state"] = "active"): Bot => ({
  key, name: key.slice(0, 4), shape: "pebble", colour: "blue", environment: "private", state, createdAt: "2026-11-01T00:00:00.000Z",
  ...(state === "deleting" ? { deletingSince: "2026-11-02T00:00:00.000Z" } : {}),
});
const rows: Record<string, OwnerBots> = {
  [owner.toLowerCase()]: { v: 1, seq: 3, bots: [bot("main"), bot(KEY_A), bot(KEY_B), bot(KEY_DELETING, "deleting")], deleted: [] },
  [other.toLowerCase()]: { v: 1, seq: 1, bots: [bot("main"), bot(KEY_OTHERS)], deleted: [] },
};
const registry = { read: async (address: string) => rows[address.toLowerCase()] ?? { v: 1 as const, seq: 0, bots: [bot("main")], deleted: [] } };

interface Received { method: string; path: string; owner: string; bot: string; body?: Record<string, unknown> }
const received: Received[] = [];
/** Accepts a call only as the service does: a valid signature whose bot is the bot in the path. */
const fetchImpl = (async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : undefined;
  const claims = serviceCalls.verifyCall(new Headers(init?.headers).get("authorization"), { method, path: url.pathname + url.search, body },
    { secret, direction: "to-service", environment: "private", nonces: new serviceCalls.NonceGuard() });
  if (!claims || claims.bot !== /^\/v1\/bots\/([^/]+)\//.exec(url.pathname)?.[1]) return new Response(null, { status: 401 });
  received.push({ method, path: url.pathname, owner: claims.owner, bot: claims.bot, body: body === undefined ? undefined : JSON.parse(body) });
  if (url.pathname.endsWith("/history/permission")) return new Response(null, { status: 204 });
  if (url.pathname.endsWith("/history/notice")) return Response.json({ notice: { deliveredAt: 1, deleteAt: 2 } });
  return new Response(null, { status: 404 });
}) as typeof fetch;

/** A backend node whose storage is a map; activation succeeds. */
const entries = new Map<string, unknown>();
const node = {
  did: backendDid, computeDelegationCid, useDelegation: async () => ({}),
  kv: { put: async (key: string, value: unknown) => { entries.set(key, value); return { ok: true, data: {} }; } },
} as unknown as TinyCloudNode;
const history = new BotHistory(node, `0x${"22".repeat(32)}`, host);
const config: BotsConfig = { serviceUrl: "http://bots.test", serviceSecret: secret, accountAllowed: address => address.toLowerCase() !== notListed.toLowerCase(), postTimeoutMs: 1000, fetchImpl };

/** Mounted as the backend mounts them with BOTS_HISTORY_ENABLED; `historyOn: false` mounts only /api/bots. */
async function listen(historyOn: boolean) {
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  const auth = createAuthMiddleware(jwtKey);
  if (historyOn) {
    app.use("/api/bots/history", createBotHistoryRouter(history, config, auth));
    app.use("/api/bots/:key/history", createSiblingHistoryRouter(history, config, auth, registry));
  }
  app.use("/api/bots", createBotsRouter({ config, authMiddleware: auth }));
  const server = app.listen(0, "127.0.0.1");
  const { promise, resolve } = Promise.withResolvers<void>();
  server.once("listening", resolve);
  await promise;
  return server;
}
const base = (server: Server) => {
  const { port } = server.address() as AddressInfo; // listening on a TCP port, never a pipe
  return `http://127.0.0.1:${port}/api/bots`;
};
const close = (server: Server) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
};
const headersFor = async (address?: string) => ({
  "content-type": "application/json", "X-Requested-With": "XMLHttpRequest",
  ...(address ? { authorization: `Bearer ${(await issueSessionToken(address, jwtKey)).token}` } : {}),
});
/** The three routes for one key. The bodies are well formed, so only the key decides the answer. */
const calls = async (key: string) => [
  { path: `/${key}/history/grant`, method: "POST", body: JSON.stringify(await grantFor(KEY_A)) },
  { path: `/${key}/history/notice`, method: "GET", body: undefined },
  { path: `/${key}/history/notice/ack`, method: "POST", body: JSON.stringify({ id: "n1" }) },
];

let server: Server;
beforeAll(async () => { server = await listen(true); });
afterAll(() => close(server));
const reset = () => { received.length = 0; entries.clear(); };

describe("who reaches a bot's history", () => {
  test("without a session every path answers 401, whatever the key", async () => {
    reset();
    for (const key of [KEY_A, KEY_OTHERS, "main", "AB".repeat(16), "0".repeat(31)]) {
      for (const call of await calls(key)) {
        const response = await fetch(base(server) + call.path, { method: call.method, headers: await headersFor(), body: call.body });
        expect([call.path, response.status]).toEqual([call.path, 401]);
      }
    }
    expect(received).toEqual([]);
  });

  test("another owner's key, an unknown key, main and a malformed key all get the same empty 404", async () => {
    reset();
    const answers = new Set<string>();
    for (const key of [KEY_OTHERS, "0123456789abcdef0123456789abcdef", "main", "AB".repeat(16), `${KEY_A}0`, KEY_A.slice(1), "history"]) {
      for (const call of await calls(key)) {
        const response = await fetch(base(server) + call.path, { method: call.method, headers: await headersFor(owner), body: call.body });
        answers.add(`${response.status} ${response.headers.get("content-type") ?? ""} ${await response.text()}`);
      }
    }
    expect([...answers]).toEqual(["404  "]);
    expect(received).toEqual([]);
    expect(entries.size).toBe(0);
  });

  test("an account the bots slice does not list gets 404 for its own bot's key", async () => {
    reset();
    for (const call of await calls(KEY_A)) {
      const response = await fetch(base(server) + call.path, { method: call.method, headers: await headersFor(notListed), body: call.body });
      expect(response.status).toBe(404);
    }
    expect(received).toEqual([]);
  });
});

describe("a bot's grant", () => {
  test("is stored under that bot and its permission is sent to that bot, signed for it and its owner", async () => {
    reset();
    const response = await fetch(`${base(server)}/${KEY_A}/history/grant`, { method: "POST", headers: await headersFor(owner), body: JSON.stringify({ ...await grantFor(KEY_A), owner: other, key: KEY_B }) });
    expect(response.status).toBe(204);
    expect([...entries.keys()]).toEqual([`bot-history/grants/${owner.toLowerCase()}/${KEY_A}`]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: "PUT", path: `/v1/bots/${KEY_A}/history/permission`, bot: KEY_A, owner: `did:pkh:eip155:1:${owner.toLowerCase()}` });
    expect(received[0]!.body).toEqual({ validUntil: expect.any(Number) });
  });

  test("made for bot A is refused on bot B's URL, and nothing is stored or sent", async () => {
    reset();
    const response = await fetch(`${base(server)}/${KEY_B}/history/grant`, { method: "POST", headers: await headersFor(owner), body: JSON.stringify(await grantFor(KEY_A)) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "history_grant_unavailable" });
    // Main's grant is not a grant for a bot either.
    const main = await fetch(`${base(server)}/${KEY_B}/history/grant`, { method: "POST", headers: await headersFor(owner), body: JSON.stringify(await grantFor()) });
    expect(main.status).toBe(503);
    expect(entries.size).toBe(0);
    expect(received).toEqual([]);
  });

  test("is refused for a bot being deleted, whose notice and acknowledgement still answer", async () => {
    reset();
    const refused = await fetch(`${base(server)}/${KEY_DELETING}/history/grant`, { method: "POST", headers: await headersFor(owner), body: JSON.stringify(await grantFor(KEY_DELETING)) });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "bot_deleting" });
    expect(entries.size).toBe(0);
    expect((await fetch(`${base(server)}/${KEY_DELETING}/history/notice`, { headers: await headersFor(owner) })).status).toBe(200);
    expect((await fetch(`${base(server)}/${KEY_DELETING}/history/notice/ack`, { method: "POST", headers: await headersFor(owner), body: JSON.stringify({ id: "n1" }) })).status).toBe(200);
    expect(received.map(call => `${call.method} ${call.path}`)).toEqual([`GET /v1/bots/${KEY_DELETING}/history/notice`, `POST /v1/bots/${KEY_DELETING}/history/notice`]);
  });

  test("with a missing field is a 400 and reaches nothing", async () => {
    reset();
    const response = await fetch(`${base(server)}/${KEY_A}/history/grant`, { method: "POST", headers: await headersFor(owner), body: JSON.stringify({ serialized: "x", siwe: "y" }) });
    expect(response.status).toBe(400);
    expect(received).toEqual([]);
  });
});

describe("a bot's notice", () => {
  test("is read from that bot, signed for it and the session owner", async () => {
    reset();
    const response = await fetch(`${base(server)}/${KEY_A}/history/notice`, { headers: { ...await headersFor(owner), "x-tinycloud-owner": `did:pkh:eip155:1:${other.toLowerCase()}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notice: { deliveredAt: 1, deleteAt: 2 } });
    expect(received).toEqual([{ method: "GET", path: `/v1/bots/${KEY_A}/history/notice`, owner: `did:pkh:eip155:1:${owner.toLowerCase()}`, bot: KEY_A, body: undefined }]);
  });

  test("is acknowledged with the backend's receive time, and a body naming deleteAt is refused", async () => {
    reset();
    const before = Date.now();
    const response = await fetch(`${base(server)}/${KEY_A}/history/notice/ack`, { method: "POST", headers: await headersFor(owner), body: JSON.stringify({ id: "n1", receivedAt: 1, owner: other }) });
    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    const sent = received[0]!;
    expect([sent.method, sent.path, sent.bot]).toEqual(["POST", `/v1/bots/${KEY_A}/history/notice`, KEY_A]);
    expect(Object.keys(sent.body ?? {})).toEqual(["id", "receivedAt"]);
    expect(Number(sent.body?.receivedAt)).toBeGreaterThanOrEqual(before);
    reset();
    const refused = await fetch(`${base(server)}/${KEY_A}/history/notice/ack`, { method: "POST", headers: await headersFor(owner), body: JSON.stringify({ id: "n1", deleteAt: before + 60_000 }) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_notice_ack" });
    expect(received).toEqual([]);
  });
});

describe("Main's history routes", () => {
  test("answer at /api/bots/history and call Main's paths, as they did", async () => {
    reset();
    const headers = await headersFor(owner);
    expect(await (await fetch(`${base(server)}/history/status`, { headers })).json()).toEqual({ enabled: true, backendDid });
    expect((await fetch(`${base(server)}/history/grant`, { method: "POST", headers, body: JSON.stringify(await grantFor()) })).status).toBe(204);
    expect((await fetch(`${base(server)}/history/notice`, { headers })).status).toBe(200);
    expect((await fetch(`${base(server)}/history/notice/ack`, { method: "POST", headers, body: JSON.stringify({ id: "n1" }) })).status).toBe(200);
    expect([...entries.keys()]).toEqual([`bot-history/grants/${owner.toLowerCase()}`]);
    expect(received.map(call => `${call.method} ${call.path} ${call.bot}`)).toEqual([
      "PUT /v1/bots/main/history/permission main", "GET /v1/bots/main/history/notice main", "POST /v1/bots/main/history/notice main",
    ]);
  });
});

describe("with the history slice off", () => {
  test("no bot's history route answers", async () => {
    reset();
    const off = await listen(false);
    try {
      for (const key of [KEY_A, "main"]) {
        for (const call of await calls(key)) {
          const response = await fetch(base(off) + call.path, { method: call.method, headers: await headersFor(owner), body: call.body });
          expect([call.path, response.status]).toEqual([call.path, 404]);
        }
      }
      expect(received).toEqual([]);
      expect(entries.size).toBe(0);
    } finally { await close(off); }
  });
});
