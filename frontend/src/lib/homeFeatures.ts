import { APP_ID, HOME_FEATURE_ENTRIES, type HomeFeature, type RequiredManifestEntry } from "@tinyboilerplate/core";
import { composeManifestRequest, type Manifest, type PermissionEntry, type TinyCloudWeb } from "@tinycloud/web-sdk";
import { encryptionDecryptGrant } from "./connectors/encryptionGrant";

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

/** Flag `feature` for `address` on this device. A store that refuses the write leaves the feature asking in place. */
export function rememberHomeFeature(store: Pick<Storage, "getItem" | "setItem"> | null, address: string, feature: HomeFeature): void {
  if (!store) return;
  const current = readHomeFeatures(store, address);
  if (current.includes(feature)) return;
  try {
    store.setItem(homeFeaturesKey(address), JSON.stringify([...current, feature]));
  } catch {
    // Not remembered: the feature asks in place next time.
  }
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

/**
 * The Home site's sign-in grant: the base, plus each flagged feature's set, plus the decrypt grant when any set is
 * flagged (it names the owner's DID, so it is composed here, as for the plain build). Nothing flagged: the base itself.
 */
export function homeSignInManifest(base: Manifest, flags: readonly HomeFeature[], address: string): Manifest {
  const entries = flaggedEntries(flags);
  if (entries.length === 0) return base;
  return { ...base, permissions: [...(base.permissions ?? []), ...entries, encryptionDecryptGrant(address)] } as Manifest;
}

/**
 * A feature's set (and the decrypt grant) resolved the way the SDK checks a manifest against a session before it
 * reuses one at sign-in: the resources of the composed request.
 */
export function homeFeatureCoverageEntries(feature: HomeFeature, address: string): PermissionEntry[] {
  const request = composeManifestRequest([{
    manifest_version: 1,
    app_id: APP_ID,
    name: "TinyCloud Home",
    defaults: false,
    permissions: [...HOME_FEATURE_ENTRIES[feature], encryptionDecryptGrant(address)],
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
