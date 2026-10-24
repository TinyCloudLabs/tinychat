// SECURITY: sign-out / account-switch half of local replication. Review with replicationClient.ts.
//
// What the SDK does (js-sdk, read from source: node-sdk TinyCloudNode.endSession):
// `TinyCloudWeb.signOut()` -> `endSession` first awaits a durable replica deny for the signed-in
// account: it writes the deny tombstone (localStorage), DELETES the account's AES-GCM/HMAC device keys
// (so the sealed rows are unreadable) and records erase intents, all BEFORE the session is cleared.
// It does NOT delete rows or the database; that happens only through lifecycle recovery at the next
// plugin build. The deny can fail in two ways that KEEP the keys: `marker` (the commit failed and
// the delete was blocked; `signOut()` still resolves, but the SDK's pending-logout marker is set in
// localStorage) and `unguarded` (`signOut()` rejects with "Replica gate was not denied").
//
// So, for every local sign-out (button, and server-side session loss through completeLocalSignOut):
//   1. write the wipe-pending marker synchronously, BEFORE `signOut()`: a page that dies mid
//      sign-out still gets the copy removed at the next load;
//   2. await `signOut()` while the replica controller is still alive. Never call
//      `replication.purge()` first: it only erases this identity's prefixes, stops the controller,
//      and deleting the database before the deny leaves the deny with no gate row, so the tombstone
//      is not advanced;
//   3. once `signOut()` has resolved OR failed (the session is cleared either way), delete the whole
//      origin-wide replica database NOW (the copy is purged at sign-out, not "on next load"). Never
//      `removeLocalCopyNow`: the controller is already closed. Never touch the deny tombstone;
//   4. when the keys were kept (`signOut()` failed, or the SDK's logout marker is set) the delete is
//      retried a few times straight away, because until it succeeds the copy may be readable;
//   5. a delete that still fails keeps the markers (the next load retries) and is reported with a
//      warning and the status line.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  browserMarkerStore, deleteReplicaDatabase, REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, SDK_LOGOUT_MARKER_KEY,
  type MarkerStore, type ReplicaDeleteResult,
} from "./replicationLocalStore";
import { trackStartupPurge } from "./replicationStartupPurge";
import { markReplicationPurgeFailed } from "./replicationStatus";

export const REPLICA_PURGE_FAILED_WARNING =
  "You are signed out, but this browser's saved copy of your meetings may not have been fully removed. "
  + "It stays locked and is not read; reload and sign in again to finish removing it.";

/** Shown when the device keys were kept and the copy could not be removed: it may still be readable. */
export const REPLICA_KEYS_KEPT_WARNING =
  "You are signed out, but a saved copy of your transcripts may still be readable on this device until it is removed. "
  + "Reload and sign in again to finish removing it.";

/** Waits between the immediate delete retries when the keys were kept: 4 attempts in all, 4.25 s at most. */
export const KEYS_KEPT_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000];

export type ReplicaSignOutResult = { ok: true } | { ok: false; message: string; code: string };

export interface ReplicaSignOutDeps {
  store?: MarkerStore | undefined;
  deleteDatabase?: () => Promise<ReplicaDeleteResult>;
  sleep?: (ms: number) => Promise<void>;
}

const GATE_NOT_DENIED = /Replica gate was not denied(?: \(([^)]*)\))?/;

