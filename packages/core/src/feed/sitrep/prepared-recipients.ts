import { recipients } from "./recipients";
import { threadOwner } from "./card-thread";
import type { BoardRecord } from "./schema";
import type { PreparedOwnerResponse, PreparedRecipient } from "./import-bundle";

const normalized = (name: string) => name.trim().replace(/^officer:/, "").toLowerCase();
/** Lookup only within the owner's explicit catalog. A display name grants nothing. */
export function mappedPreparedRecipient(catalog: readonly PreparedRecipient[], name: string): PreparedRecipient | undefined {
  const matches = catalog.filter((recipient) => normalized(recipient.legacyName) === normalized(name));
  return matches.length === 1 ? matches[0] : undefined;
}

export function prepareEventRecipients(record: BoardRecord, event: Pick<PreparedOwnerResponse, "ownerEventKind" | "legacyAnswer" | "payload">, catalog: readonly PreparedRecipient[]) {
  const data = event.payload?.data;
  const noticeTo = data !== null && typeof data === "object" && !Array.isArray(data) && typeof data.to === "string" ? data.to : undefined;
  const primary = event.ownerEventKind === "answer" ? [record.from] : event.ownerEventKind === "claim" ? ["Monica"] : event.ownerEventKind === "thread" ? [threadOwner(record)] : event.ownerEventKind === "hold-notice" ? [noticeTo ?? ""] : recipients(record);
  const copyXO = (event.ownerEventKind === "answer" && event.legacyAnswer?.action !== "code") || event.ownerEventKind === "note" || (event.ownerEventKind === "state" && record.kind === "task");
  const xo = mappedPreparedRecipient(catalog, "xo");
  const xoTarget = xo?.runtimeTarget;
  const xoIsOwner = xoTarget && primary.some((name) => { const target = mappedPreparedRecipient(catalog, name)?.runtimeTarget; return !!target && target.agentId === xoTarget.agentId && target.provider === xoTarget.provider; });
  const names = [...new Set([...primary, ...(copyXO && xo && !xoIsOwner ? ["xo"] : [])])];
  const intended = names.map((name) => mappedPreparedRecipient(catalog, name));
  const go = event.legacyAnswer?.action === "done" && record.kind === "approval" && record.approvalType === "go";
  return {
    names,
    recipientKeys: intended.flatMap((recipient) => recipient ? [recipient.recipientKey] : []),
    unresolvedRecipients: names.filter((name) => !mappedPreparedRecipient(catalog, name)),
    restoreTarget: intended.some((recipient) => recipient?.runtimeTarget) && (!go || Boolean(mappedPreparedRecipient(catalog, record.from)?.runtimeTarget)) ? "agent-response" as const : "owner-only" as const,
  };
}
