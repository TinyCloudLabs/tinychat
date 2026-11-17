// TC-3195: the owner's record of each recording share, in the owner's own space. It keeps what Stop sharing and the
// share sheet need (the root CID, what is shared, the link's window, the access end) and never the link, its key
// or the share token: once the sheet closes, the link is gone, and the owner makes a new one to send again.
import { useSyncExternalStore } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_KV_PREFIX } from "@/lib/connectors/connectorStore";
import { revokeShare } from "./sdk";
import { createSpaceRecordStore, type RecordSpace } from "./spaceRecords";

export const SENT_SHARES_PREFIX = `${CONNECTORS_KV_PREFIX}/shares/sent/`;

export interface SentRecordingShare {
  version: 1;
  /** The share's root CID (what Stop sharing revokes). */
  id: string;
  /** The link's id (the `/s/<id>` part; not a secret), once the link is made. */
  linkId: string | null;
  /** The Library item shared (`connector_meeting.id`). */
  recordingId: string;
  rootCid: string;
  /** The shared keys and prefixes. */
  paths: string[];
  linkExpiresAt: string;
  accessExpiresAt: string;
  createdAt: string;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTime = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value));

/** A stored record, rebuilt from its known fields only. */
export function parseSentShare(value: unknown): SentRecordingShare | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const paths = Array.isArray(record.paths) ? record.paths.filter(isText) : [];
  if (record.version !== 1 || !isText(record.id) || !isText(record.recordingId) || record.rootCid !== record.id || paths.length === 0) return null;
  if (!isTime(record.linkExpiresAt) || !isTime(record.accessExpiresAt) || !isTime(record.createdAt)) return null;
  return {
    version: 1,
    id: record.id,
    linkId: isText(record.linkId) ? record.linkId : null,
    recordingId: record.recordingId,
    rootCid: record.id,
    paths,
    linkExpiresAt: record.linkExpiresAt,
    accessExpiresAt: record.accessExpiresAt,
    createdAt: record.createdAt,
  };
}

export const sentShares = createSpaceRecordStore(SENT_SHARES_PREFIX, parseSentShare);

/** The record for a share just made, before its link exists. Takes no token and no link, so it cannot keep them. */
export function sentShareRecord(input: { recordingId: string; rootCid: string; paths: readonly string[]; linkExpiresAt: string; accessExpiresAt: string; now: Date }): SentRecordingShare {
  return {
    version: 1,
    id: input.rootCid,
    linkId: null,
    recordingId: input.recordingId,
    rootCid: input.rootCid,
    paths: [...input.paths],
    linkExpiresAt: input.linkExpiresAt,
    accessExpiresAt: input.accessExpiresAt,
    createdAt: input.now.toISOString(),
  };
}

/** The recording's live shares, newest first (the store's records stay in place). */
export function sharesOf(records: readonly SentRecordingShare[], recordingId: string, now = Date.now()): SentRecordingShare[] {
  return records
    .filter((record) => record.recordingId === recordingId && Date.parse(record.accessExpiresAt) > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Whether the owner is sharing `recordingId` (the Library row's and the note's "Shared" badge). */
export function useRecordingShared(recordingId: string | null): boolean {
  const snapshot = useSyncExternalStore(sentShares.subscribe, sentShares.snapshot, sentShares.snapshot);
  return recordingId !== null && sharesOf(snapshot.records, recordingId).length > 0;
}

/** Stop sharing (1 wallet approval per share): revoke each live share of the recording, then drop its record. */
export async function stopSharingRecording(tcw: TinyCloudWeb & RecordSpace, recordingId: string): Promise<void> {
  for (const record of sharesOf(sentShares.snapshot().records, recordingId)) {
    await revokeShare(tcw, record.rootCid);
    await sentShares.remove(tcw, record.id);
  }
}
