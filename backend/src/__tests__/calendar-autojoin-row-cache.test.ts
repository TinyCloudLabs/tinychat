import { describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { CalendarAutojoinStatusCache } from "../services/calendar-autojoin-status-cache.js";
import { CalendarAutojoinRowCache, KvCalendarAutojoinStore, type CalendarConnection } from "../services/calendar-autojoin-store.js";

// TC-2917 (Bobbie's #693 review, P2): the worker's row cache is bounded and keeps no tombstones.

function countingNode() {
  const values = new Map<string, unknown>();
  const calls: string[] = [];
  const node = { kv: {
    async get(key: string) {
      calls.push(`get:${key}`);
      return values.has(key) ? { ok: true, data: { data: structuredClone(values.get(key)) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
    },
    async put(key: string, value: unknown) { calls.push(`put:${key}`); values.set(key, structuredClone(value)); return { ok: true, data: {} }; },
    async delete(key: string) { calls.push(`delete:${key}`); values.delete(key); return { ok: true, data: {} }; },
    async list({ prefix }: { prefix: string }) {
      calls.push(`list:${prefix}`);
      return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } };
    },
  } } as unknown as TinyCloudNode;
  return { node, values, calls };
}

const tenant = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const connection = (n: number): CalendarConnection => ({ tenant: tenant(n), subject: "s", state: "enabled", generation: 1, scopes: [], nextScanAt: 0, scanComplete: true });

/** The worker's store: reads served from `cache`. */
function workerStore(bounds: { maxRows?: number; maxListings?: number }) {
  const { node, values, calls } = countingNode();
  const cache = new CalendarAutojoinRowCache(bounds);
  const store = new KvCalendarAutojoinStore(node, new BackendStorageLane(), { priority: "background" }, new CalendarAutojoinStatusCache(), { cache });
  return { store, values, calls };
}

describe("TC-2917 calendar autojoin row cache bounds", () => {
  test("rows past the bound are evicted least recently used first, and read from the node again", async () => {
    const { store, calls } = workerStore({ maxRows: 2 });
    for (const n of [1, 2, 3]) await store.putConnection(connection(n));
    calls.length = 0;
    expect((await store.getConnection(tenant(3)))?.tenant).toBe(tenant(3));
    expect(calls).toEqual([]);
    expect((await store.getConnection(tenant(1)))?.tenant).toBe(tenant(1));
    expect(calls.filter(call => call.startsWith("get:"))).toHaveLength(1);
  });

  test("absence comes from the listing: reads of missing rows keep no tombstones and evict nothing", async () => {
    const { store, calls } = workerStore({ maxRows: 2 });
    for (const n of [1, 2]) await store.putConnection(connection(n));
    await store.listConnections();
    calls.length = 0;
    for (let n = 100; n < 200; n++) expect(await store.getConnection(tenant(n))).toBeNull();
    expect((await store.getConnection(tenant(1)))?.tenant).toBe(tenant(1));
    expect((await store.getConnection(tenant(2)))?.tenant).toBe(tenant(2));
    expect(calls).toEqual([]);
  });

  test("listings past the bound are evicted and listed again", async () => {
    const { store, calls } = workerStore({ maxListings: 1 });
    await store.listOccurrences(tenant(1));
    await store.listOccurrences(tenant(2));
    calls.length = 0;
    await store.listOccurrences(tenant(2));
    expect(calls).toEqual([]);
    await store.listOccurrences(tenant(1));
    expect(calls.filter(call => call.startsWith("list:"))).toHaveLength(1);
  });
});
