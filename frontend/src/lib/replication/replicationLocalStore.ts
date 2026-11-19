// The lowest layer of the local copy: the localStorage markers and the delete of the origin-wide
// replica database. Imports nothing from the other replication modules, so the sign-out path
// (replicationSignOut.ts), the page-load purge (replicationOffPurge.ts) and the marker helpers
// (replicationCopyMarker.ts) can all share it without an import cycle.

/** "1" = a copy may exist (principal unknown yet); otherwise the pkh DID of the last ON session. */
export const REPLICATION_COPY_KEY = "tinychat:replication:copy";
/** The SDK's own pending-logout marker (kv-storage REPLICA_LOGOUT_MARKER). */
export const SDK_LOGOUT_MARKER_KEY = "tinycloud-replica:logout-pending";
/**
 * Set when a removal of the local copy was requested (the wipe button, switch-off, sign-out) and has
 * not finished. Unlike the copy marker it forces the next load to retry even while replication is ON.
 * The SDK's `tinycloud-replica:deny-tombstone` is NEVER touched by this app: it is the SDK's durable
 * deny floor.
 */
export const REPLICATION_WIPE_PENDING_KEY = "tinychat:replication:wipe-pending";

export type MarkerStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserMarkerStore(): MarkerStore | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

/** The origin-wide replica database name (SDK kv-storage KV_DATABASE, @tinycloud/replica 0.3.0-beta.8). */
export const REPLICA_DATABASE_NAME = "tinycloud-replica-kv";
/** The origin Web Lock the SDK holds for gate operations (kv-storage GATE_LOCK, same version). */
export const REPLICA_GATE_LOCK = "tinycloud-replica-kv:gate";

export type ReplicaDeleteResult = { ok: true } | { ok: false; code: string };

/**
 * How long one delete may wait. A delete queued behind an earlier, still-blocked one fires neither
 * `success` nor `blocked` until the earlier one is processed, and it would hold the origin gate lock
 * meanwhile; the earlier delete itself stays queued and completes once the other connection closes.
 */
export const REPLICA_DELETE_TIMEOUT_MS = 3_000;

/** Delete the origin replica database while holding the origin gate lock. Codes only, never content. */
function removeReplicaDatabase(timeoutMs: number): Promise<ReplicaDeleteResult> {
  // (The frontend's TS lib has no Promise.withResolvers.)
  return new Promise((settle) => {
    const timer = setTimeout(() => settle({ ok: false, code: "DELETE_TIMEOUT" }), timeoutMs);
    const resolve = (result: ReplicaDeleteResult) => { clearTimeout(timer); settle(result); };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(REPLICA_DATABASE_NAME);
    } catch {
      resolve({ ok: false, code: "STORAGE_ERROR" });
      return;
    }
    request.onsuccess = () => resolve({ ok: true });
    request.onerror = () => resolve({ ok: false, code: "STORAGE_ERROR" });
    // Another connection (e.g. another tab) still has the database open: report and retry next load.
    request.onblocked = () => resolve({ ok: false, code: "DELETE_BLOCKED" });
  });
}

export async function deleteReplicaDatabase(timeoutMs: number = REPLICA_DELETE_TIMEOUT_MS): Promise<ReplicaDeleteResult> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (typeof indexedDB === "undefined" || typeof locks?.request !== "function") {
    return { ok: false, code: "gate_unavailable" };
  }
  const outcome: ReplicaDeleteResult = await locks.request(REPLICA_GATE_LOCK, () => removeReplicaDatabase(timeoutMs));
  return outcome;
}
