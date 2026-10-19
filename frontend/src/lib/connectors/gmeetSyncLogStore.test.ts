import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { StoreResult } from "./connectorStore";
import { _resetGmeetSyncSingleFlightForTests, syncGoogleMeet, type GmeetSyncClient, type GmeetSyncStore } from "./gmeetSync";
import {
  gmeetSyncLogStorageKey,
  loadGmeetSyncLog,
  readStoredGmeetSyncLog,
  startPersistingGmeetRunLog,
  writeStoredGmeetSyncLog,
} from "./gmeetSyncLogStore";

const ok = <T>(data: T): StoreResult<T> => ({ ok: true, data });
const account = (did: string) => ({ did }) as unknown as TinyCloudWeb;
const ALICE = account("did:pkh:eip155:1:0xalice");
const BOB = account("did:pkh:eip155:1:0xbob");

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  readonly items = new Map<string, string>();
  writes = 0;
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; this.items.set(key, value); }
}
const asStorage = (storage: MemoryStorage) => storage as unknown as Storage;

/** A Google with no records: the engine runs end to end and finishes, which is all the log needs. */
const client: GmeetSyncClient = {
  delayMs: 0,
  pace: async () => {},
  listConferenceRecords: async () => ({ ok: true, data: [] }),
  listParticipants: async () => ({ ok: true, data: [] }),
  listTranscripts: async () => ({ ok: true, data: [] }),
  listTranscriptEntries: async () => ({ ok: true, data: [] }),
};
const store: GmeetSyncStore = {
  getConnection: async () => ok(null),
  putTranscriptBody: async () => ok(undefined),
  upsertMeeting: async () => ok({ id: "x", inserted: true, createdAt: "t" }),
  updateSyncState: async () => ok(undefined),
  countMeetings: async () => ok(0),
};
const runFor = (tcw: TinyCloudWeb) => syncGoogleMeet({ client, store, tcw });

beforeEach(() => { _resetGmeetSyncSingleFlightForTests(); });
afterEach(() => { vi.useRealTimers(); });

describe("persisted Google Meet sync log", () => {
  test("a finished run is stored under its own account and read back after a reload", async () => {
    const storage = new MemoryStorage();
    const stop = startPersistingGmeetRunLog(ALICE, { storage: asStorage(storage), build: () => "Exo test-build" });
    await runFor(ALICE);
    stop();
    expect([...storage.items.keys()]).toEqual([gmeetSyncLogStorageKey("did:pkh:eip155:1:0xalice")]);
    // A new page load has no in-memory run; the stored one is what "Copy sync log" copies.
    _resetGmeetSyncSingleFlightForTests();
    const log = loadGmeetSyncLog(ALICE, null, asStorage(storage));
    expect(log).toMatchObject({ build: "Exo test-build", result: { kind: "ok", connectionSaved: true } });
    expect(log?.timeline.length).toBeGreaterThan(0);
  });

  test("another account never reads or overwrites this account's log", async () => {
    const storage = new MemoryStorage();
    const stopAlice = startPersistingGmeetRunLog(ALICE, { storage: asStorage(storage) });
    await runFor(ALICE);
    stopAlice();
    const alicesKey = gmeetSyncLogStorageKey("did:pkh:eip155:1:0xalice");
    const before = storage.items.get(alicesKey);
    expect(readStoredGmeetSyncLog("did:pkh:eip155:1:0xbob", asStorage(storage))).toBeNull();
    _resetGmeetSyncSingleFlightForTests();
    expect(loadGmeetSyncLog(BOB, null, asStorage(storage))).toBeNull();
    // Bob's run, with only Alice's persister listening, writes nothing for Alice.
    const stopAgain = startPersistingGmeetRunLog(ALICE, { storage: asStorage(storage) });
    await runFor(BOB);
    stopAgain();
    expect(storage.items.get(alicesKey)).toBe(before);
    expect(storage.items.size).toBe(1);
  });

  test("a payload that names a different account under this account's key is ignored", () => {
    const storage = new MemoryStorage();
    const log = { generatedAt: "t", build: null, timeline: [], droppedEntries: 0, diagnostics: null, phaseTimingsMs: null, result: null, notesOutcome: null };
    storage.setItem(gmeetSyncLogStorageKey("did:pkh:eip155:1:0xalice"), JSON.stringify({ accountDid: "did:pkh:eip155:1:0xbob", log }));
    expect(readStoredGmeetSyncLog("did:pkh:eip155:1:0xalice", asStorage(storage))).toBeNull();
    writeStoredGmeetSyncLog("did:pkh:eip155:1:0xalice", log, asStorage(storage));
    expect(readStoredGmeetSyncLog("did:pkh:eip155:1:0xalice", asStorage(storage))).toEqual(log);
    storage.setItem(gmeetSyncLogStorageKey("did:pkh:eip155:1:0xalice"), "not json");
    expect(readStoredGmeetSyncLog("did:pkh:eip155:1:0xalice", asStorage(storage))).toBeNull();
  });

  test("an account without a DID stores and reads nothing", async () => {
    const storage = new MemoryStorage();
    const nameless = account("");
    const stop = startPersistingGmeetRunLog(nameless, { storage: asStorage(storage) });
    await runFor(nameless);
    stop();
    expect(storage.items.size).toBe(0);
    expect(readStoredGmeetSyncLog("", asStorage(storage))).toBeNull();
  });

  test("the stored log carries only the recorder's allow-listed fields", async () => {
    const storage = new MemoryStorage();
    const stop = startPersistingGmeetRunLog(ALICE, { storage: asStorage(storage) });
    await runFor(ALICE);
    stop();
    const stored = JSON.parse(storage.items.get(gmeetSyncLogStorageKey("did:pkh:eip155:1:0xalice"))!);
    expect(Object.keys(stored).sort()).toEqual(["accountDid", "log"]);
    expect(Object.keys(stored.log).sort()).toEqual(
      ["build", "diagnostics", "droppedEntries", "generatedAt", "notesOutcome", "phaseTimingsMs", "result", "timeline"],
    );
  });

  test("a live run is persisted at most once per throttle window, and its end at once", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const stop = startPersistingGmeetRunLog(ALICE, { storage: asStorage(storage), throttleMs: 2_000 });
    const gate = Promise.withResolvers<void>();
    const slowClient: GmeetSyncClient = { ...client, listConferenceRecords: async () => { await gate.promise; return { ok: true, data: [] }; } };
    const run = syncGoogleMeet({ client: slowClient, store, tcw: ALICE });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(storage.writes).toBe(0); // Progress so far is held back by the throttle.
    vi.advanceTimersByTime(2_000);
    expect(storage.writes).toBe(1);
    gate.resolve();
    await run;
    expect(storage.writes).toBe(2); // The final log is written without waiting for the window.
    expect(JSON.parse(storage.items.get(gmeetSyncLogStorageKey("did:pkh:eip155:1:0xalice"))!).log.result).toMatchObject({ kind: "ok" });
    stop();
  });
});
