import { describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BackendStorageLane } from "../services/backend-storage-lane.js";
import { KvCalendarAutojoinStore, MemoryCalendarAutojoinStore, TenantCoordinator, type CalendarConnection } from "../services/calendar-autojoin-store.js";

const connection = (tenant = "0xalice"): CalendarConnection => ({
  tenant, subject: "google-one", state: "enabled", generation: 1,
  scopes: [], nextScanAt: 0, scanComplete: false,
});

describe("calendar state durability", () => {
  test("updates serialize and tenants remain isolated", async () => {
    const store = new MemoryCalendarAutojoinStore();
    await store.putConnection(connection());
    await store.putConnection(connection("0xbob"));
    await Promise.all(Array.from({ length: 20 }, () => store.updateConnection("0xalice", row => row && ({ ...row, generation: row.generation + 1 }))));
    expect((await store.getConnection("0xALICE"))?.generation).toBe(21);
    expect((await store.getConnection("0xbob"))?.generation).toBe(1);
  });
  test("sent markers survive recording and occurrence deletion and reconnect", async () => {
    const store = new MemoryCalendarAutojoinStore();
    await store.putConnection(connection());
    await store.putMarker({ tenant: "0xalice", id: "opaque", meetingId: "recording", disposition: "completed" });
    await store.deleteOccurrence("0xalice", "opaque");
    await store.putConnection({ ...connection(), state: "disabled", generation: 2 });
    await store.putConnection({ ...connection(), generation: 3 });
    expect((await store.getMarker("0xalice", "opaque"))?.meetingId).toBe("recording");
    expect(await store.getMarker("0xbob", "opaque")).toBeNull();
  });
  test("KV rehydrates disabled tenants and does not discard a failed write", async () => {
    const values = new Map<string, unknown>();
    let failWrite = false;
    const node = { kv: {
      async get(key: string) { return values.has(key) ? { ok: true, data: { data: values.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "Key not found" } }; },
      async put(key: string, value: unknown) { if (failWrite) return { ok: false, error: { code: "FAILED", message: "write failed" } }; values.set(key, structuredClone(value)); return { ok: true, data: {} }; },
      async list({ prefix }: { prefix: string }) { return { ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } }; },
      async delete(key: string) { values.delete(key); return { ok: true, data: {} }; },
    } } as unknown as TinyCloudNode;
    const lane = new BackendStorageLane();
    const store = new KvCalendarAutojoinStore(node, lane);
    await store.putConnection({ ...connection(), state: "disabled" });
    failWrite = true;
    expect(store.updateConnection("0xalice", row => row && ({ ...row, generation: 2 }))).rejects.toThrow();
    failWrite = false;
    const restarted = new KvCalendarAutojoinStore(node, lane);
    expect((await restarted.listConnections()).map(row => [row.state, row.generation])).toEqual([["disabled", 1]]);
  });
  test("policy coordination releases after errors and does not block other tenants", async () => {
    const coordinator = new TenantCoordinator();
    let release!: () => void;
    const pending = coordinator.run("alice", () => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    expect(await coordinator.run("bob", async () => "ready")).toBe("ready");
    release();
    await pending;
    await expect(coordinator.run("alice", async () => { throw new Error("write failed"); })).rejects.toThrow();
    expect(await coordinator.run("alice", async () => "recovered")).toBe("recovered");
  });
});
