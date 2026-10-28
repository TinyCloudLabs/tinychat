import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { buildReplicationConfig, type ReplicationPluginLoader } from "./replicationClient";
import { REPLICATION_COPY_KEY, REPLICATION_WIPE_PENDING_KEY, replicationCopyMayExist, replicationWipePending, SDK_LOGOUT_MARKER_KEY } from "./replicationCopyMarker";
import { purgeReplicaCopyWhenOff, REPLICA_DATABASE_NAME } from "./replicationOffPurge";
import { REPLICATION_RUNTIME_FLAG_KEY } from "./replicationFlag";
import { readReplicationOptIn, replicationOptInKey, replicationPrincipalFor, writeReplicationOptIn } from "./replicationOptIn";
import { formatReplicationStatus } from "./ReplicationStatusLine";
import { getReplicationStatus, resetReplicationStatus } from "./replicationStatus";
import { removeLocalCopyNow, setReplicationSwitch } from "./replicationSwitch";

const ALICE = replicationPrincipalFor("0xAAAA");
const BOB = replicationPrincipalFor("0xbbbb");

let factory: IDBFactory;
const originals = {
  indexedDB: Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function openDb(name: string, onUpgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => onUpgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** A replica database holding one encrypted-looking row; returned OPEN so a test can hold it. */
async function seedReplica(): Promise<IDBDatabase> {
  const db = await openDb(REPLICA_DATABASE_NAME, (created) => created.createObjectStore("rows"));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("rows", "readwrite");
    tx.objectStore("rows").put("sealed-row", 1);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return db;
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

/** The SDK lifecycle gate: `deny` shreds the named principal's keys. */
function fakeLoader(log: string[], liveKeys: string[]): ReplicationPluginLoader {
  const keys = new Set(liveKeys);
  const lifecycle = {
    kind: "indexeddb" as const,
    async deny(input: { principal: string }) {
      log.push(`deny:${input.principal}`);
      keys.delete(input.principal);
      return { status: "denied" as const };
    },
  };
  return {
    registerPlugin: async () => undefined,
    createStorage: async () => ({ kind: "indexeddb", lifecycle }) as never,
  };
}

/** A client whose replica controller records the order of stop calls against the database. */
function liveClient(log: string[]): TinyCloudWeb {
  return {
    did: ALICE,
    replication: {
      purge: async () => { log.push(`controller.purge(db:${await replicaExists()})`); return { purged: [], failed: [] }; },
      close: async () => { log.push("controller.close"); },
    },
  } as unknown as TinyCloudWeb;
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

describe("the per-user switch", () => {
  test("a new profile has it ON; an explicit opt-out is OFF; an unreadable store or no principal is OFF", () => {
    expect(readReplicationOptIn(ALICE, memoryStore())).toBe(true);
    expect(readReplicationOptIn(ALICE, memoryStore({ [replicationOptInKey(ALICE)]: "false" }))).toBe(false);
    expect(readReplicationOptIn(ALICE, memoryStore({ [replicationOptInKey(ALICE)]: "garbage" }))).toBe(true);
    expect(readReplicationOptIn(undefined, memoryStore({ [replicationOptInKey(ALICE)]: "true" }))).toBe(false);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => undefined, removeItem: () => undefined };
    expect(readReplicationOptIn(ALICE, broken)).toBe(false);
    expect(readReplicationOptIn(ALICE, undefined)).toBe(false);
  });

  test("two accounts in one browser keep independent settings; address case does not matter", () => {
    const store = memoryStore();
    expect(writeReplicationOptIn(ALICE, true, store)).toBe(true);
    expect(readReplicationOptIn(ALICE, store)).toBe(true);
    expect(readReplicationOptIn(ALICE.toLowerCase(), store)).toBe(true);
    expect(writeReplicationOptIn(BOB, false, store)).toBe(true);
    expect(readReplicationOptIn(BOB, store)).toBe(false);
    expect(readReplicationOptIn(ALICE, store)).toBe(true);
    writeReplicationOptIn(BOB, true, store);
    writeReplicationOptIn(ALICE, false, store);
    expect(readReplicationOptIn(ALICE, store)).toBe(false);
    expect(readReplicationOptIn(BOB, store)).toBe(true);
  });

  test("turning ON only saves the choice: no purge, no IndexedDB, no SDK load", async () => {
    const log: string[] = [];
    const store = memoryStore();
    expect(await setReplicationSwitch(true, undefined, ALICE, { store, loader: fakeLoader(log, [ALICE]) })).toEqual({ status: "on" });
    expect(readReplicationOptIn(ALICE, store)).toBe(true);
    expect(log).toEqual([]);
    expect(store.map.has(REPLICATION_WIPE_PENDING_KEY)).toBe(false);
  });

  test("a choice that cannot be saved is reported and removes nothing", async () => {
    const replica = await seedReplica();
    replica.close();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE });
    store.setItem = () => { throw new Error("quota"); }; // turning OFF writes the opt-out
    expect(await setReplicationSwitch(false, undefined, ALICE, { store, loader: fakeLoader([], [ALICE]) })).toEqual({ status: "not-saved" });
    expect(await replicaExists()).toBe(true);
  });
});

describe("turning the switch OFF removes the local copy now", () => {
  test("stops the live controller, shreds the keys, empties the store, clears every marker and records the opt-out", async () => {
    const replica = await seedReplica();
    replica.close();
    const log: string[] = [];
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [SDK_LOGOUT_MARKER_KEY]: "1700000000000", [replicationOptInKey(ALICE)]: "true" });

    const result = await setReplicationSwitch(false, liveClient(log), ALICE, { store, loader: fakeLoader(log, [ALICE]) });

    expect(result).toEqual({ status: "off", purge: { status: "purged" } });
    expect(log).toEqual(["controller.purge(db:true)", "controller.close", `deny:${ALICE}`]);
    expect(await replicaExists()).toBe(false);
    expect([...store.map.entries()]).toEqual([[replicationOptInKey(ALICE), "false"]]); // only the explicit opt-out is left: copy marker, SDK marker and wipe marker all gone
    expect(readReplicationOptIn(ALICE, store)).toBe(false);
    expect(getReplicationStatus().offPurgeCode).toBeNull();
    expect(getReplicationStatus().purging).toBe(false);
    expect(replicationCopyMayExist(store)).toBe(false);
  });

  test("the status line reads 'removing' while the database is being deleted", async () => {
    (await seedReplica()).close();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: "1" });
    const seen: string[] = [];
    await removeLocalCopyNow(undefined, ALICE, {
      store,
      deleteDatabase: async () => {
        seen.push(formatReplicationStatus(getReplicationStatus()));
        return { ok: true };
      },
    });
    expect(seen).toEqual(["Local copy: removing…"]);
    expect(getReplicationStatus().purging).toBe(false);
  });

  test("a failed removal is surfaced, kept as pending, and finished at the next load even if the user turned it back ON", async () => {
    const holder = await seedReplica(); // another tab holds the database open: the delete is blocked
    const log: string[] = [];
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [replicationOptInKey(ALICE)]: "true" });

    const result = await setReplicationSwitch(false, undefined, ALICE, { store, loader: fakeLoader(log, [ALICE]) });

    expect(result).toEqual({ status: "off", purge: { status: "failed", code: "DELETE_BLOCKED" } });
    expect(getReplicationStatus().offPurgeCode).toBe("DELETE_BLOCKED");
    expect(formatReplicationStatus(getReplicationStatus())).toBe("Local copy: removal failed (DELETE_BLOCKED) · will retry on next load");
    expect(replicationWipePending(store)).toBe(true);
    expect(replicationCopyMayExist(store)).toBe(true);
    expect(await replicaExists()).toBe(true);

    // The user turns it back ON before the retry; the next load still finishes the removal.
    writeReplicationOptIn(ALICE, true, store);
    holder.close();
    const nextLoad = await purgeReplicaCopyWhenOff({ store, loader: fakeLoader(log, [ALICE]), principal: ALICE, isEnabled: () => true });
    expect(nextLoad).toEqual({ status: "purged" });
    expect(await replicaExists()).toBe(false);
    expect(replicationWipePending(store)).toBe(false);
    expect(getReplicationStatus().offPurgeCode).toBeNull();
  });

  test("a controller that throws while stopping does not stop the removal", async () => {
    (await seedReplica()).close();
    const tcw = { did: ALICE, replication: { purge: async () => { throw new Error("stuck"); }, close: async () => { throw new Error("stuck"); } } } as unknown as TinyCloudWeb;
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE });
    expect(await removeLocalCopyNow(tcw, ALICE, { store, loader: fakeLoader([], [ALICE]) })).toEqual({ status: "purged" });
    expect(await replicaExists()).toBe(false);
  });
});

