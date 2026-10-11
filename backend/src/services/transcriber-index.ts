import type { TinyCloudNode } from "@tinycloud/node-sdk";
import * as serverPackage from "@tinyboilerplate/server";
import type { BackendStorageLane } from "./backend-storage-lane.js";

const { assertKvResult, withSessionRefresh } = serverPackage;
const { isKvMissingKeyResult } = serverPackage as typeof serverPackage & {
  isKvMissingKeyResult: (result: unknown, key: string) => boolean;
};

/**
 * Which transcription meetings belong to which signed-in address.
 *
 * The private transcription API (SPEC.md V1) has no list endpoint and one project key for the
 * whole app, so ownership lives HERE: the tenant is always the session address, and a meeting id
 * this address did not create is simply not found. Newest first.
 */
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

export interface TranscriberIndexStore {
  list(address: string): Promise<string[]>;
  add(address: string, meetingId: string): Promise<void>;
  remove(address: string, meetingId: string): Promise<void>;
  /** Idempotent: dedupes the id and overwrites its provenance. */
  addShared(address: string, meetingId: string, provenance: ShareProvenance): Promise<void>;
  /** Shared meeting ids for this address, with their provenance. */
  shares(address: string): Promise<Record<string, ShareProvenance>>;
}

/** The stored document. A legacy `{ ids }` document has no shares. */
interface IndexDoc {
  ids: string[];
  shared?: Record<string, ShareProvenance>;
}

function withId(doc: IndexDoc, meetingId: string): IndexDoc {
  return { ...doc, ids: [meetingId, ...doc.ids.filter((id) => id !== meetingId)] };
}

function withoutId(doc: IndexDoc, meetingId: string): IndexDoc {
  const next: IndexDoc = { ...doc, ids: doc.ids.filter((id) => id !== meetingId) };
  if (doc.shared && meetingId in doc.shared) {
    const { [meetingId]: _removed, ...rest } = doc.shared;
    next.shared = rest;
  }
  return next;
}

function withShare(doc: IndexDoc, meetingId: string, provenance: ShareProvenance): IndexDoc {
  return { ...withId(doc, meetingId), shared: { ...doc.shared, [meetingId]: provenance } };
}

export class MemoryTranscriberIndexStore implements TranscriberIndexStore {
  private readonly rows = new Map<string, IndexDoc>();
  private doc(address: string): IndexDoc {
    return this.rows.get(address.toLowerCase()) ?? { ids: [] };
  }
  async list(address: string): Promise<string[]> {
    return [...this.doc(address).ids];
  }
  async add(address: string, meetingId: string): Promise<void> {
    this.rows.set(address.toLowerCase(), withId(this.doc(address), meetingId));
  }
  async remove(address: string, meetingId: string): Promise<void> {
    this.rows.set(address.toLowerCase(), withoutId(this.doc(address), meetingId));
  }
  async addShared(address: string, meetingId: string, provenance: ShareProvenance): Promise<void> {
    this.rows.set(address.toLowerCase(), withShare(this.doc(address), meetingId, structuredClone(provenance)));
  }
  async shares(address: string): Promise<Record<string, ShareProvenance>> {
    return structuredClone(this.doc(address).shared ?? {});
  }
}

export const TRANSCRIBER_INDEX_KEY_PREFIX = "transcriber/index/";

/** The index in the backend's own KV, one key per address, through the shared write lane. */
export class KvTranscriberIndexStore implements TranscriberIndexStore {
  constructor(
    private readonly node: TinyCloudNode,
    private readonly lane: BackendStorageLane,
  ) {}

  private key(address: string): string {
    return `${TRANSCRIBER_INDEX_KEY_PREFIX}${address.toLowerCase()}`;
  }

  private async read(key: string): Promise<IndexDoc> {
    const result = await withSessionRefresh(this.node, async () => {
      const r = await this.node.kv.get(key);
      if (isKvMissingKeyResult(r, key)) return null;
      return assertKvResult(r);
    });
    const response = (result as { data?: unknown } | null)?.data as
      | { data?: unknown }
      | null
      | undefined;
    if (response === null || response === undefined) return { ids: [] };
    let value = (response as { data?: unknown }).data ?? response;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return { ids: [] };
      }
    }
    const ids = (value as { ids?: unknown } | null)?.ids;
    const shared = (value as { shared?: unknown } | null)?.shared;
    return {
      ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
      ...(shared && typeof shared === "object" && !Array.isArray(shared)
        ? { shared: shared as Record<string, ShareProvenance> }
        : {}),
    };
  }

  /** Writes the whole document, so a write never drops another id's provenance. */
  private async write(key: string, doc: IndexDoc): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      assertKvResult(await this.node.kv.put(key, doc));
    });
  }

  private change(address: string, fn: (doc: IndexDoc) => IndexDoc): Promise<void> {
    const key = this.key(address);
    return this.lane.run(async () => {
      await this.write(key, fn(await this.read(key)));
    });
  }

  list(address: string): Promise<string[]> {
    return this.lane.run(async () => (await this.read(this.key(address))).ids);
  }

  add(address: string, meetingId: string): Promise<void> {
    return this.change(address, (doc) => withId(doc, meetingId));
  }

  remove(address: string, meetingId: string): Promise<void> {
    return this.change(address, (doc) => withoutId(doc, meetingId));
  }

  addShared(address: string, meetingId: string, provenance: ShareProvenance): Promise<void> {
    return this.change(address, (doc) => withShare(doc, meetingId, provenance));
  }

  shares(address: string): Promise<Record<string, ShareProvenance>> {
    return this.lane.run(async () => (await this.read(this.key(address))).shared ?? {});
  }
}
