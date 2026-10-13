import { describe, expect, test } from "bun:test";
import type { BatchResponse, StreamResponse } from "@/lib/anarlog/transcription.gen";
import { assemblyAiSentences } from "../assemblyai";
import { whisperLocalTranscript } from "./desktop/whisperTranscript";
import type { LocalTranscript } from "./nativeVoiceNotes";
import { transcriptHash } from "./voiceNoteRows";
import { localTranscriptToSave } from "./voiceNoteStore";
import { voiceNoteSentences } from "./voiceNoteTranscription";
import { splitLongTimedSegment } from "./timedSegments";

function bounded(rows: { start: number; end: number }[], max: number) {
  expect(rows.length).toBeGreaterThan(0);
  for (const [index, row] of rows.entries()) {
    expect(row.end - row.start).toBeLessThanOrEqual(max);
    expect(row.start).toBeGreaterThanOrEqual(0);
    expect(row.end).toBeGreaterThanOrEqual(row.start);
    if (index) expect(row.start).toBeGreaterThanOrEqual(rows[index - 1]!.start);
  }
}

describe("timed engine fixtures", () => {
  test("sparse speech and long silence keep words intact with coarse timing", () => {
    const one = splitLongTimedSegment({ start: 0, end: 65, text: "hello", timing: "engine" as const }, 30);
    expect(one).toMatchObject([{ start: 0, end: 65, text: "hello", timing: "coarse" }]);
    const sparse = splitLongTimedSegment({ start: 0, end: 65, text: "hello  world", timing: "engine" as const }, 30);
    expect(sparse.map((s) => s.text).join("")).toBe("hello  world");
    expect(sparse.map((s) => s.timing)).toEqual(["coarse", "coarse"]);
  });

  test("overlapping long channels are ordered after splitting", () => {
    const text = "one two three four five six";
    const ptx = voiceNoteSentences({ channels: 2, segments: [
      { start: 0, end: 65, text, channel: 0 }, { start: 10, end: 12, text: "yes", channel: 1 },
    ] });
    expect(ptx.map((s) => [s.start_time, s.channel, s.index])).toEqual([
      [0, 0, 0], [10, 1, 1], [21.666666666666668, 0, 2], [43.333333333333336, 0, 3],
    ]);
    const response = { metadata: null, results: { channels: [{ alternatives: [{ transcript: text }] }] } } as BatchResponse;
    const chunks = [
      { type: "Results", is_final: true, start: 0, duration: 65, channel_index: [0], channel: { alternatives: [{ transcript: text }] } },
      { type: "Results", is_final: true, start: 10, duration: 2, channel_index: [1], channel: { alternatives: [{ transcript: "yes" }] } },
    ] as StreamResponse[];
    const whisper = whisperLocalTranscript({ id: "n", durationMs: 65_000, channels: 2 }, "QuantizedTinyEn", response, { chunks }).segments;
    expect(whisper.map((s) => s.channel)).toEqual([0, 1, 0, 0]);
    expect(whisper.map((s) => s.start)).toEqual([...whisper.map((s) => s.start)].sort((a, b) => a - b));
  });
  test("Mac Whisper uses VAD chunk bounds for mono and keeps overlapping stereo channels", () => {
    const response = { metadata: null, results: { channels: [{ alternatives: [{ transcript: "Hello. Yes.", confidence: 1 }] }] } } as BatchResponse;
    const chunks = [
      { type: "Results", is_final: true, start: 0, duration: 12, channel_index: [0],
        channel: { alternatives: [{ transcript: "Hello." }] } },
      { type: "Results", is_final: true, start: 8, duration: 10, channel_index: [1],
        channel: { alternatives: [{ transcript: "Yes." }] } },
    ] as StreamResponse[];
    const mono = whisperLocalTranscript({ id: "n", durationMs: 20_000 }, "QuantizedTinyEn", response, { chunks: [chunks[0]!] });
    expect(mono.segments).toMatchObject([{ start: 0, end: 12_000, timing: "engine" }]);
    expect(mono.segments[0]?.channel).toBeUndefined();
    const stereo = whisperLocalTranscript({ id: "n", durationMs: 20_000, channels: 2 }, "QuantizedTinyEn", response, { chunks });
    expect(stereo.segments.map((s) => s.channel)).toEqual([0, 1]);
    expect(stereo.segments.map((s) => s.speaker)).toEqual(["Me", "Them"]);
    bounded(stereo.segments, 30_000);
  });

  test("Whisper whole-response fallback exposes coarse bounds", () => {
    const response = { metadata: null, results: { channels: [{ alternatives: [{ transcript: "One two three four five six.", confidence: 1 }] }] } } as BatchResponse;
    const rows = whisperLocalTranscript({ id: "n", durationMs: 65_000 }, "QuantizedTinyEn", response).segments;
    bounded(rows, 30_000);
    expect(rows.every((s) => s.timing === "coarse")).toBe(true);
  });

  test("Android VAD offsets survive local-to-cloud conversion", () => {
    const local: LocalTranscript = { version: 2, noteId: "n", transcriber: "on-device", rev: 1,
      engine: "parakeet-tdt-0.6b-v3", model: null, language: "en", outcome: "transcribed", diarized: false,
      createdAt: "2026-10-13T00:00:00Z", segments: [
        { start: 1_500, end: 20_000, text: "First.", speaker: null, timing: "engine" },
        { start: 23_000, end: 45_000, text: "Second.", speaker: null, timing: "engine" },
      ] };
    const rows = localTranscriptToSave(local).sentences;
    bounded(rows.map((s) => ({ start: s.start_time, end: s.end_time })), 30);
    expect(rows.map((s) => s.timing)).toEqual(["engine", "engine"]);
    expect(localTranscriptToSave({ ...local, version: 1 }).sentences[0]?.speaker_name).toBe("You");
  });

  test("PTX keeps regions, channels and diarized speaker IDs", () => {
    const rows = voiceNoteSentences({ diarized: true, speakers: [{ id: "speaker_0", name: "Speaker 1", channel: 0 }],
      segments: [
        { start: 2, end: 20, text: "Hello.", channel: 0, speaker_id: "speaker_0" },
        { start: 21, end: 55, text: "A longer sentence with several words to split.", channel: 1, speaker_id: "speaker_1" },
      ] });
    bounded(rows.map((s) => ({ start: s.start_time, end: s.end_time })), 30);
    expect(rows.map((s) => s.channel)).toEqual([0, 1, 1]);
    expect(rows.map((s) => s.speaker_name)).toEqual(["Speaker 1", "Speaker 2", "Speaker 2"]);
    expect(rows.map((s) => s.timing)).toEqual(["engine", "coarse", "coarse"]);
    const stereo = voiceNoteSentences({ channels: 2, segments: [
      { start: 0, end: 3, text: "Morning.", channel: 0 },
      { start: 2, end: 4, text: "Hello.", channel: 1 },
    ] });
    expect(stereo.map((s) => [s.channel, s.speaker_name])).toEqual([[0, "Me"], [1, "Them"]]);
  });

  test("Powerful uses sentence word times and retains channel identity", () => {
    const rows = assemblyAiSentences({ id: "a", status: "completed" }, [
      { start: 0, end: 40_000, text: "One. Two.", speaker: "A", channel: 0,
        words: [{ start: 0, end: 10_000, text: "One." }, { start: 31_000, end: 40_000, text: "Two." }] },
      { start: 32_000, end: 35_000, text: "Yes.", speaker: "B", channel: 1 },
    ]);
    bounded(rows.map((s) => ({ start: s.start_time, end: s.end_time })), 30);
    expect(rows.map((s) => s.channel)).toEqual([0, 0, 1]);
    expect(rows.map((s) => s.timing)).toEqual(["engine", "engine", "engine"]);
  });

  test("segmented body hashes are deterministic", async () => {
    const rows = voiceNoteSentences({ segments: [{ start: 0, end: 2, text: "Hello.", channel: 0 }] });
    expect(await transcriptHash(rows)).toBe(await transcriptHash(structuredClone(rows)));
  });
});
