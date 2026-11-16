import { APP_ID, type RequiredManifestEntry } from "@tinyboilerplate/core";
import { composeManifestRequest, type Manifest, type PermissionEntry, type TinyCloudWeb } from "@tinycloud/web-sdk";
import { encryptionDecryptGrant, withEncryptionDecryptGrant } from "./connectors/encryptionGrant";

/**
 * The one feature the web sign-in leaves out until it is used: Connectors, which keeps the owner's connector keys and
 * sign-ins encrypted in their secrets space. Everything else (chat, feed, apps, Recording) is in the base grant.
 */
export type HomeFeature = "connectors";

const HOME_FEATURES: readonly HomeFeature[] = ["connectors"];

/**
 * Which features this device has used, per owner address. It holds only feature names, never anything secret, so
 * sign-out keeps it: it is device knowledge that lets the next sign-in ask for those sets in its one approval.
 * Clearing it is safe; the feature then asks in place again. Earlier builds may also have stored "recording" here;
 * it is ignored.
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

/**
 * The secret keys manifest.json's secrets block resolves to (the owner's secrets space, vault/secrets/<NAME>), plus the
 * meeting storage Connectors writes. The sign-in asks for them through the manifest itself; this list is only what a
 * session must cover for Connectors to open.
 */
const CONNECTORS_ENTRIES: readonly RequiredManifestEntry[] = [
  { service: "tinycloud.sql", path: "connectors", actions: ["read", "write", "schema"] },
  { service: "tinycloud.kv", path: "connectors/", actions: ["get", "put", "del", "list"] },
  { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/FIREFLIES_API_KEY", actions: ["get", "put", "del"], skipPrefix: true },
  { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/GRANOLA_API_KEY", actions: ["get", "put", "del"], skipPrefix: true },
  { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/scoped/google-meet/REFRESH_TOKEN", actions: ["get", "put", "del"], skipPrefix: true },
];

/**
 * The web sign-in grant: manifest.json's storage for everything, and its connector secrets with the decrypt grant only
 * once this device has used Connectors. Without that, the secrets block is emptied, so neither the secret keys nor the
 * decrypt and default-network abilities the SDK derives from them are asked for.
 */
export function webSignInManifest(base: Manifest, flags: readonly HomeFeature[], address: string): Manifest {
  return flags.includes("connectors") ? withEncryptionDecryptGrant(base, address) : { ...base, secrets: {} };
}

/**
 * Connectors' set and the decrypt grant, resolved the way the SDK checks a manifest against a session before it reuses
 * one at sign-in: the resources of the composed request.
 */
export function homeFeatureCoverageEntries(_feature: HomeFeature, address: string): PermissionEntry[] {
  const request = composeManifestRequest([{
    manifest_version: 1,
    app_id: APP_ID,
    name: "TinyCloud One",
    defaults: false,
    permissions: [...CONNECTORS_ENTRIES, encryptionDecryptGrant(address)],
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
