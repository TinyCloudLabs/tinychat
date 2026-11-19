// The user's own switch for local replication: ON by default, one value per signed-in principal
// in this browser profile, so two accounts in one browser never share it. It is the SECOND gate
// (replicationFlag.ts): the build flag stays the master, so an OFF build can never replicate, and
// an explicit opt-out always wins.
//
// Stored in localStorage (same mechanism as the other per-account switches, e.g.
// chat/useExperimentalFeatures.ts). Tri-state: only the string "false" (an explicit opt-out) is
// OFF; "true", a missing key or any other value is ON. An unreadable store is OFF (an opt-out could
// not be remembered), as is no principal. Turning OFF writes "false"; turning ON writes "true".
import { browserMarkerStore, type MarkerStore } from "./replicationCopyMarker";

export const REPLICATION_OPT_IN_KEY_PREFIX = "tinychat:replication:opt-in:";

/** The principal the app signs in as (chain 1 pkh DID), from an account address. */
export function replicationPrincipalFor(address: string): string {
  return `did:pkh:eip155:1:${address}`;
}

/** Case-insensitive: an address may be checksummed in one place and lowercase in another. */
export function replicationOptInKey(principal: string): string {
  return `${REPLICATION_OPT_IN_KEY_PREFIX}${principal.toLowerCase()}`;
}

/** False for no principal, no readable store, or the explicit opt-out "false"; otherwise true. Never throws. */
export function readReplicationOptIn(principal: string | undefined, store: MarkerStore | undefined = browserMarkerStore()): boolean {
  if (!principal || !store) return false;
  try { return store.getItem(replicationOptInKey(principal)) !== "false"; } catch { return false; }
}

/** Persists the choice. Returns false when it could not be saved (the caller keeps the old state). */
export function writeReplicationOptIn(principal: string, on: boolean, store: MarkerStore | undefined = browserMarkerStore()): boolean {
  if (!store) return false;
  try {
    store.setItem(replicationOptInKey(principal), on ? "true" : "false");
    return true;
  } catch { return false; }
}
