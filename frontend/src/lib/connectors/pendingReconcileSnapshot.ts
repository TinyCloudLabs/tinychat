import { CONNECTORS_KV_PREFIX } from "./connectorStore";
import type { ConnectorMeetingMeta } from "./meetingsApi";
import type { TranscriberListRow } from "../transcriberApi";

export const PENDING_RECONCILE_SNAPSHOT_KEY = `${CONNECTORS_KV_PREFIX}/pending-reconcile-snapshot`;

export interface PendingReconcileMeeting {
  id: string;
  source: string;
  ts?: string;
  storedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  completedAt?: string;
  status: "unreconciled" | "completed";
  reconciled: false;
}

export interface PendingReconcileSourceSnapshot {
  as_of: string;
  count: number;
  meetings: PendingReconcileMeeting[];
}

export interface PendingReconcileSnapshot {
  version: 1;
  as_of: string;
  sources: Partial<Record<"backend-ingest" | "transcriber", PendingReconcileSourceSnapshot>>;
}

export interface PendingSnapshotKvReadSuccess { ok: true; data: unknown }
export interface PendingSnapshotKvReadFailure { ok: false; error: { code: string } }
export interface PendingSnapshotKvWriteResult { ok: boolean }
export interface PendingSnapshotKv {
  get(key: string): Promise<PendingSnapshotKvReadSuccess | PendingSnapshotKvReadFailure>;
  put(key: string, value: string): Promise<PendingSnapshotKvWriteResult>;
}

const timestampFields = ["ts", "storedAt", "updatedAt", "createdAt", "startedAt", "endedAt", "completedAt"] as const;

export function backendPendingRows(source: string, rows: readonly ConnectorMeetingMeta[]): PendingReconcileMeeting[] {
  return rows.map<PendingReconcileMeeting>((row) => ({
    id: row.sourceId,
    source,
    ...(row.ts === undefined ? {} : { ts: row.ts }),
    ...(row.storedAt === undefined ? {} : { storedAt: row.storedAt }),
    ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
    status: "unreconciled",
    reconciled: false,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

export function transcriberPendingRows(rows: readonly TranscriberListRow[], savedIds: readonly string[]): PendingReconcileMeeting[] {
  const saved = new Set(savedIds);
  const pending: PendingReconcileMeeting[] = [];
  for (const row of rows) {
    if ("unavailable" in row || row.status !== "completed" || saved.has(row.id)) continue;
    pending.push({
      id: row.id,
      source: "transcriber",
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      status: "completed",
      reconciled: false,
    });
  }
  return pending.sort((a, b) => a.id.localeCompare(b.id));
}

function metadataRow(raw: unknown): PendingReconcileMeeting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0 || typeof row.source !== "string" || row.reconciled !== false) return null;
  if (row.status !== "unreconciled" && row.status !== "completed") return null;
  const projected: PendingReconcileMeeting = {
    id: row.id,
    source: row.source,
    status: row.status,
    reconciled: false,
  };
  for (const field of timestampFields) {
    const value = row[field];
    if (typeof value === "string") projected[field] = value;
  }
  return projected;
}

function sourceSnapshot(raw: unknown): PendingReconcileSourceSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.as_of !== "string" || !Array.isArray(value.meetings)) return null;
  const meetings: PendingReconcileMeeting[] = [];
  for (const row of value.meetings) {
    const meeting = metadataRow(row);
    if (meeting === null) return null;
    meetings.push(meeting);
  }
  if (value.count !== meetings.length) return null;
  return { as_of: value.as_of, count: meetings.length, meetings: meetings.sort((a, b) => a.id.localeCompare(b.id)) };
}

function parseSnapshot(raw: unknown): PendingReconcileSnapshot | null {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.as_of !== "string" || !value.sources || typeof value.sources !== "object" || Array.isArray(value.sources)) return null;
  const input = value.sources as Record<string, unknown>;
  const sources: PendingReconcileSnapshot["sources"] = {};
  for (const name of ["backend-ingest", "transcriber"] as const) {
    if (input[name] === undefined) continue;
    const parsed = sourceSnapshot(input[name]);
    if (parsed === null) return null;
    sources[name] = parsed;
  }
  return { version: 1, as_of: value.as_of, sources };
}


/**
 * Update one source from an existing browser sync result. The read/compare/write
 * belongs to the caller's serialized TinyCloud lane. A source is written only
 * when its metadata projection changes; `as_of` is the last-change time, not a
 * heartbeat, so age is conservative.
 */
export async function writePendingReconcileSnapshot(
  kv: PendingSnapshotKv,
  source: "backend-ingest" | "transcriber",
  rows: readonly PendingReconcileMeeting[],
  now: () => string = () => new Date().toISOString(),
  isCurrent: () => boolean = () => true,
): Promise<{ ok: true; changed: boolean } | { ok: false }> {
  const read = await kv.get(PENDING_RECONCILE_SNAPSHOT_KEY);
  if (!isCurrent()) return { ok: false };
  let previous: PendingReconcileSnapshot = { version: 1, as_of: "", sources: {} };
  if (read.ok) {
    const data = read.data && typeof read.data === "object" && "data" in read.data ? read.data.data : read.data;
    const parsed = parseSnapshot(data);
    if (parsed === null) return { ok: false };
    previous = parsed;
  } else if (read.error.code !== "KV_NOT_FOUND") {
    return { ok: false };
  }

  const meetings = rows.map(metadataRow).filter((row): row is PendingReconcileMeeting => row !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const oldSource = previous.sources[source];
  if (oldSource && JSON.stringify(oldSource.meetings) === JSON.stringify(meetings)) return { ok: true, changed: false };

  const asOf = now();
  const snapshot: PendingReconcileSnapshot = {
    version: 1,
    as_of: asOf,
    sources: {
      ...previous.sources,
      [source]: { as_of: asOf, count: meetings.length, meetings },
    },
  };
  if (!isCurrent()) return { ok: false };
  const written = await kv.put(PENDING_RECONCILE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  return written.ok ? { ok: true, changed: true } : { ok: false };
}
