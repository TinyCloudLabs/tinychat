import { APP_ID, HOME_FEATURE_ENTRIES, type HomeFeature, type RequiredManifestEntry } from "@tinyboilerplate/core";
import { composeManifestRequest, type Manifest, type PermissionEntry, type TinyCloudWeb } from "@tinycloud/web-sdk";
import { encryptionDecryptGrant, withEncryptionDecryptGrant } from "./connectors/encryptionGrant";

export type { HomeFeature } from "@tinyboilerplate/core";

const HOME_FEATURES: readonly HomeFeature[] = ["recording", "connectors"];

/**
 * Which features this device has used, per owner address. It holds only feature names, never anything secret, so
 * sign-out keeps it: it is device knowledge that lets the next sign-in ask for those sets in its one approval.
 * Clearing it is safe; the feature then asks in place again.
 */
function homeFeaturesKey(address: string): string {
  return `xyz.tinycloud.tinychat:home-features:${address.toLowerCase()}`;
}

/** The features flagged for `address`; anything unreadable counts as none. */
export function readHomeFeatures(store: Pick<Storage, "getItem"> | null, address: string): HomeFeature[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(store?.getItem(homeFeaturesKey(address)) ?? "[]");
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? HOME_FEATURES.filter((feature) => parsed.includes(feature)) : [];
}

/**
 * Flag `feature` for `address` on this device; true when the flag is now stored. A store that refuses the write leaves
 * the feature unflagged, and it is tried again only on a later visit.
 */
export function rememberHomeFeature(store: Pick<Storage, "getItem" | "setItem"> | null, address: string, feature: HomeFeature): boolean {
  if (!store) return false;
  const current = readHomeFeatures(store, address);
  if (current.includes(feature)) return true;
  try {
    store.setItem(homeFeaturesKey(address), JSON.stringify([...current, feature]));
  } catch {
    return false;
  }
  return readHomeFeatures(store, address).includes(feature);
}

/** The flagged sets' entries, each once, in feature order. */
function flaggedEntries(flags: readonly HomeFeature[]): RequiredManifestEntry[] {
  const entries: RequiredManifestEntry[] = [];
  for (const feature of HOME_FEATURES) {
    if (!flags.includes(feature)) continue;
    for (const entry of HOME_FEATURE_ENTRIES[feature]) if (!entries.includes(entry)) entries.push(entry);
  }
  return entries;
}

/** The decrypt grant goes with Connectors only: Recording keeps no secret. It names the owner's DID, so it is composed
 * here, as for the plain build. */
const withDecrypt = (features: readonly HomeFeature[], address: string) =>
  features.includes("connectors") ? [encryptionDecryptGrant(address)] : [];

/**
 * The Home site's sign-in grant: the base, plus each flagged feature's set, plus the decrypt grant when Connectors is
 * flagged. Nothing flagged: the base itself.
 */
export function homeSignInManifest(base: Manifest, flags: readonly HomeFeature[], address: string): Manifest {
  const entries = flaggedEntries(flags);
  if (entries.length === 0) return base;
  return { ...base, permissions: [...(base.permissions ?? []), ...entries, ...withDecrypt(flags, address)] } as Manifest;
}

/** Full web keeps feature storage and asks for connector secrets and decrypt only after Connectors use. */
export function webSignInManifest(base: Manifest, flags: readonly HomeFeature[], address: string): Manifest {
  return flags.includes("connectors") ? withEncryptionDecryptGrant(base, address) : { ...base, secrets: {} };
}

/**
 * A feature's set (and, for Connectors, the decrypt grant) resolved the way the SDK checks a manifest against a session
 * before it reuses one at sign-in: the resources of the composed request.
 */
export function homeFeatureCoverageEntries(feature: HomeFeature, address: string): PermissionEntry[] {
  const request = composeManifestRequest([{
    manifest_version: 1,
    app_id: APP_ID,
    name: "TinyCloud Home",
    defaults: false,
    permissions: [...HOME_FEATURE_ENTRIES[feature], ...withDecrypt([feature], address)],
  } as Manifest], { includeAccountRegistryPermissions: false });
  return request.resources as PermissionEntry[];
}

/** Whether the session's signed approval (or a live runtime grant) covers `feature`'s set. Never prompts. */
export function sessionCoversHomeFeature(tcw: Partial<Pick<TinyCloudWeb, "hasPermissions">>, feature: HomeFeature, address: string): boolean {
  try {
    return tcw.hasPermissions?.(homeFeatureCoverageEntries(feature, address)) === true;
  } catch {
    return false;
  }
}

/** What a re-authorise asks for: `feature`, plus every set the session covers or this device used, so a swap never drops one. */
export function homeFeaturesToRequest(
  store: Pick<Storage, "getItem"> | null,
  tcw: Partial<Pick<TinyCloudWeb, "hasPermissions">>,
  address: string,
  feature: HomeFeature,
): HomeFeature[] {
  const flagged = readHomeFeatures(store, address);
  return HOME_FEATURES.filter((each) => each === feature || flagged.includes(each) || sessionCoversHomeFeature(tcw, each, address));
}
