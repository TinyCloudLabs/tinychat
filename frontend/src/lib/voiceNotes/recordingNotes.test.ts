import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deleteNote, loadNote, noteMarkdown, parseMomentLines, parseNoteMarkdown, saveNote } from "./recordingNotes";

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

  test("a discard tombstone prevents a late autosave from reviving the note", async () => {
    const recordingId = id();
    await saveNote(recordingId, "draft");
    await deleteNote(recordingId);
    expect(await loadNote(recordingId)).toBeNull();
    await expect(saveNote(recordingId, "late draft")).rejects.toThrow("discarded");
  });
});
