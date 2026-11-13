import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { readBotHistory } from "./historyRead";

test("archived assistant IDs match live completions and retain a legacy fallback", async () => {
  const address = "0x1111111111111111111111111111111111111111";
  const owner = `did:pkh:eip155:1:${address}`;
  const spaceId = makePkhSpaceId(address, 1, "applications");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
  const botId = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const generation = "a".repeat(32), challenge = "b".repeat(64);
  const keys = [1, 2].map(seq => `xyz.tinycloud.tinychat/threads/bots/v1/${botId}/${generation}/${seq}-${challenge}`);
  let seq = 0;
  const client = { session: () => ({ address, chainId: 1 }), kvForSpace: () => ({
    list: async () => ({ ok: true, data: { keys } }),
    get: async (path: string) => ({ ok: true, data: { data: { aad: btoa(JSON.stringify({ owner, spaceId, path })) } } }),
  }), encryption: { decryptEnvelope: async () => ({ ok: true, data: new TextEncoder().encode(JSON.stringify({ generation, seq: ++seq, challenge,
    record: { type: "assistant", text: "answer", ...(seq === 1 ? { outcome: { messageId: "b-123" } } : {}) } })) }) } } as unknown as TinyCloudWeb;
  expect((await readBotHistory(client)).map(message => message.id)).toEqual(["b-123", `history-${generation}-2`]);
});
