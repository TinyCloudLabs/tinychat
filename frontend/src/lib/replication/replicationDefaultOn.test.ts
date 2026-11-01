import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { buildReplicationConfig, startReplicationFill, type ReplicationPluginLoader } from "./replicationClient";
import { REPLICATION_COPY_KEY } from "./replicationCopyMarker";
import { isReplicationEnabled, REPLICATION_RUNTIME_FLAG_KEY, type ReplicationEnv } from "./replicationFlag";
import { purgeReplicaCopyWhenOff } from "./replicationOffPurge";
import { readReplicationOptIn, replicationOptInKey, writeReplicationOptIn } from "./replicationOptIn";

const ALICE = "did:pkh:eip155:1:0xaaaa";
const BOB = "did:pkh:eip155:1:0xbbbb";
const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CHROME: ReplicationEnv = {
  platform: "web", userAgent: CHROME_UA, brands: ["Chromium"], maxTouchPoints: 0,
  hasIndexedDb: true, hasWorker: true, hasLocks: true, hasSubtleCrypto: true,
};
const BUILD_ON = { killSwitchOpen: true, buildFlag: "true", runtimeFlag: false, env: CHROME } as const;

function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

const GLOBAL_NAMES = ["window", "navigator", "indexedDB", "Worker"] as const;
let saved = new Map<string, PropertyDescriptor | undefined>();
function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
/** A Chromium browser whose localStorage is `store`; the dev runtime flag stands in for the build flag. */
function installBrowser(store: ReturnType<typeof memoryStore>) {
  define("window", { localStorage: store });
  define("navigator", { userAgent: CHROME_UA, userAgentData: { brands: [{ brand: "Chromium" }] }, maxTouchPoints: 0, locks: { request: () => undefined } });
  define("indexedDB", {});
  define("Worker", class {});
}
beforeEach(() => { saved = new Map(GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])); });
afterEach(() => {
  jest.useRealTimers();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

function spyLoader(): ReplicationPluginLoader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    registerPlugin: async () => { calls.push("register"); },
    createStorage: async () => { calls.push("storage"); return {} as never; },
  };
}

