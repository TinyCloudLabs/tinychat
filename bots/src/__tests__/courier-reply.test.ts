import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { replyToCourierThread } from "../courier/reply";
import type { CourierContext, PairedPeer } from "../courier/lib-adapter";

const context: CourierContext = { identity: { did: "did:key:trustbot", publicJwk: {}, signer: { sign: async () => new Uint8Array(64), restoreSession: async () => { throw new Error("unused_signer"); } } }, grant: { raw: {}, expiresAt: 1_900_000_000_000 }, host: "https://node.tinycloud.xyz", kv: {} };
const peer: PairedPeer = { handle: "cli", peerDid: "did:key:cli", delegation: {}, delegationExpiresAt: 1_900_000_000_000 };
test("reply sends only to the admitted peer/thread with inbound-bound idempotency", async () => {
  const sent: unknown[][] = [];
  await replyToCourierThread(context, peer, { id: "message1", threadId: "thread1" }, '{"threadId":"other","peer":"other"}', async (...args) => { sent.push(args); return { messageId: "reply1" }; });
  expect(sent).toEqual([[context, peer, "thread1", '{"threadId":"other","peer":"other"}', { inReplyTo: "message1", idempotencyKey: createHash("sha256").update(JSON.stringify([peer.peerDid, "thread1", "message1"])).digest("hex") }]]);
});
