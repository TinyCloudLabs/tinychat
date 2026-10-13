/**
 * Metadata-only pending-reconcile state stored in the user's connector KV,
 * with one key per source. `changed_at` records projection change time;
 * `checked_at` is the time that source was read. Backend-ingest refreshes only
 * on existing mount/unlock passes (no timer; it can age indefinitely while a
 * tab stays open); transcriber uses its existing 30-second retry pass while
 * active and unlocked. Either source can age indefinitely without its pass.
 * Consumers use source-specific `checked_at` freshness and treat missing,
 * stale, or future `checked_at` as unknown. Any stored-field addition requires
 * a version bump.
 */

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
  status: "unreconciled" | "completed" | "unknown";
  reconciled: false;
}

export interface PendingReconcileSnapshot {
  version: 1;
  changed_at: string;
  checked_at: string;
  count: number;
  meetings: PendingReconcileMeeting[];
}

export interface PendingSnapshotKvReadSuccess { ok: true; data: unknown }
export interface PendingSnapshotKvReadFailure { ok: false; error: { code: string } }
export interface PendingSnapshotKvWriteResult { ok: boolean }
export interface PendingSnapshotKv {
  get(key: string): Promise<PendingSnapshotKvReadSuccess | PendingSnapshotKvReadFailure>;
  put(key: string, value: string, options?: { ifMatch?: string; ifNoneMatch?: "*" }): Promise<PendingSnapshotKvWriteResult>;
}

const timestampFields = ["ts", "storedAt", "updatedAt", "createdAt", "startedAt", "endedAt", "completedAt"] as const;
const SNAPSHOT_HEARTBEAT_MS = 60 * 60 * 1000;

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

export function transcriberPendingRows(
  rows: readonly TranscriberListRow[],
  savedIds: readonly string[],
  unknownIds: readonly string[] = [],
): PendingReconcileMeeting[] {
  const saved = new Set(savedIds);
  const unknown = new Set(unknownIds);
  const pending: PendingReconcileMeeting[] = [];
  for (const row of rows) {
    if (saved.has(row.id)) continue;
    if ("unavailable" in row) {
      pending.push({ id: row.id, source: "transcriber", status: "unknown", reconciled: false });
      continue;
    }
    if (row.status !== "completed") continue;
    pending.push({
      id: row.id,
      source: "transcriber",
      createdAt: row.created_at,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      status: unknown.has(row.id) ? "unknown" : "completed",
      reconciled: false,
    });
  }
  for (const id of unknown) {
    if (!saved.has(id) && !pending.some((row) => row.id === id)) {
      pending.push({ id, source: "transcriber", status: "unknown", reconciled: false });
    }
  }
  return pending.sort((a, b) => a.id.localeCompare(b.id));
}

function metadataRow(raw: unknown): PendingReconcileMeeting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id.length === 0 || typeof row.source !== "string" || row.reconciled !== false) return null;
  if (row.status !== "unreconciled" && row.status !== "completed" && row.status !== "unknown") return null;
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

function sourceSnapshot(raw: unknown): PendingReconcileSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.changed_at !== "string" || typeof value.checked_at !== "string" || !Array.isArray(value.meetings)) return null;
  const meetings: PendingReconcileMeeting[] = [];
  for (const row of value.meetings) {
    const meeting = metadataRow(row);
    if (meeting === null) return null;
    meetings.push(meeting);
  }
  if (value.count !== meetings.length) return null;
  return {
    version: 1,
    changed_at: value.changed_at,
    checked_at: value.checked_at,
    count: meetings.length,
    meetings: meetings.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function decodedSnapshot(raw: unknown): { snapshot: PendingReconcileSnapshot | null; unsupported: boolean } {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return { snapshot: null, unsupported: false }; }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const version = (raw as Record<string, unknown>).version;
    if (version !== undefined && version !== 1) return { snapshot: null, unsupported: true };
  }
  return { snapshot: sourceSnapshot(raw), unsupported: false };
}


/**
 * Update one source from an existing browser sync result. `observedAt` is
 * captured immediately before its source list request. ETag conditions prevent
 * concurrent same-source writers from replacing a newer observation.
 */
export async function writePendingReconcileSnapshot(
  kv: PendingSnapshotKv,
  source: "backend-ingest" | "transcriber",
  rows: readonly PendingReconcileMeeting[],
  observedAt: string,
  isCurrent: () => boolean = () => true,
): Promise<{ ok: true; changed: boolean } | { ok: false }> {
  const key = `${PENDING_RECONCILE_SNAPSHOT_KEY}/${source}`;
  const read = await kv.get(key);
  if (!isCurrent()) return { ok: false };
  let previous: PendingReconcileSnapshot | undefined;
  let etag: string | undefined;
  if (read.ok) {
    const response = read.data && typeof read.data === "object" ? read.data as { data?: unknown; headers?: { etag?: unknown } } : undefined;
    const raw = response && "data" in response ? response.data : read.data;
    const decoded = decodedSnapshot(raw);
    if (decoded.unsupported) return { ok: false };
    previous = decoded.snapshot ?? undefined; // malformed v1 is repaired below
    if (typeof response?.headers?.etag === "string") etag = response.headers.etag;
    if (etag === undefined) return { ok: false };
  } else if (read.error.code !== "KV_NOT_FOUND") {
    return { ok: false };
  }

  const meetings = rows.map(metadataRow).filter((row): row is PendingReconcileMeeting => row !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const sameProjection = previous !== undefined && JSON.stringify(previous.meetings) === JSON.stringify(meetings);
  if (previous) {
    const checkedMs = Date.parse(previous.checked_at);
    const observedMs = Date.parse(observedAt);
    const future = Number.isFinite(checkedMs) && checkedMs > Date.now();
    if (!future && Number.isFinite(checkedMs) && Number.isFinite(observedMs) && checkedMs >= observedMs) {
      return { ok: true, changed: false };
    }
    if (sameProjection && !future) {
      const checkedAge = observedMs - checkedMs;
      if (Number.isFinite(checkedAge) && checkedAge < SNAPSHOT_HEARTBEAT_MS) {
        return { ok: true, changed: false };
      }
    }
  }

  const snapshot: PendingReconcileSnapshot = {
    version: 1,
    changed_at: sameProjection ? previous!.changed_at : observedAt,
    checked_at: observedAt,
    count: meetings.length,
    meetings,
  };
  if (!isCurrent()) return { ok: false };
  const written = await kv.put(key, JSON.stringify(snapshot), etag === undefined ? { ifNoneMatch: "*" } : { ifMatch: etag });
  return written.ok ? { ok: true, changed: true } : { ok: false };
}
