import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { buildReplicationConfig, type ReplicationPluginLoader } from "./replicationClient";
import { REPLICATION_COPY_KEY, rememberReplicationPrincipal, SDK_LOGOUT_MARKER_KEY } from "./replicationCopyMarker";
import { isReplicationEnabled, REPLICATION_RUNTIME_FLAG_KEY, type ReplicationEnv } from "./replicationFlag";
import { replicationOptInKey, writeReplicationOptIn } from "./replicationOptIn";
import { deleteReplicaDatabase, purgeReplicaCopyWhenOff, REPLICA_DATABASE_NAME, REPLICA_GATE_LOCK } from "./replicationOffPurge";
import { formatReplicationStatus } from "./ReplicationStatusLine";
import { getReplicationStatus, resetReplicationStatus } from "./replicationStatus";

const A = "did:pkh:eip155:1:0xaaaa";
const B = "did:pkh:eip155:1:0xbbbb";
const C = "did:pkh:eip155:1:0xcccc";
const TOMBSTONE_KEY = "tinycloud-replica:deny-tombstone";

const CHROME: ReplicationEnv = {
  platform: "web",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  brands: ["Chromium"], maxTouchPoints: 0, hasIndexedDb: true, hasWorker: true, hasLocks: true, hasSubtleCrypto: true,
};

const OFF = () => false;

// --- fakes -----------------------------------------------------------------

type Factory = IDBFactory;

