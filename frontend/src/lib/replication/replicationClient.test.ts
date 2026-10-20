import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import manifest from "../../../../manifest.json";
import { composeManifestRequest } from "@tinycloud/sdk-core";
import { augmentSignInEntriesWithReplication } from "@tinycloud/node-sdk/replication/authority";
import { buildReplicationConfig, replicationConfigPatch, REPLICATION_MAX_BYTES, type ReplicationPluginLoader } from "./replicationClient";
import { REPLICATION_RUNTIME_FLAG_KEY } from "./replicationFlag";
import { replicationPrefixes } from "./replicationPrefixes";
import { voiceNoteAudioKvKey, voiceNoteMarkdownKvKey } from "../voiceNotes/voiceNoteStore";
import { transcriptRevKvKey } from "../voiceNotes/voiceNoteRows";
import { transcriptKvKey } from "@tinyboilerplate/core";

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function installBrowser(opts: { flag: boolean; tauri?: boolean }): void {
  const store = new Map<string, string>();
  if (opts.flag) store.set(REPLICATION_RUNTIME_FLAG_KEY, "true");
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("window", {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: () => undefined, removeItem: () => undefined },
    ...(opts.tauri ? { __TAURI_INTERNALS__: {} } : {}),
  });
  define("navigator", { userAgent: CHROME, userAgentData: { brands: [{ brand: "Chromium" }] }, maxTouchPoints: 0, locks: { request: () => undefined } });
  define("indexedDB", {});
  define("Worker", class {});
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

const GLOBAL_NAMES = ["window", "navigator", "indexedDB", "Worker"] as const;
const originals = new Map(GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
// Other suites in the same bun process rely on their own window/navigator: put them back.
afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
beforeEach(() => installBrowser({ flag: false }));

describe("flag OFF changes nothing", () => {
  test("no plugin or storage is loaded and the client config gets no replication key", async () => {
    const loader = spyLoader();
    expect(await buildReplicationConfig(loader)).toBeUndefined();
    const patch = await replicationConfigPatch(loader);
    expect(Object.keys(patch)).toEqual([]);
    expect({ address: "0x1", manifest: 1, ...patch }).toEqual({ address: "0x1", manifest: 1 });
    expect(loader.calls).toEqual([]);
  });

  test("a flag set in Tauri is refused: still nothing loaded", async () => {
    installBrowser({ flag: true, tauri: true });
    const loader = spyLoader();
    expect(await replicationConfigPatch(loader)).toEqual({});
    expect(loader.calls).toEqual([]);
  });
});

describe("flag ON", () => {
  test("registers the plugin once and passes enabled, per-folder prefixes, the budget and encrypted storage", async () => {
    installBrowser({ flag: true });
    const loader = spyLoader();
    const config = await buildReplicationConfig(loader);
    expect(loader.calls).toEqual(["register", "storage"]);
    expect(config?.enabled).toBe(true);
    expect(config?.prefixes).toEqual(replicationPrefixes());
    expect(config?.maxBytes).toBe(REPLICATION_MAX_BYTES);
    expect(REPLICATION_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(config?.storage).toBe(loader.storage as never);
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
      entries, primarySpaceId: SPACE, replication: { enabled: true, prefixes: replicationPrefixes() },
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
