import { describe, expect, test } from "bun:test";
import {
  NOTES_VIEW_KEY,
  readNotesView,
  rememberNotesView,
} from "./notesViewPreference";

function memory(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => void (store[k] = v),
  };
}

describe("notes view preference", () => {
  test("is Preview the first time", () => {
    expect(readNotesView(memory())).toBe("preview");
  });
  test("remembers the last view across sessions", () => {
    const storage = memory();
    rememberNotesView("write", storage);
    expect(readNotesView(storage)).toBe("write");
    rememberNotesView("preview", storage);
    expect(readNotesView(storage)).toBe("preview");
    expect(storage.store[NOTES_VIEW_KEY]).toBe("preview");
  });
  test("an unknown stored value reads as Preview", () => {
    expect(readNotesView(memory({ [NOTES_VIEW_KEY]: "split" }))).toBe(
      "preview",
    );
  });
});
