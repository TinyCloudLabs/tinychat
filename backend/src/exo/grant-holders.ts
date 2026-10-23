import { EXO_SYNC_GRANT_KIND, type DelegationStore } from "@tinyboilerplate/server";
import { extractKeys } from "../services/connector-drain.js";

export const OWNER_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The longest a grant written by another process stays unseen. One background listing runs per
 * window, regardless of how many owners are not yet in the index.
 */
export const GRANT_HOLDER_REFRESH_MS = 5_000;

/** Lists backend KV keys under a prefix. Returned keys are relative to the backend space. */
export interface GrantHolderSource {
  list(prefix: string): Promise<unknown>;
}

/**
 * In-memory over-approximation of the owners that may hold an exo sync grant. The request path reads
 * memory only; a listing runs in the background and is never awaited by a caller.
 *
 * Membership comes from this process's grant writes, from a listing of the grant prefix, and from a
 * load that finds a record. It is removed when a grant is deleted or does not open. A grant written
 * by another process appears at the next listing. A failed listing leaves membership unchanged.
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

  /** True only for an owner in the set. Reads no store. */
  mayHold(address: string): boolean {
    return this.holders.has(address.toLowerCase());
  }

  /**
   * Starts one background listing when the last one is older than the window. Returns nothing, so a
   * request path cannot wait on the store.
   */
  refreshIfStale(): void {
    if (this.refreshing !== null) return;
    if (this.now() - this.lastRefreshAt < GRANT_HOLDER_REFRESH_MS) return;
    this.start();
  }

  /** Lists now, joining a listing already in progress. Called at boot, before the router mounts. */
  refresh(): Promise<void> {
    return this.refreshing ?? this.start();
  }

  private start(): Promise<void> {
    this.lastRefreshAt = this.now();
    const listing = this.load().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = listing;
    return listing;
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