describe("the wipe button", () => {
  test("shows whenever a marker says a copy may exist, with the build flag or the switch OFF; hidden with no marker", () => {
    expect(replicationCopyMayExist(memoryStore())).toBe(false);
    expect(replicationCopyMayExist(memoryStore({ [REPLICATION_COPY_KEY]: "1" }))).toBe(true);
    expect(replicationCopyMayExist(memoryStore({ [REPLICATION_COPY_KEY]: ALICE }))).toBe(true);
    expect(replicationCopyMayExist(memoryStore({ [SDK_LOGOUT_MARKER_KEY]: "1" }))).toBe(true);
    expect(replicationCopyMayExist(memoryStore({ [REPLICATION_WIPE_PENDING_KEY]: "1" }))).toBe(true);
    expect(replicationCopyMayExist(undefined)).toBe(false);
  });

  test("wipes the copy with the flag OFF and no opt-in, without touching other stores", async () => {
    (await seedReplica()).close();
    (await openDb("tinycloud-audio", (created) => created.createObjectStore("clips"))).close();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE });
    expect(await removeLocalCopyNow(undefined, ALICE, { store, loader: fakeLoader([], [ALICE]) })).toEqual({ status: "purged" });
    expect((await factory.databases()).map((db) => db.name)).toEqual(["tinycloud-audio"]);
    expect(replicationCopyMayExist(store)).toBe(false);
  });

  test("wiping while still opted in keeps the choice and removes the copy; the page-load purge then leaves it alone", async () => {
    (await seedReplica()).close();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [replicationOptInKey(ALICE)]: "true" });
    expect(await removeLocalCopyNow(liveClient([]), ALICE, { store, loader: fakeLoader([], [ALICE]) })).toEqual({ status: "purged" });
    expect(readReplicationOptIn(ALICE, store)).toBe(true);
    expect(await purgeReplicaCopyWhenOff({ store, principal: ALICE, isEnabled: () => true })).toEqual({ status: "skipped", reason: "replication-on" });
  });
});

