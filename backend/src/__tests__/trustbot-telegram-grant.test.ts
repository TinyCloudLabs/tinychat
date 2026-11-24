import { expect, test } from "bun:test";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { makeSignedTranscriptGrant, type TranscriptAtt } from "./helpers/transcript-grant";
import { verifyTranscriptWriterGrant } from "../delegation-verify";
import { activateVerifiedDelegation } from "../portable-delegation";
import { areaResources } from "../trustbot-reads/areas";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

const address = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const key = `0x${"11".repeat(32)}` as const;
const messages = makePkhSpaceId(address, 1, "messages");
const applications = makePkhSpaceId(address, 1, "applications");
const inbox = "xyz.tinycloud.inbox";
const resources = () => [
  { service: "sql", space: "messages", path: `${inbox}/db/`, actions: ["tinycloud.sql/read"] },
  { service: "kv", space: "messages", path: `${inbox}/media/`, actions: ["tinycloud.kv/get"] },
];

async function verify(space: string, extra?: string) {
  const att: TranscriptAtt = {
    [`${space}/sql/${inbox}/db/`]: { "tinycloud.sql/read": [{}] },
    [`${space}/kv/${inbox}/media/`]: { "tinycloud.kv/get": [{}] },
  };
  if (extra) att[extra] = { "tinycloud.kv/get": [{}] };
  const grant = await makeSignedTranscriptGrant({ privateKey: key, att, expiresAt: Math.floor((Date.now() + 7 * 86400000 - 60000) / 1000) });
  return verifyTranscriptWriterGrant({ ...grant, policy: "trustbot-read", expected: resources() }, { computeDelegationCid: grant.computeDelegationCid });
}

test("Telegram area names only Inbox SQL read and KV get in messages", () => {
  expect(areaResources(["telegram" as never])).toEqual(resources());
});

test("signed Telegram resources activate in the owner's messages space", async () => {
  const result = await verify(messages);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const reached: unknown[] = [];
  const node = { useDelegation: async (grant: unknown) => { reached.push(grant); return { kv: {}, sql: {} }; } } as unknown as TinyCloudNode;
  await activateVerifiedDelegation(node, result.verified, { host: "http://127.0.0.1:9137" });
  expect(reached.map(v => { const grant = v as { spaceId: string; resources: Array<{ space: string }> }; return [grant.spaceId, grant.resources[0].space]; })).toEqual([[messages, messages], [messages, messages]]);
});

test("Telegram paths in applications or another owner's messages space are refused", async () => {
  for (const space of [applications, makePkhSpaceId(`0x${"22".repeat(20)}`, 1, "messages")]) {
    expect((await verify(space)).ok).toBe(false);
  }
  expect((await verify(messages, `${messages}/kv/${inbox}/sessions/`)).ok).toBe(false);
});

test("Telegram grant cannot exceed seven days or name another reader", async () => {
  const now = Date.now();
  const att: TranscriptAtt = {
    [`${messages}/sql/${inbox}/db/`]: { "tinycloud.sql/read": [{}] },
    [`${messages}/kv/${inbox}/media/`]: { "tinycloud.kv/get": [{}] },
  };
  const grant = await makeSignedTranscriptGrant({ privateKey: key, now, att, expiresAt: Math.floor((now + 7 * 86400000 + 120000) / 1000) });
  const result = await verifyTranscriptWriterGrant({ ...grant, now, policy: "trustbot-read", expected: resources() }, { computeDelegationCid: grant.computeDelegationCid });
  expect(result.ok ? "accepted" : result.code).toBe("expiry_too_long");
  const wrongReader = await verifyTranscriptWriterGrant({ ...grant, now, backendDid: `did:pkh:eip155:1:0x${"33".repeat(20)}`, policy: "trustbot-read", expected: resources() }, { computeDelegationCid: grant.computeDelegationCid });
  expect(wrongReader.ok ? "accepted" : wrongReader.code).toBe("wrong_delegatee");
});
