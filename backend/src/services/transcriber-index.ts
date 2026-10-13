import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import type { BackendStorageLane } from "./backend-storage-lane.js";
import { BackendStorageLane as StorageLane, REQUEST_LANE_WAIT_MS } from "./backend-storage-lane.js";
import { TranscriptionApiError, type IdempotencyLookup, type TranscriptionApiClient } from "./transcription-api.js";

export const TRANSCRIBER_INDEX_KEY_PREFIX = "transcriber/index/";
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 10_000;
const MAX_PENDING = 20;
const MISSING_INTENT_GRACE_MS = 15 * 60_000;

/**
 * Why a meeting someone else's bot captured is in this address's list (TC-581). Backend-only:
 * the owner's identity never reaches the browser. `title` and `scheduledStart` come from the
 * recipient's own calendar occurrence.
 */
export interface ShareProvenance {
  ownerTenant: string;
  ownerOccurrenceId: string;
  recipientOccurrenceId: string;
  checkedAt: number;
  title: string;
  scheduledStart: string;
}

export interface PendingTranscriberCreate {
  key: string;
  hash: string;
  createdAt: number;
}

export interface TranscriberIndexEntries {
  ids: string[];
  shared: Record<string, ShareProvenance>;
}

/** The stored document. A legacy `{ ids }` document has no shares and no pending creates. */
interface IndexRecord {
  ids: string[];
  shared?: Record<string, ShareProvenance>;
  pending?: PendingTranscriberCreate[];
}

/**
 * Which transcription meetings belong to which signed-in address, including meetings shared
 * into it (TC-581) and not-yet-reconciled manual creates (TC-641).
 *
 * The private transcription API (SPEC.md V1) has no list endpoint and one project key for the
 * whole app, so ownership lives HERE: the tenant is always the session address, and a meeting id
 * this address did not create is simply not found. Newest first.
 */
export interface TranscriberIndexStore {
  list(address: string): Promise<string[]>;
  add(address: string, meetingId: string): Promise<void>;
  remove(address: string, meetingId: string): Promise<void>;
  /** Idempotent: dedupes the id and overwrites its provenance. */
  addShared(address: string, meetingId: string, provenance: ShareProvenance): Promise<void>;
  /** Shared meeting ids for this address, with their provenance. */
  shares(address: string): Promise<Record<string, ShareProvenance>>;
  /** Ids and shares from ONE read of the document, so ownership and sharing can never disagree. */
  entries(address: string): Promise<TranscriberIndexEntries>;
  listAddresses(): Promise<string[]>;
  /** Adds the durable intent and returns ownership from the same lane read/write. */
  beginCreate(address: string, intent: PendingTranscriberCreate): Promise<TranscriberIndexEntries>;
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

/** A garbled provenance entry still marks its id as shared; its fields fall back to empty values. */
function sanitizeProvenance(raw: unknown): ShareProvenance {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  return {
    ownerTenant: text("ownerTenant"),
    ownerOccurrenceId: text("ownerOccurrenceId"),
    recipientOccurrenceId: text("recipientOccurrenceId"),
    checkedAt: typeof value.checkedAt === "number" ? value.checkedAt : 0,
    title: text("title"),
    scheduledStart: text("scheduledStart"),
  };
}

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
  const shared = "shared" in value ? value.shared : undefined;
  // Fail closed: an unreadable share map must never turn a shared id into an owned one.
  if (shared !== undefined && (shared === null || typeof shared !== "object" || Array.isArray(shared))) {
    throw new Error("transcriber_index_invalid");
  }
  return {
    ids: [...value.ids],
    ...(shared === undefined ? {} : {
      shared: Object.fromEntries(Object.entries(shared).map(([id, raw]) => [id, sanitizeProvenance(raw)])),
    }),
    ...(pending === undefined ? {} : { pending: [...pending] }),
  };
}

function withId(row: IndexRecord, meetingId: string): IndexRecord {
  return { ...row, ids: [meetingId, ...row.ids.filter(id => id !== meetingId)] };
}

function withoutId(row: IndexRecord, meetingId: string): IndexRecord {
  const next: IndexRecord = { ...row, ids: row.ids.filter(id => id !== meetingId) };
  if (row.shared && meetingId in row.shared) {
    const { [meetingId]: _removed, ...rest } = row.shared;
    next.shared = rest;
  }
  return next;
}

