import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { ReplicationPluginLoader } from "./replicationClient";
import { REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, replicationWipePending, SDK_LOGOUT_MARKER_KEY } from "./replicationCopyMarker";
import { purgeReplicaCopyWhenOff, REPLICA_DATABASE_NAME } from "./replicationOffPurge";
import { KEYS_KEPT_RETRY_DELAYS_MS, REPLICA_KEYS_KEPT_WARNING, REPLICA_PURGE_FAILED_WARNING, signOutReplicaAware } from "./replicationSignOut";
import { getReplicationStatus, resetReplicationStatus } from "./replicationStatus";

const ALICE = "did:pkh:eip155:1:0xaaaa";
const TOMBSTONE_KEY = "tinycloud-replica:deny-tombstone";
const TOMBSTONE = "{\"epoch\":2,\"deniedAt\":5}";

/** The SDK lifecycle gate for the next-load purge: every deny succeeds. */
const DENY_OK: ReplicationPluginLoader = {
  registerPlugin: async () => undefined,
  createStorage: async () => ({ kind: "indexeddb", lifecycle: { kind: "indexeddb", deny: async () => ({ status: "denied" }) } }) as never,
};

let factory: IDBFactory;
const originals = {
  indexedDB: Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

/** A replica database with one row, returned OPEN: while the caller holds it, a delete is blocked. */
function seedReplica(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(REPLICA_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("rows").put("sealed-row", 1);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function replicaExists(): Promise<boolean> {
  return (await factory.databases()).some((db) => db.name === REPLICA_DATABASE_NAME);
}

function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

const KEYS_KEPT = () => new Error("Replica gate was not denied (STORAGE_ERROR); the replica may still be restorable.");

/** Records the waits; `onSleep` can free the database between attempts. */
function sleeper(onSleep?: (call: number) => void) {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); onSleep?.(waits.length); } };
}

beforeEach(() => {
  resetReplicationStatus();
  factory = new IDBFactory();
  define("indexedDB", factory);
  define("navigator", { locks: { request: async (_name: string, callback: () => unknown) => callback() } });
});

afterEach(() => {
  for (const [name, descriptor] of [["indexedDB", originals.indexedDB], ["navigator", originals.navigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  resetReplicationStatus();
});

describe("the copy is removed AT sign-out", () => {
  test("when the sign-out promise resolves the replica database is gone, the markers are cleared and the deny tombstone is kept", async () => {
    (await seedReplica()).close();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [TOMBSTONE_KEY]: TOMBSTONE });
    const order: string[] = [];
    const tcw = {
      did: ALICE,
      replication: { purge: async () => { order.push("replication.purge"); } },
      signOut: async () => {
        order.push(`signOut(pending:${replicationWipePending(store)},db:${await replicaExists()})`);
      },
    } as unknown as TinyCloudWeb;

    expect(await signOutReplicaAware(tcw, { store })).toEqual({ ok: true });

    expect(await replicaExists()).toBe(false);
    expect(order).toEqual(["signOut(pending:true,db:true)"]); // marker first; never purge() before signOut; DB deleted after
    expect([...store.map.keys()]).toEqual([TOMBSTONE_KEY]);
    expect(store.map.get(TOMBSTONE_KEY)).toBe(TOMBSTONE);
  });

  test("a client without replication touches nothing: no marker, no delete", async () => {
    (await seedReplica()).close();
    const store = memoryStore();
    expect(await signOutReplicaAware({ signOut: async () => undefined } as unknown as TinyCloudWeb, { store })).toEqual({ ok: true });
    expect(await replicaExists()).toBe(true);
    expect(store.map.size).toBe(0);
  });

  test("a delete that fails (clean deny, keys already shredded): warning, markers kept, no immediate retry, next load removes it", async () => {
    const holder = await seedReplica(); // another tab holds the database open
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [TOMBSTONE_KEY]: TOMBSTONE });
    const { waits, sleep } = sleeper();
    const tcw = { did: ALICE, replication: {}, signOut: async () => undefined } as unknown as TinyCloudWeb;

    const result = await signOutReplicaAware(tcw, { store, sleep });

    expect(result).toEqual({ ok: false, message: REPLICA_PURGE_FAILED_WARNING, code: "DELETE_BLOCKED" });
    expect(waits).toEqual([]);
    expect(getReplicationStatus()).toMatchObject({ purgeFailed: true, errorCode: "DELETE_BLOCKED" });
    expect(replicationWipePending(store)).toBe(true);
    expect(store.map.get(REPLICATION_COPY_KEY)).toBe(ALICE);

    holder.close();
    expect(await purgeReplicaCopyWhenOff({ store, loader: DENY_OK, isEnabled: () => true })).toEqual({ status: "purged" });
    expect(await replicaExists()).toBe(false);
    expect(store.map.get(TOMBSTONE_KEY)).toBe(TOMBSTONE);
  });
});

