// TC-3195: a small set of JSON records under one key prefix of the signed-in account's space, held in memory for
// the UI (useSyncExternalStore). Both share stores use it: the owner's sent shares and the shares received.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { listKvKeys, parseKvValue } from "@/lib/shareRecords";

export type RecordSpace = Pick<TinyCloudWeb, "did" | "kv">;
export type RecordStoreState = "idle" | "loading" | "ready" | "failed";

export interface RecordStoreSnapshot<T> {
  state: RecordStoreState;
  records: readonly T[];
}

export interface SpaceRecordStore<T extends { id: string }> {
  /** Load the account's records (null on sign-out clears them). */
  bind(space: RecordSpace | null): Promise<void>;
  snapshot(): RecordStoreSnapshot<T>;
  subscribe(listener: () => void): () => void;
  /**
   * One record, read from the space at its own key: `null` when the space holds none, `undefined` when that is not
   * established (a failed read, a missing space, or a value there that is not this record).
   */
  read(space: RecordSpace, id: string): Promise<T | null | undefined>;
  /** Write one record to the space, then show it. */
  put(space: RecordSpace, record: T): Promise<void>;
  /** Delete one record from the space, then drop it. */
  remove(space: RecordSpace, id: string): Promise<void>;
}

export function createSpaceRecordStore<T extends { id: string }>(prefix: string, parse: (value: unknown) => T | null): SpaceRecordStore<T> {
  let bound: string | null = null;
  let generation = 0;
  let current: RecordStoreSnapshot<T> = { state: "idle", records: [] };
  const listeners = new Set<() => void>();
  const publish = (next: RecordStoreSnapshot<T>) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const keyOf = (id: string) => `${prefix}${encodeURIComponent(id)}`;

  return {
    async bind(space) {
      const account = space?.did ?? null;
      if (account === bound && current.state !== "failed") return;
      bound = account;
      const run = ++generation;
      if (!space || !account) {
        publish({ state: "idle", records: [] });
        return;
      }
      publish({ state: "loading", records: [] });
      try {
        const keys = await listKvKeys(space, prefix);
        const read = await Promise.all(keys.map(async (key): Promise<T | null> => {
          const res = await space.kv.get(key, { source: "network" });
          const record = res.ok ? parse(parseKvValue(res.data.data)) : null;
          // A record is only trusted at its own key.
          return record && keyOf(record.id) === key ? record : null;
        }));
        // Records written while the list loaded are newer than what it read.
        const merged = new Map<string, T>(read.flatMap((record) => (record === null ? [] : [[record.id, record] as const])));
        if (run === generation) {
          for (const record of current.records) merged.set(record.id, record);
          publish({ state: "ready", records: [...merged.values()] });
        }
      } catch {
        if (run === generation) publish({ state: "failed", records: [] });
      }
    },
    snapshot: () => current,
    async read(space, id) {
      try {
        const res = await space.kv.get(keyOf(id), { source: "network" });
        // An un-hosted space also answers KV_NOT_FOUND ("Space not found"): that is not an absent record.
        if (!res.ok) return res.error.code === "KV_NOT_FOUND" && !/space not found/i.test(res.error.message) ? null : undefined;
        const record = parse(parseKvValue(res.data.data));
        return record && record.id === id ? record : undefined;
      } catch {
        return undefined;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async put(space, record) {
      const res = await space.kv.put(keyOf(record.id), JSON.stringify(record));
      if (!res.ok) throw new Error(res.error.message);
      if (space.did !== bound) return;
      publish({ ...current, records: [...current.records.filter((entry) => entry.id !== record.id), record] });
    },
    async remove(space, id) {
      const res = await space.kv.delete(keyOf(id));
      if (!res.ok) throw new Error(res.error.message);
      if (space.did !== bound) return;
      publish({ ...current, records: current.records.filter((entry) => entry.id !== id) });
    },
  };
}
