import { z } from "zod";
import type { PreparedCardIdentity, PreparedRecipient } from "./import-bundle";

const Attempt = z.object({ recipientKey: z.string().min(1), state: z.enum(["waiting", "claimed", "delivered", "unconfirmed", "refused"]), recipient: z.string(), routedTo: z.enum(["owner", "xo"]), at: z.string().datetime({ offset: true }), reason: z.string().optional(), absentPolls: z.number().int().nonnegative().optional() }).strict();
const Receipts = z.object({ version: z.literal(1), responseId: z.string().min(1), cardId: z.string().min(1), revision: z.number().int().positive(), issuanceId: z.string().min(1), messageId: z.string(), receipts: z.array(Attempt) }).strict();
export type PublisherThreadReceipt = z.infer<typeof Attempt>;

/** This is publisher-reported evidence, not independent runtime verification. */
export function publisherThreadReceipts(detail: unknown, response: PreparedCardIdentity & { responseId: string }, messageId: string, approved: readonly PreparedRecipient[]): PublisherThreadReceipt[] {
  if (!detail || typeof detail !== "object" || !("threadReceipts" in detail)) return [];
  const parsed = Receipts.safeParse(detail.threadReceipts);
  if (!parsed.success) return [];
  const data = parsed.data;
  if (data.responseId !== response.responseId || data.cardId !== response.cardId || data.revision !== response.revision || data.issuanceId !== response.issuanceId || data.messageId !== messageId) return [];
  const seen = new Set<string>();
  for (const receipt of data.receipts) {
    const recipient = approved.find((candidate) => candidate.recipientKey === receipt.recipientKey);
    if (!recipient?.runtimeTarget || recipient.legacyName.toLowerCase() !== receipt.recipient.replace(/^officer:/, "").toLowerCase() || seen.has(receipt.recipientKey)) return [];
    if (receipt.routedTo === "xo" && recipient.legacyName.toLowerCase() !== "xo") return [];
    seen.add(receipt.recipientKey);
  }
  return data.receipts;
}
