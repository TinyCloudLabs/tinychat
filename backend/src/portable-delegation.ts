import { deserializeDelegation, type TinyCloudNode } from "@tinycloud/node-sdk";
import { DEFAULT_MANIFEST_SPACE, expandActionShortNames } from "@tinycloud/node-sdk/core";
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

/**
 * §3.2a, accept-side half of the space identity check.
 *
 * `isCapabilitySubset` (and `normalizeResourceSpace`, which mirrors it) compares a space by the
 * segment after its LAST colon, so a resource declaring `tinycloud:0xVICTIM:applications` compares
 * EQUAL to the policy's `applications` and `delegationExceedsBackendPolicy` returns an empty
 * offending list for a grant naming another user's space. Only `resourceSpaceWithinPolicy` refuses
 * it, and that runs at ACTIVATION — after the accept-side ceiling has already declared the bundle
 * within policy and therefore storable. The stored bundle is the artifact T4 inherits, so the
 * check that bounds what may be STORED has to see it too. Same identity rule, applied at accept:
 * a `tinycloud:`-prefixed space passes only when it is that delegation's own.
 */
export function foreignSpaceResources(input: PortableDelegationSet): ServerInfoPermission[] {
  return portableDelegations(input).flatMap((delegation) => {
    const spaceId = (delegation as { spaceId?: unknown }).spaceId;
    return extractPortableResources(delegation).filter(
      (resource) =>
        typeof resource.space === "string" &&
        resource.space.startsWith("tinycloud:") &&
        resource.space !== spaceId,
    );
  });
}

/**
 * §3.2a, the OTHER half of the space identity check — the bundle's own top-level `spaceId`.
 *
 * {@link foreignSpaceResources} bounds the space a RESOURCE may name, and `intersectResource`
 * re-emits the POLICY's space so an attacker-chosen resource space never becomes the invocation
 * target. Neither of them looks at `delegation.spaceId` — and `activateResource` reads exactly
 * that field as the invocation's `spaceId` whenever the clamped resource carries no
 * `tinycloud:`-prefixed space of its own, which for this backend's policy (`space:
 * "applications"`) is ALWAYS. So the unsigned top-level `spaceId` is the real activation target,
 * and the one rule that did consult it — `resourceSpaceWithinPolicy`'s `granted ===
 * delegationSpaceId` arm — compares it against the attacker's own resource string, an equality
 * the attacker arranges by setting both sides to the victim's space (and skips entirely when the
 * resource declares no space at all).
 *
 * The rule here is the one comparison at this layer that is not circular: a present `spaceId` must
 * be a space of the bundle's OWN owner address, which `POST /api/delegations` has already pinned
 * to the authenticated session (`wrong_delegator`). A value that does not parse into a
 * `pkh:eip155:{chainId}:{address}` owner — including a bare space NAME, which names no owner at
 * all — is REFUSED rather than interpreted, the same "uncomparable ⇒ refuse" reading
 * {@link isCanonicalResourcePath} takes. An ABSENT `spaceId` is still allowed: there is then no
 * attacker-chosen target for `activateResource` to fall back to.
 *
 * What this is NOT: §9.2's owner-binding control, and it does not close T9. Every field it reads
 * is still unsigned, so a bundle whose signed chain genuinely grants a third party's space is
 * untouched by it. That control needs a verified `att` (task S2) or V4's second half, and V4 came
 * back ESCALATE — see `docs/connector-webhooks-delegation-gate.md`.
 */
