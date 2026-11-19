import { beginStorageAccountSession, __resetStorageStatusForTests } from "@/lib/storageStatus";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { adoptNote, deleteNote, loadNote, noteMarkdown, parseMomentLines, parseNoteMarkdown, saveNote } from "./recordingNotes";

const OWNER = "did:test:recording-notes";
let serial = 0;
const id = () => `notes-${++serial}`;
const values = new Map<string, string>();
let previous: PropertyDescriptor | undefined;
beforeEach(() => {
  beginStorageAccountSession({}, OWNER, OWNER);
  previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  } });
});
afterEach(() => {
  values.clear();
  __resetStorageStatusForTests();
  if (previous) Object.defineProperty(globalThis, "localStorage", previous);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("recording Markdown", () => {
  test("a failed IndexedDB open is retried by the next read", async () => {
    const previousDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    let opens = 0;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
      open() {
        opens++;
        const request: { error: Error; onerror?: () => void } = { error: new Error(`open ${opens} failed`) };
        queueMicrotask(() => request.onerror?.());
        return request as unknown as IDBOpenDBRequest;
      },
    } });
    try {
      // Dynamic import on purpose: a static import shares one module instance, and recordingNotes caches its
      // first successful DB connection process-wide, so an earlier file that opened IndexedDB would satisfy this read.
      const fresh = await import(`./recordingNotes?fresh=${id()}`);
      await expect(fresh.loadNote(id())).rejects.toThrow("open 1 failed");
      await expect(fresh.loadNote(id())).rejects.toThrow("open 2 failed");
      expect(opens).toBe(2);
    } finally {
      if (previousDb) Object.defineProperty(globalThis, "indexedDB", previousDb);
      else Reflect.deleteProperty(globalThis, "indexedDB");
    }
  });

  test("parses m:ss, h:mm:ss, an empty bookmark, and ignores other lines", () => {
    expect(parseMomentLines("# Notes\n- **2:05** useful idea\n- **1:02:03**\n- **0:07** bookmark\n- **2:62** invalid\n- ordinary item\n**0:04** missing bullet"))
      .toEqual([{ atMs: 125_000, label: "useful idea" }, { atMs: 3_723_000, label: "" },
        { atMs: 7_000, label: "bookmark" }]);
  });

  test("frontmatter round-trips the Markdown-derived moments and an edit advances edited", async () => {
    const recordingId = id();
    const first = await saveNote(recordingId, "# Field note\n- **0:04** Door opened");
    expect(await loadNote(recordingId)).toEqual(first);
    expect(noteMarkdown(first)).toContain('moments: [{"atMs":4000,"label":"Door opened"}]');
    expect(parseNoteMarkdown(noteMarkdown(first))).toEqual({ ...first, revision: 1 });
    const second = await saveNote(recordingId, "# Edited\n- **0:04** Door opened\n- **1:03:02**");
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.editedAt > first.editedAt).toBe(true);
    expect(second.moments).toEqual([{ atMs: 4_000, label: "Door opened" }, { atMs: 3_782_000, label: "" }]);
    expect(parseNoteMarkdown(noteMarkdown(second)).md).toBe(second.md);
  });

  test("a note written while recording has no saved-edit time; only a saved edit sets it", async () => {
    const recordingId = id();
    const recorded = await saveNote(recordingId, "typed while recording");
    expect(recorded.savedEditAt).toBeNull();
    expect(noteMarkdown(recorded)).not.toContain("edited:");
    expect((await saveNote(recordingId, "typed while recording, more")).savedEditAt).toBeNull();
    const saved = await saveNote(recordingId, "edited after saving", { savedEdit: true });
    expect(saved.savedEditAt).toBe(saved.editedAt);
    expect(noteMarkdown(saved)).toContain(`edited: ${JSON.stringify(saved.savedEditAt)}`);
    expect((await loadNote(recordingId))?.savedEditAt).toBe(saved.savedEditAt);
    const later = await saveNote(recordingId, "recorder write after the saved edit");
    expect(later.savedEditAt).toBe(saved.savedEditAt);
    expect(later.editedAt > saved.editedAt).toBe(true);
  });

  test("frontmatter round-trips savedEditAt with and without edited:", async () => {
    const recordingId = id();
    const recorded = await saveNote(recordingId, "# A");
    const without = parseNoteMarkdown(noteMarkdown(recorded));
    expect(without.savedEditAt).toBeNull();
    expect(without).toEqual({ ...recorded, revision: 1 });
    const saved = await saveNote(recordingId, "# B", { savedEdit: true });
    expect(parseNoteMarkdown(noteMarkdown(saved))).toEqual({ ...saved, revision: 1 });
    const older = `---\nrecordingId: "${recordingId}"\ncreatedAt: "2026-10-09T10:00:00.000Z"\nmoments: []\n---\ntext`;
    expect(parseNoteMarkdown(older).savedEditAt).toBeNull();
    expect(() => parseNoteMarkdown(older.replace("moments", 'edited: 5\nmoments'))).toThrow("frontmatter");
  });

  test("a stored note from before savedEditAt reads as null", async () => {
    const recordingId = id();
    values.set(`exo.voiceNotes.note.${JSON.stringify([OWNER, recordingId])}`, JSON.stringify({ recordingId, md: "old", createdAt: "2026-10-09T10:00:00.000Z",
      editedAt: "2026-10-09T10:00:00.000Z", revision: 3 }));
    expect((await loadNote(recordingId))?.savedEditAt).toBeNull();
    const later = await saveNote(recordingId, "old, more");
    expect(later.savedEditAt).toBeNull();
    expect(later.revision).toBe(4);
  });

  test("an incoming record without the field never clears a stored savedEditAt; absent is not null", async () => {
    const recordingId = id();
    const saved = await saveNote(recordingId, "edited after saving", { savedEdit: true });
    const olderClient = { recordingId, md: "older client text", createdAt: saved.createdAt,
      editedAt: "2099-01-01T00:00:00.000Z", moments: [], revision: 1 };
    const adopted = await adoptNote(olderClient);
    expect(adopted.savedEditAt).toBe(saved.savedEditAt);
    expect(adopted.md).toBe("edited after saving");
    expect((await loadNote(recordingId))?.savedEditAt).toBe(saved.savedEditAt);
    // An explicit null does not clear a stored one either.
    expect((await adoptNote({ ...olderClient, savedEditAt: null })).savedEditAt).toBe(saved.savedEditAt);
    // A later saved-edit time on the remote moves a stored one forward; an earlier one does not move it back.
    expect((await adoptNote({ ...olderClient, savedEditAt: "2000-01-01T00:00:00.000Z" })).savedEditAt).toBe(saved.savedEditAt);
    expect((await adoptNote({ ...olderClient, savedEditAt: "2099-01-01T00:00:00.000Z" })).savedEditAt).toBe("2099-01-01T00:00:00.000Z");
    expect((await loadNote(recordingId))?.savedEditAt).toBe("2099-01-01T00:00:00.000Z");
    expect((await loadNote(recordingId))?.md).toBe("edited after saving");
    const fresh = id();
    expect((await adoptNote({ ...olderClient, recordingId: fresh, savedEditAt: "2026-10-09T11:00:00.000Z" })).savedEditAt)
      .toBe("2026-10-09T11:00:00.000Z");
    expect((await adoptNote({ ...olderClient, recordingId: id() })).savedEditAt).toBeNull();
  });

  test("a discard tombstone prevents a late autosave from reviving the note", async () => {
    const recordingId = id();
    await saveNote(recordingId, "draft");
    await deleteNote(recordingId);
    expect(await loadNote(recordingId)).toBeNull();
    await expect(saveNote(recordingId, "late draft")).rejects.toThrow("This recording was deleted.");
  });
});

