// The user's own switch for local replication: OFF by default, one value per signed-in principal
// in this browser profile, so two accounts in one browser never share it. It is the SECOND gate
// (replicationFlag.ts): the build flag stays the master, so an OFF build can never replicate.
//
// Stored in localStorage (same mechanism as the other per-account switches, e.g.
// chat/useExperimentalFeatures.ts). Only the string "true" means ON; anything else, a missing key
// or an unreadable store is OFF. Turning OFF removes the key.
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

/** False for no principal, no readable store, or any value but "true". Never throws. */
export function readReplicationOptIn(principal: string | undefined, store: MarkerStore | undefined = browserMarkerStore()): boolean {
  if (!principal || !store) return false;
  try { return store.getItem(replicationOptInKey(principal)) === "true"; } catch { return false; }
}

/** Persists the choice. Returns false when it could not be saved (the caller keeps the old state). */
export function writeReplicationOptIn(principal: string, on: boolean, store: MarkerStore | undefined = browserMarkerStore()): boolean {
  if (!store) return false;
  try {
    if (on) store.setItem(replicationOptInKey(principal), "true");
    else store.removeItem(replicationOptInKey(principal));
    return true;
  } catch { return false; }
}
