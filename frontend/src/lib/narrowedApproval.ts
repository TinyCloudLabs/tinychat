import type { PermissionEntry } from "@tinycloud/web-sdk";
import { APP_NAME } from "./homeSite";

// DRAFT COPY, Monica words it. The owner approved OpenKey's review with some permissions unticked; the app cannot work
// with less than it asked for, so it says which permissions it needs and why, and how to try again.
const WHAT: Record<string, string> = {
  "tinycloud.kv": "save your chats, notes and settings",
  "tinycloud.sql": "keep your library, feed and recordings",
  "tinycloud.hooks": "get live updates",
  "tinycloud.encryption": "decrypt the connector credentials you add",
};
const FALLBACK = "use your TinyCloud space";

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? FALLBACK;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Which permissions the approval left out, in plain words, and what to do about it. */
export function narrowedApprovalMessage(missing: readonly Pick<PermissionEntry, "service">[], who: string = APP_NAME, again = "Sign in again"): string {
  const needs = [...new Set(missing.map((entry) => WHAT[entry.service] ?? FALLBACK))];
  return `${who} needs permission to ${joinList(needs)} to work. ${again} and keep every permission ticked.`;
}
