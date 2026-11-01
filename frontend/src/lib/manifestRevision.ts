import { manifestCarriesBundle } from "@tinyboilerplate/core";

/**
 * App-owned revision of the sign-in manifest's grants. The manifest's own
 * version cannot signal a grant change, so this constant does. A persisted
 * session recorded under an older revision (or none) is cleared once on
 * restore, so the user signs in again under the current grants.
 *
 * Bump this when the grants change. "1" was used by an earlier, withdrawn gate
 * whose records may still sit in browsers, so the current value is never "1".
 */
export const EXO_MANIFEST_REVISION = "4";

/** Shown above the sign-in action only after the gate clears a stale session (final wording). */
export const MANIFEST_RESIGN_NOTICE =
  "Sign in once more so TinyCloud Home can open your apps and your feed. Your data stays as it is.";

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
 * Restore-time gate used by App. A stale session for `address` is cleared only after
 * the current client's sign-in manifest is known to carry the grants. Then capture
 * is handed off before clearing, so the owner can consent once to that same bundle.
 *
 * "deferred" keeps the session untouched, so the next load runs the gate again: offline,
 * the current manifest unavailable, or the current manifest lacking the bundle. A failed
 * handoff keeps the session and reports "handoff_failed"; the caller stops without clearing.
 */
export async function applyManifestRevisionGate(input: {
  store: RevisionStore | null;
  address: string | null;
  isOffline: () => boolean;
  /** Reports whether the current sign-in manifest carries the bundle; a rejection counts as no. */
  servedManifestCarriesBundle: () => Promise<boolean>;
  handoff: () => Promise<boolean>;
  clearSession: (address: string) => void;
  /** When given, the gate clears a stale session at most once per guard (one page session). */
  promptGuard?: ResignPromptGuard;
}): Promise<ManifestRevisionGate> {
  const { store, address, isOffline, servedManifestCarriesBundle, handoff, clearSession, promptGuard } = input;
  if (!address || !needsManifestResign(store, address)) return "current";
  if (promptGuard?.prompted) return "current";
  if (isOffline()) return "deferred";
  const served = await servedManifestCarriesBundle().catch(() => false);
  if (!served) return "deferred";
  if (!await handoff()) return "handoff_failed";
  clearSession(address);
  if (promptGuard) promptGuard.prompted = true;
  return "cleared";
}

/**
 * Records that this page session has already asked the user to sign in again, so unwritable
 * storage (the record below never sticks) cannot turn every later restore into another
 * forced re-sign. In memory only: a new page session may ask once more.
 */
export interface ResignPromptGuard {
  prompted: boolean;
}

export function createResignPromptGuard(): ResignPromptGuard {
  return { prompted: false };
}

/**
 * Record the current revision after a successful sign-in. Unwritable storage
 * leaves the revision stale; the gate's prompt guard keeps that to one re-sign per page session.
 */
export function recordManifestRevision(store: RevisionStore | null, address: string): void {
  if (!store) return;
  try {
    store.setItem(revisionKey(address), EXO_MANIFEST_REVISION);
  } catch {
    // Not recorded: the next restore finds it stale and re-signs.
  }
}

/**
 * Record the revision after a sign-in only if the manifest that sign-in used carries the bundle.
 * A sign-in under an older served manifest holds the older grants and must not be marked current.
 */
export function recordManifestRevisionIfSigned(
  store: RevisionStore | null,
  address: string,
  signedManifest: Parameters<typeof manifestCarriesBundle>[0],
): void {
  if (manifestCarriesBundle(signedManifest)) recordManifestRevision(store, address);
}

/** Browser storage, or null when it is absent or blocked (reading the global can throw). */
export function browserRevisionStore(): RevisionStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
