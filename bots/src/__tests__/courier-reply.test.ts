import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { guardReply } from "../courier/guard";
import { replyToCourierThread } from "../courier/reply";
import type { CourierContext, PairedPeer } from "../courier/lib-adapter";

const context: CourierContext = { identity: { did: "did:key:trustbot", publicJwk: {}, signer: { sign: async () => new Uint8Array(64), restoreSession: async () => { throw new Error("unused_signer"); } } }, grant: { raw: {}, expiresAt: 1_900_000_000_000 }, host: "https://node.tinycloud.xyz", kv: {} };
const peer: PairedPeer = { handle: "cli", peerDid: "did:key:cli", delegation: {}, delegationExpiresAt: 1_900_000_000_000 };
test("reply sends only to the admitted peer/thread with inbound-bound idempotency", async () => {
  const sent: unknown[][] = [];
  const text = '{"threadId":"other","peer":"other"}';
  await replyToCourierThread(context, peer, { id: "message1", threadId: "thread1" }, guardReply(text, [])!, async (...args) => { sent.push(args); return { messageId: "reply1" }; });
  expect(sent).toEqual([[context, peer, "thread1", text, { inReplyTo: "message1", idempotencyKey: createHash("sha256").update(JSON.stringify([peer.peerDid, "thread1", "message1"])).digest("hex") }]]);
});

test("an unguarded or forged reply is refused before any send", async () => {
  const sent: unknown[][] = [];
  const send = async (...args: unknown[]) => { sent.push(args); return { messageId: "reply1" }; };
  const verbatim = "one two three four five six seven eight nine ten eleven twelve";
  expect(guardReply(verbatim, [verbatim])).toBeUndefined();
  for (const forged of [verbatim, { kind: "guarded", text: verbatim }, undefined]) {
    // @ts-expect-error The send path must refuse values that did not come from the guard.
    await expect(replyToCourierThread(context, peer, { id: "message1", threadId: "thread1" }, forged, send)).rejects.toThrow("courier_reply_unguarded");
  }
  expect(sent).toEqual([]);
});
