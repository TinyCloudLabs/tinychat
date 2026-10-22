import { EXO_SYNC_GRANT_KIND, type DelegationStore } from "@tinyboilerplate/server";
import { extractKeys } from "../services/connector-drain.js";

export const OWNER_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The longest an owner missing from the index waits before the grant prefix is listed again. A
 * flood of unknown owners therefore costs one listing per window, not one read per request.
 */
export const GRANT_HOLDER_REFRESH_MS = 5_000;

/** Lists backend KV keys under a prefix. Returned keys are relative to the backend space. */
export interface GrantHolderSource {
  list(prefix: string): Promise<unknown>;
}

/**
 * In-memory over-approximation of the owners that may hold an exo sync grant.
 *
 * Membership comes from this process's grant writes, from a listing of the grant prefix, and from
 * a load that finds a record. It is removed when a grant is deleted or does not open. A grant
 * written by another process is seen at the next listing, so for up to one window it reads as
 * inactive. A failed listing also fails closed for one window.
 */
export class GrantHolderIndex {
  private readonly holders = new Set<string>();
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly source: GrantHolderSource,
    private readonly now: () => number = Date.now,
  ) {}

  add(address: string): void {
    this.holders.add(address.toLowerCase());
  }

  remove(address: string): void {
    this.holders.delete(address.toLowerCase());
  }

  /**
   * True only when the owner may hold a grant. An owner in the set returns without store reads.
   * Otherwise at most one listing runs per window, and concurrent callers share it.
   */
  async mayHold(address: string): Promise<boolean> {
    const owner = address.toLowerCase();
    if (this.holders.has(owner)) return true;
    if (this.refreshing === null) {
      if (this.now() - this.lastRefreshAt < GRANT_HOLDER_REFRESH_MS) return false;
      this.lastRefreshAt = this.now();
      this.refreshing = this.load().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    return this.holders.has(owner);
  }

  private async load(): Promise<void> {
    const prefix = EXO_SYNC_GRANT_KIND.keyPrefix;
    try {
      for (const key of extractKeys(await this.source.list(prefix))) {
        if (!key.startsWith(prefix)) continue;
        const owner = key.slice(prefix.length);
        if (OWNER_ADDRESS_RE.test(owner)) this.holders.add(owner.toLowerCase());
      }
    } catch {
      console.error("[exo] grant holder listing failed");
    }
  }
}

/**
 * Keeps the index in step with the grant store: a stored grant is added, a removed grant is
 * dropped, and a load updates membership from what the store returned.
 */
export function createTrackedGrantStore(
  store: Pick<DelegationStore, "store" | "load" | "remove">,
  holders: Pick<GrantHolderIndex, "add" | "remove">,
): Pick<DelegationStore, "store" | "load" | "remove"> {
  return {
    store: async (identifier, serialized, metadata) => {
      await store.store(identifier, serialized, metadata);
      holders.add(identifier);
    },
    load: async (identifier) => {
      const stored = await store.load(identifier);
      if (stored) holders.add(identifier);
      else holders.remove(identifier);
      return stored;
    },
    remove: async (identifier) => {
      await store.remove(identifier);
      holders.remove(identifier);
    },
  };
}