let factory: Factory;
let locksSeen: string[];
const originals = {
  indexedDB: Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function openDb(name: string, version = 1, onUpgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => onUpgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Creates a database with one store holding `rows`; returns it OPEN (caller closes or keeps it). */
async function seed(name: string, rows: string[]): Promise<IDBDatabase> {
  const db = await openDb(name, 1, (created) => created.createObjectStore("rows"));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("rows", "readwrite");
    rows.forEach((row, index) => tx.objectStore("rows").put(row, index));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return db;
}

async function seedClosed(name: string, rows: string[]) {
  (await seed(name, rows)).close();
}

async function names(): Promise<string[]> {
  return (await factory.databases()).map((db) => db.name ?? "").sort();
}

/** Models the SDK lifecycle gate: per-principal live keys; `deny` shreds the named principal only. */
function fakeGate(liveKeys: string[]) {
  const log: string[] = [];
  const keys = new Set(liveKeys);
  const seen = { databasesAtDeny: [] as string[][] };
  const behaviour = { denyUnguarded: false };
  const lifecycle = {
    kind: "indexeddb" as const,
    async deny(input: { principal: string }) {
      log.push(`deny:${input.principal}`);
      seen.databasesAtDeny.push(await names());
      if (behaviour.denyUnguarded) return { status: "unguarded" as const, code: "STORAGE_ERROR" };
      if (!keys.has(input.principal)) return { status: "stale" as const };
      keys.delete(input.principal);
      return { status: "denied" as const };
    },
  };
  const loader: ReplicationPluginLoader = {
    registerPlugin: async () => { log.push("register"); },
    createStorage: async () => { log.push("storage"); return { kind: "indexeddb", lifecycle } as never; },
  };
  return { log, keys, seen, behaviour, loader };
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

// --- lifecycle --------------------------------------------------------------

beforeEach(() => {
  resetReplicationStatus();
  factory = new IDBFactory();
  locksSeen = [];
  define("indexedDB", factory);
  define("navigator", { userAgent: CHROME.userAgent, locks: { request: async (name: string, callback: () => unknown) => { locksSeen.push(name); return callback(); } } });
});

afterEach(() => {
  for (const [name, descriptor] of [["indexedDB", originals.indexedDB], ["navigator", originals.navigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
  resetReplicationStatus();
});

// --- tests ------------------------------------------------------------------

describe("origin-wide purge on OFF", () => {
  test("ON->OFF: denies the recorded principal BEFORE the delete, then erases the whole replica database and clears both markers", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a-row", "b-row"]);
    const gate = fakeGate([A]);
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A, [SDK_LOGOUT_MARKER_KEY]: "1700000000000" });

    expect(await purgeReplicaCopyWhenOff({ loader: gate.loader, store, isEnabled: OFF })).toEqual({ status: "purged" });

    expect(gate.log).toEqual(["storage", `deny:${A}`]);
    expect(gate.seen.databasesAtDeny[0]).toContain(REPLICA_DATABASE_NAME); // shred ran while the store still existed
    expect(await names()).not.toContain(REPLICA_DATABASE_NAME);
    expect(store.map.has(REPLICATION_COPY_KEY)).toBe(false);
    expect(store.map.has(SDK_LOGOUT_MARKER_KEY)).toBe(false);
    expect(getReplicationStatus().offPurgeCode).toBeNull();
    expect(locksSeen).toEqual([REPLICA_GATE_LOCK]);
  });

  test("two accounts: the whole origin copy is erased, so neither account keeps a replica", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a-row", "b-row", "c-row"]);
    const gate = fakeGate([A, B, C]);
    await purgeReplicaCopyWhenOff({ loader: gate.loader, store: memoryStore({ [REPLICATION_COPY_KEY]: A }), isEnabled: OFF });
    expect(gate.log.filter((entry) => entry.startsWith("deny:"))).toEqual([`deny:${A}`]);
    expect(await names()).not.toContain(REPLICA_DATABASE_NAME);
    expect([...gate.keys].sort()).toEqual([B, C].sort()); // only the recorded principal is denied
  });

  test("other stores and the deny tombstone are untouched", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["x"]);
    await seedClosed("tinycloud-audio", ["clip"]);
    await seedClosed("tinycloud-voice-notes", ["note"]);
    await seedClosed("tinycloud-session", ["token"]);
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A, [TOMBSTONE_KEY]: "{\"epoch\":2,\"deniedAt\":5}" });

    await purgeReplicaCopyWhenOff({ loader: fakeGate([A]).loader, store, isEnabled: OFF });

    expect(await names()).toEqual(["tinycloud-audio", "tinycloud-session", "tinycloud-voice-notes"]);
    expect(store.map.get(TOMBSTONE_KEY)).toBe("{\"epoch\":2,\"deniedAt\":5}");
  });

  test("OFF with no copy: loads no replica chunk and opens no IndexedDB", async () => {
    await seedClosed("tinycloud-audio", ["clip"]);
    const gate = fakeGate([]);
    const opened: string[] = [];
    const open = factory.open.bind(factory);
    const remove = factory.deleteDatabase.bind(factory);
    factory.open = ((name: string, version?: number) => { opened.push(name); return open(name, version); }) as typeof factory.open;
    factory.deleteDatabase = ((name: string) => { opened.push(`delete:${name}`); return remove(name); }) as typeof factory.deleteDatabase;

    expect(await purgeReplicaCopyWhenOff({ loader: gate.loader, store: memoryStore(), isEnabled: OFF })).toEqual({ status: "skipped", reason: "no-copy" });
    expect(await purgeReplicaCopyWhenOff({ loader: gate.loader, store: undefined, isEnabled: OFF })).toEqual({ status: "skipped", reason: "no-copy" });
    expect(gate.log).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("replication ON: nothing is purged, nothing loads, the copy stays", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
    const gate = fakeGate([A]);
    const outcome = await purgeReplicaCopyWhenOff({ loader: gate.loader, store: memoryStore({ [REPLICATION_COPY_KEY]: A }), isEnabled: () => true });
    expect(outcome).toEqual({ status: "skipped", reason: "replication-on" });
    expect(gate.log).toEqual([]);
    expect(await names()).toContain(REPLICA_DATABASE_NAME);
  });

  test("blocked delete (another tab holds the database open): reported, marker kept, next load erases it", async () => {
    const holder = await seed(REPLICA_DATABASE_NAME, ["a"]); // stays open: blocks deleteDatabase
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    expect(await purgeReplicaCopyWhenOff({ loader: fakeGate([A]).loader, store, isEnabled: OFF })).toEqual({ status: "failed", code: "DELETE_BLOCKED" });
    expect(store.map.get(REPLICATION_COPY_KEY)).toBe(A);
    expect(getReplicationStatus().offPurgeCode).toBe("DELETE_BLOCKED");
    expect(formatReplicationStatus(getReplicationStatus())).toBe("Local copy: removal failed (DELETE_BLOCKED) · will retry on next load");

    holder.close(); // the other tab is gone
    expect(await purgeReplicaCopyWhenOff({ loader: fakeGate([A]).loader, store, isEnabled: OFF })).toEqual({ status: "purged" });
    expect(await names()).not.toContain(REPLICA_DATABASE_NAME);
    expect(store.map.has(REPLICATION_COPY_KEY)).toBe(false);
    expect(getReplicationStatus().offPurgeCode).toBeNull();
  });

  test("delete failing AND marker write failing: both are reported as codes, nothing is lost silently", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    store.setItem = () => { throw new Error("quota"); };
    const outcome = await purgeReplicaCopyWhenOff({
      loader: fakeGate([A]).loader,
      store,
      isEnabled: OFF,
      deleteDatabase: async () => ({ ok: false, code: "STORAGE_ERROR" }),
    });
    expect(outcome).toEqual({ status: "failed", code: "STORAGE_ERROR+MARKER_WRITE_FAILED" });
    expect(getReplicationStatus().offPurgeCode).toBe("STORAGE_ERROR+MARKER_WRITE_FAILED");
  });

  test("deny reports unguarded: no delete, marker kept, the copy is still there", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
    const gate = fakeGate([A]);
    gate.behaviour.denyUnguarded = true;
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    expect(await purgeReplicaCopyWhenOff({ loader: gate.loader, store, isEnabled: OFF })).toEqual({ status: "failed", code: "STORAGE_ERROR" });
    expect(await names()).toContain(REPLICA_DATABASE_NAME);
    expect(store.map.get(REPLICATION_COPY_KEY)).toBe(A);
  });

  test("marker \"1\" (principal unknown): no SDK load, the origin copy is still erased", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
    const gate = fakeGate([]);
    expect(await purgeReplicaCopyWhenOff({ loader: gate.loader, store: memoryStore({ [REPLICATION_COPY_KEY]: "1" }), isEnabled: OFF })).toEqual({ status: "purged" });
    expect(gate.log).toEqual([]);
    expect(await names()).not.toContain(REPLICA_DATABASE_NAME);
  });

  test("a pending SDK logout marker alone triggers the erase and is cleared", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
    const store = memoryStore({ [SDK_LOGOUT_MARKER_KEY]: "1700000000000" });
    expect(await purgeReplicaCopyWhenOff({ loader: fakeGate([]).loader, store, isEnabled: OFF })).toEqual({ status: "purged" });
    expect(store.map.has(SDK_LOGOUT_MARKER_KEY)).toBe(false);
    expect(await names()).not.toContain(REPLICA_DATABASE_NAME);
  });

  test("no wipe loop: after a successful purge the next load does nothing", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    expect(await purgeReplicaCopyWhenOff({ loader: fakeGate([A]).loader, store, isEnabled: OFF })).toEqual({ status: "purged" });
    const next = fakeGate([]);
    expect(await purgeReplicaCopyWhenOff({ loader: next.loader, store, isEnabled: OFF })).toEqual({ status: "skipped", reason: "no-copy" });
    expect(next.log).toEqual([]);
  });

  test("a loader that throws is a reported failure with the marker kept, not an unhandled rejection", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
    const loader: ReplicationPluginLoader = { registerPlugin: async () => undefined, createStorage: async () => { throw new Error("chunk failed"); } };
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    expect(await purgeReplicaCopyWhenOff({ loader, store, isEnabled: OFF })).toEqual({ status: "failed", code: "OFF_PURGE_ERROR" });
    expect(store.map.get(REPLICATION_COPY_KEY)).toBe(A);
    expect(await names()).toContain(REPLICA_DATABASE_NAME);
  });

  test("the delete runs under the origin gate lock", async () => {
    await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
    expect(await deleteReplicaDatabase()).toEqual({ ok: true });
    expect(locksSeen).toEqual([REPLICA_GATE_LOCK]);
    expect(await names()).not.toContain(REPLICA_DATABASE_NAME);
  });

  test("flag ON creates the marker; the next OFF load erases the origin copy", async () => {
    const store = memoryStore({ [REPLICATION_RUNTIME_FLAG_KEY]: "true", [replicationOptInKey(A)]: "true" });
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const savedWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    try {
      define("window", { localStorage: store });
      define("navigator", { userAgent: CHROME.userAgent, userAgentData: { brands: [{ brand: "Chromium" }] }, maxTouchPoints: 0, locks: { request: async (_name: string, callback: () => unknown) => callback() } });
      define("Worker", class {});
      const gate = fakeGate([A]);
      await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
      expect(await buildReplicationConfig(A, gate.loader)).toBeDefined();
      expect(store.map.get(REPLICATION_COPY_KEY)).toBe("1");
      rememberReplicationPrincipal({ replication: {}, did: A } as unknown as TinyCloudWeb, store);
      expect(store.map.get(REPLICATION_COPY_KEY)).toBe(A);
      expect(writeReplicationOptIn(A, false, store)).toBe(true); // the user turns their switch OFF
      // Same gates as the app: the build flag (runtime flag here) is still ON; only the user's choice changed.
      expect(await purgeReplicaCopyWhenOff({ loader: gate.loader, store, principal: A })).toEqual({ status: "purged" });
      expect(await names()).not.toContain(REPLICA_DATABASE_NAME);
    } finally {
      for (const [name, descriptor] of [["window", savedWindow], ["Worker", savedWorker]] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test("an OFF client never records a principal", () => {
    const store = memoryStore();
    rememberReplicationPrincipal({ did: A } as unknown as TinyCloudWeb, store);
    expect(store.map.size).toBe(0);
  });

  describe("what counts as OFF", () => {
    const requested = { buildFlag: "true", runtimeFlag: true, userOptIn: true } as const;
    const cases: Array<[string, () => boolean]> = [
      ["kill switch engaged", () => isReplicationEnabled({ ...requested, killSwitchOpen: false, env: CHROME })],
      ["flag \"false\"", () => isReplicationEnabled({ killSwitchOpen: true, buildFlag: "false", runtimeFlag: false, userOptIn: true, env: CHROME })],
      ["user switch OFF (build flag ON, platform qualified)", () => isReplicationEnabled({ ...requested, userOptIn: false, killSwitchOpen: true, env: CHROME })],
      ["Tauri shell refused", () => isReplicationEnabled({ ...requested, killSwitchOpen: true, env: { ...CHROME, platform: "tauri" } })],
      ["Capacitor (android) shell refused", () => isReplicationEnabled({ ...requested, killSwitchOpen: true, env: { ...CHROME, platform: "android" } })],
      ["iOS refused", () => isReplicationEnabled({ ...requested, killSwitchOpen: true, env: { ...CHROME, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" } })],
    ];
    for (const [name, isEnabled] of cases) {
      test(`${name}: erases like flag OFF`, async () => {
        await seedClosed(REPLICA_DATABASE_NAME, ["a"]);
        const gate = fakeGate([A]);
        expect(await purgeReplicaCopyWhenOff({ loader: gate.loader, store: memoryStore({ [REPLICATION_COPY_KEY]: A }), isEnabled })).toEqual({ status: "purged" });
        expect(await names()).not.toContain(REPLICA_DATABASE_NAME);
      });
    }
  });
});
