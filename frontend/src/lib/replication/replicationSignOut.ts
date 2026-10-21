// SECURITY: sign-out / account-switch half of local replication. Review with replicationClient.ts.
//
// What the SDK does (js-sdk beta.25, confirmed by the replication lead, read from source):
// `TinyCloudWeb.signOut()` -> node `endSession` first awaits a durable replica deny for the
// signed-in account: it writes the deny marker, DELETES the account's AES-GCM/HMAC keys (so the
// sealed rows are unreadable) and records erase intents, all BEFORE the session is cleared. Row
// and blob erase then finishes through lifecycle recovery, which runs when the plugin is built
// (next page load / next sign-in, for ANY account) and again before any replica opens. Admission
// of a replica needs a clean recovery, otherwise reads go to the network with REPLICA_GATED.
//
// So the app must NOT call `replication.purge()` first (it only erases the current identity's
// prefixes and then stops the controller), and must not build its own retry: it only has to
//   1. await `signOut()` while the replica controller is still alive;
//   2. treat the SDK's "Replica gate was not denied" error as a FAILED PURGE: sign-out itself has
//      succeeded (the session is cleared), but the user is told and the status line shows it;
//   3. run this for every local sign-out, including server-side session loss, not just the button.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { markReplicationPurgeFailed } from "./replicationStatus";

export const REPLICA_PURGE_FAILED_WARNING =
  "You are signed out, but this browser's saved copy of your meetings may not have been fully removed. "
  + "It stays locked and is not read; reload and sign in again to finish removing it.";

export type ReplicaSignOutResult = { ok: true } | { ok: false; message: string; code: string };

const GATE_NOT_DENIED = /Replica gate was not denied(?: \(([^)]*)\))?/;

/** True when this client was built with replication (never throws; OFF clients have no controller). */
export function clientHasReplication(tcw: TinyCloudWeb): boolean {
  try { return tcw.replication !== undefined; } catch { return false; }
}

const inFlight = new WeakMap<TinyCloudWeb, Promise<ReplicaSignOutResult>>();

/**
 * `tcw.signOut()`, once per client. On a replica client, any failure resolves `{ ok: false }`
 * so the caller shows the purge warning; clients without replication rethrow.
 */
export function signOutReplicaAware(tcw: TinyCloudWeb): Promise<ReplicaSignOutResult> {
  const existing = inFlight.get(tcw);
  if (existing) return existing;
  const task = (async (): Promise<ReplicaSignOutResult> => {
    try {
      await tcw.signOut?.();
      return { ok: true };
    } catch (caught) {
      if (!clientHasReplication(tcw)) throw caught;
      const text = caught instanceof Error ? caught.message : String(caught);
      const match = GATE_NOT_DENIED.exec(text);
      const code = match ? match[1]?.trim() || "REPLICA_GATE_NOT_DENIED" : "REPLICA_SIGNOUT_FAILED";
      markReplicationPurgeFailed(code);
      return { ok: false, message: REPLICA_PURGE_FAILED_WARNING, code };
    }
  })();
  inFlight.set(tcw, task);
  return task;
}
