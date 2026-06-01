import { deserializeDelegation, type TinyCloudNode } from "@tinycloud/node-sdk";
import type { ServerInfoPermission } from "@tinyboilerplate/core";

type PortableDelegation = Parameters<TinyCloudNode["useDelegation"]>[0];
export type PortableDelegationSet = PortableDelegation | PortableDelegation[];
type DelegatedAccess = Awaited<ReturnType<TinyCloudNode["useDelegation"]>>;
type PortableResource = ServerInfoPermission;
interface ActivatedResource {
  service: string;
  resource: PortableResource;
  access: DelegatedAccess;
}
export interface PortableDelegationIdentity {
  ownerAddress: string;
  chainId: number;
  primaryDid: string;
  delegateDID: string;
}

const DELEGATION_BUNDLE_FORMAT = "tinycloud.delegation-bundle";

interface DelegationBundle {
  format: typeof DELEGATION_BUNDLE_FORMAT;
  version: 1;
  delegations: string[];
}

export function deserializePortableDelegationSet(serialized: string): PortableDelegationSet {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (isDelegationBundle(parsed)) {
      return parsed.delegations.map((delegation) => deserializeDelegation(delegation));
    }
  } catch {
    // Opaque SDK delegation strings are handled below.
  }

  return deserializeDelegation(serialized);
}

export function portableDelegations(input: PortableDelegationSet): PortableDelegation[] {
  return Array.isArray(input) ? input : [input];
}

export function portableDelegationExpiry(input: PortableDelegationSet): Date | null {
  const expiries = portableDelegations(input)
    .map((delegation) => delegation.expiry)
    .filter((expiry): expiry is Date => expiry instanceof Date);

  if (expiries.length === 0) return null;
  return new Date(Math.min(...expiries.map((expiry) => expiry.getTime())));
}

export function extractPortableDelegationIdentity(
  input: PortableDelegationSet,
): PortableDelegationIdentity | null {
  const identities = portableDelegations(input).map((delegation) => {
    const entry = delegation as {
      ownerAddress?: unknown;
      chainId?: unknown;
      delegateDID?: unknown;
      delegatorDID?: unknown;
    };

    if (
      typeof entry.ownerAddress !== "string" ||
      typeof entry.chainId !== "number" ||
      !Number.isFinite(entry.chainId) ||
      typeof entry.delegateDID !== "string"
    ) {
      return null;
    }

    const primaryDid = `did:pkh:eip155:${entry.chainId}:${entry.ownerAddress}`;
    if (
      typeof entry.delegatorDID === "string" &&
      normalizeDid(entry.delegatorDID) !== normalizeDid(primaryDid)
    ) {
      return null;
    }

    return {
      ownerAddress: entry.ownerAddress,
      chainId: entry.chainId,
      primaryDid,
      delegateDID: entry.delegateDID,
    };
  });

  if (identities.some((identity) => identity === null)) return null;
  const [first] = identities as PortableDelegationIdentity[];
  if (!first) return null;

  const sameIdentity = identities.every(
    (identity) =>
      identity !== null &&
      normalizeAddress(identity.ownerAddress) === normalizeAddress(first.ownerAddress) &&
      identity.chainId === first.chainId &&
      normalizeDid(identity.primaryDid) === normalizeDid(first.primaryDid) &&
      normalizeDid(identity.delegateDID) === normalizeDid(first.delegateDID),
  );

  return sameIdentity ? first : null;
}

export function extractPortableResources(input: PortableDelegationSet): ServerInfoPermission[] {
  return portableDelegations(input).flatMap((delegation) => {
    const resources = (delegation as { resources?: unknown }).resources;
    if (!Array.isArray(resources)) return [];

    return resources.flatMap((resource) => {
      if (typeof resource !== "object" || resource === null) return [];
      const entry = resource as {
        service?: unknown;
        space?: unknown;
        path?: unknown;
        actions?: unknown;
      };
      if (
        typeof entry.service !== "string" ||
        typeof entry.path !== "string" ||
        !Array.isArray(entry.actions) ||
        !entry.actions.every((action) => typeof action === "string")
      ) {
        return [];
      }
      return [
        {
          service: entry.service.startsWith("tinycloud.")
            ? entry.service
            : `tinycloud.${entry.service}`,
          ...(typeof entry.space === "string" ? { space: entry.space } : {}),
          path: entry.path,
          actions: [...entry.actions],
        },
      ];
    });
  });
}

