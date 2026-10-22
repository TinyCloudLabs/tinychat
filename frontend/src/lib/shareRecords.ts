import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { THREADS_SQL_DB_NAME } from "./threadKeys";

export const SNAPSHOT_KEY_PREFIX = `${THREADS_SQL_DB_NAME}/shares/`;
export const SHARE_INDEX_KEY_PREFIX = `${THREADS_SQL_DB_NAME}/share-index/`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnedShareIndexEntry {
  shareId: string;
  threadId: string;
  title: string;
  key: string;
  cid: string;
  createdAt: string;
  expiresAt: string;
}

export function isShareId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// True only for `<SNAPSHOT_KEY_PREFIX><uuid>`: no traversal, extra segments, or other folders.
export function isSnapshotPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith(SNAPSHOT_KEY_PREFIX) && isShareId(path.slice(SNAPSHOT_KEY_PREFIX.length));
}

export function snapshotKeyFor(shareId: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${shareId}`;
}

export function shareIndexKeyFor(shareId: string): string {
  return `${SHARE_INDEX_KEY_PREFIX}${shareId}`;
}

export function parseKvValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function parseOwnedShareIndexEntry(raw: unknown): OwnedShareIndexEntry | null {
  const value = parseKvValue(raw);
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const valid =
    isShareId(entry.shareId) &&
    typeof entry.threadId === "string" &&
    typeof entry.title === "string" &&
    entry.key === snapshotKeyFor(entry.shareId) &&
    typeof entry.cid === "string" &&
    typeof entry.createdAt === "string" &&
    typeof entry.expiresAt === "string";
  return valid ? (entry as unknown as OwnedShareIndexEntry) : null;
}

export async function listShareIndexKeys(tcw: TinyCloudWeb): Promise<string[]> {
  const indexKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await tcw.kv.list({
      path: SHARE_INDEX_KEY_PREFIX,
      source: "network",
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok) throw new Error(page.error.message);
    for (const key of page.data.keys) {
      if (typeof key === "string" && key.startsWith(SHARE_INDEX_KEY_PREFIX)) indexKeys.push(key);
    }
    const metadata = page.data as typeof page.data & { cursor?: unknown; nextCursor?: unknown };
    const next = metadata.nextCursor ?? metadata.cursor;
    cursor = typeof next === "string" && next ? next : undefined;
  } while (cursor);
  return indexKeys;
}

// Called when a chat is deleted. Removes that chat's share snapshots and owner records.
// Best effort per share: a failure leaves that share's index record in place so the owner can
// still revoke it, and never fails the thread delete.
// The snapshot is deleted before revoke, so the link stops returning data even if revoke fails.
export async function deleteShareRecordsForThread(tcw: TinyCloudWeb, threadId: string): Promise<void> {
  let indexKeys: string[];
  try {
    indexKeys = await listShareIndexKeys(tcw);
  } catch {
    return;
  }
  for (const indexKey of indexKeys) {
    try {
      const res = await tcw.kv.get(indexKey, { source: "network" });
      if (!res.ok) continue;
      const entry = parseOwnedShareIndexEntry(res.data.data);
      if (!entry || entry.threadId !== threadId) continue;
      await tcw.kv.delete(entry.key);
      const revoked = await tcw.revokeDelegation(entry.cid);
      if (!revoked.ok) continue;
      await tcw.kv.delete(indexKey);
    } catch {
      // Left for the owner to revoke from the share list.
    }
  }
}
