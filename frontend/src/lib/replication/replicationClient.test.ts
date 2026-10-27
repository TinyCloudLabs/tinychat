import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import manifest from "../../../../manifest.json";
import { composeManifestRequest } from "@tinycloud/sdk-core";
import { augmentSignInEntriesWithReplication } from "@tinycloud/node-sdk/replication/authority";
import { buildReplicationConfig, replicationConfigPatch, REPLICATION_MAX_BYTES, REPLICATION_SYNC_SCOPE, type ReplicationPluginLoader } from "./replicationClient";
import { REPLICATION_RUNTIME_FLAG_KEY } from "./replicationFlag";
import { replicationOptInKey } from "./replicationOptIn";
import { trackStartupPurge } from "./replicationStartupPurge";
import { replicationPrefixes } from "./replicationPrefixes";
import { voiceNoteAudioKvKey, voiceNoteMarkdownKvKey } from "../voiceNotes/voiceNoteStore";
import { transcriptRevKvKey } from "../voiceNotes/voiceNoteRows";
import { transcriptKvKey } from "@tinyboilerplate/core";

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ALICE = "did:pkh:eip155:1:0xaaaa";
const BOB = "did:pkh:eip155:1:0xbbbb";

/** `flag`: the dev runtime flag (stands in for the build flag). `optIn`: principals with a stored "true". `optOut`: principals with an explicit opt-out ("false"). */
function installBrowser(opts: { flag: boolean; tauri?: boolean; optIn?: string[]; optOut?: string[] }): Map<string, string> {
  const store = new Map<string, string>();
  if (opts.flag) store.set(REPLICATION_RUNTIME_FLAG_KEY, "true");
  for (const principal of opts.optIn ?? []) store.set(replicationOptInKey(principal), "true");
  for (const principal of opts.optOut ?? []) store.set(replicationOptInKey(principal), "false");
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    ...(opts.tauri ? { __TAURI_INTERNALS__: {} } : {}),
  });
  define("navigator", { userAgent: CHROME, userAgentData: { brands: [{ brand: "Chromium" }] }, maxTouchPoints: 0, locks: { request: () => undefined } });
  define("indexedDB", {});
  define("Worker", class {});
  return store;
}

function spyLoader(): ReplicationPluginLoader & { calls: string[]; storage: object } {
  const calls: string[] = [];
  const storage = { sentinel: "encrypted-kv-storage" };
  return {
    calls, storage,
    registerPlugin: async () => { calls.push("register"); },
    createStorage: async () => { calls.push("storage"); return storage as never; },
  };
}

