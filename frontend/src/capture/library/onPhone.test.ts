// Notes still on this phone, listed with the Library's rows (P1-7): a stand-in for a note with no row, the row
// itself (marked saving) once there is one, newest first, never two of the same note.
import { describe, expect, test } from "bun:test";

import type { PendingNote } from "@/lib/voiceNotes/recorderSaves";
import type { LibraryItem } from "./LibraryRow";
import { noteSnippet, onPhoneId, onPhoneItem, recordingIdOfOnPhoneId, withOnPhone } from "./onPhone";

const row = (id: string, sourceId: string, startedAt: string): LibraryItem => ({
  id, source: "exo-voice-note", sourceId, title: `Voice note ${id}`, startedAt, durationSecs: 5,
});
const note = (id: string, startedAt: string): PendingNote => ({ id, startedAt: Date.parse(startedAt), durationMs: 14_400 });

describe("withOnPhone", () => {
  test("a note with no row is a stand-in with its own id, time and length", () => {
    const [item] = withOnPhone([], [note("rec-1", "2026-10-10T19:16:00.000Z")]);
    expect(item).toEqual({
      id: "on-phone:rec-1", source: "exo-voice-note", sourceId: "rec-1", title: null,
      startedAt: "2026-10-10T19:16:00.000Z", durationSecs: 14, onPhone: true,
    });
    expect(recordingIdOfOnPhoneId(item.id)).toBe("rec-1");
    expect(recordingIdOfOnPhoneId("row-1")).toBeNull();
    expect(onPhoneId("rec-1")).toBe(item.id);
    expect(onPhoneItem(note("rec-1", "2026-10-10T19:16:00.000Z"))).toEqual(item);
  });

  test("a note whose row exists is that row, marked saving, and never listed twice", () => {
    const rows = [row("a", "rec-a", "2026-10-10T19:00:00.000Z"), row("b", "rec-b", "2026-10-10T18:00:00.000Z")];
    const merged = withOnPhone(rows, [note("rec-a", "2026-10-10T19:00:00.000Z")]);
    expect(merged.map((item) => item.id)).toEqual(["a", "b"]);
    expect(merged[0]).toMatchObject({ saving: true });
    expect(merged[1].saving).toBeUndefined();
  });

  test("a failed note stays pending but its Recent row does not claim it is saving", () => {
    const rows = [row("a", "rec-a", "2026-10-10T19:00:00.000Z")];
    const merged = withOnPhone(rows, [{ ...note("rec-a", "2026-10-10T19:00:00.000Z"), failed: { kind: "other", message: "failed" } }]);
    expect(merged).toEqual(rows);
    expect(merged[0]?.saving).toBeUndefined();
  });

  test("stand-ins sit among the rows newest first, and the rows keep the space's order", () => {
    const rows = [row("a", "rec-a", "2026-10-10T19:00:00.000Z"), row("b", "rec-b", "2026-10-10T17:00:00.000Z")];
    const merged = withOnPhone(rows, [note("rec-old", "2026-10-10T10:00:00.000Z"), note("rec-mid", "2026-10-10T18:00:00.000Z"), note("rec-new", "2026-10-10T20:00:00.000Z")]);
    expect(merged.map((item) => item.id)).toEqual(["on-phone:rec-new", "a", "on-phone:rec-mid", "b", "on-phone:rec-old"]);
  });

  test("a note that has left the phone stands in only while the list has no row for it, and is never marked", () => {
    const rows = [row("a", "rec-a", "2026-10-10T19:00:00.000Z")];
    const gone = [note("rec-a", "2026-10-10T19:00:00.000Z"), note("rec-b", "2026-10-10T18:00:00.000Z")];
    const merged = withOnPhone(rows, [], gone);
    expect(merged.map((item) => item.id)).toEqual(["a", "on-phone:rec-b"]);
    expect(merged[0].saving).toBeUndefined();
  });

  test("another kind of row with the same source id is not the note's row", () => {
    const meeting: LibraryItem = { id: "m", source: "tinycloud-transcriber", sourceId: "rec-1", title: "Sync", startedAt: "2026-10-10T19:00:00.000Z", durationSecs: 1 };
    const merged = withOnPhone([meeting], [note("rec-1", "2026-10-10T19:00:00.000Z")]);
    expect(merged.map((item) => item.id).sort()).toEqual(["m", "on-phone:rec-1"]);
    expect(merged.find((item) => item.id === "m")?.saving).toBeUndefined();
  });

  test("nothing on the phone leaves the rows as they are", () => {
    const rows = [row("a", "rec-a", "2026-10-10T19:00:00.000Z")];
    expect(withOnPhone(rows, [])).toEqual(rows);
  });
});

describe("noteSnippet", () => {
  test("one line of the words, trimmed", () => {
    expect(noteSnippet("  Call the\n landlord  ")).toBe("Call the landlord");
  });
  test("long text is cut at a word with an ellipsis", () => {
    const long = "word ".repeat(40);
    const snippet = noteSnippet(long)!;
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(73);
    expect(snippet.slice(0, -1).endsWith("word")).toBe(true);
  });
  test("no words is null", () => {
    expect(noteSnippet("")).toBeNull();
    expect(noteSnippet("  \n ")).toBeNull();
    expect(noteSnippet(null)).toBeNull();
    expect(noteSnippet(undefined)).toBeNull();
  });
});
