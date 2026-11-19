// TC-3045: the phone app's first launch on its new origin copies what the old origin kept (oldOriginImport.ts).
// The old origin is a separate fake-indexeddb factory and storage map; the export script runs against them exactly as
// the native side runs it, and the import writes through the app's own database openers.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  importOldOrigin, isMigratedKey, OLD_ORIGIN_ALLOW, OLD_ORIGIN_EXPORT_SCRIPT,
  type OldOriginAllow, type OldOriginExport, type OldOriginMigrationPlugin, type TakeResult,
} from "./oldOriginImport";
import { openRecordingNotesDb, RECORDING_NOTES_DB } from "./voiceNotes/recordingNotes";
import { HELD_RESULTS_DB, openHeldResultsDb } from "./voiceNotes/heldResults";
import { THEME_CHOICE_KEY } from "./theme";
import { FEED_VIEW_MODE_KEY } from "@/feed/feedViewMode";
import { NOTES_VIEW_KEY } from "@/capture/recorder/final/notesViewPreference";
import { TINYCLOUD_BUTTON_KEY } from "./tinycloudButton";
import { UPLOAD_ENGINE_STORAGE_KEY, UPLOAD_PENDING_STORAGE_KEY } from "./audioUpload";
import { accountStorageKey, VOICE_NOTE_LIMIT_BLOCKED_CHOICES_KEY, VOICE_NOTE_PENDING_JOBS_KEY, VOICE_NOTE_PRIVATE_CHOICES_KEY } from "./voiceNotes/sourcePins";
import { VOICE_NOTE_CONSENT_KEY, VOICE_NOTE_HELD_KEY } from "./voiceNotes/voiceNoteTranscription";
import { VOICE_NOTE_AUTO_RESUBMITTED_KEY } from "./voiceNotes/providerResubmit";
import { VOICE_NOTE_DISCARDED_KEY } from "./voiceNotes/recorderSaves";
import { PRIVATE_CONSENT_PROMPT_KEY } from "@/capture/recorder/privateConsentPrompt";
import { __setVoiceNotesForTests, VoiceNotes } from "./voiceNotes/nativeVoiceNotes";
import { createFakeVoiceNotes } from "./voiceNotes/fakeVoiceNotes";
import { writeAccountDefaults } from "./voiceNotes/transcriberPreference";

const DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const SECRETS = [
  "xyz.tinycloud.tinychat:session",
  "tinycloud:session:0x00000000000000000000000000000000000000a1",
  "tinycloud:session:active-address",
  `tinychat:shared-with-me:${DID}`,
];