/** True when this client was built with replication (never throws; OFF clients have no controller). */
export function clientHasReplication(tcw: TinyCloudWeb): boolean {
  try { return tcw.replication !== undefined; } catch { return false; }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

type Removal = { status: "deleted" } | { status: "skipped" } | { status: "failed"; code: string };

/** Delete the replica database, retrying after each delay while it fails. Never throws. */
async function deleteWithRetries(deps: ReplicaSignOutDeps, delays: readonly number[]): Promise<Removal> {
  // Without IndexedDB no replica store can exist: nothing to remove (not a success of the purge either).
  if (!deps.deleteDatabase && typeof indexedDB === "undefined") return { status: "skipped" };
  const remove = deps.deleteDatabase ?? deleteReplicaDatabase;
  const attempt = async (): Promise<ReplicaDeleteResult> => {
    try { return await remove(); } catch { return { ok: false, code: "STORAGE_ERROR" }; }
  };
  let result = await attempt();
  for (const delay of delays) {
    if (result.ok) break;
    await (deps.sleep ?? defaultSleep)(delay);
    result = await attempt();
  }
  return result.ok ? { status: "deleted" } : { status: "failed", code: result.code };
}

/** The copy is gone: clear our markers and the SDK's pending-logout marker. NEVER the deny tombstone. */
function clearMarkers(store: MarkerStore | undefined): void {
  try {
    store?.removeItem(REPLICATION_COPY_KEY);
    store?.removeItem(REPLICATION_WIPE_PENDING_KEY);
    store?.removeItem(SDK_LOGOUT_MARKER_KEY);
  } catch { /* a marker left behind only makes the next load delete again (a no-op on a missing database) */ }
}

const inFlight = new WeakMap<TinyCloudWeb, Promise<ReplicaSignOutResult>>();

/**
 * `tcw.signOut()`, once per client, then the immediate removal of the local copy. On a replica client
 * any failure resolves `{ ok: false }` so the caller shows the warning; clients without replication
 * rethrow their sign-out error and touch nothing.
 *
 * On a replica client the WHOLE task (sign-out, delete and its bounded retries) is registered with
 * trackStartupPurge, so a sign-in or restore that starts on this page waits for it: a delete issued
 * after the new replica was opened would wipe the new copy. Worst case the chain is 4 deletes of at
 * most 3 s each plus 4.25 s of waits (about 16 s); the sign-out button stops WAITING after its own
 * 10 s capture deadline, but the removal keeps running and the next sign-in still waits for it.
 */
export function signOutReplicaAware(tcw: TinyCloudWeb, deps: ReplicaSignOutDeps = {}): Promise<ReplicaSignOutResult> {
  const existing = inFlight.get(tcw);
  if (existing) return existing;
  const task = (async (): Promise<ReplicaSignOutResult> => {
    const hasReplica = clientHasReplication(tcw);
    const store: MarkerStore | undefined = "store" in deps ? deps.store : browserMarkerStore();
    // Synchronously, before signOut(): a page that dies mid sign-out still removes the copy next load.
    if (hasReplica) {
      try { store?.setItem(REPLICATION_WIPE_PENDING_KEY, "1"); } catch { /* the removal below reports its own failure */ }
    }
    let signOutCode: string | null = null;
    try {
      await tcw.signOut?.();
    } catch (caught) {
      if (!hasReplica) throw caught;
      const text = caught instanceof Error ? caught.message : String(caught);
      const match = GATE_NOT_DENIED.exec(text);
      signOutCode = match ? match[1]?.trim() || "REPLICA_GATE_NOT_DENIED" : "REPLICA_SIGNOUT_FAILED";
    }
    if (!hasReplica) return { ok: true };

    // The SDK reports a kept-keys deny as a rejection (`unguarded`) or, for `marker`, only through
    // its localStorage pending-logout marker. A rejection of any other kind is treated the same way.
    let sdkMarker = false;
    try { sdkMarker = (store?.getItem(SDK_LOGOUT_MARKER_KEY) ?? null) !== null; } catch { /* unreadable: no marker seen */ }
    const keysKept = signOutCode !== null || sdkMarker;

    const removal = await deleteWithRetries(deps, keysKept ? KEYS_KEPT_RETRY_DELAYS_MS : []);
    if (removal.status === "deleted" || (removal.status === "skipped" && signOutCode === null)) {
      clearMarkers(store);
      return { ok: true };
    }
    const code = signOutCode ?? (removal.status === "failed" ? removal.code : "REPLICA_SIGNOUT_FAILED");
    markReplicationPurgeFailed(code);
    // Plain words about readability only when the copy is still there and its keys may be too.
    const message = keysKept && removal.status === "failed" ? REPLICA_KEYS_KEPT_WARNING : REPLICA_PURGE_FAILED_WARNING;
    return { ok: false, message, code };
  })();
  inFlight.set(tcw, clientHasReplication(tcw) ? trackStartupPurge(task) : task);
  return inFlight.get(tcw)!;
}
