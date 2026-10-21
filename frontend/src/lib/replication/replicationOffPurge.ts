// Purge-on-OFF: when replication is OFF (flag unset, kill switch engaged, platform refused) and this
// origin may still hold a local replica copy from an earlier ON session, erase that copy on the next
// load. The erase is origin-wide: the replica database is shared by every account in the origin, so
// the whole `tinycloud-replica-kv` database is deleted. Nothing else is touched.
//
// Order:
//  1. If the last ON session recorded a principal, deny it through the SDK lifecycle gate. This
//     shreds that account's keys and writes the deny tombstone (localStorage, kept). It runs BEFORE
//     the delete and OUTSIDE the gate lock, because the SDK takes that lock itself and it is not
//     reentrant. An "unguarded" deny stops here: no delete, marker kept.
//  2. Under the origin gate lock, delete the replica database.
//  3. On success, clear our marker and the SDK pending-logout marker. A blocked or failed delete
//     keeps (or writes) the marker so the next load retries.
//
// Detection: our localStorage marker (written when an ON config is built) or the SDK's pending-logout
// marker. With neither, nothing is loaded and no IndexedDB is opened. Only when a principal is
// recorded is the replica chunk loaded lazily, for the deny step.
import { isReplicationEnabled } from "./replicationFlag";
import { defaultReplicationLoader, type ReplicationPluginLoader } from "./replicationClient";
import { browserMarkerStore, REPLICATION_COPY_KEY, SDK_LOGOUT_MARKER_KEY, type MarkerStore } from "./replicationCopyMarker";
import { setReplicationOffPurgeCode } from "./replicationStatus";

/** The origin-wide replica database name (SDK kv-storage KV_DATABASE, @tinycloud/replica 0.3.0-beta.8). */
export const REPLICA_DATABASE_NAME = "tinycloud-replica-kv";
/** The origin Web Lock the SDK holds for gate operations (kv-storage GATE_LOCK, same version). */
export const REPLICA_GATE_LOCK = "tinycloud-replica-kv:gate";

export type ReplicationOffPurgeOutcome =
  | { status: "skipped"; reason: "replication-on" | "no-copy" }
  | { status: "purged" }
  | { status: "failed"; code: string };

export type ReplicaDeleteResult = { ok: true } | { ok: false; code: string };

export interface ReplicationOffPurgeDeps {
  loader?: ReplicationPluginLoader;
  store?: MarkerStore | undefined;
  isEnabled?: () => boolean;
  deleteDatabase?: () => Promise<ReplicaDeleteResult>;
}

function codeOf(caught: unknown): string {
  if (caught && typeof caught === "object" && "code" in caught && typeof caught.code === "string") return caught.code;
  return "OFF_PURGE_ERROR";
}

/** Delete the origin replica database while holding the origin gate lock. Codes only, never content. */
function removeReplicaDatabase(): Promise<ReplicaDeleteResult> {
  return new Promise((resolve) => {
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

export async function deleteReplicaDatabase(): Promise<ReplicaDeleteResult> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (typeof indexedDB === "undefined" || typeof locks?.request !== "function") {
    return { ok: false, code: "gate_unavailable" };
  }
  const outcome: ReplicaDeleteResult = await locks.request(REPLICA_GATE_LOCK, removeReplicaDatabase);
  return outcome;
}

/** Remove the origin's leftover replica copy while replication is OFF. Never throws; reports codes only. */
export async function purgeReplicaCopyWhenOff(deps: ReplicationOffPurgeDeps = {}): Promise<ReplicationOffPurgeOutcome> {
  if ((deps.isEnabled ?? isReplicationEnabled)()) return { status: "skipped", reason: "replication-on" };
  const store = "store" in deps ? deps.store : browserMarkerStore();
  let hint: string | null = null;
  let logoutPending = false;
  try {
    hint = store?.getItem(REPLICATION_COPY_KEY) ?? null;
    logoutPending = (store?.getItem(SDK_LOGOUT_MARKER_KEY) ?? null) !== null;
  } catch { /* no readable storage: no marker, nothing to address */ }
  if (hint === null && !logoutPending) return { status: "skipped", reason: "no-copy" };

  const fail = (code: string): ReplicationOffPurgeOutcome => {
    setReplicationOffPurgeCode(code);
    return { status: "failed", code };
  };
  // Keep (or write) the retry marker so the next load runs the purge again; report both failures.
  const failAndRetry = (code: string): ReplicationOffPurgeOutcome => {
    try {
      store?.setItem(REPLICATION_COPY_KEY, hint ?? "1");
    } catch {
      return fail(`${code}+MARKER_WRITE_FAILED`);
    }
    return fail(code);
  };

  // 1. Deny the recorded principal (shred its keys). Skipped when no principal is known: the SDK is
  //    then not loaded at all.
  if (hint?.startsWith("did:pkh:")) {
    try {
      const lifecycle = (await (deps.loader ?? defaultReplicationLoader).createStorage())?.lifecycle;
      if (lifecycle?.kind !== "indexeddb") return failAndRetry("gate_unavailable");
      const denied = await lifecycle.deny({ reason: "sign_out", principal: hint });
      if (denied.status === "unguarded") return failAndRetry(denied.code ?? "unguarded");
    } catch (caught) {
      return failAndRetry(codeOf(caught));
    }
  }

  // 2. Origin-wide erase.
  const deleted = await (deps.deleteDatabase ?? deleteReplicaDatabase)();
  if (!deleted.ok) return failAndRetry(deleted.code);

  // 3. Success: clear the markers. A failed clear leaves a marker, so the next load deletes again
  //    (a no-op on a missing database) and clears it then.
  try {
    store?.removeItem(SDK_LOGOUT_MARKER_KEY);
    store?.removeItem(REPLICATION_COPY_KEY);
  } catch {
    return fail("STORAGE_ERROR");
  }
  setReplicationOffPurgeCode(null);
  return { status: "purged" };
}

let startup: Promise<ReplicationOffPurgeOutcome> | undefined;

/** App start: runs the OFF purge once per page load (restore retries must not repeat it). */
export function purgeReplicaCopyWhenOffOnce(): Promise<ReplicationOffPurgeOutcome> {
  startup ??= purgeReplicaCopyWhenOff();
  return startup;
}
