/**
 * App-owned revision of the sign-in manifest's grants. The manifest's own
 * version cannot signal a grant change, so this constant does. A persisted
 * session recorded under an older revision (or none) is cleared once on
 * restore, so the user signs in again under the current grants.
 *
 * Bump this when the grants change.
 */
export const EXO_MANIFEST_REVISION = "1";

const REVISION_KEY_PREFIX = "xyz.tinycloud.tinychat:manifest-revision:";

export interface RevisionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function revisionKey(address: string): string {
  return `${REVISION_KEY_PREFIX}${address.toLowerCase()}`;
}

// Unreadable storage counts as stale: the user re-signs under the current grants.
function readRevision(store: RevisionStore | null, address: string): string | null {
  if (!store) return null;
  try {
    return store.getItem(revisionKey(address));
  } catch {
    return null;
  }
}

/**
 * True when the persisted session for `address` predates the current revision
 * and must be cleared so the user signs in again. Never writes.
 */
export function needsManifestResign(store: RevisionStore | null, address: string): boolean {
  return readRevision(store, address) !== EXO_MANIFEST_REVISION;
}

export type ManifestRevisionGate = "current" | "deferred" | "cleared" | "handoff_failed";

/**
 * Restore-time gate used by App. A stale session for `address` gets one capture
 * handoff, then is cleared so the user signs in again. Offline, a stale session is
 * kept and reported "deferred", so the next online load runs the gate. A failed
 * handoff keeps the session and reports "handoff_failed"; the caller stops without clearing.
 */
export async function applyManifestRevisionGate(input: {
  store: RevisionStore | null;
  address: string | null;
  isOffline: () => boolean;
  handoff: () => Promise<boolean>;
  clearSession: (address: string) => void;
}): Promise<ManifestRevisionGate> {
  const { store, address, isOffline, handoff, clearSession } = input;
  if (!address || !needsManifestResign(store, address)) return "current";
  if (isOffline()) return "deferred";
  if (!await handoff()) return "handoff_failed";
  clearSession(address);
  return "cleared";
}

/**
 * Record the current revision after a successful sign-in. Unwritable storage
 * leaves the revision stale, so the next restore re-signs once more.
 */
export function recordManifestRevision(store: RevisionStore | null, address: string): void {
  if (!store) return;
  try {
    store.setItem(revisionKey(address), EXO_MANIFEST_REVISION);
  } catch {
    // Not recorded: the next restore finds it stale and re-signs.
  }
}

/** Browser storage, or null when it is absent or blocked (reading the global can throw). */
export function browserRevisionStore(): RevisionStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
