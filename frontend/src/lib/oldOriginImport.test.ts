// TC-3045: the phone app's first launch on its new origin copies what the old origin kept (oldOriginImport.ts).
// The old origin is a separate fake-indexeddb factory and storage map; the export script runs against them exactly as
// the native side runs it, and the import writes through the app's own database openers.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  addMissingRows, importOldOrigin, isMigratedKey, OLD_ORIGIN_ALLOW, OLD_ORIGIN_EXPORT_SCRIPT, OLD_ORIGIN_IMPORT_MARKER,
  OLD_ORIGIN_SCRUB_SCRIPT, type OldOriginAllow, type OldOriginExport, type OldOriginMigrationPlugin, type TakeResult,
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
async function runExport(origin: { factory: IDBFactory; storage: ReturnType<typeof mapStorage> }, allow: OldOriginAllow = OLD_ORIGIN_ALLOW, script = OLD_ORIGIN_EXPORT_SCRIPT): Promise<string> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<string>;
  return new AsyncFunction("allow", "localStorage", "indexedDB", script)(JSON.parse(JSON.stringify(allow)), origin.storage, origin.factory);
}

/** The native side: "export" before an ack, "verify" after one, "done" (`data` null) once confirmed. */
function nativeSide(data: string | null, order: string[] = [], state: "export" | "verify" = "export") {
  const plugin = {
    acks: 0,
    confirms: 0,
    scrub: "",
    take: async (options: Parameters<OldOriginMigrationPlugin["take"]>[0]): Promise<TakeResult> => {
      plugin.scrub = options.scrub;
      return data === null ? { state: "done" } : { state, data };
    },
    ack: async () => { plugin.acks++; order.push("ack"); },
    confirm: async () => { plugin.confirms++; order.push("confirm"); },
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
  expect([...newOrigin.values.keys()]).toEqual([OLD_ORIGIN_IMPORT_MARKER]);
  for (const key of SECRETS) expect(isMigratedKey(key)).toBe(false);
});

