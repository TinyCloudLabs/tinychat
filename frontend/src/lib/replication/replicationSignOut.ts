import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  browserMarkerStore, REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, SDK_LOGOUT_MARKER_KEY,
  type MarkerStore,
} from "./replicationLocalStore";
import { trackStartupPurge } from "./replicationStartupPurge";
import { markReplicationPurgeFailed } from "./replicationStatus";

export const REPLICA_PURGE_FAILED_WARNING =
  "You are signed out, but this browser's saved copy of your meetings may not have been fully removed. "
  + "Reload and sign in again to finish removing it.";

export const REPLICA_KEYS_KEPT_WARNING =
  "You are signed out, but a saved copy of your transcripts may still be readable on this device until it is removed. "
  + "Reload and sign in again to finish removing it.";

export type ReplicaSignOutResult = { ok: true } | { ok: false; message: string; code: string };

export interface ReplicaSignOutDeps {
  store?: MarkerStore | undefined;
  remoteTimeoutMs?: number;
}


const GATE_NOT_DENIED = /Replica gate was not denied(?: \(([^)]*)\))?/;
const REMOTE_SIGN_OUT_TIMEOUT_MS = 5_000;
const inFlight = new WeakMap<TinyCloudWeb, Promise<ReplicaSignOutResult>>();
function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TinyCloud sign-out timed out")), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** True when this client was built with replication (never throws; OFF clients have no controller). */
export function clientHasReplication(tcw: TinyCloudWeb): boolean {
  try { return tcw.replication !== undefined; } catch { return false; }
}

function clearCompletedMarkers(store: MarkerStore | undefined, principal: string): boolean {
  try {
    if (store?.getItem(SDK_LOGOUT_MARKER_KEY) != null) return false;
    const copyPrincipal = store?.getItem(REPLICATION_COPY_KEY);
    if (copyPrincipal?.toLowerCase() === principal.toLowerCase()) {
      store?.removeItem(REPLICATION_COPY_KEY);
      store?.removeItem(REPLICATION_WIPE_PENDING_KEY);
    }
    return true;
  } catch { return false; }
}


/** Stop the SDK session; its signOut path owns replica denial, key shredding, and local-copy erasure. */
export function signOutReplicaAware(tcw: TinyCloudWeb, deps: ReplicaSignOutDeps = {}): Promise<ReplicaSignOutResult> {
  const existing = inFlight.get(tcw);
  if (existing) return existing;
  const hasReplica = clientHasReplication(tcw);
  let resolveTask!: (result: ReplicaSignOutResult) => void;
  let rejectTask!: (error: unknown) => void;
  const pendingTask = new Promise<ReplicaSignOutResult>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  const task = hasReplica ? trackStartupPurge(pendingTask) : pendingTask;
  inFlight.set(tcw, task);
  const run = async (): Promise<ReplicaSignOutResult> => {
    try {
      // Invoke signOut now so the SDK fences credential writers before another queued
      // persistence microtask can run after the app's synchronous local clear.
      await withTimeout(
        Promise.resolve(tcw.signOut?.()),
        deps.remoteTimeoutMs ?? REMOTE_SIGN_OUT_TIMEOUT_MS,
      );
    } catch (caught) {
      if (!hasReplica) throw caught;
      const text = caught instanceof Error ? caught.message : String(caught);
      const match = GATE_NOT_DENIED.exec(text);
      const code = match ? match[1]?.trim() || "REPLICA_GATE_NOT_DENIED" : "REPLICA_SIGNOUT_FAILED";
      markReplicationPurgeFailed(code);
      return { ok: false, message: REPLICA_PURGE_FAILED_WARNING, code };
    }
    if (hasReplica) {
      const store = "store" in deps ? deps.store : browserMarkerStore();
      if (!clearCompletedMarkers(store, tcw.did)) {
        markReplicationPurgeFailed("REPLICA_PURGE_FAILED");
        return { ok: false, message: REPLICA_PURGE_FAILED_WARNING, code: "REPLICA_PURGE_FAILED" };
      }
    }
    return { ok: true };
  };
  void run().then(resolveTask, rejectTask);
  return task;
}
