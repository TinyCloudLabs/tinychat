// The native contract's web-side helpers (TC-517):
//   1. the recording limit is three hours; a test override can only lower it, never raise it;
//   2. a recording is read from the phone a slice at a time, and a short or changed read rejects
//      (a note is never stored truncated).

import { describe, expect, test } from "bun:test";

import {
  VOICE_NOTE_MAX_DURATION_MS,
  VOICE_NOTE_MAX_DURATION_OVERRIDE_KEY,
  nativeRecordingSource,
  voiceNoteMaxDurationMs,
  type VoiceNoteAudioChunk,
} from "./nativeVoiceNotes";
import { bytesToBase64 } from "./voiceNoteAudio";

const storage = (value: string | null) => ({ getItem: (key: string) => (key === VOICE_NOTE_MAX_DURATION_OVERRIDE_KEY ? value : null) });

describe("voiceNoteMaxDurationMs", () => {
  test("three hours unless a test override lowers it, clamped to [1 s, 3 h]", () => {
    expect(VOICE_NOTE_MAX_DURATION_MS).toBe(10_800_000);
    expect(voiceNoteMaxDurationMs(storage(null))).toBe(10_800_000);
    expect(voiceNoteMaxDurationMs(null)).toBe(10_800_000);
    expect(voiceNoteMaxDurationMs(storage("15000"))).toBe(15_000);
    expect(voiceNoteMaxDurationMs(storage("10"))).toBe(1_000);
    expect(voiceNoteMaxDurationMs(storage(String(6 * 3_600_000)))).toBe(10_800_000);
    expect(voiceNoteMaxDurationMs(storage("nope"))).toBe(10_800_000);
    expect(voiceNoteMaxDurationMs(storage("-5"))).toBe(10_800_000);
  });
});

describe("nativeRecordingSource", () => {
  const file = new Uint8Array(2_500).map((_, i) => i % 256);
  const recording = { id: "rec-1", mimeType: "audio/mp4", sizeBytes: file.byteLength };
  const plugin = (mutate: (chunk: VoiceNoteAudioChunk) => VoiceNoteAudioChunk = (c) => c) => {
    const calls: { id: string; offset: number; length: number }[] = [];
    return {
      calls,
      readAudioChunk: async (options: { id: string; offset: number; length: number }) => {
        calls.push(options);
        const bytes = file.slice(options.offset, options.offset + options.length);
        return mutate({
          id: options.id,
          offset: options.offset,
          base64: bytesToBase64(bytes),
          bytesRead: bytes.byteLength,
          size: file.byteLength,
          eof: options.offset + bytes.byteLength >= file.byteLength,
        });
      },
    };
  };

  test("reads exactly the slice asked for, through readAudioChunk", async () => {
    const native = plugin();
    const source = nativeRecordingSource(recording, native);
    expect(source.size).toBe(2_500);
    expect(source.mimeType).toBe("audio/mp4");
    expect(await source.readPart(1_000, 1_000)).toEqual(file.slice(1_000, 2_000));
    expect(await source.readPart(2_000, 500)).toEqual(file.slice(2_000));
    expect(native.calls).toEqual([
      { id: "rec-1", offset: 1_000, length: 1_000 },
      { id: "rec-1", offset: 2_000, length: 500 },
    ]);
  });

  test("a short read, or a file whose size changed, rejects", async () => {
    const short = nativeRecordingSource(recording, plugin((c) => ({ ...c, base64: bytesToBase64(new Uint8Array(10)), bytesRead: 10 })));
    await expect(short.readPart(0, 1_000)).rejects.toThrow("changed while it was being saved");
    const grown = nativeRecordingSource(recording, plugin((c) => ({ ...c, size: 9_999 })));
    await expect(grown.readPart(0, 1_000)).rejects.toThrow("changed while it was being saved");
  });
});
