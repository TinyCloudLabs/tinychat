import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makeSignedTranscriptGrant, computeDelegationCid } from "./helpers/transcript-grant";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { projectBotHistoryGrant } from "../bot-history-grant";
import { BotHistory, HISTORY_PREFIX, historyBotId } from "../bot-history";
const key = "0x" + "11".repeat(32) as `0x${string}`;
const address = privateKeyToAccount(key).address;
const backendDid = "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810";
const host = "http://127.0.0.1:9137";
const path = `${HISTORY_PREFIX}${historyBotId(address)}/`;
const space = makePkhSpaceId(address, 1, "applications");
const uri = `${space}/kv/${path}`;
const actions = { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] };
const node = { did: backendDid, computeDelegationCid } as TinyCloudNode;
async function fixture(att = { [uri]: actions }) {
  const grant = await makeSignedTranscriptGrant({ privateKey: key, att });
  return { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature };
}
test("history has its own exact get+put subtree schema and rejects additional authority", async () => {
  expect((await projectBotHistoryGrant(node, host, address, await fixture())).resources).toEqual([{ service: "kv", space, path, actions: ["tinycloud.kv/get", "tinycloud.kv/put"] }]);
  for (const att of [
    { [uri]: { ...actions, "tinycloud.kv/del": [{}] } },
    { [uri]: { "tinycloud.kv/get": [{}] } },
    { [`${space}/kv/${HISTORY_PREFIX}`]: actions },
    { [uri]: actions, [`urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`]: { "tinycloud.encryption/decrypt": [{}] } },
  ]) await expect(projectBotHistoryGrant(node, host, address, await fixture(att))).rejects.toThrow();
  await expect(projectBotHistoryGrant(node, host, "0x" + "22".repeat(20), await fixture())).rejects.toThrow();
  await expect(projectBotHistoryGrant(node, "http://other", address, await fixture())).rejects.toThrow();
});
test("node activation must verify the proof chain before a grant is stored, and stored grants are encrypted", async () => {
  const values: unknown[] = [];
  let refuse = true;
  const fake = { ...node, useDelegation: async () => { if (refuse) throw new Error("revoked"); return {}; }, kv: {
    put: async (_key: string, value: unknown) => { values.push(value); return { ok: true, data: {} }; },
  } } as unknown as TinyCloudNode;
  const history = new BotHistory(fake, key, host);
  const envelope = await fixture();
  await expect(history.accept(address, envelope)).rejects.toThrow();
  expect(values).toHaveLength(0);
  refuse = false;
  await history.accept(address, envelope);
  expect(values).toHaveLength(1);
  expect(typeof values[0]).toBe("string");
  expect(JSON.stringify(values[0])).not.toContain(envelope.serialized);
  expect(JSON.stringify(values[0])).not.toContain(envelope.siwe);
});
