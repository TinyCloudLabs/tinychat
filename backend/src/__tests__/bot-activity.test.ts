import { expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import { BotHistory, checkedBatch, HISTORY_PREFIX, historyBotId, historyHash, historyOwner } from "../bot-history";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const ownerKey = `0x${"11".repeat(32)}` as const;
const backendKey = `0x${"44".repeat(32)}` as const;
const address = privateKeyToAccount(ownerKey).address;
const backendDid = historyOwner(privateKeyToAccount(backendKey).address);
const host = "http://127.0.0.1:9137";
const hidden = "sandbox tool text and file paths";
const at = "2026-11-18T23:00:00.000Z";
const networkId = "fixture-network";

function fakeOwnerStorage() {
  const store = () => {
    const entries = new Map<string, unknown>();
    const reads: string[] = [];
    const kv = {
      put: async (path: string, value: unknown) => {
        entries.set(path, value);
        return { ok: true, data: {} };
      },
      get: async (path: string) => {
        reads.push(path);
        return entries.has(path)
          ? { ok: true, data: { data: entries.get(path) } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${path}`, service: "kv" } };
      },
    };
    return { entries, reads, kv };
  };
  const saved = store();
  const node = {
    did: backendDid,
    computeDelegationCid,
    kv: store().kv,
    useDelegation: async () => saved,
    getEncryptionNetworkIdForSpace: () => networkId,
    encryption: {
      discoverNetwork: async () => ({ ok: true, data: { ownerDid: `did:pkh:eip155:1:${address}`, networkId, state: "active" } }),
      encryptToNetwork: async (_network: string, payload: Buffer, { aad }: { aad: Buffer }) => ({
        ok: true, data: { networkId, aad: aad.toString("base64"), payload: payload.toString("base64") },
      }),
    },
  } as unknown as TinyCloudNode;
  return { node, saved };
}

test("an activity batch is saved and read back byte for byte from its owner's history path", async () => {
  const { node, saved } = fakeOwnerStorage();
  const writer = new BotHistory(node, backendKey, host);
  const directory = `${HISTORY_PREFIX}${historyBotId(address)}/`;
  const scope = makePkhSpaceId(address, 1, "applications");
  const grant = await makeSignedTranscriptGrant({ privateKey: ownerKey, audience: backendDid, att: {
    [`${scope}/kv/${directory}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
  } });
  await writer.accept(address, grant);
  const batch = {
    v: 1, generation: "a".repeat(32), seq: 3, challenge: "b".repeat(64),
    record: { type: "activity", id: "c".repeat(32), verb: "changed_files", count: 2, at },
  };
  const path = `${directory}${batch.generation}/${batch.seq}-${batch.challenge}`;
  const receipt = await writer.archive(address, batch, async staged => {
    expect(staged.batchHash).toBe(historyHash(JSON.stringify(batch)));
    expect(saved.entries.has(path)).toBe(false);
  });
  const savedEnvelope = saved.entries.get(path) as { payload: string };
  expect(saved.reads).toEqual([path, path]);
  expect(Buffer.from(savedEnvelope.payload, "base64").toString()).toBe(JSON.stringify(batch));
  expect(receipt.body.batchHash).toBe(historyHash(JSON.stringify(batch)));
});

test("activity history accepts only the fixed record fields and bounded counts", () => {
  const record = { type: "activity", id: "a".repeat(32), verb: "ran_commands", count: 2, at };
  const batch = { v: 1, generation: "a".repeat(32), seq: 1, challenge: "b".repeat(64), record };
  expect(checkedBatch(batch)).toEqual(batch);
  for (const extra of [{ text: hidden }, { verb: hidden }, { count: 0 }, { count: 257 }, { count: 1.5 }, { id: hidden }, { at: hidden }]) {
    expect(() => checkedBatch({ ...batch, record: { ...record, ...extra } })).toThrow("invalid_history_batch");
  }
});