describe("a removal that is interrupted or overlapped", () => {
  test("tab closed mid-removal: the pending marker is written BEFORE the purge starts, so the next load finishes it even if the user is still ON", async () => {
    (await seedReplica()).close();
    const store = memoryStore({ [REPLICATION_COPY_KEY]: ALICE, [replicationOptInKey(ALICE)]: "true" });
    let pendingWhenDeleteStarted: boolean | undefined;

    // The page dies inside the delete: nothing after this point (no failure markers) ever runs.
    await removeLocalCopyNow(undefined, ALICE, {
      store,
      loader: fakeLoader([], [ALICE]),
      deleteDatabase: async () => {
        pendingWhenDeleteStarted = replicationWipePending(store);
        throw new Error("tab closed");
      },
    }).catch(() => undefined);

    expect(pendingWhenDeleteStarted).toBe(true);
    expect(await replicaExists()).toBe(true);

    // Next load, opted in: only the pending marker makes the purge run (ON alone is skipped).
    expect(await purgeReplicaCopyWhenOff({ store, loader: fakeLoader([], [ALICE]), principal: ALICE, isEnabled: () => true })).toEqual({ status: "purged" });
    expect(await replicaExists()).toBe(false);
    expect(replicationWipePending(store)).toBe(false);
  });

  test("OFF then ON then sign-in on the same page: the replica is not built until the removal has finished", async () => {
    (await seedReplica()).close();
    const store = memoryStore({ [REPLICATION_RUNTIME_FLAG_KEY]: "true", [replicationOptInKey(ALICE)]: "true", [REPLICATION_COPY_KEY]: ALICE });
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const savedWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      define("window", { localStorage: store });
      define("Worker", class {});
      define("navigator", {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        userAgentData: { brands: [{ brand: "Chromium" }] },
        maxTouchPoints: 0,
        locks: { request: async (_name: string, callback: () => unknown) => callback() },
      });
      const events: string[] = [];
      const deleting = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();

      const off = setReplicationSwitch(false, undefined, ALICE, {
        store,
        loader: fakeLoader(events, [ALICE]),
        deleteDatabase: async () => {
          events.push("delete-start");
          entered.resolve();
          await deleting.promise;
          events.push("delete-end");
          return { ok: true };
        },
      });
      await entered.promise;
      writeReplicationOptIn(ALICE, true, store); // the user turns it straight back ON
      const sdk: ReplicationPluginLoader = {
        registerPlugin: async () => { events.push("register"); },
        createStorage: async () => { events.push("storage"); return {} as never; },
      };
      const building = buildReplicationConfig(ALICE, sdk);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(events).toEqual([`deny:${ALICE}`, "delete-start"]); // nothing built while the delete runs

      deleting.resolve();
      expect((await off).status).toBe("off");
      expect((await building)?.enabled).toBe(true);
      expect(events).toEqual([`deny:${ALICE}`, "delete-start", "delete-end", "register", "storage"]);
    } finally {
      for (const [name, descriptor] of [["window", savedWindow], ["Worker", savedWorker], ["navigator", savedNavigator]] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
