import { z } from "zod";
import { findSecrets } from "./guard";
import { BOARD_PREFIX, SAM_PREFIX, compactStamp, isKind, stampToIso, validRecordId, type BoardRecord, type Kind } from "./schema";

export const SAM_THREAD_PREFIX = `${SAM_PREFIX}thread/`;
export const BOARD_THREAD_PREFIX = `${BOARD_PREFIX}thread/`;
export const THREAD_RECEIPT_PREFIX = `${BOARD_PREFIX}watch/thread/`;
export const threadReceiptKey = (kind: Kind, id: string, messageId: string): string => `${THREAD_RECEIPT_PREFIX}${kind}/${id}/${messageId}.json`;
const ID = /^(\d{8}T\d{9}Z)-([0-9a-f]{32})$/;
const timestamp = z.string().datetime({ offset: true });
const text = z.string().trim().min(1).max(1000).refine((value) => !findSecrets(value).length, "keep secrets and approval codes out of card threads");
const fields = { kind: z.enum(["ask", "task", "approval", "incident", "work", "ship", "order", "claim", "hold", "progress"]), id: z.string(), at: timestamp, text };
export const SamThreadMessageSchema = z.object({ ...fields, resendOf: z.string().regex(ID).optional() }).strict();
export const OfficerThreadMessageSchema = z.object({ ...fields, from: z.string().trim().min(1).max(40), replyTo: z.string().regex(ID).optional() }).strict();
export type SamThreadMessage = z.infer<typeof SamThreadMessageSchema>;
export type OfficerThreadMessage = z.infer<typeof OfficerThreadMessageSchema>;
export type ThreadMessage = ({ side: "sam" } & SamThreadMessage | { side: "officer" } & OfficerThreadMessage) & { messageId: string };

/** Assigned owner on operational cards; posting officer on Sam-facing cards. */
export function threadOwner(card: BoardRecord): string {
  switch (card.kind) {
    case "progress":
    case "incident":
    case "ship":
    case "order":
    case "claim":
      return card.owner ?? card.from;
    default:
      return card.from;
  }
}

export function threadPrefix(side: "sam" | "officer", kind: Kind, id: string): string {
  return `${side === "sam" ? SAM_THREAD_PREFIX : BOARD_THREAD_PREFIX}${kind}/${id}/`;
}
export function threadKey(side: "sam" | "officer", kind: Kind, id: string, at: string, nonce: string): string {
  if (!validRecordId(kind, id) || !/^[0-9a-f]{32}$/.test(nonce)) throw new Error("invalid thread key");
  return `${threadPrefix(side, kind, id)}${compactStamp(at)}-${nonce}.json`;
}
export function parseThreadKey(key: string): { side: "sam" | "officer"; kind: Kind; id: string; at: string; messageId: string } | null {
  const side = key.startsWith(SAM_THREAD_PREFIX) ? "sam" : key.startsWith(BOARD_THREAD_PREFIX) ? "officer" : null;
  if (!side) return null;
  const suffix = key.slice((side === "sam" ? SAM_THREAD_PREFIX : BOARD_THREAD_PREFIX).length);
  const match = /^([^/]+)\/([^/]+)\/(\d{8}T\d{9}Z-[0-9a-f]{32})\.json$/.exec(suffix);
  if (!match || !isKind(match[1]) || !validRecordId(match[1], match[2]!)) return null;
  const messageId = match[3]!;
  const stamp = ID.exec(messageId)?.[1];
  const at = stamp ? stampToIso(stamp) : null;
  return at ? { side, kind: match[1], id: match[2]!, at, messageId } : null;
}
export function parseThreadMessage(key: string, input: unknown): ThreadMessage | null {
  const parsed = parseThreadKey(key);
  if (!parsed) return null;
  if (parsed.side === "sam") {
    const checked = SamThreadMessageSchema.safeParse(input);
    return checked.success && checked.data.kind === parsed.kind && checked.data.id === parsed.id && checked.data.at === parsed.at
      ? { ...checked.data, side: "sam", messageId: parsed.messageId } : null;
  }
  const checked = OfficerThreadMessageSchema.safeParse(input);
  return checked.success && checked.data.kind === parsed.kind && checked.data.id === parsed.id && checked.data.at === parsed.at
    ? { ...checked.data, side: "officer", messageId: parsed.messageId } : null;
}
export function cardRef(ref: string): { kind: Kind; id: string } | null {
  const match = /^([^/]+)\/([^/]+)$/.exec(ref);
  return match && isKind(match[1]) && validRecordId(match[1], match[2]!) ? { kind: match[1], id: match[2]! } : null;
}

/** Bounded active transcript; older immutable keys remain available to page separately. */
export function recentThread(messages: readonly ThreadMessage[]): ThreadMessage[] {
  const sorted = [...messages].sort((a, b) => a.at.localeCompare(b.at) || a.messageId.localeCompare(b.messageId) || a.side.localeCompare(b.side));
  const recent: ThreadMessage[] = [];
  let bytes = 2;
  for (let index = sorted.length - 1; index >= 0 && recent.length < 100; index--) {
    const message = sorted[index]!;
    const size = new TextEncoder().encode(JSON.stringify(message)).length + 1;
    if (bytes + size > 32 * 1024) break;
    recent.push(message);
    bytes += size;
  }
  return recent.reverse();
}