describe("when the SDK kept the device keys", () => {
  test("backoff is 250 ms, 1 s, 3 s: four attempts in all", () => {
    expect(KEYS_KEPT_RETRY_DELAYS_MS).toEqual([250, 1_000, 3_000]);
  });

  test("sign-out fails (unguarded), the first delete attempts are blocked, a later attempt removes it", async () => {
    const holder = await seedReplica();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [TOMBSTONE_KEY]: TOMBSTONE });
    // The first delete is blocked; the attempt after the first wait runs once the other tab let go.
    const { waits, sleep } = sleeper((call) => { if (call === 1) holder.close(); });
    const tcw = { did: ALICE, replication: {}, signOut: async () => { throw KEYS_KEPT(); } } as unknown as TinyCloudWeb;

    expect(await signOutReplicaAware(tcw, { store, sleep })).toEqual({ ok: true });

    expect(waits).toEqual([250]);
    expect(await replicaExists()).toBe(false);
    expect([...store.map.keys()]).toEqual([TOMBSTONE_KEY]);
    expect(getReplicationStatus().purgeFailed).toBe(false);
  });

  test("sign-out resolves but the SDK's pending-logout marker is set (deny outcome 'marker'): retried the same way", async () => {
    const holder = await seedReplica();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [SDK_LOGOUT_MARKER_KEY]: "1700000000000" });
    const { waits, sleep } = sleeper((call) => { if (call === 1) holder.close(); });
    const tcw = { did: ALICE, replication: {}, signOut: async () => undefined } as unknown as TinyCloudWeb;

    expect(await signOutReplicaAware(tcw, { store, sleep })).toEqual({ ok: true });

    expect(waits).toEqual([250]);
    expect(await replicaExists()).toBe(false);
    expect(store.map.has(SDK_LOGOUT_MARKER_KEY)).toBe(false);
  });

  test("every attempt fails: the 'may still be readable' warning, ok:false, the pending marker stays, the next load removes it", async () => {
    const holder = await seedReplica();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [TOMBSTONE_KEY]: TOMBSTONE });
    const { waits, sleep } = sleeper();
    const tcw = { did: ALICE, replication: {}, signOut: async () => { throw KEYS_KEPT(); } } as unknown as TinyCloudWeb;

    // Every attempt reports a blocked delete (a real queued delete would only time out; see replicationDeleteTimeout.test.ts).
    const result = await signOutReplicaAware(tcw, { store, sleep, deleteDatabase: async () => ({ ok: false, code: "DELETE_BLOCKED" }) });

    expect(result).toEqual({ ok: false, message: REPLICA_KEYS_KEPT_WARNING, code: "STORAGE_ERROR" });
    expect(REPLICA_KEYS_KEPT_WARNING).toBe(
      "You are signed out, but a saved copy of your transcripts may still be readable on this device until it is removed. "
      + "Reload and sign in again to finish removing it.",
    );
    expect(waits).toEqual([250, 1_000, 3_000]);
    expect(await replicaExists()).toBe(true);
    expect(replicationWipePending(store)).toBe(true);
    expect(store.map.get(REPLICATION_COPY_KEY)).toBe(ALICE);
    expect(getReplicationStatus()).toMatchObject({ purgeFailed: true, errorCode: "STORAGE_ERROR" });

    holder.close();
    expect(await purgeReplicaCopyWhenOff({ store, loader: DENY_OK, isEnabled: () => true })).toEqual({ status: "purged" });
    expect(await replicaExists()).toBe(false);
    expect(store.map.has(REPLICATION_WIPE_PENDING_KEY)).toBe(false);
    expect(store.map.get(TOMBSTONE_KEY)).toBe(TOMBSTONE);
  });

  test("a delete that throws is a failed attempt, not an unhandled rejection", async () => {
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE });
    let attempts = 0;
    const tcw = { did: ALICE, replication: {}, signOut: async () => { throw KEYS_KEPT(); } } as unknown as TinyCloudWeb;
    const result = await signOutReplicaAware(tcw, {
      store,
      sleep: async () => undefined,
      deleteDatabase: async () => { attempts += 1; throw new Error("storage gone"); },
    });
    expect(attempts).toBe(4);
    expect(result).toMatchObject({ ok: false, message: REPLICA_KEYS_KEPT_WARNING });
  });
});
