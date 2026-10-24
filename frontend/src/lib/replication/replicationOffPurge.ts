// Purge-on-OFF: when replication is OFF for the signed-in user (build flag unset, kill switch
// engaged, platform refused, or the user's own switch OFF) and this
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
// Detection: our localStorage marker (written when an ON config is built), a pending user-requested
// wipe, or the SDK's pending-logout marker. With none, nothing is loaded and no IndexedDB is opened.
// Only when a principal is recorded is the replica chunk loaded lazily, for the deny step.
//
// A pending wipe (REPLICATION_WIPE_PENDING_KEY: set by the wipe button and by any failed purge) is
// retried at the next load even when replication is ON for that user, so a failed removal is never
// forgotten. The same purge backs "turn OFF" and "wipe" at click time (replicationSwitch.ts).
import { isReplicationEnabled } from "./replicationFlag";
import { defaultReplicationLoader, type ReplicationPluginLoader } from "./replicationClient";
import {
  browserMarkerStore, deleteReplicaDatabase, REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, SDK_LOGOUT_MARKER_KEY,
  type MarkerStore, type ReplicaDeleteResult,
} from "./replicationLocalStore";
import { trackStartupPurge } from "./replicationStartupPurge";
import { setReplicationOffPurgeCode, setReplicationPurging } from "./replicationStatus";

// The database name, gate lock and the delete itself live in replicationLocalStore.ts (shared with
// the sign-out path); re-exported here so existing imports keep working.
export { deleteReplicaDatabase, REPLICA_DATABASE_NAME, REPLICA_GATE_LOCK, type ReplicaDeleteResult } from "./replicationLocalStore";

export type ReplicationOffPurgeOutcome =
  | { status: "skipped"; reason: "replication-on" | "no-copy" }
  | { status: "purged" }
  | { status: "failed"; code: string };

export interface ReplicationOffPurgeDeps {
  loader?: ReplicationPluginLoader;
  store?: MarkerStore | undefined;
  /** The signed-in principal whose user setting decides ON/OFF; none = OFF. */
  principal?: string | undefined;
  isEnabled?: () => boolean;
  deleteDatabase?: () => Promise<ReplicaDeleteResult>;
}

function codeOf(caught: unknown): string {
  if (caught && typeof caught === "object" && "code" in caught && typeof caught.code === "string") return caught.code;
  return "OFF_PURGE_ERROR";
}

/** Remove the origin's leftover replica copy while replication is OFF (or a wipe is pending). Never throws; reports codes only. */
export async function purgeReplicaCopyWhenOff(deps: ReplicationOffPurgeDeps = {}): Promise<ReplicationOffPurgeOutcome> {
  const store = "store" in deps ? deps.store : browserMarkerStore();
  let hint: string | null = null;
  let logoutPending = false;
  let wipePending = false;
  try {
    hint = store?.getItem(REPLICATION_COPY_KEY) ?? null;
    logoutPending = (store?.getItem(SDK_LOGOUT_MARKER_KEY) ?? null) !== null;
    wipePending = (store?.getItem(REPLICATION_WIPE_PENDING_KEY) ?? null) !== null;
  } catch { /* no readable storage: no marker, nothing to address */ }
  if (!wipePending && (deps.isEnabled ?? (() => isReplicationEnabled({ principal: deps.principal })))()) {
    return { status: "skipped", reason: "replication-on" };
  }
  if (hint === null && !logoutPending && !wipePending) return { status: "skipped", reason: "no-copy" };

  setReplicationPurging(true);
  try {
    return await removeCopy(deps, store, hint);
  } finally {
    setReplicationPurging(false);
  }
}

async function removeCopy(
  deps: ReplicationOffPurgeDeps,
  store: MarkerStore | undefined,
  hint: string | null,
): Promise<ReplicationOffPurgeOutcome> {

  const fail = (code: string): ReplicationOffPurgeOutcome => {
    setReplicationOffPurgeCode(code);
    return { status: "failed", code };
  };
  // Keep (or write) the retry markers so the next load runs the purge again, whatever the user
  // setting is by then; report both failures.
  const failAndRetry = (code: string): ReplicationOffPurgeOutcome => {
    try {
      store?.setItem(REPLICATION_COPY_KEY, hint ?? "1");
      store?.setItem(REPLICATION_WIPE_PENDING_KEY, "1");
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
    store?.removeItem(REPLICATION_WIPE_PENDING_KEY);
  } catch {
    return fail("STORAGE_ERROR");
  }
  setReplicationOffPurgeCode(null);
  return { status: "purged" };
}

let startup: Promise<ReplicationOffPurgeOutcome> | undefined;

/** App start: runs the purge once per page load (restore retries must not repeat it). */
export function purgeReplicaCopyWhenOffOnce(principal?: string): Promise<ReplicationOffPurgeOutcome> {
  startup ??= trackStartupPurge(purgeReplicaCopyWhenOff({ principal }));
  return startup;
}
