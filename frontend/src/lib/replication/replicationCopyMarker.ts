// The "a local copy may exist" marker that lets an OFF load find (and address) a leftover replica
// without loading any replica code. See replicationOffPurge.ts for how it is used.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { clientHasReplication } from "./replicationSignOut";

/** "1" = a copy may exist (principal unknown yet); otherwise the pkh DID of the last ON session. */
export const REPLICATION_COPY_KEY = "tinychat:replication:copy";
/** The SDK's own pending-logout marker (kv-storage REPLICA_LOGOUT_MARKER). */
export const SDK_LOGOUT_MARKER_KEY = "tinycloud-replica:logout-pending";
/**
 * Set when the user asked to remove the local copy and the removal has not finished. Unlike the
 * copy marker it forces the next load to retry even while replication is ON for that user.
 */
export const REPLICATION_WIPE_PENDING_KEY = "tinychat:replication:wipe-pending";

export type MarkerStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserMarkerStore(): MarkerStore | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

/** Called when an ON config is built, before sign-in can create any copy. */
export function noteReplicationCopyPossible(store: MarkerStore | undefined = browserMarkerStore()): void {
  try { if (store && store.getItem(REPLICATION_COPY_KEY) === null) store.setItem(REPLICATION_COPY_KEY, "1"); } catch { /* ON then fails closed in the SDK */ }
}

/** After an ON sign-in/restore: remember the gate's principal so an OFF load can address it. */
export function rememberReplicationPrincipal(tcw: TinyCloudWeb, store: MarkerStore | undefined = browserMarkerStore()): void {
  try {
    const principal = clientHasReplication(tcw) ? tcw.did : undefined;
    if (store && principal?.startsWith("did:pkh:")) store.setItem(REPLICATION_COPY_KEY, principal);
  } catch { /* best effort: the "1" marker still triggers the OFF purge */ }
}

/** True when a local copy may exist: our marker, a pending wipe, or the SDK's pending-logout marker. */
export function replicationCopyMayExist(store: MarkerStore | undefined = browserMarkerStore()): boolean {
  try {
    return [REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, SDK_LOGOUT_MARKER_KEY].some((key) => store?.getItem(key) != null);
  } catch { return false; }
}

export function replicationWipePending(store: MarkerStore | undefined = browserMarkerStore()): boolean {
  try { return store?.getItem(REPLICATION_WIPE_PENDING_KEY) != null; } catch { return false; }
}