// TC-2785: remote notes need no native metadata, but their local text stays account-bound.
test("account namespaces isolate colliding remote ids, sign-out, late writes and owner-specific deletion", async () => {
  const recordingId = id();
  beginStorageAccountSession({}, "did:A", "space:A");
  await saveNote(recordingId, "A private text\n- **0:04** A moment");
  beginStorageAccountSession({}, null, null);
  expect(await loadNote(recordingId)).toBeNull();
  beginStorageAccountSession({}, "did:B", "space:B");
  expect(await loadNote(recordingId)).toBeNull();
  expect(await loadNote(recordingId, "did:A")).toBeNull();
  await adoptNote({ recordingId, md: "B remote note", moments: [], createdAt: "2026-11-11T00:00:00Z",
    editedAt: "2026-11-11T00:00:00Z", revision: 1 }, "did:B");
  await saveNote(recordingId, "B remote edit", { savedEdit: true, owner: "did:B" });
  await saveNote(recordingId, "A late text\n- **0:05** A late moment", { owner: "did:A" });
  expect((await loadNote(recordingId))?.md).toBe("B remote edit");
  await deleteNote(recordingId, "did:B");
  expect(await loadNote(recordingId)).toBeNull();
  beginStorageAccountSession({}, "did:A", "space:A");
  expect((await loadNote(recordingId))?.md).toBe("A late text\n- **0:05** A late moment");
  expect((await loadNote(recordingId))?.moments).toEqual([{ atMs: 5_000, label: "A late moment" }]);
});

