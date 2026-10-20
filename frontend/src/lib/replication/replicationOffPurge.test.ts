import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { buildReplicationConfig, type ReplicationPluginLoader } from "./replicationClient";
import { REPLICATION_COPY_KEY, rememberReplicationPrincipal, SDK_LOGOUT_MARKER_KEY } from "./replicationCopyMarker";
import { isReplicationEnabled, REPLICATION_RUNTIME_FLAG_KEY, type ReplicationEnv } from "./replicationFlag";
import { purgeReplicaCopyWhenOff } from "./replicationOffPurge";
import { formatReplicationStatus } from "./ReplicationStatusLine";
import { getReplicationStatus, resetReplicationStatus } from "./replicationStatus";

const A = "did:pkh:eip155:1:0xaaaa";
const B = "did:pkh:eip155:1:0xbbbb";
const C = "did:pkh:eip155:1:0xcccc";

const CHROME: ReplicationEnv = {
  platform: "web",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  brands: ["Chromium"], maxTouchPoints: 0, hasIndexedDb: true, hasWorker: true, hasLocks: true, hasSubtleCrypto: true,
};

/** Models the browser replica origin: per-account keys + rows, and the deny -> recover split. */
function fakeReplica(accounts: Record<string, { rows: number }>) {
  const log: string[] = [];
  const keys = new Set(Object.keys(accounts));
  const rows = new Map(Object.entries(accounts).map(([principal, value]) => [principal, value.rows]));
  const intents = new Set<string>();
  const behaviour = { denyFails: false, recoverFails: false, erasedWithoutShred: 0 };
  const lifecycle = {
    kind: "indexeddb" as const,
    async deny(input: { principal: string }) {
      log.push(`deny:${input.principal}`);
      if (behaviour.denyFails) return { status: "unguarded" as const, code: "STORAGE_ERROR" };
      if (!keys.has(input.principal)) return { status: "stale" as const };
      keys.delete(input.principal);
      intents.add(input.principal);
      return { status: "denied" as const };
    },
    async recover() {
      log.push("recover");
      if (behaviour.recoverFails) return { erased: [], failed: [{ id: "database", code: "DELETE_BLOCKED" }], remaining: 1 };
      for (const principal of [...intents]) {
        if (keys.has(principal)) behaviour.erasedWithoutShred++;
        rows.delete(principal);
        intents.delete(principal);
      }
      return { erased: [], failed: [], remaining: 0 };
    },
  };
  const loader: ReplicationPluginLoader = {
    registerPlugin: async () => { log.push("register"); },
    createStorage: async () => { log.push("storage"); return { kind: "indexeddb", lifecycle } as never; },
  };
  return { log, keys, rows, intents, behaviour, loader };
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

const OFF = () => false;

beforeEach(resetReplicationStatus);

describe("purge on OFF", () => {
  test("shreds the key BEFORE any store is deleted, then empties the stores and clears the marker", async () => {
    const replica = fakeReplica({ [A]: { rows: 7 } });
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store, isEnabled: OFF })).toEqual({ status: "purged" });
    expect(replica.log).toEqual(["storage", `deny:${A}`, "recover"]);
    expect(replica.keys.has(A)).toBe(false);
    expect(replica.rows.has(A)).toBe(false);
    expect(replica.behaviour.erasedWithoutShred).toBe(0);
    expect(store.map.has(REPLICATION_COPY_KEY)).toBe(false);
    expect(getReplicationStatus().offPurgeCode).toBeNull();
  });

  test("flag ON creates the marker; the next OFF load purges that copy", async () => {
    const store = memoryStore({ [REPLICATION_RUNTIME_FLAG_KEY]: "true" });
    const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
    const savedNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const savedIdb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const savedWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    try {
      define("window", { localStorage: store });
      define("navigator", { userAgent: CHROME.userAgent, userAgentData: { brands: [{ brand: "Chromium" }] }, maxTouchPoints: 0, locks: { request: () => undefined } });
      define("indexedDB", {});
      define("Worker", class {});
      const replica = fakeReplica({ [A]: { rows: 3 } });
      expect(await buildReplicationConfig(replica.loader)).toBeDefined();
      expect(store.map.get(REPLICATION_COPY_KEY)).toBe("1");
      // After sign-in the principal is remembered (only for a client that really has replication).
      rememberReplicationPrincipal({ replication: {}, did: A } as unknown as TinyCloudWeb, store);
      expect(store.map.get(REPLICATION_COPY_KEY)).toBe(A);
      store.map.delete(REPLICATION_RUNTIME_FLAG_KEY); // user turns it OFF
      expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store, isEnabled: () => isReplicationEnabled({ env: CHROME, killSwitchOpen: true, buildFlag: undefined, runtimeFlag: false }) })).toEqual({ status: "purged" });
      expect(replica.rows.size).toBe(0);
    } finally {
      for (const [name, descriptor] of [["window", saved], ["navigator", savedNav], ["indexedDB", savedIdb], ["Worker", savedWorker]] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test("an OFF client never records a principal", () => {
    const store = memoryStore();
    rememberReplicationPrincipal({ did: A } as unknown as TinyCloudWeb, store);
    expect(store.map.size).toBe(0);
  });

  test("two-account device: only the recorded account (and already-denied leftovers) go; another live partition is untouched", async () => {
    const replica = fakeReplica({ [A]: { rows: 4 }, [B]: { rows: 2 }, [C]: { rows: 9 } });
    // B was denied earlier by an ON account switch: keys already gone, erase still queued.
    replica.keys.delete(B);
    replica.intents.add(B);
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    await purgeReplicaCopyWhenOff({ loader: replica.loader, store, isEnabled: OFF });
    expect(replica.log.filter((entry) => entry.startsWith("deny:"))).toEqual([`deny:${A}`]);
    expect(replica.rows.has(A)).toBe(false);
    expect(replica.rows.has(B)).toBe(false);
    expect(replica.rows.get(C)).toBe(9);
    expect(replica.keys.has(C)).toBe(true);
  });

  test("a principal that does not own the gate is a no-op for it, and recovery still runs", async () => {
    const replica = fakeReplica({ [C]: { rows: 5 } });
    await purgeReplicaCopyWhenOff({ loader: replica.loader, store: memoryStore({ [REPLICATION_COPY_KEY]: A }), isEnabled: OFF });
    expect(replica.keys.has(C)).toBe(true);
    expect(replica.rows.get(C)).toBe(5);
  });

  test("an unknown principal (marker \"1\") runs recovery only: no deny is invented", async () => {
    const replica = fakeReplica({ [A]: { rows: 1 } });
    replica.keys.delete(A);
    replica.intents.add(A);
    await purgeReplicaCopyWhenOff({ loader: replica.loader, store: memoryStore({ [REPLICATION_COPY_KEY]: "1" }), isEnabled: OFF });
    expect(replica.log).toEqual(["storage", "recover"]);
    expect(replica.rows.size).toBe(0);
  });

  test("a pending SDK logout marker alone triggers recovery", async () => {
    const replica = fakeReplica({});
    const store = memoryStore({ [SDK_LOGOUT_MARKER_KEY]: "1700000000000" });
    expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store, isEnabled: OFF })).toEqual({ status: "purged" });
    expect(replica.log).toEqual(["storage", "recover"]);
  });

  test("no copy: nothing is loaded or called", async () => {
    const replica = fakeReplica({});
    expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store: memoryStore(), isEnabled: OFF })).toEqual({ status: "skipped", reason: "no-copy" });
    expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store: undefined, isEnabled: OFF })).toEqual({ status: "skipped", reason: "no-copy" });
    expect(replica.log).toEqual([]);
  });

  test("replication ON: nothing is purged", async () => {
    const replica = fakeReplica({ [A]: { rows: 1 } });
    const outcome = await purgeReplicaCopyWhenOff({ loader: replica.loader, store: memoryStore({ [REPLICATION_COPY_KEY]: A }), isEnabled: () => true });
    expect(outcome).toEqual({ status: "skipped", reason: "replication-on" });
    expect(replica.log).toEqual([]);
  });

  test("shred failure: stores are NOT deleted, failure is reported (code only), marker kept, next load retries", async () => {
    const replica = fakeReplica({ [A]: { rows: 6 } });
    replica.behaviour.denyFails = true;
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store, isEnabled: OFF })).toEqual({ status: "failed", code: "STORAGE_ERROR" });
    expect(replica.log).toEqual(["storage", `deny:${A}`]); // recover (the store delete) never ran
    expect(replica.rows.get(A)).toBe(6);
    expect(store.map.get(REPLICATION_COPY_KEY)).toBe(A);
    expect(getReplicationStatus().offPurgeCode).toBe("STORAGE_ERROR");
    expect(formatReplicationStatus(getReplicationStatus())).toBe("Local copy: removal failed (STORAGE_ERROR) · will retry on next load");

    replica.behaviour.denyFails = false; // next load
    expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store, isEnabled: OFF })).toEqual({ status: "purged" });
    expect(replica.rows.size).toBe(0);
    expect(getReplicationStatus().offPurgeCode).toBeNull();
  });

  test("erase failure after a successful shred is reported and retried, never success", async () => {
    const replica = fakeReplica({ [A]: { rows: 2 } });
    replica.behaviour.recoverFails = true;
    const store = memoryStore({ [REPLICATION_COPY_KEY]: A });
    expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store, isEnabled: OFF })).toEqual({ status: "failed", code: "DELETE_BLOCKED" });
    expect(replica.keys.has(A)).toBe(false);
    expect(store.map.get(REPLICATION_COPY_KEY)).toBe(A);
    expect(getReplicationStatus().offPurgeCode).toBe("DELETE_BLOCKED");
  });

  test("a loader that throws is a reported failure, not an unhandled rejection", async () => {
    const loader: ReplicationPluginLoader = { registerPlugin: async () => undefined, createStorage: async () => { throw new Error("chunk failed"); } };
    expect(await purgeReplicaCopyWhenOff({ loader, store: memoryStore({ [REPLICATION_COPY_KEY]: A }), isEnabled: OFF })).toEqual({ status: "failed", code: "OFF_PURGE_ERROR" });
  });

  describe("what counts as OFF", () => {
    const requested = { buildFlag: "true", runtimeFlag: true } as const;
    const cases: Array<[string, () => boolean]> = [
      ["kill switch engaged", () => isReplicationEnabled({ ...requested, killSwitchOpen: false, env: CHROME })],
      ["flag unset", () => isReplicationEnabled({ killSwitchOpen: true, buildFlag: undefined, runtimeFlag: false, env: CHROME })],
      ["Tauri shell refused", () => isReplicationEnabled({ ...requested, killSwitchOpen: true, env: { ...CHROME, platform: "tauri" } })],
      ["Capacitor (android) shell refused", () => isReplicationEnabled({ ...requested, killSwitchOpen: true, env: { ...CHROME, platform: "android" } })],
      ["iOS refused", () => isReplicationEnabled({ ...requested, killSwitchOpen: true, env: { ...CHROME, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" } })],
    ];
    for (const [name, isEnabled] of cases) {
      test(`${name}: purges like flag OFF`, async () => {
        const replica = fakeReplica({ [A]: { rows: 1 } });
        expect(await purgeReplicaCopyWhenOff({ loader: replica.loader, store: memoryStore({ [REPLICATION_COPY_KEY]: A }), isEnabled })).toEqual({ status: "purged" });
        expect(replica.log).toEqual(["storage", `deny:${A}`, "recover"]);
      });
      test(`${name}: with no copy nothing loads`, async () => {
        const replica = fakeReplica({});
        await purgeReplicaCopyWhenOff({ loader: replica.loader, store: memoryStore(), isEnabled });
        expect(replica.log).toEqual([]);
      });
    }
  });

  describe("SDK facts this module depends on", () => {
    const installed = (path: string) => readFileSync(Bun.resolveSync(path, import.meta.dir), "utf8");
    test("the pending-logout marker name matches the installed replica storage", () => {
      expect(installed("@tinycloud/replica/kv-storage")).toContain(`"${SDK_LOGOUT_MARKER_KEY}"`);
    });
  });
});

afterEach(resetReplicationStatus);