export async function activatePortableDelegation(
  node: TinyCloudNode,
  input: PortableDelegationSet,
): Promise<DelegatedAccess> {
  const delegations = portableDelegations(input);
  const activatable = delegations.flatMap((delegation) =>
    extractDelegationResources(delegation).map((resource) => ({ delegation, resource })),
  );

  if (activatable.length === 0) {
    if (delegations.length === 1) return node.useDelegation(delegations[0]);
    throw new Error("Delegation bundle does not include activatable resources");
  }

  if (activatable.length === 1) {
    const only = activatable[0];
    return activateResource(node, only.delegation, only.resource);
  }

  assertSupportedMultiResourceShape(activatable.map(({ resource }) => resource));

  const activated = await Promise.all(
    activatable.map(async ({ delegation, resource }): Promise<ActivatedResource> => {
      const service = normalizeResourceService(resource.service);
      const access = await activateResource(node, delegation, resource);
      return { service, resource, access };
    }),
  );
  const combined = activated[0].access as DelegatedAccess & Record<string, unknown>;
  const kvResources = activated.filter(({ service }) => service === "kv");
  if (kvResources.length === 1) {
    Object.defineProperty(combined, "kv", {
      value: kvResources[0].access.kv,
      configurable: true,
    });
  } else if (kvResources.length > 1) {
    Object.defineProperty(combined, "kv", {
      value: createKvRouter(kvResources),
      configurable: true,
    });
  }

  for (const service of ["sql", "duckdb", "hooks"] as const) {
    const activatedResource = activated.find((entry) => entry.service === service);
    if (!activatedResource) continue;
    Object.defineProperty(combined, service, {
      value: activatedResource.access[service],
      configurable: true,
    });
  }
  return combined;
}

type KvAccess = DelegatedAccess["kv"];
type KvOptions = object | undefined;
type KvGetOptions = Parameters<KvAccess["get"]>[1];
type KvPutOptions = Parameters<KvAccess["put"]>[2];
type KvDeleteOptions = Parameters<KvAccess["delete"]>[1];
type KvHeadOptions = Parameters<KvAccess["head"]>[1];
type KvSignedUrlOptions = Parameters<KvAccess["createSignedReadUrl"]>[1];
type KvListOptions = Parameters<KvAccess["list"]>[0];

function createKvRouter(resources: ActivatedResource[], scopePrefix = ""): KvAccess {
  const entries = resources.map(({ resource, access }) => ({
    path: normalizeKvPath(resource.path),
    kv: access.kv,
  }));

  const route = (key: string): KvAccess => {
    const fullKey = applyKvPrefix(scopePrefix, key);
    const entry = entries.find(({ path }) => kvPathContains(path, fullKey));
    if (!entry) {
      throw new Error(
        `KV key "${fullKey}" does not match any activated portable delegation resource path`,
      );
    }
    return entry.kv;
  };

  return Object.assign(Object.create(entries[0].kv) as KvAccess, {
    get: <T = unknown>(key: string, options?: KvGetOptions) =>
      route(key).get<T>(applyKvPrefix(scopePrefix, key), withoutKvPrefix(options)),
    put: (key: string, value: unknown, options?: KvPutOptions) =>
      route(key).put(applyKvPrefix(scopePrefix, key), value, withoutKvPrefix(options)),
    delete: (key: string, options?: KvDeleteOptions) =>
      route(key).delete(applyKvPrefix(scopePrefix, key), withoutKvPrefix(options)),
    head: (key: string, options?: KvHeadOptions) =>
      route(key).head(applyKvPrefix(scopePrefix, key), withoutKvPrefix(options)),
    createSignedReadUrl: (key: string, options?: KvSignedUrlOptions) =>
      route(key).createSignedReadUrl(applyKvPrefix(scopePrefix, key), withoutKvPrefix(options)),
    list: (options?: KvListOptions) => {
      if (scopePrefix || options?.prefix || options?.path) {
        const listPath = applyKvPrefix(
          applyKvPrefix(scopePrefix, String(options?.prefix ?? "")),
          String(options?.path ?? ""),
        );
        const entry = entries.find(({ path }) => kvPathContains(path, listPath));
        if (!entry) {
          throw new Error(
            `KV list path "${listPath}" does not match any activated portable delegation resource path`,
          );
        }
        return entry.kv.list({ ...options, prefix: listPath });
      }

      return entries[0].kv.list(options);
    },
    withPrefix: (prefix: string) => createKvRouter(resources, applyKvPrefix(scopePrefix, prefix)),
  });
}

