import { expect, test } from "bun:test";
import { once } from "node:events";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import { BotHistory, checkedBatch, HISTORY_PREFIX, historyBotId, historyHash, historyOwner } from "../bot-history";
import { NonceGuard, verifyCall } from "../bots-signed-call";
import { createBotsRouter } from "../routes/bots";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const key = "a".repeat(32);
const at = "2026-11-19T00:00:00.000Z";
const record = { type: "activity", id: "b".repeat(32), verb: "messaged_bot", count: 2, at, targetKey: key };
const batch = { v: 1, generation: "c".repeat(32), seq: 3, challenge: "d".repeat(64), record };

test("the messages route sends only the registry roster for its session owner and source key", async () => {
  const address = `0x${"Ab".repeat(20)}`;
  const calls: string[][] = [];
  const bodies: unknown[] = [];
  const owners: unknown[] = [];
  const nonces = new NonceGuard();
  let available = true;
  const app = express();
  app.use(express.json());
  app.use("/api/bots", createBotsRouter({
    config: {
      serviceUrl: "http://bots.test", serviceSecret: "fixture", accountAllowed: () => true, postTimeoutMs: 5000,
      listForTurn: async (ownerDid, sourceKey) => {
        calls.push([ownerDid, sourceKey]);
        if (!available) throw new Error("fixture registry unavailable");
        return [key];
      },
      fetchImpl: (async (_url, init) => {
        const body = init?.body as string;
        const claims = verifyCall(new Headers(init?.headers).get("authorization"), {
          method: "POST", path: "/v1/bots/main/messages", body,
        }, { secret: "fixture", direction: "to-service", environment: "private", nonces });
        owners.push(claims?.owner);
        bodies.push(JSON.parse(body));
        return new Response('event: done\ndata: {"messageId":"fixture"}\n\n');
      }) as typeof fetch,
    },
    authMiddleware: (req, _res, next) => { req.user = { address } as typeof req.user; next(); },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const send = () => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots/main/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", owner: "forged", sourceKey: "forged", messageableBotKeys: ["f".repeat(32)] }),
  });
  try {
    expect(await (await send()).text()).toContain("event: done");
    available = false;
    expect(await (await send()).text()).toContain("event: done");
    expect(bodies).toEqual([{ text: "hello", messageableBotKeys: [key] }, { text: "hello" }]);
    expect(calls).toEqual([[historyOwner(address), "main"], [historyOwner(address), "main"]]);
    expect(owners).toEqual([historyOwner(address), historyOwner(address)]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("messaging activity permits a bounded count and a bot key, with no other payload", () => {
  expect(JSON.stringify(checkedBatch(batch))).toBe(JSON.stringify(batch));
  expect(checkedBatch({ ...batch, record: { ...record, targetKey: "main" } }).record)
    .toEqual({ ...record, targetKey: "main" });
  for (const extra of [
    { text: "any model text" }, { reply: "any model reply" }, { name: "model output" }, { extra: null },
    { targetKey: "owner/bot" }, { targetKey: key + "\n" }, { targetKey: key.toUpperCase() }, { targetKey: {} },
    { count: 257 }, { count: -1 }, { count: 2.5 }, { id: "a".repeat(1024) },
  ]) {
    expect(() => checkedBatch({ ...batch, record: { ...record, ...extra } })).toThrow("invalid_history_batch");
  }

  // Existing record field order and bytes still match the input, including the old Main records.
  for (const previous of [
    { type: "user", text: "hello", at },
    { type: "assistant", text: "world", outcome: { type: "done", messageId: "b-1" }, at },
    { type: "activity", id: "b".repeat(32), verb: "ran_commands", count: 1, at },
  ]) {
    const older = { ...batch, record: previous };
    expect(JSON.stringify(checkedBatch(older))).toBe(JSON.stringify(older));
  }
});

test("messaging activity makes a byte-for-byte owner-space archive round trip", async () => {
  const ownerKey = `0x${"11".repeat(32)}` as const;
  const backendKey = `0x${"44".repeat(32)}` as const;
  const address = privateKeyToAccount(ownerKey).address;
  const backendDid = historyOwner(privateKeyToAccount(backendKey).address);
  const directory = `${HISTORY_PREFIX}${historyBotId(address)}/`;
  const path = `${directory}${batch.generation}/${batch.seq}-${batch.challenge}`;
  const spaceId = makePkhSpaceId(address, 1, "applications");
  const networkId = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
  const storage = new Map<string, unknown>();
  let reads = 0;
  const get = async (key: string) => storage.has(key)
    ? { ok: true, data: { data: storage.get(key) } }
    : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } };
  const put = async (key: string, value: unknown) => { storage.set(key, value); return { ok: true, data: {} }; };
  const node = {
    did: backendDid, computeDelegationCid, kv: { get, put },
    useDelegation: async () => ({ kv: { put, get: async (key: string) => { reads++; return get(key); } } }),
    getEncryptionNetworkIdForSpace: () => networkId,
    keys: {
      encrypt: async (keyPath: string, payload: Buffer, { networkId: net, aad, descriptor }: { networkId: string; aad: Buffer; descriptor: { keyVersion: number } }) => ({
        v: 2, networkId: net, keyPath, keyVersion: descriptor.keyVersion, aad: Buffer.from(aad).toString("base64"), payload: Buffer.from(payload).toString("base64"),
      }),
    },
  } as unknown as TinyCloudNode;
  const writer = new BotHistory(node, backendKey, "http://127.0.0.1:9137");
  const signedGrant = await makeSignedTranscriptGrant({ privateKey: ownerKey, audience: backendDid, att: {
    [`${spaceId}/kv/${directory}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
  } });
  await writer.accept(address, signedGrant);
  await writer.acceptKeyDescriptor(address, signedGrant.signKeyDescriptor());
  const receipt = await writer.archive(address, batch, async staged => {
    expect(staged.batchHash).toBe(historyHash(JSON.stringify(batch)));
    expect(storage.has(path)).toBe(false);
  });
  expect(reads).toBe(2);
  expect(receipt.body.batchHash).toBe(historyHash(JSON.stringify(batch)));
  const archived = storage.get(path) as { payload: string };
  expect(Buffer.from(archived.payload, "base64").toString()).toBe(JSON.stringify({ ...batch, ctx: { v: 1, owner: historyOwner(address), spaceId, path, bot: "main", generation: batch.generation, seq: batch.seq, challenge: batch.challenge } }));
});
