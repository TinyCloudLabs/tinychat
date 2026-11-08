// Thin wrapper over `tcw.secrets` (`ISecretsService`). See docs/connectors-spec.md §7.
// Result plumbing only — never throws, never invents an error, never fallbacks silently.
// The SDK's put may 404 on the first call in a session created via manifest capabilities
// because the owned `secrets` space was never registered with the node. In that one case
// we call `tcw.ensureOwnedSpaceHosted?.("secrets")` (if the SDK exposes it) and retry
// ONCE. If the method doesn't exist we surface the original error — no silent fallback.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { secretsAvailable } from "../openkeyNative";
import type { ConnectorDescriptor } from "./types";

/** Same Result shape the SDK uses. Errors propagate untouched. */
export type SecretsResult<T, E> =
  | { ok: true; data: T }
  | { ok: false; error: E };

/** Shape of errors surfaced by `tcw.secrets` operations. The SDK does not
 *  expose a stable enum, so we forward whatever it hands us and let the UI
 *  render `message` (with `code` for logs). */
export type SecretsErr = { code?: string; message?: string };

/** Minimum surface we invoke on tcw. Kept structural so tests can supply a fake. */
type SecretsTcw = Pick<TinyCloudWeb, "secrets"> & {
  ensureOwnedSpaceHosted?: TinyCloudWeb["ensureOwnedSpaceHosted"];
};

/**
 * True if `err` looks like a "space/resource not found" from the node — the
 * signal we retry on for the first-put case.
 */
function isNotFoundShaped(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === "string" && /NOT_FOUND/i.test(e.code)) return true;
  if (typeof e.message === "string" && /not found|404/i.test(e.message))
    return true;
  return false;
}

export function isSecretsUnlocked(tcw: SecretsTcw): boolean {
  // Native OpenKey sessions have no secrets space at all; report locked so
  // every deferred path stays a no-op instead of touching tcw.secrets.
  if (!secretsAvailable()) return false;
  return tcw.secrets.isUnlocked;
}

/** Where a key lives in the vault: a connector's descriptor, or another source key's name. */
export type SecretLocation = Pick<ConnectorDescriptor, "secretName" | "secretScope">;

// ── Per-session in-memory cache of DECRYPTED vault reads (TC-2080) ───
//
// Every `tcw.secrets.get` is a node round trip. Within one session the answer
// cannot change except through this module's own put/delete, so successful
// reads are kept in a module-level Map. Invariants:
//   - MEMORY ONLY: never persisted, never logged, never put in an error.
//   - Keyed by (the session's `tcw.did`, scope, name). A tcw that exposes no
//     identity BYPASSES the cache entirely (every read hits the vault).
//   - Bound to ONE tcw instance + identity: any other instance or DID drops
//     every entry first (account switch / re-sign-in), as does the vault
//     reporting `secrets.isUnlocked === false` (lock) and local sign-out
//     (`clearVaultSecretCache`, called from App's `completeLocalSignOut`).
//   - Successes only. A failed/locked read is never stored; concurrent reads
//     of one key share one in-flight promise that is dropped when it settles.
//   - put stores the written value on success and evicts the entry on
//     failure; delete evicts. Any invalidation bumps `epoch`, so a read that
//     was already in flight cannot repopulate the cache with a stale value.

type CacheBinding = { tcw: object; identity: string };
let cacheBinding: CacheBinding | null = null;
let cacheEpoch = 0;
const secretCache = new Map<string, string>();
const inflightReads = new Map<string, Promise<unknown>>();

/** Drop every cached secret and forget the bound session. Safe to call any time. */
export function clearVaultSecretCache(): void {
  cacheBinding = null;
  cacheEpoch++;
  secretCache.clear();
  inflightReads.clear();
}

/** Tests only: return the module to its pristine state. */
export function resetVaultSecretCacheForTests(): void {
  clearVaultSecretCache();
}

function sessionIdentity(tcw: SecretsTcw): string | null {
  try {
    const did: unknown = "did" in tcw ? tcw.did : undefined;
    return typeof did === "string" && did.length > 0 ? did : null;
  } catch {
    return null;
  }
}

/** The cache key for this session+secret, or null when the cache must be bypassed. */
function cacheKeyFor(tcw: SecretsTcw, descriptor: SecretLocation): string | null {
  const identity = sessionIdentity(tcw);
  if (identity === null) return null;
  const locked = tcw.secrets.isUnlocked === false;
  if (locked || (cacheBinding && (cacheBinding.tcw !== tcw || cacheBinding.identity !== identity))) {
    clearVaultSecretCache();
  }
  cacheBinding ??= { tcw, identity };
  return JSON.stringify([identity, descriptor.secretScope ?? "", descriptor.secretName]);
}

function evict(key: string | null): void {
  cacheEpoch++;
  if (key === null) return;
  secretCache.delete(key);
  inflightReads.delete(key);
}

export async function saveConnectorKey<E>(
  tcw: SecretsTcw,
  descriptor: SecretLocation,
  key: string,
): Promise<SecretsResult<void, E>> {
  const cacheKey = cacheKeyFor(tcw, descriptor);
  const options = descriptor.secretScope
    ? { scope: descriptor.secretScope }
    : undefined;
  const first = (await tcw.secrets.put(
    descriptor.secretName,
    key,
    options,
  )) as SecretsResult<void, E>;
  let result = first;
  if (!first.ok && isNotFoundShaped(first.error) && typeof tcw.ensureOwnedSpaceHosted === "function") {
    await tcw.ensureOwnedSpaceHosted("secrets");
    result = (await tcw.secrets.put(
      descriptor.secretName,
      key,
      options,
    )) as SecretsResult<void, E>;
  }
  evict(cacheKey);
  if (result.ok && cacheKey !== null) secretCache.set(cacheKey, key);
  return result;
}

export async function getConnectorKey<E>(
  tcw: SecretsTcw,
  descriptor: SecretLocation,
): Promise<SecretsResult<string, E>> {
  const options = descriptor.secretScope
    ? { scope: descriptor.secretScope }
    : undefined;
  const read = async () =>
    (await tcw.secrets.get(descriptor.secretName, options)) as SecretsResult<string, E>;
  const cacheKey = cacheKeyFor(tcw, descriptor);
  if (cacheKey === null) return read();

  const hit = secretCache.get(cacheKey);
  if (hit !== undefined) return { ok: true, data: hit };
  const pending = inflightReads.get(cacheKey);
  if (pending) return pending as Promise<SecretsResult<string, E>>;

  const epoch = cacheEpoch;
  const promise = read().then(
    (result) => {
      if (inflightReads.get(cacheKey) === promise) inflightReads.delete(cacheKey);
      if (result.ok && epoch === cacheEpoch) secretCache.set(cacheKey, result.data);
      return result;
    },
    (caught: unknown) => {
      if (inflightReads.get(cacheKey) === promise) inflightReads.delete(cacheKey);
      throw caught;
    },
  );
  inflightReads.set(cacheKey, promise);
  return promise;
}

export async function deleteConnectorKey<E>(
  tcw: SecretsTcw,
  descriptor: SecretLocation,
): Promise<SecretsResult<void, E>> {
  const cacheKey = cacheKeyFor(tcw, descriptor);
  evict(cacheKey);
  const options = descriptor.secretScope
    ? { scope: descriptor.secretScope }
    : undefined;
  const result = (await tcw.secrets.delete(
    descriptor.secretName,
    options,
  )) as SecretsResult<void, E>;
  evict(cacheKey);
  return result;
}
