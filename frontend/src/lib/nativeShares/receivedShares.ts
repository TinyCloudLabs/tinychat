// TC-3195: recordings shared with this account ("Shared with me"), in the recipient's own space. A record keeps the
// claimed child delegation (usable only with this account's signature), what the link showed, who shared it and
// when it was added; never the link or its token.
import { useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { TinyCloudKv } from "@/lib/audio/audioStore";
import { CONNECTORS_KV_PREFIX } from "@/lib/connectors/connectorStore";
import { parseRecordingDisplay, type RecordingShareDisplay } from "./display";
import { openSharedKv, type ClaimedShare, type OpenedShareLink } from "./sdk";
import { sentShares } from "./sentShares";
import { createSpaceRecordStore, type RecordSpace } from "./spaceRecords";

export const RECEIVED_SHARES_PREFIX = `${CONNECTORS_KV_PREFIX}/shares/received/`;
const SHARED_NOTE_PREFIX = "shared:";

export interface ReceivedRecordingShare {
  version: 1;
  /** The share's root CID: claiming the same link twice keeps one record. */
  id: string;
  display: RecordingShareDisplay;
  owner: { address: string; chainId: number; spaceId: string };
  /** The serialized child delegation. */
  delegation: string;
  /** The shared keys and prefixes. */
  paths: string[];
  claimedAt: string;
  /** When access ends at the latest. */
  accessExpiresAt: string;
  /** Set once a read found the owner had stopped sharing. */
  revokedAt?: string;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A stored record, rebuilt from its known fields only. */
export function parseReceivedShare(value: unknown): ReceivedRecordingShare | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const display = parseRecordingDisplay(record.display);
  const owner = typeof record.owner === "object" && record.owner !== null ? (record.owner as Record<string, unknown>) : null;
  const paths = Array.isArray(record.paths) ? record.paths.filter(isText) : [];
  if (record.version !== 1 || !isText(record.id) || !display || !isText(record.delegation) || paths.length === 0 || !isText(record.claimedAt) || !isText(record.accessExpiresAt)) return null;
  if (!owner || !isText(owner.address) || typeof owner.chainId !== "number" || !isText(owner.spaceId)) return null;
  return {
    version: 1,
    id: record.id,
    display,
    owner: { address: owner.address, chainId: owner.chainId, spaceId: owner.spaceId },
    delegation: record.delegation,
    paths,
    claimedAt: record.claimedAt,
    accessExpiresAt: record.accessExpiresAt,
    ...(isText(record.revokedAt) ? { revokedAt: record.revokedAt } : {}),
  };
}

export const receivedShares = createSpaceRecordStore(RECEIVED_SHARES_PREFIX, parseReceivedShare);

/** The record for a share just claimed. Built from the opened link's display and owner only: never its token. */
export function receivedShareRecord(opened: Pick<OpenedShareLink, "owner">, display: RecordingShareDisplay, claimed: ClaimedShare, now: Date): ReceivedRecordingShare {
  return {
    version: 1,
    id: claimed.rootCid,
    display,
    owner: { address: opened.owner.address, chainId: opened.owner.chainId, spaceId: opened.owner.spaceId },
    delegation: claimed.delegation,
    paths: [...claimed.paths],
    claimedAt: now.toISOString(),
    accessExpiresAt: claimed.accessExpiresAt,
  };
}

/** The Library address of a shared recording (`notePath(sharedNoteId(id))`). */
export function sharedNoteId(id: string): string {
  return `${SHARED_NOTE_PREFIX}${id}`;
}

/** The received share a Library address names, or `null` for the account's own notes. */
export function sharedRecordId(noteId: string | null | undefined): string | null {
  return noteId?.startsWith(SHARED_NOTE_PREFIX) ? noteId.slice(SHARED_NOTE_PREFIX.length) : null;
}

/** The transcript key and the audio base the share covers: a path ending in "/" is the audio prefix. */
export function sharedRecordingKeys(paths: readonly string[]): { transcriptKey: string | null; audioBase: string | null } {
  const audio = paths.find((path) => path.endsWith("/"));
  return { transcriptKey: paths.find((path) => !path.endsWith("/")) ?? null, audioBase: audio ? audio.slice(0, -1) : null };
}

export function useReceivedShares() {
  return useSyncExternalStore(receivedShares.subscribe, receivedShares.snapshot, receivedShares.snapshot);
}

// One reader per share for this session: each activation costs the recipient an approval.
const readers = new Map<string, Promise<TinyCloudKv>>();

/** The share's reader. A failed activation is not kept, so the next open asks again. */
export function sharedReader(tcw: TinyCloudWeb, record: ReceivedRecordingShare): Promise<TinyCloudKv> {
  const key = `${tcw.did ?? ""}\n${record.id}`;
  let reader = readers.get(key);
  if (!reader) {
    reader = openSharedKv(tcw, record.delegation);
    readers.set(key, reader);
    reader.catch(() => readers.delete(key));
  }
  return reader;
}

/** The owner stopped sharing: the row says so from now on. */
export async function markReceivedShareRevoked(space: RecordSpace, record: ReceivedRecordingShare, now: Date): Promise<void> {
  readers.delete(`${space.did ?? ""}\n${record.id}`);
  if (record.revokedAt) return;
  await receivedShares.put(space, { ...record, revokedAt: now.toISOString() });
}

/** Remove from Library: the record, and this device's reader for it. */
export async function removeReceivedShare(space: RecordSpace, id: string): Promise<void> {
  readers.delete(`${space.did ?? ""}\n${id}`);
  await receivedShares.remove(space, id);
}

/** Load this account's share records, or clear them (and every reader) on sign-out. */
export function bindNativeShares(space: RecordSpace | null): void {
  if (!space) readers.clear();
  void receivedShares.bind(space);
  void sentShares.bind(space);
}
