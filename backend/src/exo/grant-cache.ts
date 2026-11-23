import type { ExoActivatedGrant } from "./activated-grant.js";

/** How long an opened owner grant is reused. The opener re-checks the stored grant's expiry on every real open. */
export const EXO_GRANT_CACHE_TTL_MS = 30_000;
/** How long "no active grant" is reused, so a burst for an owner without one costs one lookup. */
export const EXO_GRANT_CACHE_MISS_TTL_MS = 5_000;
/** Owners remembered at once. Past it the oldest entry is dropped. */
export const EXO_GRANT_CACHE_MAX_OWNERS = 1_024;

export interface OwnerGrantCacheOptions {
  ttlMs?: number;
  missTtlMs?: number;
  maxOwners?: number;
  now?: () => number;
}

export interface OwnerGrantCache {
  /** The opener the exo stores use. Same contract as the uncached one: a grant, or null. */
  open(owner: string): Promise<ExoActivatedGrant | null>;
  /** Forget one owner. Call it whenever that owner's stored grant is written or removed. */
  invalidate(owner: string): void;
}

interface Entry {
  /** Settled result or the lookup still in flight; callers that arrive meanwhile share it. */
  result: Promise<ExoActivatedGrant | null>;
  expiresAt: number;
}

/**
 * Per-owner cache in front of the owner-grant opener. One wake check opens the same owner's grant four
 * times, and every open is a stored-grant load plus node calls, so a burst of wakes for one holder costs
 * one open per window instead of one per read. Concurrent opens for one owner share one lookup.
 *
 * Process-local, like the wake queue. A grant written or removed through this process is dropped with
 * `invalidate`; a change made elsewhere is picked up when the entry expires.
 */
export function createOwnerGrantCache(
  open: (owner: string) => Promise<ExoActivatedGrant | null>,
  options: OwnerGrantCacheOptions = {},
): OwnerGrantCache {
  const ttlMs = options.ttlMs ?? EXO_GRANT_CACHE_TTL_MS;
  const missTtlMs = options.missTtlMs ?? EXO_GRANT_CACHE_MISS_TTL_MS;
  const maxOwners = options.maxOwners ?? EXO_GRANT_CACHE_MAX_OWNERS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function key(owner: string): string {
    return owner.toLowerCase();
  }

  return {
    open(owner) {
      const k = key(owner);
      const cached = entries.get(k);
      if (cached && cached.expiresAt > now()) return cached.result;
      entries.delete(k);

      // An in-flight lookup lives for the longest a result can, then is cut down to the result's own lifetime.
      const entry: Entry = { result: undefined as unknown as Promise<ExoActivatedGrant | null>, expiresAt: now() + ttlMs };
      entry.result = open(owner).then(
        (grant) => {
          entry.expiresAt = now() + (grant ? ttlMs : missTtlMs);
          return grant;
        },
        (error: unknown) => {
          // A lookup that throws is not remembered.
          if (entries.get(k) === entry) entries.delete(k);
          throw error;
        },
      );
      entries.set(k, entry);
      while (entries.size > maxOwners) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
      return entry.result;
    },
    invalidate(owner) {
      entries.delete(key(owner));
    },
  };
}
