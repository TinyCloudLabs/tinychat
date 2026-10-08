import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import type { BackendStorageLane } from "./backend-storage-lane.js";
import { BackendStorageLane as StorageLane } from "./backend-storage-lane.js";
import { TranscriptionApiError, type IdempotencyLookup, type TranscriptionApiClient } from "./transcription-api.js";

export const TRANSCRIBER_INDEX_KEY_PREFIX = "transcriber/index/";
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 10_000;
const MAX_PENDING = 20;
const MISSING_INTENT_GRACE_MS = 15 * 60_000;

export interface PendingTranscriberCreate {
  key: string;
  hash: string;
  createdAt: number;
}

interface IndexRecord {
  ids: string[];
  pending?: PendingTranscriberCreate[];
}

/** Ownership index for both sent meetings and not-yet-reconciled manual creates. */
export interface TranscriberIndexStore {
  list(address: string): Promise<string[]>;
  add(address: string, meetingId: string): Promise<void>;
  remove(address: string, meetingId: string): Promise<void>;
  listAddresses(): Promise<string[]>;
  beginCreate(address: string, intent: PendingTranscriberCreate): Promise<void>;
  completeCreate(address: string, key: string, meetingId: string): Promise<void>;
  abandonCreate(address: string, key: string): Promise<void>;
  listPending(address: string): Promise<PendingTranscriberCreate[]>;
}

export class TooManyPendingCreatesError extends Error {
  constructor() {
    super("too_many_pending_creates");
  }
}

export interface JsonKv {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

/** A TinyCloud KV adapter; no network calls are made outside the store's storage lane. */
export class KvJsonKv implements JsonKv {
  constructor(private readonly node: TinyCloudNode) {}

  async get<T>(key: string): Promise<T | null> {
    const result = await withSessionRefresh(this.node, async () => {
      const response = await this.node.kv.get(key);
      return isKvMissingKeyResult(response, key) ? null : assertKvResult(response);
    });
    if (result === null) return null;
    if (!result || typeof result !== "object" || !("data" in result)) {
      throw new Error("transcriber_index_invalid");
    }
    const outer = result.data;
    const raw = outer && typeof outer === "object" && "data" in outer ? outer.data : outer;
    if (raw === null || raw === undefined) throw new Error("transcriber_index_invalid");
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      assertKvResult(await this.node.kv.put(key, value));
    });
  }

  async remove(key: string): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      const response = await this.node.kv.delete(key);
      if (!isKvMissingKeyResult(response, key)) assertKvResult(response);
    });
  }

  async keys(prefix: string): Promise<string[]> {
    const result = await withSessionRefresh(this.node, async () => assertKvResult(await this.node.kv.list({ prefix })));
    if (!result || typeof result !== "object" || !("data" in result)
      || !result.data || typeof result.data !== "object" || !("keys" in result.data)
      || !Array.isArray(result.data.keys) || !result.data.keys.every(key => typeof key === "string")) {
      throw new Error("transcriber_index_listing_invalid");
    }
    return result.data.keys.map(key => key.startsWith(prefix) ? key : `${prefix}${key}`);
  }
}

const indexKey = (address: string) => `${TRANSCRIBER_INDEX_KEY_PREFIX}${address.toLowerCase()}`;

function parseRecord(value: unknown): IndexRecord {
  if (value === null) return { ids: [] };
  if (!value || typeof value !== "object" || !("ids" in value)
    || !Array.isArray(value.ids) || !value.ids.every(id => typeof id === "string")) {
    throw new Error("transcriber_index_invalid");
  }
  const pending = "pending" in value ? value.pending : undefined;
  if (pending !== undefined && (!Array.isArray(pending) || !pending.every(
    intent => intent && typeof intent === "object"
      && "key" in intent && typeof intent.key === "string"
      && "hash" in intent && typeof intent.hash === "string"
      && "createdAt" in intent && typeof intent.createdAt === "number",
  ))) throw new Error("transcriber_index_invalid");
  return { ids: [...value.ids], ...(pending === undefined ? {} : { pending: [...pending] }) };
}

export class JsonTranscriberIndexStore implements TranscriberIndexStore {
  private readonly cache = new Map<string, { row: IndexRecord; until: number }>();

  constructor(private readonly json: JsonKv, private readonly lane: BackendStorageLane) {}

  private remember(key: string, row: IndexRecord): void {
    this.cache.delete(key);
    this.cache.set(key, { row, until: Date.now() + CACHE_TTL_MS });
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }

  private async read(key: string): Promise<IndexRecord> {
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.row;
    }
    if (cached) this.cache.delete(key);
    const row = parseRecord(await this.json.get<IndexRecord>(key));
    this.remember(key, row);
    return row;
  }

  private async update(address: string, change: (current: IndexRecord) => IndexRecord): Promise<void> {
    const key = indexKey(address);
    await this.lane.run(async () => {
      const next = change(await this.read(key));
      await this.json.put(key, next);
      this.remember(key, next);
    });
  }

  list(address: string): Promise<string[]> {
    return this.lane.run(async () => [...(await this.read(indexKey(address))).ids]);
  }

  listPending(address: string): Promise<PendingTranscriberCreate[]> {
    return this.lane.run(async () => (await this.read(indexKey(address))).pending?.map(intent => ({ ...intent })) ?? []);
  }

  async listAddresses(): Promise<string[]> {
    return this.lane.run(async () => (await this.json.keys(TRANSCRIBER_INDEX_KEY_PREFIX))
      .filter(key => key.startsWith(TRANSCRIBER_INDEX_KEY_PREFIX))
      .map(key => key.slice(TRANSCRIBER_INDEX_KEY_PREFIX.length)));
  }

  add(address: string, meetingId: string): Promise<void> {
    return this.update(address, row => ({
      ...row, ids: [meetingId, ...row.ids.filter(id => id !== meetingId)],
    }));
  }

  remove(address: string, meetingId: string): Promise<void> {
    return this.update(address, row => ({ ...row, ids: row.ids.filter(id => id !== meetingId) }));
  }

  beginCreate(address: string, intent: PendingTranscriberCreate): Promise<void> {
    return this.update(address, row => {
      if ((row.pending?.length ?? 0) >= MAX_PENDING) throw new TooManyPendingCreatesError();
      if (row.pending?.some(existing => existing.key === intent.key)) throw new Error("duplicate_create_intent");
      return { ...row, pending: [...(row.pending ?? []), { ...intent }] };
    });
  }

  completeCreate(address: string, key: string, meetingId: string): Promise<void> {
    return this.update(address, row => {
      if (!row.pending?.some(intent => intent.key === key)) {
        // A GET/sweep can finish this intent while the original POST awaits the lookup.
        if (row.ids.includes(meetingId)) return row;
        throw new Error("create_intent_missing");
      }
      return {
        ids: [meetingId, ...row.ids.filter(id => id !== meetingId)],
        pending: row.pending.filter(intent => intent.key !== key),
      };
    });
  }

  abandonCreate(address: string, key: string): Promise<void> {
    return this.update(address, row => ({
      ...row, pending: row.pending?.filter(intent => intent.key !== key),
    }));
  }
}

export class MemoryTranscriberIndexStore extends JsonTranscriberIndexStore {
  constructor() {
    const rows = new Map<string, unknown>();
    super({
      async get<T>(key: string) { return structuredClone(rows.get(key) ?? null) as T | null; },
      async put(key, value) { rows.set(key, structuredClone(value)); },
      async remove(key) { rows.delete(key); },
      async keys(prefix) { return [...rows.keys()].filter(key => key.startsWith(prefix)); },
    }, new StorageLane());
  }
}

export class KvTranscriberIndexStore extends JsonTranscriberIndexStore {
  constructor(node: TinyCloudNode, lane: BackendStorageLane) {
    super(new KvJsonKv(node), lane);
  }
}

/** Validate ptx's persisted request, not the untrusted response body from POST. */
export function matchingCreateLookup(
  address: string,
  intent: PendingTranscriberCreate,
  lookup: IdempotencyLookup,
): boolean {
  const id = lookup.meeting?.id;
  return lookup.requestHash === intent.hash
    && lookup.meeting?.metadata?.tinychat_address === address.toLowerCase()
    && typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** A lookup may create ownership only when both the original request and tenant match. */
export async function resolvePendingCreates(
  address: string,
  api: Pick<TranscriptionApiClient, "lookupMeetingByIdempotencyKey">,
  index: TranscriberIndexStore,
  options: {
    now?: () => number;
    beforeIndexWrite?: () => Promise<void>;
    onResolved?: (id: string) => void;
    maxLookups?: number;
    onlyKey?: string;
  } = {},
): Promise<number> {
  const owner = address.toLowerCase();
  let attempted = 0;
  for (const intent of await index.listPending(owner)) {
    if (options.onlyKey !== undefined && intent.key !== options.onlyKey) continue;
    if (attempted >= (options.maxLookups ?? Infinity)) break;
    attempted++;
    let lookup: IdempotencyLookup | null;
    try {
      lookup = await api.lookupMeetingByIdempotencyKey(intent.key);
    } catch (error) {
      if (error instanceof TranscriptionApiError && error.status === 404) lookup = null;
      else continue; // A temporary upstream failure leaves the durable intent in place.
    }
    if (!lookup) {
      if ((options.now?.() ?? Date.now()) - intent.createdAt >= MISSING_INTENT_GRACE_MS) {
        await options.beforeIndexWrite?.();
        await index.abandonCreate(owner, intent.key);
      }
      continue;
    }
    if (!matchingCreateLookup(owner, intent, lookup)) {
      console.warn("[transcriber] lookup_identity_mismatch");
      await options.beforeIndexWrite?.();
      await index.abandonCreate(owner, intent.key);
      continue;
    }
    const id = lookup.meeting.id;
    await options.beforeIndexWrite?.();
    await index.completeCreate(owner, intent.key, id);
    options.onResolved?.(id);
  }
  return attempted;
}
