import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { adoptNote, deleteNote, loadNote, noteMarkdown, parseMomentLines, parseNoteMarkdown, saveNote } from "./recordingNotes";

let serial = 0;
const id = () => `notes-${++serial}`;
const values = new Map<string, string>();
let previous: PropertyDescriptor | undefined;
beforeEach(() => {
  previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  } });
});
afterEach(() => {
  values.clear();
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
      await expect(loadNote(id())).rejects.toThrow("open 1 failed");
      await expect(loadNote(id())).rejects.toThrow("open 2 failed");
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
    values.set(`exo.voiceNotes.note.${recordingId}`, JSON.stringify({ recordingId, md: "old", createdAt: "2026-10-09T10:00:00.000Z",
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
    // An explicit null does not overwrite a stored note either: adopting never changes one.
    expect((await adoptNote({ ...olderClient, savedEditAt: null })).savedEditAt).toBe(saved.savedEditAt);
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
    await expect(saveNote(recordingId, "late draft")).rejects.toThrow("discarded");
  });
});