test("nothing is marked or acked, so nothing is wiped, when the rows can't be imported or the export doesn't answer in time", async () => {
  newOrigin = mapStorage();
  const data: OldOriginExport = { version: 1, localStorage: [], databases: { [RECORDING_NOTES_DB]: { stores: { notes: [note("x", "x")] } } } };
  const failing = nativeSide(JSON.stringify(data));
  const failed = await importOldOrigin({ plugin: failing, storage: newOrigin, addMissingRows: async () => { throw new Error("quota"); } });
  expect(failed).toEqual({ kind: "failed", reason: "quota" });
  expect(failing.acks).toBe(0);
  expect(newOrigin.getItem(OLD_ORIGIN_IMPORT_MARKER)).toBeNull();

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

/** The app's own adder, through the same openers and copy-if-absent add the import uses by default. */
async function addAppRows(database: string, store: string, rows: unknown[]) {
  const db = database === RECORDING_NOTES_DB ? await openRecordingNotesDb() : await openHeldResultsDb();
  try {
    await addMissingRows(db, store, rows);
  } finally {
    if (database === HELD_RESULTS_DB) db.close();
  }
}

async function rowsOf(database: string, store: string, prefix: string): Promise<unknown[]> {
  const db = database === RECORDING_NOTES_DB ? await openRecordingNotesDb() : await openHeldResultsDb();
  try {
    return (await allRows(db, store)).filter((row) => JSON.stringify(row).includes(prefix));
  } finally {
    if (database === HELD_RESULTS_DB) db.close();
  }
}

test("every key and row is in before the marker, and the marker before the ack", async () => {
  const origin = await oldOrigin({
    "tinychat.home.post-draft.v1:ord": "{\"draft\":\"half\"}",
    "exo.voiceNotes.transcriber": "assemblyai",
  }, { notes: [note("ord-1", "typed")], held: [held("ord-s1")] });
  newOrigin = mapStorage();
  const order: string[] = [];
  const storage = { getItem: newOrigin.getItem, setItem: (key: string, value: string) => { order.push(`key ${key}`); newOrigin.setItem(key, value); } };
  const plugin = nativeSide(await runExport(origin), order);

  await importOldOrigin({ plugin, storage, addMissingRows: async (database, store, rows) => {
    await addAppRows(database, store, rows);
    order.push(`rows ${database}/${store}`);
  } });

  expect(order.slice(-2)).toEqual([`key ${OLD_ORIGIN_IMPORT_MARKER}`, "ack"]);
  expect(order.filter((step) => step === "ack" || step.endsWith(OLD_ORIGIN_IMPORT_MARKER))).toHaveLength(2);
  expect(order.slice(0, -2).sort()).toEqual([
    "key exo.voiceNotes.transcriber",
    "key tinychat.home.post-draft.v1:ord",
    `rows ${HELD_RESULTS_DB}/held`,
    `rows ${RECORDING_NOTES_DB}/notes`,
  ]);
  expect(plugin.confirms).toBe(0);
});

test("a store that fails midway leaves no ack; the next launch finishes from the same export without duplicating, then acks once", async () => {
  const origin = await oldOrigin({ "xyz.tinycloud.tinychat:theme-choice": "dark" }, {
    notes: [note("part-1", "one"), note("part-2", "two")],
    held: [held("part-s1"), held("part-s2")],
  });
  newOrigin = mapStorage();
  const plugin = nativeSide(await runExport(origin));

  // First launch: the held store takes its first row, then fails (the disk filled up, say).
  const first = await importOldOrigin({ plugin, storage: newOrigin, addMissingRows: async (database, store, rows) => {
    if (store !== "held") return addAppRows(database, store, rows);
    await addAppRows(database, store, rows.slice(0, 1));
    throw new Error("QuotaExceededError");
  } });
  expect(first).toEqual({ kind: "failed", reason: "QuotaExceededError" });
  expect(plugin.acks).toBe(0);
  expect(await rowsOf(HELD_RESULTS_DB, "held", "part-s")).toHaveLength(1);

  // Between launches the user changes the copied theme on the new origin; the retry must not undo that.
  newOrigin.setItem("xyz.tinycloud.tinychat:theme-choice", "light");

  const second = await importOldOrigin({ plugin, storage: newOrigin, addMissingRows: addAppRows });
  expect(second).toEqual({ kind: "imported", keys: [] });
  expect(plugin.acks).toBe(1);
  expect(newOrigin.values.get("xyz.tinycloud.tinychat:theme-choice")).toBe("light");
  expect(await rowsOf(HELD_RESULTS_DB, "held", "part-s")).toEqual([held("part-s1"), held("part-s2")]);
  expect(await rowsOf(RECORDING_NOTES_DB, "notes", "part-")).toEqual([note("part-1", "one"), note("part-2", "two")]);
});

test("an ack lost after a full import: the next launch re-imports without duplicating or overwriting, and the one after imports nothing", async () => {
  const origin = await oldOrigin({ "tinychat.home.answer-outbox.v1:idem": "{\"answer\":\"yes\"}" }, {
    notes: [note("idem-1", "typed on the old origin")],
    held: [held("idem-s1")],
  });
  newOrigin = mapStorage();
  const data = await runExport(origin);
  const lost = { ...nativeSide(data), ack: async () => { throw new Error("bridge gone"); } };

  expect(await importOldOrigin({ plugin: lost, storage: newOrigin, addMissingRows: addAppRows })).toEqual({ kind: "failed", reason: "bridge gone" });
  // The user edits the imported note before the next launch.
  const notes = await openRecordingNotesDb();
  await putRows(notes, "notes", [note("idem-1", "edited on the new origin")]);

  const retry = nativeSide(data);
  expect(await importOldOrigin({ plugin: retry, storage: newOrigin, addMissingRows: addAppRows })).toEqual({ kind: "imported", keys: [] });
  expect(retry.acks).toBe(1);
  expect(await rowsOf(RECORDING_NOTES_DB, "notes", "idem-")).toEqual([note("idem-1", "edited on the new origin")]);
  expect(await rowsOf(HELD_RESULTS_DB, "held", "idem-")).toEqual([held("idem-s1")]);
  expect([...newOrigin.values.keys()].sort()).toEqual([OLD_ORIGIN_IMPORT_MARKER, "tinychat.home.answer-outbox.v1:idem"].sort());

  // Native now answers "done": nothing is imported or acked again.
  const after = nativeSide(null);
  expect(await importOldOrigin({ plugin: after, storage: newOrigin, addMissingRows: async () => { throw new Error("must not run"); } })).toEqual({ kind: "none" });
  expect(after.acks).toBe(0);
});

test("a launch after the ack finds the marker on disk: it confirms (native then wipes) and imports nothing", async () => {
  const origin = await oldOrigin({ "tinychat.home.answer-outbox.v1:conf": "{\"answer\":\"sent later\"}" }, { notes: [note("conf-1", "typed")] });
  newOrigin = mapStorage();
  const data = await runExport(origin);
  const first = nativeSide(data);
  expect((await importOldOrigin({ plugin: first, storage: newOrigin, addMissingRows: addAppRows })).kind).toBe("imported");
  expect(first.confirms).toBe(0);
  // The user sends the outbox answer and deletes the note before the next launch: confirming must not bring them back.
  newOrigin.removeItem("tinychat.home.answer-outbox.v1:conf");
  const notes = await openRecordingNotesDb();
  await settle(notes.transaction("notes", "readwrite").objectStore("notes").delete(`${DID}:conf-1`));

  const order: string[] = [];
  const second = nativeSide(data, order, "verify");
  expect(await importOldOrigin({ plugin: second, storage: newOrigin, addMissingRows: async () => { throw new Error("must not run"); } }))
    .toEqual({ kind: "confirmed" });
  expect(order).toEqual(["confirm"]);
  expect(newOrigin.getItem("tinychat.home.answer-outbox.v1:conf")).toBeNull();
  expect(await rowsOf(RECORDING_NOTES_DB, "notes", "conf-")).toEqual([]);
});

test("a launch after the ack without the marker (the copy never reached disk) copies again, keeps the user's values, marks and acks, never confirms", async () => {
  const origin = await oldOrigin({
    "tinychat.home.answer-unsent.v1:lost": "{\"answer\":\"unsent\"}",
    "xyz.tinycloud.tinychat:theme-choice": "dark",
  }, { notes: [note("lost-1", "typed")], held: [held("lost-s1")] });
  const data = await runExport(origin);
  // The first launch's import and marker were lost with the WebView's unwritten localStorage; this launch has
  // since set a theme of its own.
  newOrigin = mapStorage({ "xyz.tinycloud.tinychat:theme-choice": "light" });
  const order: string[] = [];
  const plugin = nativeSide(data, order, "verify");

  expect(await importOldOrigin({ plugin, storage: newOrigin, addMissingRows: addAppRows }))
    .toEqual({ kind: "imported", keys: ["tinychat.home.answer-unsent.v1:lost"] });
  expect(order).toEqual(["ack"]);
  expect(newOrigin.getItem("xyz.tinycloud.tinychat:theme-choice")).toBe("light");
  expect(newOrigin.getItem(OLD_ORIGIN_IMPORT_MARKER)).not.toBeNull();
  expect(await rowsOf(RECORDING_NOTES_DB, "notes", "lost-")).toEqual([note("lost-1", "typed")]);
  expect(await rowsOf(HELD_RESULTS_DB, "held", "lost-")).toEqual([held("lost-s1")]);

  // The launch after that finds it.
  const next = nativeSide(data, [], "verify");
  expect(await importOldOrigin({ plugin: next, storage: newOrigin })).toEqual({ kind: "confirmed" });
  expect(next.acks).toBe(0);
});

test("the scrub the app hands native removes only the old origin's sign-in token and session keys", async () => {
  const userData = {
    "tinychat.home.answer-outbox.v1:scr": "{\"answer\":\"yes\"}",
    "exo.voiceNotes.transcriber": "private-cloud",
    "xyz.tinycloud.tinychat:theme-choice": "dark",
  };
  const origin = await oldOrigin({ ...userData, ...Object.fromEntries(SECRETS.map((key) => [key, "secret"])) }, { notes: [note("scr-1", "typed")] });
  const plugin = nativeSide(null);
  await importOldOrigin({ plugin, storage: mapStorage() });

  expect(JSON.parse(await runExport(origin, { exact: [], prefixes: [], databases: [] }, plugin.scrub))).toEqual({ removed: 3 });

  expect(Object.fromEntries(origin.storage.values)).toEqual({ ...userData, [`tinychat:shared-with-me:${DID}`]: "secret" });
  const exported = JSON.parse(await runExport(origin)) as OldOriginExport;
  expect(exported.databases[RECORDING_NOTES_DB].stores.notes).toEqual([note("scr-1", "typed")]);
  expect(plugin.scrub).toBe(OLD_ORIGIN_SCRUB_SCRIPT);
});