export function foreignSpaceIdDelegations(
  input: PortableDelegationSet,
  ownerAddress: string,
): string[] {
  const expected = normalizeAddress(ownerAddress);
  return portableDelegations(input).flatMap((delegation) => {
    const spaceId = (delegation as { spaceId?: unknown }).spaceId;
    if (spaceId === undefined || spaceId === null) return [];
    if (typeof spaceId !== "string") return ["<non-string spaceId>"];
    // A NON-`tinycloud:` value is refused, not skipped. An earlier reading treated a bare space
    // NAME (`applications`) as naming no owner and therefore harmless — but this field is the
    // invocation's `spaceId`, forwarded VERBATIM to `node.useDelegation` (a code-executing audit
    // confirmed the recorded invocation carried `spaceId: "applications"`), and what the node
    // resolves a bare name against is exactly the thing this check exists not to guess. The SDK
    // types the field as the full space URI
    // (`tinycloud:pkh:eip155:<chain>:<addr>:<name>` — node-sdk core-ojeY-wet.d.ts:1320), so a
    // legitimately-minted bundle always carries the comparable form; anything else is
    // uncomparable, and `isCanonicalResourcePath`'s "uncomparable ⇒ refuse" reading applies.
    if (!spaceId.startsWith("tinycloud:")) return [spaceId];
    const owner = pkhSpaceIdAddress(spaceId);
    return owner !== null && owner === expected ? [] : [spaceId];
  });
}

/** `tinycloud:pkh:eip155:{chainId}:{address}[:{name}]` → the normalized address, or null. */
function pkhSpaceIdAddress(spaceId: string): string | null {
  const parts = spaceId.split(":");
  if (parts.length < 5) return null;
  if (parts[1] !== "pkh" || parts[2] !== "eip155") return null;
  const address = parts[4];
  return address ? normalizeAddress(address) : null;
}

export interface ActivatePortableDelegationOptions {
  /**
   * Resolved backend policy. When present, activation is clamped to `policy ∩ granted` — see
   * {@link clampResourcesToPolicy}. Callers that activate a user delegation always pass it.
   */
  policy?: readonly ServerInfoPermission[];
  /**
   * The address this activation is being performed FOR. When present, the bundle's top-level
   * `spaceId` must name a space of that address — see {@link foreignSpaceIdDelegations}. Every
   * caller that activates a user delegation passes it, so the re-activation paths (the delegation
   * middleware, the drain's stored-delegation gate) re-run the check on the STORED bundle rather
   * than inheriting the accept route's verdict.
   */
  ownerAddress?: string;
}

