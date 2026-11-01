// The "a local copy may exist" marker that lets an OFF load find (and address) a leftover replica
// without loading any replica code. See replicationOffPurge.ts for how it is used.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { clientHasReplication } from "./replicationSignOut";
import { browserMarkerStore, type MarkerStore } from "./replicationLocalStore";

// The keys and the store live in replicationLocalStore.ts (shared with the sign-out path without an
// import cycle); re-exported here so existing imports keep working.
export {
  browserMarkerStore, REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, SDK_LOGOUT_MARKER_KEY, type MarkerStore,
} from "./replicationLocalStore";
import { REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, SDK_LOGOUT_MARKER_KEY } from "./replicationLocalStore";

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
