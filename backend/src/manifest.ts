import { readFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  isCapabilitySubset,
  resolveManifest,
  validateManifest,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/node-sdk/core";
import type { NonEmptyServerInfoPermissions, ServerInfoPermission } from "@tinyboilerplate/core";
import { isCanonicalResourcePath } from "./portable-delegation.js";

export const APP_ID = "xyz.tinycloud.tinychat";
export const THREADS_KV_PATH = "threads/";
export const THREADS_KV_PREFIX = `${APP_ID}/${THREADS_KV_PATH}`;

interface TinychatManifest extends Omit<Manifest, "permissions"> {
  manifest_version?: 1;
  permissions?: Array<PermissionEntry & { description?: string }>;
}

export interface BackendDelegationConfig {
  name: string;
  expiry: string;
  permissions: NonEmptyServerInfoPermissions;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(__dirname, "../../manifest.json");
const BACKEND_DELEGATION_NAME = "TinyChat Backend";
const BACKEND_DELEGATION_EXPIRY = "7d";
/**
 * The same 7 days as a number (§3.3). The delegation accept path clamps the stored `expiresAt`
 * to it: the TTL T2/T4 name as the mitigation has to be a bound this backend applies, not a
 * client-supplied field it repeats back.
 */
export const BACKEND_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function backendDelegationPermissions(): NonEmptyServerInfoPermissions {
  return [
    {
      service: "tinycloud.kv",
      path: THREADS_KV_PATH,
      actions: ["get", "put", "del", "list"],
      description: "Read and write chat threads and messages.",
    },
  ];
}

function validateTinychatManifest(manifest: Manifest): TinychatManifest {
  const candidate = manifest as Manifest & {
    app_id?: unknown;
    backend?: unknown;
    delegations?: unknown;
    defaults?: unknown;
    manifest_version?: unknown;
    permissions?: unknown;
  };

  if (candidate.backend !== undefined) {
    throw new Error(
      "manifest.backend is not supported; backend policy is served by /api/server-info",
    );
  }
  if (candidate.delegations !== undefined) {
    throw new Error(
      "manifest.delegations is not supported; delegate policy is composed by app code",
    );
  }
  if (candidate.manifest_version !== undefined && candidate.manifest_version !== 1) {
    throw new Error("manifest.manifest_version must be 1");
  }
  if (candidate.app_id !== APP_ID) {
    throw new Error(`manifest.app_id must be ${APP_ID}`);
  }
  if (candidate.defaults !== false) {
    throw new Error("TinyChat manifest must use defaults: false");
  }
  if (!Array.isArray(candidate.permissions)) {
    throw new Error("TinyChat manifest must declare explicit permissions");
  }

  return manifest as TinychatManifest;
}

// The manifest is baked into the image and cannot change without a redeploy, but
// `runtimeManifest()` sits under `validateBackendPolicy()`, which §3.6 rule 2 puts on the
// per-write path: without memoization a drained queue pays a synchronous `readFileSync`
// plus several `resolveManifest` passes per item, on the event loop of a public HTTP
// server. Memoized for the process lifetime (§9.3). Nothing here mutates the cached
// manifest — `resolveManifest`/`validateManifest` only read it — and the resolved policy
// is cloned on the way out, so callers cannot corrupt the cache either.
let memoizedManifest: TinychatManifest | undefined;
let backendPolicyValidated = false;
let memoizedResolvedPolicy: ServerInfoPermission[] | undefined;
const memoizedPolicyHashes = new Map<string, string>();

export function runtimeManifest(): TinychatManifest {
  if (memoizedManifest === undefined) {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
    memoizedManifest = validateTinychatManifest(validateManifest(raw));
  }
  return memoizedManifest;
}

/**
 * Key a permission by the pair that identifies it after resolution. `resolveManifest` is
 * not order- or shape-preserving: entries flat-map (a `tinycloud.vault` entry becomes a
 * `tinycloud.kv` one at `vault/<path>`), the result is deduped, and a
 * `tinycloud.capabilities` resource is appended — so the filter below can drop an entry
 * from the middle of the array. Matching resolved entries back to their inputs by array
 * index therefore misattaches `skipPrefix` and `description` as soon as the policy has
 * more than one entry, and a lost `skipPrefix: true` changes the resolved path form and
 * so both the coverage check and the policy hash — silently, since the hash excludes
 * `description` (§3.2).
 */
function resolvedPermissionKey(service: string, resolvedPath: string): string {
  return `${service}\u0000${resolvedPath}`;
}

export function resolvePermissions(
  manifest: TinychatManifest,
  permissions: readonly ServerInfoPermission[],
): ServerInfoPermission[] {
  const { secrets: _secrets, ...manifestWithoutGeneratedResources } = manifest;
  const requestedByKey = new Map<string, ServerInfoPermission>();
  for (const permission of permissions) {
    const key = resolvedPermissionKey(
      permission.service,
      permission.skipPrefix ? permission.path : `${APP_ID}/${permission.path}`,
    );
    if (!requestedByKey.has(key)) requestedByKey.set(key, permission);
  }

  const resolved = resolveManifest({
    ...manifestWithoutGeneratedResources,
    defaults: false,
    permissions: permissions.map((permission) => ({
      service: permission.service,
      ...(permission.space !== undefined ? { space: permission.space } : {}),
      path: permission.path,
      actions: [...permission.actions],
      ...(permission.skipPrefix !== undefined ? { skipPrefix: permission.skipPrefix } : {}),
    })),
  }).resources.filter((permission) =>
    requestedByKey.has(resolvedPermissionKey(permission.service, permission.path)),
  );

  return resolved.map((permission) => {
    const requested = requestedByKey.get(
      resolvedPermissionKey(permission.service, permission.path),
    );
    return {
      service: permission.service,
      space: permission.space,
      path: permission.path,
      actions: [...permission.actions],
      skipPrefix: requested?.skipPrefix,
      description: requested?.description,
    };
  });
}

function validateBackendPolicy(manifest: TinychatManifest): void {
  const granted = resolveManifest(manifest).resources;
  const requested = resolvePermissions(manifest, backendDelegationPermissions());
  const { subset, missing } = isCapabilitySubset(requested, granted);

  if (!subset) {
    throw new Error(
      `backend delegation policy exceeds manifest permissions: ${missing
        .map((permission) => `${permission.service}:${permission.path}`)
        .join(", ")}`,
    );
  }
}

/** Validated once: the manifest and the policy it is checked against are both immutable. */
function ensureBackendPolicyValidated(): TinychatManifest {
  const manifest = runtimeManifest();
  if (!backendPolicyValidated) {
    validateBackendPolicy(manifest);
    backendPolicyValidated = true;
  }
  return manifest;
}

export function backendManifestConfig(_backendDid: string): BackendDelegationConfig {
  ensureBackendPolicyValidated();
  return {
    name: BACKEND_DELEGATION_NAME,
    expiry: BACKEND_DELEGATION_EXPIRY,
    permissions: cloneNonEmptyPermissions(backendDelegationPermissions()),
  };
}

export function backendDelegationResolvedPermissions(backendDid: string): ServerInfoPermission[] {
  if (!backendDid) throw new Error("backend DID is required for delegation policy resolution");
  if (memoizedResolvedPolicy === undefined) {
    const manifest = ensureBackendPolicyValidated();
    // The resolved policy does not depend on the delegate DID — only the hash below does.
    memoizedResolvedPolicy = resolvePermissions(manifest, backendDelegationPermissions());
  }
  // Clone: the cached array outlives every caller, and callers store and serialize what
  // they get back.
  return memoizedResolvedPolicy.map((permission) => ({
    ...permission,
    actions: [...permission.actions],
  }));
}

export function backendDelegationPolicyHash(backendDid: string): string {
  const memoized = memoizedPolicyHashes.get(backendDid);
  if (memoized !== undefined) return memoized;

  const policy = {
    delegateDid: backendDid,
    permissions: backendDelegationResolvedPermissions(backendDid)
      .map((permission) => ({
        service: permission.service,
        space: permission.space ?? null,
        path: permission.path,
        actions: [...permission.actions].sort(),
      }))
      .sort((a, b) =>
        `${a.service}:${a.space}:${a.path}`.localeCompare(`${b.service}:${b.space}:${b.path}`),
      ),
  };

  const hash = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  memoizedPolicyHashes.set(backendDid, hash);
  return hash;
}

function toCapabilityEntries(
  permissions: readonly ServerInfoPermission[],
): ServerInfoPermission[] {
  return permissions.map((permission) => ({
    service: permission.service,
    ...(permission.space !== undefined ? { space: permission.space } : {}),
    path: permission.path,
    actions: [...permission.actions],
  }));
}

export function delegationCoversBackendPolicy(
  permissions: readonly ServerInfoPermission[],
  backendDid: string,
): boolean {
  const requested = backendDelegationResolvedPermissions(backendDid);
  // An entry the prefix predicate cannot compare cannot be counted as coverage either — see
  // `delegationExceedsBackendPolicy` below and `isCanonicalResourcePath`.
  const granted = toCapabilityEntries(permissions).filter((entry) =>
    isCanonicalResourcePath(entry.path),
  );

  return isCapabilitySubset(requested, granted).subset;
}

/**
 * Least-privilege ceiling (§3.2a). `delegationCoversBackendPolicy` runs the subset check in one
 * direction only — "does the bundle cover the policy?" — so a bundle that grants strictly more
 * than the policy passes it. This is the same check with the arguments swapped: "is the bundle no
 * broader than the policy?". Returns the granted entries the policy does not cover, empty when the
 * grant sits at or below the policy.
 *
 * This is an in-process bound on which bundles this backend is willing to store. It is not
 * enforced by the node and says nothing about what the node would authorize for a holder of a
 * broader bundle obtained elsewhere.
 */
export function delegationExceedsBackendPolicy(
  permissions: readonly ServerInfoPermission[],
  backendDid: string,
): ServerInfoPermission[] {
  const allowed = backendDelegationResolvedPermissions(backendDid);
  const granted = toCapabilityEntries(permissions);

  // `isCapabilitySubset` compares paths by raw string prefix, so `<policy>/../../` reads as
  // INSIDE the policy and this check returns an EMPTY offending list for a grant that escapes
  // it. Such an entry is offending by construction rather than by comparison — the ceiling and
  // the activation clamp (§3.2a edit 2, `isCanonicalResourcePath`) have to agree on that, or a
  // bundle carrying one legitimate entry plus one escaping entry passes both.
  const uncomparable = granted.filter((entry) => !isCanonicalResourcePath(entry.path));
  const comparable = granted.filter((entry) => isCanonicalResourcePath(entry.path));

  return [...uncomparable, ...isCapabilitySubset(comparable, allowed).missing];
}

export function resolveAppPath(path: string, service = "tinycloud.kv"): string {
  const manifest = runtimeManifest();
  const { secrets: _secrets, ...manifestWithoutGeneratedResources } = manifest;
  const resolved = resolveManifest({
    ...manifestWithoutGeneratedResources,
    defaults: false,
    permissions: [
      {
        service,
        path,
        actions: service === "tinycloud.sql" ? ["read"] : ["get"],
      },
    ],
  }).resources[0];

  if (!resolved) throw new Error(`Failed to resolve manifest path: ${path}`);
  return resolved.path;
}

function cloneNonEmptyPermissions(
  permissions: NonEmptyServerInfoPermissions,
): NonEmptyServerInfoPermissions {
  const [first, ...rest] = permissions;
  return [
    {
      ...first,
      actions: [...first.actions],
    },
    ...rest.map((permission) => ({
      ...permission,
      actions: [...permission.actions],
    })),
  ];
}
