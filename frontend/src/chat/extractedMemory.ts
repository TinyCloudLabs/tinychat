import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { isConversationMarked } from "../lib/imageGate";
import { setMemory } from "../lib/threadStore";

/**
 * The write a background extraction makes. Memory written from a chat that held outside content is marked in the same
 * write, so a later chat that loads it starts marked (lib/imageGate.ts). The chat's mark never clears, so asking at write
 * time can only be later than the turn, never earlier.
 */
export function writeExtractedMemory(tcw: TinyCloudWeb, threadId: string, doc: string): Promise<void> {
  return setMemory(tcw, doc, isConversationMarked(threadId) ? { outside: true } : {});
}
