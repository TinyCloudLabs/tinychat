// SECURITY: purge-on-OFF. Review with replicationClient.ts and replicationSignOut.ts.
//
// When replication is OFF (flag unset, kill switch engaged, platform refused) and this browser may
// still hold a local copy from an earlier ON session, remove it on the next load: shred the keys
// FIRST, then delete the stores. The copy is an encrypted cache of node data, so nothing is lost.
//
// Why a dedicated path (read from @tinycloud/replica 0.3.0-beta.8 kv-storage and node-sdk beta.29):
//  - `TinyCloudWeb.signOut()` only denies the replica when `config.replication.enabled`, and an OFF
//    client has none, so signing out OFF never shreds anything;
//  - lifecycle recovery (erase of already-denied rows) only runs when the plugin is built or a
//    replica opens, i.e. never while OFF;
//  - `replication.purge()` needs a signed-in identity with a live gate and cannot address another
//    identity's partition.
// The SDK's own entry point for this is the browser lifecycle gate (`storage.lifecycle`), the same
// object signOut uses: `deny({ reason: "sign_out", principal })` commits, in ONE IndexedDB
// transaction, the deny marker, the erase intents and the deletion of the AES-GCM/HMAC keys (the
// shred), and `recover()` then erases the rows the intents name. Calling them in that order is the
// "key first, stores second" contract; we never delete rows ourselves.
//
// Which identity: the origin has ONE replica gate, so at most one account holds a live copy; an
// account switch while ON already denied the previous one (its rows are erased by `recover()`,
// which is identity-independent). `deny` only acts when `principal` equals the gate's principal
// (anything else is a no-op "stale"), so the principal we name is the one recorded by the last ON
// session (`rememberReplicationPrincipal`), never the currently signed-in account unless it is that
// one, and never another origin. A copy whose principal we cannot name is left for `recover()`
// only (known limit: there is no SDK call that denies an unnamed live gate).
//
// Detecting "a copy may exist" costs two localStorage reads and no import, network call or sign-in
// change: our own marker (written when an ON config is built, upgraded to the principal after
// sign-in) or the SDK's pending-logout marker. Only then is the replica chunk lazily loaded. The
// marker is removed only after deny AND recovery report clean, so a failure retries next load.
import { isReplicationEnabled } from "./replicationFlag";
import { defaultReplicationLoader, type ReplicationPluginLoader } from "./replicationClient";
import { browserMarkerStore, REPLICATION_COPY_KEY, SDK_LOGOUT_MARKER_KEY, type MarkerStore } from "./replicationCopyMarker";
import { setReplicationOffPurgeCode } from "./replicationStatus";

const RECOVER_TIMEOUT_MS = 10_000;

export type ReplicationOffPurgeOutcome =
  | { status: "skipped"; reason: "replication-on" | "no-copy" }
  | { status: "purged" }
  | { status: "failed"; code: string };

export interface ReplicationOffPurgeDeps {
  loader?: ReplicationPluginLoader;
  store?: MarkerStore | undefined;
  isEnabled?: () => boolean;
}

function codeOf(caught: unknown): string {
  if (caught && typeof caught === "object" && "code" in caught && typeof caught.code === "string") return caught.code;
  return "OFF_PURGE_ERROR";
}

/** Remove a leftover local copy while replication is OFF. Never throws; reports codes only. */
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECOVER_TIMEOUT_MS);
  try {
    const lifecycle = (await (deps.loader ?? defaultReplicationLoader).createStorage())?.lifecycle;
    if (lifecycle?.kind !== "indexeddb") return fail("gate_unavailable");
    // 1. Shred: deny the recorded principal. "unguarded" = the keys may still be there, so STOP:
    //    no erase, no success, marker kept for the next load. "stale" = nothing live for it.
    if (hint?.startsWith("did:pkh:")) {
      const denied = await lifecycle.deny({ reason: "sign_out", principal: hint });
      if (denied.status === "unguarded") return fail(denied.code ?? "unguarded");
    }
    // 2. Erase: recovery deletes the rows the deny (or an earlier sign-out) queued.
    const report = await lifecycle.recover({ signal: controller.signal });
    if (report.failed.length > 0) return fail(report.failed[0]?.code ?? "STORAGE_ERROR");
    if (report.remaining > 0) return fail("purge_pending");
    try { store?.removeItem(REPLICATION_COPY_KEY); } catch { return fail("STORAGE_ERROR"); }
    setReplicationOffPurgeCode(null);
    return { status: "purged" };
  } catch (caught) {
    return fail(codeOf(caught));
  } finally {
    clearTimeout(timer);
  }
}

let startup: Promise<ReplicationOffPurgeOutcome> | undefined;

/** App start: runs the OFF purge once per page load (restore retries must not repeat it). */
export function purgeReplicaCopyWhenOffOnce(): Promise<ReplicationOffPurgeOutcome> {
  startup ??= purgeReplicaCopyWhenOff();
  return startup;
}
