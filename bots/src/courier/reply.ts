// The model supplies text only. Destination and thread come exclusively from admitted intake.
// Only a fixed sentence or guard-issued text can be sent: the copy guard cannot be skipped by a caller.
// Details: TC-4058
import { createHash } from "node:crypto";
import { type CourierReplyText, isCourierReply, replyText } from "./guard";
import type { CourierInbound } from "./intake";
import type { sendMessage, CourierContext, PairedPeer } from "./lib-adapter";

export async function replyToCourierThread(
  context: CourierContext,
  peer: PairedPeer,
  message: Pick<CourierInbound, "id" | "threadId">,
  reply: CourierReplyText,
  send: typeof sendMessage,
): Promise<void> {
  if (!isCourierReply(reply)) throw new Error("courier_reply_unguarded");
  const text = replyText(reply);
  if (!/^[0-9A-Za-z_-]{1,64}$/.test(message.threadId) || !/^[0-9A-Za-z_-]{1,64}$/.test(message.id) || !text.trim() || text.length > 8000) throw new Error("courier_reply_invalid");
  const idempotencyKey = createHash("sha256").update(JSON.stringify([peer.peerDid, message.threadId, message.id])).digest("hex");
  await send(context, peer, message.threadId, text, { inReplyTo: message.id, idempotencyKey });
}
