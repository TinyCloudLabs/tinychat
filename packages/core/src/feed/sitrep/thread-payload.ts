import { parseThreadMessage, threadPrefix, type ThreadMessage } from "./card-thread";
import type { BoardRecord } from "./schema";
import type { SitrepMessageDelivery } from "./model-types";

export type OwnerThreadMessage = Extract<ThreadMessage, { side: "sam" }>;
export const ownerThreadResponseKey = (message: Pick<ThreadMessage, "kind" | "id" | "messageId">): string => JSON.stringify([message.kind, message.id, message.messageId]);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Route data expresses the owner's intended destination, never grants authority. */
export function decodeOwnerThreadMessage(record: Pick<BoardRecord, "kind" | "id">, input: unknown): { message: OwnerThreadMessage; delivery?: SitrepMessageDelivery } {
  if (!object(input) || input.side !== "sam" || typeof input.messageId !== "string") throw new Error("Invalid owner card message");
  const { side: _side, messageId, delivery: route, ...body } = input;
  const message = parseThreadMessage(`${threadPrefix("sam", record.kind, record.id)}${messageId}.json`, body);
  if (!message || message.side !== "sam" || message.kind !== record.kind || message.id !== record.id) throw new Error("Thread identity or immutable timestamp does not match");
  if (route === undefined) return { message };
  if (!object(route) || route.version !== 1 || !Array.isArray(route.targets) || !route.targets.length || Object.keys(route).some((key) => key !== "version" && key !== "targets")) throw new Error("Invalid owner-approved message route");
  const keys = new Set<string>(); const targets: SitrepMessageDelivery["targets"] = [];
  for (const target of route.targets) {
    if (!object(target) || typeof target.recipientKey !== "string" || !target.recipientKey || typeof target.agentId !== "string" || !target.agentId || (target.provider !== undefined && typeof target.provider !== "string") || Object.keys(target).some((key) => !["recipientKey", "agentId", "provider"].includes(key)) || keys.has(target.recipientKey)) throw new Error("Invalid explicit message recipient");
    keys.add(target.recipientKey);
    targets.push({ recipientKey: target.recipientKey, agentId: target.agentId, ...(typeof target.provider === "string" ? { provider: target.provider } : {}) });
  }
  return { message, delivery: { version: 1, targets } };
}
