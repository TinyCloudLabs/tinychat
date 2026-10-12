import { deserializeDelegation, type TinyCloudNode } from "@tinycloud/node-sdk";
import type { ServerInfoPermission } from "@tinyboilerplate/core";
import type { VerifiedTranscriptWriter } from "./delegation-verify.js";

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

interface DelegationBundle {
  format: "tinycloud.delegation-bundle";
  version: 1;
  delegations: string[];
}

/** Agent-owned delegations use this deserializer; transcript grants use the signed verifier. */
export function deserializePortableDelegationSet(serialized: string): PortableDelegationSet {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (isDelegationBundle(parsed)) {
      return parsed.delegations.map((delegation) => deserializeDelegation(delegation));
    }
  } catch {
    // The SDK accepts opaque single-delegation strings as well.
  }
  return deserializeDelegation(serialized);
}

function portableDelegations(input: PortableDelegationSet): PortableDelegation[] {
  return Array.isArray(input) ? input : [input];
}

/** Used for the separate agent delegation protocol, not transcript-writer acceptance. */
export function extractPortableDelegationIdentity(input: PortableDelegationSet): PortableDelegationIdentity | null {
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
    ) return null;
    const primaryDid = `did:pkh:eip155:${entry.chainId}:${entry.ownerAddress}`;
    if (typeof entry.delegatorDID === "string" && normalizeDid(entry.delegatorDID) !== normalizeDid(primaryDid)) return null;
    return { ownerAddress: entry.ownerAddress, chainId: entry.chainId, primaryDid, delegateDID: entry.delegateDID };
  });
  if (identities.some((identity) => identity === null)) return null;
  const [first] = identities as PortableDelegationIdentity[];
  if (!first) return null;
  const sameIdentity = identities.every((identity) =>
    identity !== null &&
    normalizeAddress(identity.ownerAddress) === normalizeAddress(first.ownerAddress) &&
    identity.chainId === first.chainId &&
    normalizeDid(identity.primaryDid) === normalizeDid(first.primaryDid) &&
    normalizeDid(identity.delegateDID) === normalizeDid(first.delegateDID),
  );
  return sameIdentity ? first : null;
}

/** Activate only the verified signed projection, on the configured node origin. */
export async function activateVerifiedDelegation(
  node: TinyCloudNode,
  verified: VerifiedTranscriptWriter,
  options: { host: string; beforeNodeWrite?: () => Promise<void> },
): Promise<DelegatedAccess> {
  assertSupportedMultiResourceShape(verified.resources);
  const activated: ActivatedResource[] = [];
  for (const resource of verified.resources) {
    await options.beforeNodeWrite?.();
    const actions = [...resource.actions];
    const access = await observeActivation(() => node.useDelegation({
      cid: verified.cid,
      delegationHeader: { Authorization: verified.authorization },
      spaceId: verified.spaceId,
      path: resource.path,
      actions,
      resources: [{ service: resource.service, space: verified.spaceId, path: resource.path, actions }],
      expiry: verified.expiresAt,
      delegateDID: verified.backendDid,
      ownerAddress: verified.ownerAddress,
      chainId: verified.chainId,
      host: options.host,
    }));
    activated.push({ service: normalizeResourceService(resource.service), resource, access });
  }
  const combined = activated[0].access as DelegatedAccess & Record<string, unknown>;
  const kvResources = activated.filter(({ service }) => service === "kv");
  if (kvResources.length) {
    Object.defineProperty(combined, "kv", { value: createKvRouter(kvResources), configurable: true });
  }
  const sqlResource = activated.find(({ service }) => service === "sql");
  if (sqlResource) Object.defineProperty(combined, "sql", { value: sqlResource.access.sql, configurable: true });
  return combined;
}

/**
 * The node refused (or failed) a delegated-session activation, with the HTTP status of its
 * `POST {host}/delegate`, so a revoked grant (401/403) can be told apart from a node outage (5xx).
 */
export class DelegationActivationError extends Error {
  readonly status: number;
  constructor(status: number, options: { cause: unknown }) {
    super(`Delegated session activation failed with HTTP ${status}`, options);
    this.name = "DelegationActivationError";
    this.status = status;
  }
}

const ACTIVATION_FAILURE = "Failed to activate delegated session:";

/**
 * The status the node answered a refused activation with, or undefined. SDK 3.1 `useDelegation()`
 * throws `Error("Failed to activate delegated session: …")` whose `cause` is the activation's
 * `SpaceHostResult` (`{ success: false, status, error }`). Callers that joined a single-flighted
 * identical `POST /delegate` get the same result as their cause, so this needs no request of its
 * own. A network failure, or any other throw, has no such cause and is not a refusal.
 */
function refusedActivationStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !error.message.startsWith(ACTIVATION_FAILURE)) return undefined;
  const cause: unknown = error.cause;
  if (!cause || typeof cause !== "object" || !("success" in cause) || cause.success !== false
    || !("status" in cause) || typeof cause.status !== "number" || !Number.isInteger(cause.status)) return undefined;
  return cause.status < 200 || cause.status > 299 ? cause.status : undefined;
}

/** Run one activation; if the node answered it non-2xx, rethrow with that status. */
async function observeActivation<T>(activate: () => Promise<T>): Promise<T> {
  try {
    return await activate();
  } catch (error) {
    const rejected = refusedActivationStatus(error);
    if (rejected !== undefined) throw new DelegationActivationError(rejected, { cause: error });
    throw error;
  }
}

type KvAccess = DelegatedAccess["kv"];
type KvOptions = object | undefined;
type KvGetOptions = Parameters<KvAccess["get"]>[1];
type KvPutOptions = Parameters<KvAccess["put"]>[2];
type KvDeleteOptions = Parameters<KvAccess["delete"]>[1];
type KvHeadOptions = Parameters<KvAccess["head"]>[1];
type KvSignedUrlOptions = Parameters<KvAccess["createSignedReadUrl"]>[1];
type KvListOptions = Parameters<KvAccess["list"]>[0];

/** Always route KV operations through verified resource paths before forwarding to the node. */
function createKvRouter(resources: ActivatedResource[], scopePrefix = ""): KvAccess {
  const entries = resources.map(({ resource, access }) => ({ path: normalizeKvPath(resource.path), kv: access.kv }));
  const route = (key: string): KvAccess => {
    const fullKey = applyKvPrefix(scopePrefix, key);
    assertCanonicalKvKey(fullKey);
    const entry = entries.find(({ path }) => kvPathContains(path, fullKey));
    if (!entry) throw new Error(`KV key "${fullKey}" does not match any activated portable delegation resource path`);
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
      const requested = applyKvPrefix(applyKvPrefix(scopePrefix, String(options?.prefix ?? "")), String(options?.path ?? ""));
      const listPath = requested || entries[0].path;
      assertCanonicalKvKey(listPath);
      const entry = entries.find(({ path }) => kvPathContains(path, listPath));
      if (!entry) throw new Error(`KV list path "${listPath}" does not match any activated portable delegation resource path`);
      return entry.kv.list({ ...options, prefix: listPath });
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

function assertCanonicalKvKey(key: string): void {
  if (/%2f|%5c/i.test(key) || !isCanonicalResourcePath(key)) {
    throw new Error(`KV key "${key}" is not canonical; refusing to forward it to the node`);
  }
}

function kvPathContains(path: string, key: string): boolean {
  const normalizedPath = normalizeKvPath(path);
  const normalizedKey = normalizeKvPath(key);
  return normalizedKey === normalizedPath || normalizedKey.startsWith(`${normalizedPath}/`);
}

/** Grant and KV paths must be literal, canonical prefix-comparable paths. */
export function isCanonicalResourcePath(path: string): boolean {
  if (path.includes("\\")) return false;
  if (path === "" || path === "/") return true;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export const MAX_ACTIVATABLE_RESOURCES = 4;

function assertSupportedMultiResourceShape(resources: PortableResource[]): void {
  if (resources.length === 0 || resources.length > MAX_ACTIVATABLE_RESOURCES) {
    throw new Error(`Delegation activates ${resources.length} resources; expected 1–${MAX_ACTIVATABLE_RESOURCES}`);
  }
  const counts = new Map<string, number>();
  for (const resource of resources) {
    const service = normalizeResourceService(resource.service);
    counts.set(service, (counts.get(service) ?? 0) + 1);
  }
  for (const service of ["sql", "duckdb", "hooks"]) {
    if ((counts.get(service) ?? 0) > 1) throw new Error(`Multiple tinycloud.${service} resources are not supported`);
  }
}

function normalizeResourceService(service: string): string {
  return service.startsWith("tinycloud.") ? service.slice("tinycloud.".length) : service;
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
  return entry.format === "tinycloud.delegation-bundle" && entry.version === 1 &&
    Array.isArray(entry.delegations) && entry.delegations.every((delegation) => typeof delegation === "string");
}