test("an id-only legacy copy stays hidden without native ownership proof", async () => {
  const recordingId = id();
  values.set(`exo.voiceNotes.note.${recordingId}`, JSON.stringify({ recordingId, md: "unproven private text",
    createdAt: "2026-11-11T00:00:00Z", editedAt: "2026-11-11T00:00:00Z", revision: 1 }));
  expect(await loadNote(recordingId)).toBeNull();
  expect(values.get(`exo.voiceNotes.note.${recordingId}`)).toContain("unproven private text");
});

test("v1 copies require native ownership proof, and an explicit claim hides the anonymous copy before moving it", async () => {
  const { IDBFactory } = await import("fake-indexeddb");
  const { VoiceNotes, __setVoiceNotesForTests } = await import("./nativeVoiceNotes");
  const original = VoiceNotes;
  const previousDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const factory = new IDBFactory();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  const legacyId = id();
  const unownedId = id();
  const purgeLegacyId = id();
  let active: string | null = "did:B";
  const owners = new Map<string, string | null>([[legacyId, "did:A"], [unownedId, null]]);
  __setVoiceNotesForTests({
    getCaptureDefaults: async () => ({ accountDid: active, status: active ? "signed_in" : "signed_out", transitionGen: 1,
      transcriber: "on-device", identifySpeakers: false }),
    status: async () => ({ id: null, state: "idle" }),
    listPending: async () => ({ recordings: [...owners].filter(([, owner]) => owner === null || owner === active).map(([recordingId, owner]) => ({ id: recordingId, owner })) }),
  } as unknown as typeof VoiceNotes, { available: true });
  try {
    const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open("exo-recording-notes", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("notes", { keyPath: "recordingId" });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = oldDb.transaction("notes", "readwrite");
      tx.objectStore("notes").put({ recordingId: legacyId, md: "A legacy text", createdAt: "2026-11-11T00:00:00Z",
        editedAt: "2026-11-11T00:00:00Z", revision: 1 });
      tx.objectStore("notes").put({ recordingId: purgeLegacyId, md: "Unsynced legacy moments", createdAt: "2026-11-11T00:00:00Z",
        editedAt: "2026-11-11T00:00:00Z", revision: 1 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    oldDb.close();
    const fresh = await import(`./recordingNotes?owner-migration=${id()}`) as typeof import("./recordingNotes");
    beginStorageAccountSession({}, "did:B", "space:B");
    expect(await fresh.loadNote(legacyId)).toBeNull();
    active = "did:A";
    beginStorageAccountSession({}, "did:A", "space:A");
    expect((await fresh.loadNote(legacyId))?.md).toBe("A legacy text");
    const adoptedId = id();
    await fresh.adoptNote({ recordingId: adoptedId, md: "Already saved remote text", moments: [],
      createdAt: "2026-11-11T00:00:00Z", editedAt: "2026-11-11T00:00:00Z", revision: 3 }, "did:A");
    await fresh.deleteSyncedNote(adoptedId, "did:A");
    expect(await fresh.loadNote(adoptedId)).toBeNull();
    await fresh.deleteSyncedNote(purgeLegacyId, "did:A");
    expect((await fresh.loadNote(purgeLegacyId))?.md).toBe("Unsynced legacy moments");
    await fresh.saveNote(unownedId, "Signed-out text", { owner: null });
    expect((await fresh.loadNote(unownedId))?.md).toBe("Signed-out text");
    owners.set(unownedId, "did:A");
    expect(await fresh.loadNote(unownedId, null)).toBeNull();
    await fresh.claimRecordingNote(unownedId, "did:A");
    expect((await fresh.loadNote(unownedId))?.md).toBe("Signed-out text");
    active = null;
    beginStorageAccountSession({}, null, null);
    expect(await fresh.loadNote(legacyId)).toBeNull();
    expect(await fresh.loadNote(unownedId)).toBeNull();
    active = "did:B";
    beginStorageAccountSession({}, "did:B", "space:B");
    expect(await fresh.loadNote(legacyId)).toBeNull();
    expect(await fresh.loadNote(unownedId)).toBeNull();
  } finally {
    __setVoiceNotesForTests(original, { available: null });
    if (previousDb) Object.defineProperty(globalThis, "indexedDB", previousDb);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  }
});

test("synced audio cleanup keeps an unsynced Markdown edit and removes only an acknowledged revision", async () => {
  const { deleteSyncedNote, markNoteSynced } = await import("./recordingNotes");
  const recordingId = id();
  const first = await saveNote(recordingId, "Only local text");
  await deleteSyncedNote(recordingId, OWNER);
  expect((await loadNote(recordingId))?.md).toBe("Only local text");
  await markNoteSynced(recordingId, OWNER, first.revision);
  const latest = await saveNote(recordingId, "New unsynced edit");
  await markNoteSynced(recordingId, OWNER, first.revision);
  await deleteSyncedNote(recordingId, OWNER);
  expect((await loadNote(recordingId))?.md).toBe("New unsynced edit");
  await markNoteSynced(recordingId, OWNER, latest.revision);
  await deleteSyncedNote(recordingId, OWNER);
  expect(await loadNote(recordingId)).toBeNull();
  await expect(saveNote(recordingId, "Late autosave", { owner: OWNER })).rejects.toThrow("This recording was deleted.");
});

test("another tab's account marker denies both directions instead of adopting its namespace", async () => {
  const recordingId = id();
  beginStorageAccountSession({}, "did:A", "space:A");
  await saveNote(recordingId, "A text", { owner: "did:A" });
  await saveNote(recordingId, "B text", { owner: "did:B" });
  values.set("exo.recordingNotes.account", JSON.stringify("did:B"));
  await expect(loadNote(recordingId)).rejects.toThrow("account changed");
  await expect(saveNote(recordingId, "Stale A tab write")).rejects.toThrow("account changed");
  beginStorageAccountSession({}, "did:B", "space:B");
  values.set("exo.recordingNotes.account", JSON.stringify("did:A"));
  await expect(loadNote(recordingId)).rejects.toThrow("account changed");
});


test("a newly adopted space copy is synced, while adopting over a local edit never acknowledges that edit", async () => {
  const { deleteSyncedNote } = await import("./recordingNotes");
  const remoteId = id();
  const localId = id();
  const remote = { recordingId: remoteId, md: "Text already in the space", moments: [],
    createdAt: "2026-11-11T00:00:00Z", editedAt: "2026-11-11T00:00:00Z", revision: 4 };
  await adoptNote(remote, OWNER);
  // The persisted acknowledgement is also what the local-copy move guard reads.
  expect(JSON.parse(values.get(`exo.voiceNotes.note.${JSON.stringify([OWNER, remoteId])}`)!).syncedRevision).toBe(remote.revision);
  await saveNote(localId, "Only local edit", { owner: OWNER });
  expect((await adoptNote({ ...remote, recordingId: localId }, OWNER)).md).toBe("Only local edit");
  await deleteSyncedNote(remoteId, OWNER);
  await deleteSyncedNote(localId, OWNER);
  expect(await loadNote(remoteId)).toBeNull();
  expect((await loadNote(localId))?.md).toBe("Only local edit");
});
