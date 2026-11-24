// Test fixture: a real, tool-less Courier turn that answers with the given text, so the reply is guard-issued.
import { courierTurn } from "../courier/turn";
import type { CourierReplyText } from "../courier/guard";
import { MeetingDesk } from "../meeting-reads";

const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const reads = new MeetingDesk({ backendOrigin: "https://backend.test", backendCallSecret: "s".repeat(48), fetch: async () => Response.json({ ok: true, text: "unused" }) });

export function guardedAnswer(content: string): Promise<CourierReplyText> {
  return courierTurn({ owner, handle: "cli", peerDid: "did:key:cli", threadId: "t", text: "hi", reads, model: async () => ({ content }), deniedChatIds: async () => new Set(), enabledReadAreas: async () => [] });
}
