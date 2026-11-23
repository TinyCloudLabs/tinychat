import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { signedCallHeader } from "../bots-signed-call";
import { createTrustBotReadsInternalRouter, TRUSTBOT_READS_INTERNAL_PREFIX } from "../routes/trustbot-reads";
import type { BotsConfig } from "../routes/bots";
import { areaResources } from "../trustbot-reads/areas";
import { TrustBotReadGrants, TRUSTBOT_READ_GRANT_KEY_PREFIX } from "../trustbot-reads/grants";
import { backendGrantStore } from "../trustbot-reads/setup";
import { fakeBackendNode } from "./helpers/fake-backend-node";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

async function fixture(enabled = true) {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const secret = "s".repeat(64);
  const did = "did:pkh:eip155:1:0x" + "22".repeat(20);
  const { address, spaceId } = await makeSignedTranscriptGrant({ now });
  const { node, values } = fakeBackendNode();
  const key = `${TRUSTBOT_READ_GRANT_KEY_PREFIX}${address.toLowerCase()}`;
  const db = new Database(":memory:");
  db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, updated_at TEXT)");
  db.run("CREATE TABLE messages (thread_id TEXT, position INTEGER, payload TEXT, created_at TEXT)");
  for (const id of ["private", "allowed"]) {
    db.run("INSERT INTO threads VALUES (?, ?, '2026-11-23')", [id, `${id} matching title`]);
    db.run("INSERT INTO messages VALUES (?, 0, ?, '2026-11-23')", [id, JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `${id} message` }] } })]);
  }
  const backing = backendGrantStore(node);
  let reads = 0;
  let afterRead: (() => void) | undefined;
  let pauseQuery: ((statement: string) => Promise<void>) | undefined;
  const grants = new TrustBotReadGrants({
    reader: { did, computeDelegationCid } as Pick<TinyCloudNode, "did" | "useDelegation" | "computeDelegationCid">,
    store: { ...backing, get: async key => {
      reads++;
      const result = await backing.get(key);
      const hook = afterRead;
      afterRead = undefined;
      hook?.();
      return result;
    } },
    host: "http://127.0.0.1:9137", sealSecret: new Uint8Array(32).fill(7), now: () => now,
    activate: async () => ({ sql: { db: () => ({ query: async (statement: string, params: Array<string | number | null>) => {
      const rows = db.query(statement).values(...params);
      await pauseQuery?.(statement);
      return { ok: true, data: { columns: [], rows, rowCount: rows.length } };
    } }) } }) as never,
  });
  if (enabled) {
    const { serialized, siwe, signature } = await makeSignedTranscriptGrant({
      now, audience: did, expiresAt: (now + 86_400_000) / 1000,
      att: Object.fromEntries(areaResources(["feed_chats"]).map(({ service, path, actions }) => [
        `${spaceId}/${service}/${path}`, Object.fromEntries(actions.map(action => [action, [{}]])),
      ])),
    });
    await grants.enable(address, "feed_chats", { serialized, siwe, signature });
  }
  const app = express();
  app.use(TRUSTBOT_READS_INTERNAL_PREFIX, createTrustBotReadsInternalRouter({ grants,
    config: { accountAllowed: () => true } as BotsConfig, callSecret: secret }));
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    grants, address, values, key,
    get reads() { return reads; },
    resetReads() { reads = 0; },
    afterRead(hook: () => void) { afterRead = hook; },
    pauseQuery(hook: (statement: string) => Promise<void>) { pauseQuery = hook; },
    async post(tool: string, args: unknown = {}) {
      const path = `${TRUSTBOT_READS_INTERNAL_PREFIX}/${tool}`;
      const body = JSON.stringify({ args });
      const authorization = signedCallHeader(secret, { direction: "to-backend", environment: "private", owner: `did:pkh:eip155:1:${address.toLowerCase()}`, bot: "main", method: "POST", path, body });
      return fetch(`${base}${path}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body }).then(response => response.json());
    },
    close() { server.close(); db.close(); },
  };
}

for (const [label, tool, args] of [
  ["list", "list_chats", {}],
  ["search", "list_chats", { query: "matching" }],
  ["direct read", "read_chat", { chat: "private" }],
] as const) {
  test(`a ${label} paused after SQL drops its result when a returned chat becomes denied`, async () => {
    const f = await fixture();
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    f.pauseQuery(async statement => {
      if (tool === "read_chat" && !statement.startsWith("SELECT role, body")) return;
      reached.resolve();
      await resume.promise;
    });
    let pending: Promise<unknown> | undefined;
    try {
      pending = f.post(tool, args);
      await reached.promise;
      await f.grants.setChatDenied(f.address, "private", true);
      resume.resolve();
      const result = await pending;
      expect(result).toEqual({ ok: false, error: "not_found", code: "not_found" });
      expect(JSON.stringify(result)).not.toContain("private matching title");
      expect(JSON.stringify(result)).not.toContain("private message");
    } finally {
      resume.resolve();
      await pending?.catch(() => {});
      f.close();
    }
  });
}

test("read_status never mixes areas from the old record with denies from a replacement record", async () => {
  const f = await fixture();
  try {
    const original = f.values.get(f.key)!;
    await f.grants.setChatDenied(f.address, "private", true);
    await f.grants.disable(f.address, "feed_chats");
    const replacement = f.values.get(f.key)!;
    f.values.set(f.key, original);
    f.resetReads();
    f.afterRead(() => f.values.set(f.key, replacement));
    expect(await f.post("read_status")).toEqual({ enabledReadAreas: ["feed_chats"], deniedChatIds: [] });
    expect(f.reads).toBe(1);
    expect(await f.post("read_status")).toEqual({ enabledReadAreas: [], deniedChatIds: ["private"] });
  } finally { f.close(); }
});

test("read_status with no record is all areas off and an empty deny list from one read", async () => {
  const f = await fixture(false);
  try {
    f.resetReads();
    expect(await f.post("read_status")).toEqual({ enabledReadAreas: [], deniedChatIds: [] });
    expect(f.reads).toBe(1);
  } finally { f.close(); }
});
