// The user-facing half of local replication: the per-user switch and the wipe button.
//
// Turning ON only records the choice. It takes effect at the next sign-in/restore, when the SDK adds
// `kv/sync` (replicationClient.ts); nothing is re-signed or prompted here.
//
// Turning OFF and Wipe remove the local copy NOW, not at the next load:
//  1. stop the live sync controller, if this client has one (`purge` stops timers and syncs and
//     closes its handles, `close` ends the runtime), so nothing holds the database open or writes
//     to it again;
//  2. the same origin-wide removal the page-load purge uses (replicationOffPurge.ts): deny the
//     recorded principal (shred its keys), delete the encrypted `tinycloud-replica-kv` database
//     under the gate lock, clear the markers.
// A removal that fails is never ignored: it leaves the retry markers, reports its code through the
// status line, and is retried at the next load (even if the user turned the switch back on).
// Sign-out purge (replicationSignOut.ts) is unchanged.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { purgeReplicaCopyWhenOff, type ReplicationOffPurgeDeps, type ReplicationOffPurgeOutcome } from "./replicationOffPurge";
import { browserMarkerStore, REPLICATION_WIPE_PENDING_KEY, type MarkerStore } from "./replicationCopyMarker";
import { writeReplicationOptIn } from "./replicationOptIn";
import { clientHasReplication } from "./replicationSignOut";

/** Upper bound for the live controller to stop its syncs and close its handles. */
const STOP_TIMEOUT_MS = 10_000;

export type ReplicationSwitchResult =
  | { status: "on" }
  | { status: "off"; purge: ReplicationOffPurgeOutcome }
  | { status: "not-saved" };

/** Stops this client's sync controller (if any). Never throws: the origin-wide erase follows regardless. */
async function stopLiveReplica(tcw: TinyCloudWeb | undefined): Promise<void> {
  if (!tcw || !clientHasReplication(tcw)) return;
  const control = tcw.replication;
  try { await control?.purge({ timeoutMs: STOP_TIMEOUT_MS }); } catch { /* the delete below covers the rows */ }
  try { await control?.close(); } catch { /* handles are closed by the delete or the next load */ }
}

/** Removes the local copy now, whatever the switch or the build flag say. Never throws. */
export async function removeLocalCopyNow(
  tcw: TinyCloudWeb | undefined,
  principal: string | undefined,
  deps: ReplicationOffPurgeDeps = {},
): Promise<ReplicationOffPurgeOutcome> {
  const store: MarkerStore | undefined = "store" in deps ? deps.store : browserMarkerStore();
  // Written first: if the page dies mid-removal, the next load finishes it.
  try { store?.setItem(REPLICATION_WIPE_PENDING_KEY, "1"); } catch { /* the purge reports its own failures */ }
  await stopLiveReplica(tcw);
  return purgeReplicaCopyWhenOff({ ...deps, store, principal, isEnabled: () => false });
}

/** Records the user's choice. OFF also removes the local copy now; ON waits for the next sign-in. */
export async function setReplicationSwitch(
  on: boolean,
  tcw: TinyCloudWeb | undefined,
  principal: string,
  deps: ReplicationOffPurgeDeps = {},
): Promise<ReplicationSwitchResult> {
  const store: MarkerStore | undefined = "store" in deps ? deps.store : browserMarkerStore();
  // The choice is saved before the removal starts, so a removal that fails is retried while OFF.
  if (!writeReplicationOptIn(principal, on, store)) return { status: "not-saved" };
  if (on) return { status: "on" };
  return { status: "off", purge: await removeLocalCopyNow(tcw, principal, { ...deps, store }) };
}