function withShare(row: IndexRecord, meetingId: string, provenance: ShareProvenance): IndexRecord {
  return { ...withId(row, meetingId), shared: { ...row.shared, [meetingId]: structuredClone(provenance) } };
}

/** Every write keeps the whole document, so no write drops another id's provenance or intent. */
export class JsonTranscriberIndexStore implements TranscriberIndexStore {
  private readonly cache = new Map<string, { row: IndexRecord; until: number }>();

  constructor(private readonly json: JsonKv, private readonly lane: BackendStorageLane) {}

  private remember(key: string, row: IndexRecord): void {
    this.cache.delete(key);
    this.cache.set(key, { row, until: Date.now() + CACHE_TTL_MS });
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }

  private fresh(key: string): IndexRecord | undefined {
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    this.cache.delete(key);
    if (cached.until <= Date.now()) return undefined;
    this.cache.set(key, cached);
    return cached.row;
  }

  private async read(key: string): Promise<IndexRecord> {
    const cached = this.fresh(key);
    if (cached) return cached;
    const row = parseRecord(await this.json.get<IndexRecord>(key));
    this.remember(key, row);
    return row;
  }

  /**
   * Request-path reads (TC-1006). A fresh cached document is answered without queueing on the
   * shared storage lane: the cache is only filled and replaced inside lane jobs after a committed
   * read or write, so a hit is what a queued read would have returned for every write this caller
   * has awaited. A miss waits at most REQUEST_LANE_WAIT_MS to start, then rejects (the routes
   * answer 503) instead of outwaiting the client.
   */
  private view<T>(address: string, project: (row: IndexRecord) => T): Promise<T> {
    const key = indexKey(address);
    const cached = this.fresh(key);
    if (cached) return Promise.resolve(project(cached));
    return this.lane.run(async () => project(await this.read(key)), { waitTimeoutMs: REQUEST_LANE_WAIT_MS });
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
    return this.view(address, row => [...row.ids]);
  }

  listPending(address: string): Promise<PendingTranscriberCreate[]> {
    return this.view(address, row => row.pending?.map(intent => ({ ...intent })) ?? []);
  }

  shares(address: string): Promise<Record<string, ShareProvenance>> {
    return this.view(address, row => structuredClone(row.shared ?? {}));
  }

  entries(address: string): Promise<TranscriberIndexEntries> {
    return this.view(address, row => structuredClone({ ids: row.ids, shared: row.shared ?? {} }));
  }

  async listAddresses(): Promise<string[]> {
    return this.lane.run(async () => (await this.json.keys(TRANSCRIBER_INDEX_KEY_PREFIX))
      .filter(key => key.startsWith(TRANSCRIBER_INDEX_KEY_PREFIX))
      .map(key => key.slice(TRANSCRIBER_INDEX_KEY_PREFIX.length)));
  }

  add(address: string, meetingId: string): Promise<void> {
    return this.update(address, row => withId(row, meetingId));
  }

  remove(address: string, meetingId: string): Promise<void> {
    return this.update(address, row => withoutId(row, meetingId));
  }

  addShared(address: string, meetingId: string, provenance: ShareProvenance): Promise<void> {
    return this.update(address, row => withShare(row, meetingId, provenance));
  }

  beginCreate(address: string, intent: PendingTranscriberCreate): Promise<TranscriberIndexEntries> {
    const key = indexKey(address);
    return this.lane.run(async () => {
      const row = await this.read(key);
      const existing = row.pending?.find(candidate => candidate.key === intent.key);
      if (existing && existing.hash !== intent.hash) throw new Error("duplicate_create_intent");
      if (!existing && (row.pending?.length ?? 0) >= MAX_PENDING) throw new TooManyPendingCreatesError();
      const next = existing ? row : { ...row, pending: [...(row.pending ?? []), { ...intent }] };
      if (!existing) {
        await this.json.put(key, next);
        this.remember(key, next);
      }
      return structuredClone({ ids: next.ids, shared: next.shared ?? {} });
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
        ...withId(row, meetingId),
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

/** The index in the backend's own KV, one key per address, through the shared write lane. */
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
