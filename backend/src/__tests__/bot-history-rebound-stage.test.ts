import { expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BotHistory, HISTORY_PREFIX, historyBotId, historyHash, historyOwner } from "../bot-history";
import { BOT_HISTORY_KEY_PATH, botHistoryNetworkId } from "../bot-history-key";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const ownerKey = generatePrivateKey();
const backendKey = generatePrivateKey();
const address = privateKeyToAccount(ownerKey).address;
const backendDid = historyOwner(privateKeyToAccount(backendKey).address);
const host = "http://127.0.0.1:9137";
const networkId = botHistoryNetworkId(address);
const directory = `${HISTORY_PREFIX}${historyBotId(address)}/`;
const spaceId = makePkhSpaceId(address, 1, "applications");

const batch = {
  v: 1, generation: "ab".repeat(16), seq: 1, challenge: "cd".repeat(32),
  record: { type: "assistant", text: "record kept for a receipt" },
};
const path = `${directory}${batch.generation}/${batch.seq}-${batch.challenge}`;
const aad = Buffer.from(JSON.stringify({ owner: historyOwner(address), spaceId, path })).toString("base64");
const named = (ciphertext: string, keyVersion = 1) => ({ v: 2, keyPath: BOT_HISTORY_KEY_PATH, keyVersion, networkId, aad, ciphertext });
const legacy = { v: 1, networkId, aad, ciphertext: "network ciphertext" };

/** The owner's space as the backend sees it through its delegation: one stored record, no receipt yet. */
async function fixture(stored: unknown) {
  const entries = new Map<string, { body: unknown; etag: string }>([[path, { body: stored, etag: '"1"' }]]);
  let writes = 0;
  const owned = {
    get: async (key: string) => {
      const entry = entries.get(key);
      return entry ? { ok: true, data: { data: entry.body, headers: { etag: entry.etag } } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } };
    },
    put: async (key: string, body: unknown) => { entries.set(key, { body, etag: `"${++writes + 1}"` }); return { ok: true, data: {} }; },
  };
  let encrypts = 0;
  const service = new Map<string, unknown>();
  const node = {
    did: backendDid, computeDelegationCid,
    kv: {
      get: async (key: string) => service.has(key) ? { ok: true, data: { data: service.get(key), headers: { etag: '"s"' } } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } },
      put: async (key: string, body: unknown) => { service.set(key, body); return { ok: true, data: {} }; },
    },
    useDelegation: async () => ({ kv: owned }),
    keys: { encrypt: async () => { encrypts++; throw new Error("unexpected seal"); } },
  } as unknown as TinyCloudNode;
  const history = new BotHistory(node, backendKey, host);
  await history.accept(address, await makeSignedTranscriptGrant({
    privateKey: ownerKey, audience: backendDid, host, now: Date.now(), att: {
      [`${spaceId}/kv/${directory}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
    },
  }));
  const input = (envelope: unknown) => ({
    ...batch, staged: { seq: batch.seq, challenge: batch.challenge, batchHash: historyHash(JSON.stringify(batch)), envelope },
  });
  const noStage = async () => { throw new Error("unexpected restage"); };
  return { history, input, noStage, writes: () => writes, seals: () => encrypts, entries };
}

test("a staged named record that the owner has since rewritten still receives its receipt", async () => {
  const rewritten = named("rewritten ciphertext");
  const f = await fixture(rewritten);
  const receipt = await f.history.archive(address, f.input(named("staged ciphertext")), f.noStage);
  expect(receipt.body.ciphertextHash).toBe(historyHash(JSON.stringify(rewritten)));
  expect(await f.history.archive(address, f.input(named("staged ciphertext")), f.noStage)).toEqual(receipt);
  expect(f.writes()).toBe(0);
  expect(f.seals()).toBe(0);
  expect(f.entries.get(path)?.body).toEqual(rewritten);
});

test("a staged named record is still refused when the stored record is not a bound named envelope", async () => {
  const staged = named("staged ciphertext");
  const stored = named("rewritten ciphertext");
  for (const other of [{ aad: "wrong" }, { networkId: "wrong" }, { keyPath: "wrong" }, { v: 1 }, { keyVersion: 0 }]) {
    const f = await fixture({ ...stored, ...other });
    await expect(f.history.archive(address, f.input(staged), f.noStage)).rejects.toThrow("history_integrity_failure");
    expect(f.writes()).toBe(0);
  }
  const unrelated = await fixture(legacy);
  await expect(unrelated.history.archive(address, unrelated.input(staged), unrelated.noStage)).rejects.toThrow("history_integrity_failure");
});

test("a staged named record is never answered with a record on a lower key version", async () => {
  const staged = named("staged ciphertext", 2);
  const lower = await fixture(named("rewritten ciphertext", 1));
  await expect(lower.history.archive(address, lower.input(staged), lower.noStage)).rejects.toThrow("history_integrity_failure");
  expect(lower.writes()).toBe(0);

  const same = await fixture(named("rewritten ciphertext", 2));
  const receipt = await same.history.archive(address, same.input(staged), same.noStage);
  expect(receipt.body.ciphertextHash).toBe(historyHash(JSON.stringify(named("rewritten ciphertext", 2))));

  const higher = await fixture(named("rewritten ciphertext", 3));
  const raised = await higher.history.archive(address, higher.input(staged), higher.noStage);
  expect(raised.body.ciphertextHash).toBe(historyHash(JSON.stringify(named("rewritten ciphertext", 3))));
});