function withoutKvPrefix<T extends KvOptions>(options: T): T & { prefix: string } {
  return { ...(options ?? {}), prefix: "" } as T & { prefix: string };
}

function normalizeKvPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

function applyKvPrefix(prefix: string, key: string): string {
  const normalizedPrefix = normalizeKvPath(prefix);
  const normalizedKey = key.replace(/^\/+/, "");
  if (!normalizedPrefix) return normalizedKey;
  if (!normalizedKey) return normalizedPrefix;
  return `${normalizedPrefix}/${normalizedKey}`;
}

function kvPathContains(path: string, key: string): boolean {
  const normalizedPath = normalizeKvPath(path);
  const normalizedKey = normalizeKvPath(key);
  return normalizedKey === normalizedPath || normalizedKey.startsWith(`${normalizedPath}/`);
}

function extractDelegationResources(delegation: PortableDelegation): PortableResource[] {
  return extractPortableResources(delegation);
}

function assertSupportedMultiResourceShape(resources: PortableResource[]): void {
  const counts = new Map<string, number>();
  for (const resource of resources) {
    const service = normalizeResourceService(resource.service);
    counts.set(service, (counts.get(service) ?? 0) + 1);
  }

  for (const service of ["sql", "duckdb", "hooks"]) {
    if ((counts.get(service) ?? 0) > 1) {
      throw new Error(
        `Multiple tinycloud.${service} resources are not supported by this delegation combiner. Add an explicit resource router before requesting more than one ${service} resource.`,
      );
    }
  }
}

function activateResource(
  node: TinyCloudNode,
  delegation: PortableDelegation,
  resource: PortableResource,
): Promise<DelegatedAccess> {
  const service = normalizeResourceService(resource.service);
  return node.useDelegation({
    ...delegation,
    spaceId: resource.space?.startsWith("tinycloud:") ? resource.space : delegation.spaceId,
    path: resource.path,
    actions: resource.actions.map((action) => normalizeResourceAction(action, service)),
    resources: [
      {
        ...resource,
        service: resource.service,
        space: resource.space ?? delegation.spaceId,
      },
    ],
  });
}

function normalizeResourceService(service: string): string {
  return service.startsWith("tinycloud.") ? service.slice("tinycloud.".length) : service;
}

function normalizeResourceAction(action: string, service: string): string {
  return action.includes("/") ? action : `tinycloud.${service}/${action}`;
}

export function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function normalizeDid(did: string): string {
  const pkhPrefix = "did:pkh:eip155:";
  if (!did.startsWith(pkhPrefix)) return did;

  const parts = did.split(":");
  const address = parts.at(-1);
  if (!address) return did;
  return [...parts.slice(0, -1), normalizeAddress(address)].join(":");
}

function isDelegationBundle(value: unknown): value is DelegationBundle {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<DelegationBundle>;
  return (
    entry.format === DELEGATION_BUNDLE_FORMAT &&
    entry.version === 1 &&
    Array.isArray(entry.delegations) &&
    entry.delegations.every((delegation) => typeof delegation === "string")
  );
}