export async function activatePortableDelegation(
  node: TinyCloudNode,
  input: PortableDelegationSet,
  options: ActivatePortableDelegationOptions = {},
): Promise<DelegatedAccess> {
  const delegations = portableDelegations(input);
  const { policy, ownerAddress } = options;

  // BEFORE the clamp, because the clamp's output is what makes the fallback fire: every clamped
  // resource carries the policy's bare `applications` space, so `activateResource` always falls
  // back to `delegation.spaceId`. Checked here rather than only at accept so the middleware and
  // the drain gate re-run it against the stored bundle.
  if (ownerAddress !== undefined) {
    const foreign = foreignSpaceIdDelegations(input, ownerAddress);
    if (foreign.length > 0) {
      throw new Error(
        `Delegation bundle declares ${foreign.length} space id(s) that do not belong to the ` +
          `activating address; refusing to activate`,
      );
    }
  }

  const activatable = delegations.flatMap((delegation) => {
    const granted = extractDelegationResources(delegation);
    const spaceId = (delegation as { spaceId?: unknown }).spaceId;
    const scoped = policy
      ? clampResourcesToPolicy(
          granted,
          policy,
          typeof spaceId === "string" ? spaceId : undefined,
        )
      : granted;
    return scoped.map((resource) => ({ delegation, resource }));
  });

  if (policy && activatable.length === 0) {
    throw new Error("Delegation grants no resources that survive clamping to the backend policy");
  }

  // §3.5 (S2b), verbatim: activation MUST throw when nothing is activatable. The deleted arm was
  // `delegations.length === 1 → node.useDelegation(delegations[0])`, which handed the ENTIRE raw
  // delegation to the node and so used its unsigned top-level `spaceId`/`path`/`actions` — the
  // exact fields §9.2 exists to stop trusting, reached precisely when extraction found nothing to
  // trust. A grammar mismatch, an unexpected `att` shape, a wildcard ability or a CACAO-backed
  // delegation all project to `[]`, and each of those must be a rejection, never an unscoped
  // activation. There is no legitimate caller for that arm.
  if (activatable.length === 0) {
    throw new Error(
      `Delegation bundle does not include activatable resources ` +
        `(delegations=${delegations.length}, extracted=0)`,
    );
  }

  if (activatable.length === 1) {
    const only = activatable[0];
    const access = await activateResource(node, only.delegation, only.resource);
    if (normalizeResourceService(only.resource.service) !== "kv") return access;
    return guardedKvAccess(access, only.resource);
  }

  assertSupportedMultiResourceShape(activatable.map(({ resource }) => resource));

  // §9.3, unconditionally: TinyCloud drops concurrent responses on the same space, so a
  // `Promise.all` fan-out here is two (or more) simultaneous `useDelegation` calls against one
  // space. The symptom is an intermittent `400 invalid_delegation` at accept time and, inside the
  // drain, a `delegation_unusable` that sets `needsReauth` for a user whose delegation is fine.
  const activated: ActivatedResource[] = [];
  for (const { delegation, resource } of activatable) {
    const service = normalizeResourceService(resource.service);
    const access = await activateResource(node, delegation, resource);
    activated.push({ service, resource, access });
  }
  const combined = activated[0].access as DelegatedAccess & Record<string, unknown>;
  const kvResources = activated.filter(({ service }) => service === "kv");
  if (kvResources.length > 0) {
    Object.defineProperty(combined, "kv", {
      // W4 (§3.5). The `=== 1` case used to hand over the RAW activated handle, so
      // `createKvRouter` was never constructed, `kvPathContains` never ran, and whether a key
      // outside `connectors/` was refused rested entirely on node-side authorization — which
      // §9.3 says must never be the only control. One branch now, for one and for many.
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

/**
 * W4 (§3.5) — the in-process KV key guard. `createKvRouter` is the guard: `route()` refuses any
 * key that `kvPathContains` does not place under an activated resource path, in-process and
 * before any node round trip. §3.5 offers two equivalent forms for the one-KV-resource case, and
 * this is the second one ("change the `=== 1` branch to route through `createKvRouter` as well"),
 * because the first one is not implementable against the raw handle: `DelegatedAccess`
 * constructs its KV service as `new KVService({ prefix: delegation.path })`
 * (node-sdk dist/core.js:1230-1246), so the raw handle AUTO-PREFIXES and its callers pass keys
 * relative to the grant. A prefix assertion over relative keys would assert nothing.
 *
 * Routing makes the key convention uniform — always the FULL app-prefixed key, `prefix: ""`
 * forced — whether one KV resource is activated or several, instead of silently flipping
 * convention on resource count. That uniformity is what makes §6.1's "full path, not a relative
 * one" failure mode catchable where this section said it was.
 */
function guardedKvAccess(access: DelegatedAccess, resource: PortableResource): DelegatedAccess {
  const guarded = access as DelegatedAccess & Record<string, unknown>;
  Object.defineProperty(guarded, "kv", {
    value: createKvRouter([{ service: "kv", resource, access }]),
    configurable: true,
  });
  return guarded;
}

function createKvRouter(resources: ActivatedResource[], scopePrefix = ""): KvAccess {
  const entries = resources.map(({ resource, access }) => ({
    path: normalizeKvPath(resource.path),
    kv: access.kv,
  }));

  const route = (key: string): KvAccess => {
    const fullKey = applyKvPrefix(scopePrefix, key);
    assertCanonicalKvKey(fullKey);
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
      // EVERY verb routes, including a bare `list()`. The un-prefixed case used to be forwarded
      // to the raw handle with no assertion at all, scoped only by `DelegatedAccess`'s own
      // `new KVService({ prefix: delegation.path })` — precisely the node-side control this
      // module's W4 note says must never be the only one. A bare list means "everything I am
      // scoped to", so it resolves to the first activated resource path and is then containment-
      // checked and forwarded with that path made EXPLICIT, exactly like a keyed verb.
      const requested = applyKvPrefix(
        applyKvPrefix(scopePrefix, String(options?.prefix ?? "")),
        String(options?.path ?? ""),
      );
      const listPath = requested || entries[0].path;
      assertCanonicalKvKey(listPath);
      const entry = entries.find(({ path }) => kvPathContains(path, listPath));
      if (!entry) {
        throw new Error(
          `KV list path "${listPath}" does not match any activated portable delegation resource path`,
        );
      }
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

/**
 * W4 (§3.5), the KEY half of the same rule {@link isCanonicalResourcePath} applies to grants.
 *
 * `kvPathContains` is a pure `startsWith` over UNRESOLVED strings, so
 * `<grant>/../../../secrets/master` starts with the grant and is judged INSIDE it, and the key is
 * then forwarded to the node verbatim. That is the exact shape `isCanonicalResourcePath` refuses
 * for a resource PATH, on the stated grounds that a prefix predicate cannot compare a traversal —
 * the two halves of one rule disagreeing. A non-canonical key is not "outside the grant"; it is
 * *uncomparable* by the predicate in use, and the only safe reading is refusal.
 *
 * Percent-encoded separators are refused too: the key travels to the node unchanged, so a storage
 * layer that decodes `%2F` would resolve the traversal on the far side of this check.
 *
 * Not reachable with attacker-controlled input today — under ingest shape B the drain writes
 * nothing, and meeting ids are pinned by `MEETING_ID_PATTERN` before they can become a segment —
 * which is precisely why it is fixed now rather than when an Option-A writer composes a key from
 * a less-constrained field.
 */
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

function extractDelegationResources(delegation: PortableDelegation): PortableResource[] {
  return extractPortableResources(delegation);
}

/**
 * Least-privilege ceiling, activation half (§3.2a edit 2): build the `DelegatedAccess` from
 * `policy ∩ granted` rather than from whatever the bundle happens to grant, so this process's
 * writer is never handed authority the consent copy denies — even if the accept-side reject
 * (`delegationExceedsBackendPolicy`, §3.2a edit 1) regresses, and even where the bundle's `att`
 * is not verified.
 *
 * This is an IN-PROCESS bound, clamped to the policy. It is not visible to the node and does not
 * restrict the delegatee: the node still authorizes whatever the underlying delegation chain
 * grants, so a holder of the stored bundle can activate it unclamped. The clamp is real against
 * overbroad client mints, XSS-driven mints, SDK regressions and our own refactors, and worth
 * nothing against a process that already holds the backend key.
 *
 * A granted resource is kept once per policy entry it overlaps, narrowed to the more specific of
 * the two paths and to the actions both sides allow. Resources that overlap nothing are dropped.
 */
function clampResourcesToPolicy(
  granted: PortableResource[],
  policy: readonly PortableResource[],
  delegationSpaceId?: string,
): PortableResource[] {
  const seen = new Set<string>();
  return granted.flatMap((resource) =>
    policy.flatMap((allowed) => {
      const clamped = intersectResource(resource, allowed, delegationSpaceId);
      if (!clamped) return [];
      const space = normalizeResourceSpace(clamped.space);
      const key = [clamped.service, space, clamped.path, clamped.actions.join(",")].join("|");
      if (seen.has(key)) return [];
      seen.add(key);
      return [clamped];
    }),
  );
}

function intersectResource(
  granted: PortableResource,
  allowed: PortableResource,
  delegationSpaceId?: string,
): PortableResource | null {
  if (granted.service !== allowed.service) return null;
  if (!resourceSpaceWithinPolicy(granted.space, allowed.space, delegationSpaceId)) return null;
  // Uncomparable paths are refused, not clamped: see `isCanonicalResourcePath`.
  if (!isCanonicalResourcePath(granted.path) || !isCanonicalResourcePath(allowed.path)) return null;

  const path = narrowerResourcePath(granted.path, allowed.path);
  if (path === null) return null;

  const allowedActions = new Set(expandActionShortNames(allowed.service, [...allowed.actions]));
  const actions = expandActionShortNames(granted.service, [...granted.actions]).filter((action) =>
    allowedActions.has(action),
  );
  if (actions.length === 0) return null;

  return {
    service: granted.service,
    // The POLICY's space, never the granted string. `activateResource` reads this back as the
    // invocation's `spaceId` when it is `tinycloud:`-prefixed, so re-emitting an attacker-chosen
    // space here would let an unsigned bundle field steer the activation off `delegation.spaceId`.
    ...(allowed.space !== undefined ? { space: allowed.space } : {}),
    path,
    actions,
  };
}

/**
 * A grant is a literal capability, so its path is a literal prefix: there is no legitimate `.`,
 * `..`, empty or backslash segment in one. This matters because BOTH least-privilege checks
 * compare paths by raw string prefix — `isCapabilitySubset` at accept (§3.2a edit 1) and
 * `resourcePathContains` in the clamp (edit 2) — so `<policy>/../../` starts with `<policy>` and
 * is judged INSIDE the policy by both, and the clamp then re-emits the traversal path verbatim.
 * Such a path is not "outside the policy"; it is *uncomparable* by the predicate in use, and the
 * only safe reading of an uncomparable grant is refusal.
 */
export function isCanonicalResourcePath(path: string): boolean {
  if (path.includes("\\")) return false;
  if (path === "" || path === "/") return true;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * `normalizeResourceSpace` mirrors the SDK and compares only the segment after the LAST colon, so
 * `tinycloud:0xVICTIM:applications` compares equal to the policy's `applications`. That is fine as
 * a *containment* test and fatal as an *identity* test, and `activateResource` treats a
 * `tinycloud:`-prefixed space as an identity (it sends it verbatim as the invocation `spaceId`).
 * So a full space id passes only when it is this delegation's own.
 */
function resourceSpaceWithinPolicy(
  granted: string | undefined,
  allowed: string | undefined,
  delegationSpaceId: string | undefined,
): boolean {
  if (granted === undefined) return true;
  if (normalizeResourceSpace(granted) !== normalizeResourceSpace(allowed)) return false;
  if (!granted.startsWith("tinycloud:")) return true;
  return delegationSpaceId !== undefined && granted === delegationSpaceId;
}

/** Mirrors the SDK's `normalizeSpace`, so the clamp and `isCapabilitySubset` agree. */
function normalizeResourceSpace(space: string | undefined): string {
  const value = space ?? DEFAULT_MANIFEST_SPACE;
  if (!value.startsWith("tinycloud:")) return value;
  const lastColon = value.lastIndexOf(":");
  if (lastColon === -1 || lastColon === value.length - 1) return value;
  return value.slice(lastColon + 1);
}

/** Mirrors the SDK's `pathContains`: a trailing slash makes a path a prefix, otherwise exact. */
function resourcePathContains(container: string, candidate: string): boolean {
  if (container === "" || container === "/") return true;
  if (container.endsWith("/")) return candidate.startsWith(container);
  return candidate === container;
}

function narrowerResourcePath(granted: string, allowed: string): string | null {
  if (resourcePathContains(allowed, granted)) return granted;
  if (resourcePathContains(granted, allowed)) return allowed;
  return null;
}

/**
 * §3.5 (S2e). `assertSupportedMultiResourceShape` capped only `sql`/`duckdb`/`hooks` at one each,
 * leaving the KV resource count unbounded — and every activatable resource is one SERIALIZED
 * `node.useDelegation` round trip (§9.3) inside a single HTTP request, against the ~0.5 writes/sec
 * node shared with every user and app. 4 covers Option A's widest legitimate shape (sql +
 * connectors-kv + two secrets entries), and `docs/connector-webhooks-kv-write-budget.md` §2.3
 * computes its "accept + activate: ≤4 sequential node calls" row AT THIS LITERAL — a larger cap
 * doubles the per-`PUT` node budget and voids that row, so the number is pinned here and asserted
 * in `portable-delegation.test.ts`. A future shape needing more revisits the write budget first.
 */
export const MAX_ACTIVATABLE_RESOURCES = 4;

function assertSupportedMultiResourceShape(resources: PortableResource[]): void {
  if (resources.length > MAX_ACTIVATABLE_RESOURCES) {
    throw new Error(
      `Delegation bundle activates ${resources.length} resources; the maximum is ` +
        `${MAX_ACTIVATABLE_RESOURCES}. Each resource is a separate sequential node activation.`,
    );
  }

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
  const spaceId = resource.space?.startsWith("tinycloud:")
    ? resource.space
    : delegation.spaceId;
  return node.useDelegation({
    ...delegation,
    spaceId,
    path: resource.path,
    actions: resource.actions.map((action) => normalizeResourceAction(action, service)),
    resources: [
      {
        ...resource,
        service: resource.service,
        space: spaceId,
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