describe("replicationClient", () => {
  const GLOBAL_NAMES = ["window", "navigator", "indexedDB", "Worker"] as const;
  // Other suites in the same bun process rely on their own window/navigator: snapshot what is there right
  // before each test (not at import time, when another suite may not have installed its globals yet) and
  // put it back right after.
  let saved = new Map<string, PropertyDescriptor | undefined>();
  let savedBuildFlag: string | undefined;
  beforeEach(() => {
    saved = new Map(GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    savedBuildFlag = import.meta.env.VITE_EXO_REPLICATION;
    import.meta.env.VITE_EXO_REPLICATION = "false"; // the build flag is ON unless "false"; the dev runtime flag stands in for it
    installBrowser({ flag: false });
  });
  afterEach(() => {
    import.meta.env.VITE_EXO_REPLICATION = savedBuildFlag;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  describe("flag OFF changes nothing", () => {
    test("no plugin or storage is loaded and the client config gets no replication key", async () => {
      const loader = spyLoader();
      expect(await buildReplicationConfig(ALICE, loader)).toBeUndefined();
      const patch = await replicationConfigPatch(ALICE, loader);
      expect(Object.keys(patch)).toEqual([]);
      expect({ address: "0x1", manifest: 1, ...patch }).toEqual({ address: "0x1", manifest: 1 });
      expect(loader.calls).toEqual([]);
    });

    test("a flag set in Tauri is refused: still nothing loaded, even with the user's switch ON", async () => {
      installBrowser({ flag: true, tauri: true, optIn: [ALICE] });
      const loader = spyLoader();
      expect(await replicationConfigPatch(ALICE, loader)).toEqual({});
      expect(loader.calls).toEqual([]);
    });
  });

  describe("the user's switch is OFF: the build flag alone builds nothing", () => {
    test("an explicit opt-out wins: no config key, no marker, nothing imported", async () => {
      const store = installBrowser({ flag: true, optOut: [ALICE] });
      const loader = spyLoader();
      expect(await replicationConfigPatch(ALICE, loader)).toEqual({});
      expect(await replicationConfigPatch(undefined, loader)).toEqual({});
      expect(loader.calls).toEqual([]);
      expect([...store.keys()]).toEqual([REPLICATION_RUNTIME_FLAG_KEY, replicationOptInKey(ALICE)]);
    });

    test("two accounts in one browser: only the one that did not opt out gets a replica", async () => {
      installBrowser({ flag: true, optOut: [BOB] });
      const loader = spyLoader();
      expect(await replicationConfigPatch(BOB, loader)).toEqual({});
      expect(loader.calls).toEqual([]);
      expect((await replicationConfigPatch(ALICE, loader)).replication?.enabled).toBe(true);
      expect(loader.calls).toEqual(["register", "storage"]);
    });
  });

  describe("flag ON", () => {
    test("registers the plugin once and passes enabled, per-folder prefixes, the budget and encrypted storage", async () => {
      installBrowser({ flag: true, optIn: [ALICE] });
      const loader = spyLoader();
      const config = await buildReplicationConfig(ALICE, loader);
      expect(loader.calls).toEqual(["register", "storage"]);
      expect(config?.enabled).toBe(true);
      expect(config?.prefixes).toEqual(replicationPrefixes());
      expect(config?.maxBytes).toBe(REPLICATION_MAX_BYTES);
      expect(REPLICATION_MAX_BYTES).toBe(100 * 1024 * 1024);
      expect(config?.storage).toBe(loader.storage as never);
    });

    test("production's replication config carries the sync scope constant (prefixes)", async () => {
      installBrowser({ flag: true, optIn: [ALICE] });
      const config = await buildReplicationConfig(ALICE, spyLoader());
      expect(config?.syncScope).toBe(REPLICATION_SYNC_SCOPE);
      expect(REPLICATION_SYNC_SCOPE).toBe("prefixes");
    });

    test("syncs in the background every 5 minutes and serves a local read up to 15 minutes old, with the same prefixes and budget", async () => {
      installBrowser({ flag: true, optIn: [ALICE] });
      const config = await buildReplicationConfig(ALICE, spyLoader());
      expect(config?.syncIntervalMs).toBe(300_000);
      expect(config?.maxStalenessMs).toBe(900_000);
      expect(config?.prefixes).toEqual(replicationPrefixes());
      expect(config?.maxBytes).toBe(100 * 1024 * 1024);
    });

    test("the local copy syncs names only: content is fetched on demand, not in bulk", async () => {
      installBrowser({ flag: true, optIn: [ALICE] });
      const config = await buildReplicationConfig(ALICE, spyLoader());
      expect(config?.contentFetch).toBe("lazy");
    });

    test("waits for a page-load purge that is still deleting the copy before it builds anything", async () => {
      installBrowser({ flag: true, optIn: [ALICE] });
      const loader = spyLoader();
      const purge = Promise.withResolvers<void>();
      void trackStartupPurge(purge.promise);
      const building = buildReplicationConfig(ALICE, loader);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); // let anything that is not blocked run
      expect(loader.calls).toEqual([]);
      purge.resolve();
      expect((await building)?.enabled).toBe(true);
      expect(loader.calls).toEqual(["register", "storage"]);
    });
  });

  describe("prefixes", () => {
    const prefixes = replicationPrefixes();
    const covered = (key: string): boolean => prefixes.some((prefix) => key.startsWith(prefix));

    test("each entry is its own slash-terminated folder under the app's connectors space", () => {
      expect(new Set(prefixes).size).toBe(prefixes.length);
      for (const prefix of prefixes) expect(prefix).toMatch(/^xyz\.tinycloud\.tinychat\/connectors\/[a-z-]+\/transcript(-rev)?\/$/);
    });

    test("covers transcript bodies and immutable revisions, never audio, note.md, history, state or vault", () => {
      for (const source of ["fireflies", "google-meet", "tinycloud-transcriber", "exo-local", "exo-voice-note", "exo-upload"]) {
        expect(covered(transcriptKvKey(source, "abc"))).toBe(true);
      }
      expect(covered(transcriptRevKvKey("exo-voice-note", "abc", "h".repeat(8)))).toBe(true);
      expect(covered(voiceNoteAudioKvKey("abc"))).toBe(false);
      expect(covered(`${voiceNoteAudioKvKey("abc")}/part/0`)).toBe(false);
      expect(covered(voiceNoteMarkdownKvKey("abc"))).toBe(false);
      expect(covered("xyz.tinycloud.tinychat/connectors/exo-voice-note/transcript-history/abc/1/h")).toBe(false);
      expect(covered("xyz.tinycloud.tinychat/connectors/fireflies/sync-attempt")).toBe(false);
      expect(covered("xyz.tinycloud.tinychat/connectors/pending-reconcile-snapshot/transcriber")).toBe(false);
      expect(covered("xyz.tinycloud.tinychat/threads/t1")).toBe(false);
      expect(covered("vault/secrets/FIREFLIES_API_KEY")).toBe(false);
    });
  });

  describe("grant: the SDK adds get+sync only on these prefixes, from the unchanged manifest", () => {
    const SPACE = "tinycloud:pkh:eip155:1:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01:applications";
    const request = composeManifestRequest([manifest as never]);
    const entries = request.resources.filter((r) => r.space === "applications").map((r) => ({ ...r, space: SPACE }));

    test("one {kv/get, kv/sync} entry per prefix, nothing else", () => {
      const extra = augmentSignInEntriesWithReplication({
        entries, primarySpaceId: SPACE, replication: { enabled: true, prefixes: replicationPrefixes(), syncScope: REPLICATION_SYNC_SCOPE },
      });
      expect(extra.map((e) => e.path)).toEqual(replicationPrefixes());
      for (const entry of extra) expect([...entry.actions]).toEqual(["tinycloud.kv/get", "tinycloud.kv/sync"]);
    });

    test("with no replication option nothing is added (flag OFF keeps today's grant)", () => {
      expect(augmentSignInEntriesWithReplication({ entries, primarySpaceId: SPACE, replication: undefined })).toEqual([]);
    });

    test("the app manifest itself carries no sync action", () => {
      const actions = manifest.permissions.flatMap((permission) => permission.actions);
      expect(actions.some((action) => action === "sync")).toBe(false);
    });
  });
});