const originals = Object.fromEntries(["indexedDB", "IDBKeyRange", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function mapStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

/** The new origin. Its databases are opened by the app's own modules, which read these globals. */
let newOrigin: ReturnType<typeof mapStorage>;
beforeAll(() => {
  define("indexedDB", new IDBFactory());
  define("IDBKeyRange", IDBKeyRange);
});
afterEach(() => __setVoiceNotesForTests(VoiceNotes, { available: null }));
afterAll(() => {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putRows(db: IDBDatabase, store: string, rows: object[]) {
  const tx = db.transaction(store, "readwrite");
  for (const row of rows) tx.objectStore(store).put(row);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}

async function allRows(db: IDBDatabase, store: string): Promise<unknown[]> {
  return settle(db.transaction(store, "readonly").objectStore(store).getAll());
}

/** An old origin with the app's two databases (their v2 schemas) and one it doesn't migrate. */
async function oldOrigin(storage: Record<string, string>, rows: { notes?: object[]; held?: object[]; meta?: object[] }) {
  const factory = new IDBFactory();
  const open = (name: string, upgrade: (db: IDBDatabase) => void) => {
    const request = factory.open(name, 2);
    request.onupgradeneeded = () => upgrade(request.result);
    return settle(request);
  };
  const notes = await open(RECORDING_NOTES_DB, (db) => db.createObjectStore("notes", { keyPath: "storageId" }));
  await putRows(notes, "notes", rows.notes ?? []);
  notes.close();
  const held = await open(HELD_RESULTS_DB, (db) => {
    db.createObjectStore("held", { keyPath: ["did", "sourceId"] });
    db.createObjectStore("meta", { keyPath: "did" });
  });
  await putRows(held, "held", rows.held ?? []);
  await putRows(held, "meta", rows.meta ?? []);
  held.close();
  const cache = await open("exo-audio-playback-cache", (db) => db.createObjectStore("audio", { keyPath: "id" }));
  await putRows(cache, "audio", [{ id: "a", bytes: "…" }]);
  cache.close();
  return { factory, storage: mapStorage(storage) };
}

/** What the native side does: run the script at the old origin, where `localStorage` and `indexedDB` are its own. */
async function runExport(origin: { factory: IDBFactory; storage: ReturnType<typeof mapStorage> }, allow: OldOriginAllow = OLD_ORIGIN_ALLOW): Promise<string> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<string>;
  return new AsyncFunction("allow", "localStorage", "indexedDB", OLD_ORIGIN_EXPORT_SCRIPT)(JSON.parse(JSON.stringify(allow)), origin.storage, origin.factory);
}

function nativeSide(data: string | null, order: string[] = []): OldOriginMigrationPlugin & { acks: number } {
  const plugin = {
    acks: 0,
    take: async (): Promise<TakeResult> => (data === null ? { state: "done" } : { state: "export", data }),
    ack: async () => { plugin.acks++; order.push("ack"); },
  };
  return plugin;
}

const note = (id: string, md: string) => ({ storageId: `${DID}:${id}`, recordingId: id, owner: DID, md, revision: 0, syncedRevision: null });
const held = (sourceId: string) => ({ did: DID, sourceId, hash: `h-${sourceId}`, transcript: { sentences: [{ text: "hello" }] }, heldAt: 1 });

test("the export holds the allowlisted keys and both databases' rows, never a sign-in secret or another database", async () => {
  const origin = await oldOrigin({
    "tinychat.home.answer-outbox.v1:q1": "{\"answer\":\"yes\"}",
    "exo.voiceNotes.transcriber": "private-cloud",
    [`exo.voiceNotes.privateCloudJobs:${DID}`]: "[]",
    "exo-failure-notifications-v2:x": "1",
    ...Object.fromEntries(SECRETS.map((key) => [key, "secret"])),
  }, { notes: [note("r1", "typed")], held: [held("s1")], meta: [{ did: DID, epoch: 3 }] });

  const exported = JSON.parse(await runExport(origin)) as OldOriginExport;

  expect(exported.version).toBe(1);
  expect(Object.fromEntries(exported.localStorage)).toEqual({
    "tinychat.home.answer-outbox.v1:q1": "{\"answer\":\"yes\"}",
    "exo.voiceNotes.transcriber": "private-cloud",
    [`exo.voiceNotes.privateCloudJobs:${DID}`]: "[]",
  });
  expect(Object.keys(exported.databases).sort()).toEqual([HELD_RESULTS_DB, RECORDING_NOTES_DB].sort());
  expect(exported.databases[RECORDING_NOTES_DB].stores.notes).toEqual([note("r1", "typed")]);
  expect(exported.databases[HELD_RESULTS_DB].stores).toEqual({ held: [held("s1")], meta: [{ did: DID, epoch: 3 }] });
  expect(origin.storage.values.size).toBe(8);
});

test("the import copies only what the new origin lacks, keeps the new origin's own values and rows, then acks", async () => {
  const origin = await oldOrigin({
    "tinychat.home.answer-unsent.v1:q2": "{\"answer\":\"unsent\"}",
    "xyz.tinycloud.tinychat:theme-choice": "dark",
    "exo.voiceNotes.uploadAudio": "1",
  }, { notes: [note("imp-1", "old"), note("imp-2", "only old")], held: [held("imp-s1")], meta: [{ did: DID, epoch: 3 }] });
  newOrigin = mapStorage({ "exo.voiceNotes.uploadAudio": "0" });
  const notes = await openRecordingNotesDb();
  await putRows(notes, "notes", [note("imp-1", "new")]);
  const order: string[] = [];
  const plugin = nativeSide(await runExport(origin), order);

  const outcome = await importOldOrigin({ plugin, storage: newOrigin });

  expect(outcome).toEqual({ kind: "imported", keys: ["tinychat.home.answer-unsent.v1:q2", "xyz.tinycloud.tinychat:theme-choice"] });
  expect(newOrigin.values.get("exo.voiceNotes.uploadAudio")).toBe("0");
  const imported = (await allRows(notes, "notes"))
    .filter((row) => typeof row === "object" && row !== null && "recordingId" in row && String(row.recordingId).startsWith("imp-"));
  expect(imported).toEqual([note("imp-1", "new"), note("imp-2", "only old")]);
  const heldDb = await openHeldResultsDb();
  try {
    expect(await allRows(heldDb, "held")).toContainEqual(held("imp-s1"));
    expect(await allRows(heldDb, "meta")).toContainEqual({ did: DID, epoch: 3 });
  } finally {
    heldDb.close();
  }
  expect(plugin.acks).toBe(1);
  expect(order).toEqual(["ack"]);
});

test("keys outside the allowlist in an export are never imported", async () => {
  newOrigin = mapStorage();
  const data: OldOriginExport = { version: 1, localStorage: SECRETS.map((key) => [key, "secret"]), databases: {} };
  const plugin = nativeSide(JSON.stringify(data));

  expect(await importOldOrigin({ plugin, storage: newOrigin })).toEqual({ kind: "imported", keys: [] });
  expect(newOrigin.values.size).toBe(0);
  for (const key of SECRETS) expect(isMigratedKey(key)).toBe(false);
});

test("nothing is acked, so nothing is wiped, when the rows can't be imported or the export doesn't answer in time", async () => {
  newOrigin = mapStorage();
  const data: OldOriginExport = { version: 1, localStorage: [], databases: { [RECORDING_NOTES_DB]: { stores: { notes: [note("x", "x")] } } } };
  const failing = nativeSide(JSON.stringify(data));
  const failed = await importOldOrigin({ plugin: failing, storage: newOrigin, addMissingRows: async () => { throw new Error("quota"); } });
  expect(failed).toEqual({ kind: "failed", reason: "quota" });
  expect(failing.acks).toBe(0);

  const silent = { ...nativeSide(null), take: () => new Promise<TakeResult>(() => {}) };
  expect((await importOldOrigin({ plugin: silent, storage: newOrigin, timeoutMs: 10 })).kind).toBe("failed");
  expect(silent.acks).toBe(0);
});

test("an import already done, or a dev build on the old origin, imports nothing and acks nothing", async () => {
  newOrigin = mapStorage();
  const done = nativeSide(null);
  expect(await importOldOrigin({ plugin: done, storage: newOrigin })).toEqual({ kind: "none" });
  const skip = { ...nativeSide(null), take: async (): Promise<TakeResult> => ({ state: "skip" }) };
  expect(await importOldOrigin({ plugin: skip, storage: newOrigin })).toEqual({ kind: "none" });
  expect(done.acks + skip.acks).toBe(0);
});

test("the allowlist names the keys and databases the app writes", () => {
  for (const key of [THEME_CHOICE_KEY, FEED_VIEW_MODE_KEY, NOTES_VIEW_KEY, TINYCLOUD_BUTTON_KEY, UPLOAD_ENGINE_STORAGE_KEY, VOICE_NOTE_DISCARDED_KEY]) {
    expect(isMigratedKey(key)).toBe(true);
  }
  for (const key of [UPLOAD_PENDING_STORAGE_KEY, VOICE_NOTE_PENDING_JOBS_KEY, VOICE_NOTE_PRIVATE_CHOICES_KEY, VOICE_NOTE_LIMIT_BLOCKED_CHOICES_KEY,
    VOICE_NOTE_CONSENT_KEY, VOICE_NOTE_HELD_KEY, VOICE_NOTE_AUTO_RESUBMITTED_KEY, PRIVATE_CONSENT_PROMPT_KEY]) {
    expect(isMigratedKey(accountStorageKey(key, DID))).toBe(true);
  }
  expect([...OLD_ORIGIN_ALLOW.databases].sort()).toEqual([HELD_RESULTS_DB, RECORDING_NOTES_DB].sort());
});

test("the imported recording settings are what RecorderProvider's account write then gives the engine", async () => {
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  await fake.plugin.setCaptureDefaults({ accountDid: DID, transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
  newOrigin = mapStorage();
  define("localStorage", newOrigin);
  const origin = await oldOrigin({ "exo.voiceNotes.transcriber": "private-cloud", "exo.voiceNotes.identifySpeakers": "1" }, {});

  await importOldOrigin({ plugin: nativeSide(await runExport(origin)), storage: newOrigin });
  await writeAccountDefaults((native) => ({ accountDid: native.accountDid, transitionGen: native.transitionGen }));

  const engine = await fake.plugin.getCaptureDefaults();
  expect(engine.transcriber).toBe("private-cloud");
  expect(engine.identifySpeakers).toBe(true);
});
