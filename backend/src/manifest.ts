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

export function runtimeManifest(): TinychatManifest {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  return validateTinychatManifest(validateManifest(raw));
}

function resolvePermissions(
  manifest: TinychatManifest,
  permissions: readonly ServerInfoPermission[],
): ServerInfoPermission[] {
  const { secrets: _secrets, ...manifestWithoutGeneratedResources } = manifest;
  const requestedPaths = new Set(
    permissions.map((permission) =>
      permission.skipPrefix ? permission.path : `${APP_ID}/${permission.path}`,
    ),
  );
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
  }).resources.filter((permission) => requestedPaths.has(permission.path));

  return resolved.map((permission, index) => ({
    service: permission.service,
    space: permission.space,
    path: permission.path,
    actions: [...permission.actions],
    skipPrefix: permissions[index]?.skipPrefix,
    description: permissions[index]?.description,
  }));
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

export function backendManifestConfig(_backendDid: string): BackendDelegationConfig {
  const manifest = runtimeManifest();
  validateBackendPolicy(manifest);
  return {
    name: BACKEND_DELEGATION_NAME,
    expiry: BACKEND_DELEGATION_EXPIRY,
    permissions: cloneNonEmptyPermissions(backendDelegationPermissions()),
  };
}

export function backendDelegationResolvedPermissions(backendDid: string): ServerInfoPermission[] {
  const manifest = runtimeManifest();
  validateBackendPolicy(manifest);
  if (!backendDid) throw new Error("backend DID is required for delegation policy resolution");
  return resolvePermissions(manifest, backendDelegationPermissions());
}

export function backendDelegationPolicyHash(backendDid: string): string {
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

  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function delegationCoversBackendPolicy(
  permissions: readonly ServerInfoPermission[],
  backendDid: string,
): boolean {
  const requested = backendDelegationResolvedPermissions(backendDid);
  const granted = permissions.map((permission) => ({
    service: permission.service,
    ...(permission.space !== undefined ? { space: permission.space } : {}),
    path: permission.path,
    actions: [...permission.actions],
  }));

  return isCapabilitySubset(requested, granted).subset;
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
