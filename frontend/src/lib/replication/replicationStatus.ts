// Read-only replica status for the debug line. Counters and codes only: no keys, paths, prefixes,
// space ids or contents are stored or logged (replication events carry them; we drop them here).
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

export interface ReplicationStatus {
  /** Worst per-prefix state: ready / idle / gated / unavailable / … (SDK ReplicaState). */
  state: string;
  lastSyncAt: string | null;
  /** SDK error code such as STORAGE_BUDGET, STORAGE_FULL, REPLICA_GATED. */
  errorCode: string | null;
  bytes: number;
  keys: number;
  /** An unfinished erase from a previous sign-out (SDK `purgePending`). */
  purgePending: boolean;
  /** A sign-out whose replica deny/erase did not complete. Set by replicationSignOut. */
  purgeFailed: boolean;
}

const INITIAL: ReplicationStatus = {
  state: "idle", lastSyncAt: null, errorCode: null, bytes: 0, keys: 0, purgePending: false, purgeFailed: false,
};

let current: ReplicationStatus = INITIAL;
const listeners = new Set<() => void>();

function publish(next: ReplicationStatus): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

export function getReplicationStatus(): ReplicationStatus { return current; }
export function subscribeReplicationStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function resetReplicationStatus(): void { publish(INITIAL); }
export function markReplicationPurgeFailed(code: string): void {
  publish({ ...current, purgeFailed: true, errorCode: code });
}

/** Subset of the SDK `replication.sync` / `replication.state` events this view reads. */
export interface ReplicationEventLike {
  type: string;
  outcome?: string;
  code?: string;
  at?: string;
  state?: string;
}

/** `onEvent` handler for the SDK. Keeps only outcome, code and time. */
export function recordReplicationEvent(event: ReplicationEventLike): void {
  if (event.type === "replication.sync") {
    if (event.outcome === "ok") publish({ ...current, lastSyncAt: event.at ?? current.lastSyncAt, errorCode: null });
    else if (event.outcome === "error") publish({ ...current, errorCode: event.code ?? "SYNC_ERROR" });
  } else if (event.type === "replication.state" && (event.state === "purge_failed" || event.state === "unavailable")) {
    publish({ ...current, errorCode: event.code ?? event.state });
  }
}

const STATE_RANK = ["ready", "idle", "closed", "grant_missing", "runtime_unsupported", "unavailable", "revoked", "gated"];

/** Poll the controller once; folds per-prefix entries into a single status. */
export async function refreshReplicationStatus(tcw: TinyCloudWeb): Promise<ReplicationStatus> {
  const control = tcw.replication;
  if (!control) return current;
  try {
    const entries = await control.status();
    let state = "ready";
    let lastSyncAt: string | null = null;
    let errorCode: string | null = null;
    let bytes = 0;
    let keys = 0;
    let purgePending = false;
    for (const entry of entries) {
      if (STATE_RANK.indexOf(entry.state) > STATE_RANK.indexOf(state)) state = entry.state;
      if (entry.lastSyncAt && (!lastSyncAt || entry.lastSyncAt > lastSyncAt)) lastSyncAt = entry.lastSyncAt;
      errorCode ??= entry.lastError?.code ?? entry.errorCode ?? null;
      bytes += entry.bytes ?? 0;
      keys += entry.counts?.keys ?? 0;
      if ("purgePending" in entry && entry.purgePending === true) purgePending = true;
    }
    publish({ ...current, state, lastSyncAt, errorCode: errorCode ?? current.errorCode, bytes, keys, purgePending });
  } catch (caught) {
    publish({ ...current, state: "unavailable", errorCode: caught instanceof Error && "code" in caught && typeof caught.code === "string" ? caught.code : "STATUS_ERROR" });
  }
  return current;
}
