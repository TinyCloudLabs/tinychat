import { describe, expect, test } from "bun:test";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import type { LibraryItem } from "../LibraryRow";
import { savedNoteMeta } from "./savedNoteMeta";

const item = {
  id: "i",
  sourceId: "rec-1",
  source: VOICE_NOTE_SOURCE,
  title: "Standup",
  startedAt: "2026-10-08T12:10:00",
  durationSecs: 60,
} as unknown as LibraryItem;

describe("savedNoteMeta", () => {
  test("says where it was recorded, how it was transcribed and that it is saved", () => {
    const meta = savedNoteMeta(
      item,
      { capture: { platform: "ios" }, transcript_provider: "whispercpp" },
      "tauri",
    );
    expect(meta).toContain("1 min");
    expect(meta).toContain("recorded on iPhone");
    expect(meta).toContain("Local transcript");
    expect(meta.endsWith("saved to your space")).toBe(true);
  });

  test("names the private cloud route", () => {
    expect(
      savedNoteMeta(item, { transcript_provider: "tinycloud-private-transcription" }, "ios"),
    ).toContain("Private cloud transcript");
  });

  test("leaves out what is not known", () => {
    const meta = savedNoteMeta(item, null, "web");
    expect(meta).not.toContain("recorded on");
    expect(meta).not.toContain("transcript");
  });
});
