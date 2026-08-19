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
export interface TranscriberIndexStore {
  list(address: string): Promise<string[]>;
  add(address: string, meetingId: string): Promise<void>;
  remove(address: string, meetingId: string): Promise<void>;
}

export class MemoryTranscriberIndexStore implements TranscriberIndexStore {
  private readonly rows = new Map<string, string[]>();
  async list(address: string): Promise<string[]> {
    return [...(this.rows.get(address.toLowerCase()) ?? [])];
  }
  async add(address: string, meetingId: string): Promise<void> {
    const key = address.toLowerCase();
    const current = (this.rows.get(key) ?? []).filter((id) => id !== meetingId);
    this.rows.set(key, [meetingId, ...current]);
  }
  async remove(address: string, meetingId: string): Promise<void> {
    const key = address.toLowerCase();
    this.rows.set(key, (this.rows.get(key) ?? []).filter((id) => id !== meetingId));
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

  private async read(key: string): Promise<string[]> {
    const result = await withSessionRefresh(this.node, async () => {
      const r = await this.node.kv.get(key);
      if (isKvMissingKeyResult(r, key)) return null;
      return assertKvResult(r);
    });
    const response = (result as { data?: unknown } | null)?.data as
      | { data?: unknown }
      | null
      | undefined;
    if (response === null || response === undefined) return [];
    let value = (response as { data?: unknown }).data ?? response;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return [];
      }
    }
    const ids = (value as { ids?: unknown } | null)?.ids;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  }

  private async write(key: string, ids: string[]): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      assertKvResult(await this.node.kv.put(key, { ids }));
    });
  }

  list(address: string): Promise<string[]> {
    return this.lane.run(() => this.read(this.key(address)));
  }

  add(address: string, meetingId: string): Promise<void> {
    const key = this.key(address);
    return this.lane.run(async () => {
      const current = (await this.read(key)).filter((id) => id !== meetingId);
      await this.write(key, [meetingId, ...current]);
    });
  }

  remove(address: string, meetingId: string): Promise<void> {
    const key = this.key(address);
    return this.lane.run(async () => {
      const current = await this.read(key);
      await this.write(
        key,
        current.filter((id) => id !== meetingId),
      );
    });
  }
}
