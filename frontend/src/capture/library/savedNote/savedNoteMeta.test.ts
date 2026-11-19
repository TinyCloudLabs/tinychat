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
      { capture: { platform: "ios" }, transcription_outcome: "transcribed", transcript_provider: "whispercpp" },
      "tauri",
      true,
    );
    expect(meta).toContain("1 min");
    expect(meta).toContain("recorded on iPhone");
    expect(meta).toContain("Local transcript");
    expect(meta.endsWith("saved to your space")).toBe(true);
  });

  test("says nothing about the space until the note's pipeline is done (the stepper says where it is)", () => {
    const meta = savedNoteMeta({ ...item, onPhone: true }, {}, "ios", false);
    expect(meta).not.toContain("space");
    expect(meta).not.toContain("saved to your space");
  });


  test("names each transcript by its mode", () => {
    const transcribed = { transcription_outcome: "transcribed" };
    expect(
      savedNoteMeta(item, { ...transcribed, transcript_provider: "tinycloud-private-transcription" }, "ios", false),
    ).toContain("Private transcript");
    expect(savedNoteMeta(item, { ...transcribed, transcript_provider: "assemblyai" }, "ios", false)).toContain(
      "Powerful transcript",
    );
  });

  test("a voice note claims no transcript unless its transcription outcome says it was transcribed", () => {
    const engine = { transcription_engine: "private-cloud", transcript_provider: "tinycloud-private-transcription" };
    for (const outcome of [undefined, "none", "no_speech"]) {
      const meta = savedNoteMeta(item, { ...engine, ...(outcome ? { transcription_outcome: outcome } : {}) }, "ios", false);
      expect(meta).not.toContain("transcript");
    }
  });

  test("an upload's provider still names its transcript", () => {
    const upload = { ...item, source: "exo-upload" } as LibraryItem;
    expect(savedNoteMeta(upload, { transcript_provider: "tinycloud-private-transcription" }, "ios", false)).toContain(
      "Private transcript",
    );
  });

  test("names the transcription model only beside a transcript that names its maker", () => {
    const transcribed = { transcription_outcome: "transcribed", transcript_provider: "whispercpp", transcription_model: "QuantizedTinyEn" };
    expect(savedNoteMeta(item, transcribed, "tauri", false)).toContain("Whisper Tiny (English)");
    expect(savedNoteMeta(item, { ...transcribed, transcription_model: undefined }, "tauri", false)).not.toContain("Whisper");
    expect(savedNoteMeta(item, { transcription_model: "QuantizedTinyEn" }, "tauri", false)).not.toContain("Whisper");
  });

  test("leaves out what is not known", () => {
    const meta = savedNoteMeta(item, null, "web", false);
    expect(meta).not.toContain("recorded on");
    expect(meta).not.toContain("transcript");
  });
});