describe("local copy is ON by default (build flag is the master, an explicit opt-out wins)", () => {
  test("the stored value decides: missing/true/garbage = ON, only an explicit false = OFF", () => {
    const key = replicationOptInKey(ALICE);
    expect(readReplicationOptIn(ALICE, memoryStore())).toBe(true);
    expect(readReplicationOptIn(ALICE, memoryStore({ [key]: "true" }))).toBe(true);
    expect(readReplicationOptIn(ALICE, memoryStore({ [key]: "garbage" }))).toBe(true);
    expect(readReplicationOptIn(ALICE, memoryStore({ [key]: "" }))).toBe(true);
    expect(readReplicationOptIn(ALICE, memoryStore({ [key]: "false" }))).toBe(false);
  });

  test("an unreadable store, a missing store and no principal are OFF", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => undefined, removeItem: () => undefined };
    expect(readReplicationOptIn(ALICE, broken)).toBe(false);
    expect(readReplicationOptIn(ALICE, undefined)).toBe(false);
    expect(readReplicationOptIn(undefined, memoryStore())).toBe(false);
    expect(readReplicationOptIn("", memoryStore())).toBe(false);
  });

  test("turning OFF writes \"false\" and turning ON writes \"true\"; a failed save reports false", () => {
    const store = memoryStore();
    expect(writeReplicationOptIn(ALICE, false, store)).toBe(true);
    expect(store.map.get(replicationOptInKey(ALICE))).toBe("false");
    expect(writeReplicationOptIn(ALICE, true, store)).toBe(true);
    expect(store.map.get(replicationOptInKey(ALICE))).toBe("true");
    store.setItem = () => { throw new Error("quota"); };
    expect(writeReplicationOptIn(ALICE, false, store)).toBe(false);
  });

  test("build flag set, nothing stored: replication is ON for a principal, OFF for none", () => {
    installBrowser(memoryStore());
    expect(isReplicationEnabled({ ...BUILD_ON, principal: ALICE })).toBe(true);
    expect(isReplicationEnabled({ ...BUILD_ON })).toBe(false);
  });

  test("build flag unset (or empty, or anything but \"false\"): ON on a qualified platform when not opted out", () => {
    installBrowser(memoryStore({ [replicationOptInKey(BOB)]: "false" }));
    for (const buildFlag of [undefined, "", "true", "1"]) {
      expect(isReplicationEnabled({ ...BUILD_ON, buildFlag, principal: ALICE })).toBe(true);
      expect(isReplicationEnabled({ ...BUILD_ON, buildFlag, principal: BOB })).toBe(false); // the opt-out still wins
    }
  });

  test("build flag \"false\" or kill switch engaged: OFF for everyone, whatever is stored", () => {
    installBrowser(memoryStore({ [replicationOptInKey(ALICE)]: "true" }));
    expect(isReplicationEnabled({ ...BUILD_ON, buildFlag: "false", principal: ALICE })).toBe(false);
    expect(isReplicationEnabled({ ...BUILD_ON, buildFlag: "false", principal: BOB })).toBe(false);
    expect(isReplicationEnabled({ ...BUILD_ON, killSwitchOpen: false, principal: ALICE })).toBe(false);
    expect(isReplicationEnabled({ ...BUILD_ON, killSwitchOpen: false, principal: BOB })).toBe(false);
    expect(isReplicationEnabled({ ...BUILD_ON, killSwitchOpen: false, buildFlag: undefined, principal: ALICE })).toBe(false);
  });

  test("the real build env decides when no flag is injected: unset = ON, \"false\" = OFF", () => {
    installBrowser(memoryStore());
    const saved = import.meta.env.VITE_EXO_REPLICATION;
    try {
      import.meta.env.VITE_EXO_REPLICATION = undefined;
      expect(isReplicationEnabled({ killSwitchOpen: true, runtimeFlag: false, env: CHROME, principal: ALICE })).toBe(true);
      import.meta.env.VITE_EXO_REPLICATION = "false";
      expect(isReplicationEnabled({ killSwitchOpen: true, runtimeFlag: false, env: CHROME, principal: ALICE })).toBe(false);
    } finally {
      import.meta.env.VITE_EXO_REPLICATION = saved;
    }
  });

  test("a refused platform stays OFF by default", () => {
    installBrowser(memoryStore());
    for (const env of [{ ...CHROME, platform: "tauri" as const }, { ...CHROME, platform: "ios" as const }, { ...CHROME, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" }, { ...CHROME, brands: [], userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0" }]) {
      expect(isReplicationEnabled({ ...BUILD_ON, env, principal: ALICE })).toBe(false);
    }
  });

  test("two principals in one browser are independent", () => {
    installBrowser(memoryStore({ [replicationOptInKey(BOB)]: "false" }));
    expect(isReplicationEnabled({ ...BUILD_ON, principal: ALICE })).toBe(true);
    expect(isReplicationEnabled({ ...BUILD_ON, principal: BOB })).toBe(false);
  });

  test("a default-on user gets a replica config; an opted-out user gets none and nothing is loaded", async () => {
    installBrowser(memoryStore({ [REPLICATION_RUNTIME_FLAG_KEY]: "true", [replicationOptInKey(BOB)]: "false" }));
    const loader = spyLoader();
    expect((await buildReplicationConfig(BOB, loader))).toBeUndefined();
    expect(loader.calls).toEqual([]);
    expect((await buildReplicationConfig(ALICE, loader))?.enabled).toBe(true);
    expect(loader.calls).toEqual(["register", "storage"]);
  });

  test("explicit opt-out WINS with the build flag set: no replica, and the load purge erases the copy", async () => {
    const store = memoryStore({ [REPLICATION_RUNTIME_FLAG_KEY]: "true", [replicationOptInKey(ALICE)]: "false", [REPLICATION_COPY_KEY]: "1" });
    installBrowser(store);
    expect(isReplicationEnabled({ ...BUILD_ON, principal: ALICE })).toBe(false);
    expect(await buildReplicationConfig(ALICE, spyLoader())).toBeUndefined();
    let deleted = 0;
    const outcome = await purgeReplicaCopyWhenOff({ store, principal: ALICE, deleteDatabase: async () => { deleted += 1; return { ok: true }; } });
    expect(outcome).toEqual({ status: "purged" });
    expect(deleted).toBe(1);
    expect(store.map.has(REPLICATION_COPY_KEY)).toBe(false);
    expect(store.map.get(replicationOptInKey(ALICE))).toBe("false"); // the opt-out is kept
  });

  test("a default-on user is NOT purged on load (no wipe pending)", async () => {
    const store = memoryStore({ [REPLICATION_RUNTIME_FLAG_KEY]: "true", [REPLICATION_COPY_KEY]: ALICE });
    installBrowser(store);
    expect(await purgeReplicaCopyWhenOff({ store, principal: ALICE, deleteDatabase: async () => { throw new Error("must not delete"); } }))
      .toEqual({ status: "skipped", reason: "replication-on" });
  });

  test("the fill starts for a default-on user after the first data load, and never for an opted-out one", async () => {
    jest.useFakeTimers();
    const started: string[] = [];
    const make = (did: string) => {
      const tcw = { did } as unknown as TinyCloudWeb;
      Object.defineProperty(tcw, "replication", { get: () => ({ sync: async ({ prefix }: { prefix: string }) => { started.push(`${did}:${prefix}`); } }) });
      return tcw;
    };
    installBrowser(memoryStore({ [REPLICATION_RUNTIME_FLAG_KEY]: "true", [replicationOptInKey(BOB)]: "false" }));
    const firstLoad = Promise.withResolvers<void>();
    const deps = { firstLoadSettled: () => firstLoad.promise, prefixes: ["a/"] };
    startReplicationFill(make(ALICE), undefined, deps);
    startReplicationFill(make(BOB), undefined, deps);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(started).toEqual([]); // waits for the first load
    firstLoad.resolve();
    for (let step = 0; step < 10; step += 1) {
      jest.advanceTimersByTime(250);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    }
    expect(started).toEqual([`${ALICE}:a/`]);
  });
});
