import { expect, test } from "bun:test";
import type { BatchResponse } from "@/lib/anarlog/transcription.gen";
import { whisperLocalTranscript } from "./whisperTranscript";

// The response Soniqo's batch runner returns (anarlog @864ddc1, crates/transcribe-soniqo/src/responses.rs,
// `batch_words_from_chunks`): one channel per audio channel, each 29.5 s window's text with made-up word times,
// 0.4 s a word from the window's start, squeezed into the window when the text is longer. No stream results.
const WINDOW = 29.5;

function soniqoChannel(channel: number, windows: (string | null)[]) {
  const words = windows.flatMap((text, index) => {
    const parts = text ? text.split(/\s+/) : [];
    const start = index * WINDOW;
    const duration = Math.min(parts.length * 0.4, WINDOW);
    return parts.map((word, i) => ({
      word, punctuated_word: word, confidence: 1, channel, speaker: null,
      start: start + (i / parts.length) * duration, end: start + ((i + 1) / parts.length) * duration,
    }));
  });
  return { alternatives: [{ transcript: windows.filter(Boolean).join(" "), confidence: 1, words }] };
}

function soniqoResponse(seconds: number, channels: (string | null)[][]): BatchResponse {
  return {
    metadata: { duration: seconds, channels: channels.length, timing_source: "synthetic_text" },
    results: { channels: channels.map((windows, channel) => soniqoChannel(channel, windows)) },
  } as unknown as BatchResponse;
}

test("a stereo Parakeet recording becomes coarse Me and Them turns, ordered only to the window", () => {
  const response = soniqoResponse(60, [
    ["Can you hear me now?", "Good, let us start."],
    ["Yes, I can hear you.", null],
  ]);
  const transcript = whisperLocalTranscript({ id: "note", durationMs: 60_000, channels: 2 }, "soniqo-parakeet-batch", response);
  expect(transcript.segments.map(({ speaker, channel, text, timing }) => ({ speaker, channel, text, timing }))).toEqual([
    { speaker: "Me", channel: 0, text: "Can you hear me now?", timing: "coarse" },
    { speaker: "Them", channel: 1, text: "Yes, I can hear you.", timing: "coarse" },
    { speaker: "Me", channel: 0, text: "Good, let us start.", timing: "coarse" },
  ]);
  // Both sides' first words are placed at the window's start: the order inside a window is not known.
  expect(transcript.segments[0]!.start).toBe(0);
  expect(transcript.segments[1]!.start).toBe(0);
  expect(transcript.segments[2]!.start).toBe(29_500);
  expect(transcript).toMatchObject({ engine: "parakeet-tdt-0.6b-v3", model: "soniqo-parakeet-batch", outcome: "transcribed", diarized: true });
});

test("a long Parakeet window is split into turns of 30 s at most, with no stream results", () => {
  const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ");
  const response = soniqoResponse(29.5, [[long], [null]]);
  const transcript = whisperLocalTranscript({ id: "note", durationMs: 29_500, channels: 2 }, "soniqo-parakeet-batch", response);
  expect(transcript.segments.length).toBeGreaterThan(0);
  expect(transcript.segments.every((segment) => segment.end - segment.start <= 30_000 && segment.speaker === "Me")).toBe(true);
  expect(transcript.segments.map((segment) => segment.text).join(" ").split(/\s+/)).toHaveLength(120);
});

test("a mono Parakeet recording is one unnamed coarse span; silence on every channel is no speech", () => {
  const mono = whisperLocalTranscript({ id: "note", durationMs: 31_000 }, "soniqo-parakeet-batch",
    soniqoResponse(31, [["One two three.", "Four."]]));
  expect(mono.segments).toEqual([{ start: 0, end: 29_900, text: "One two three. Four.", speaker: null, timing: "coarse" }]);
  expect(mono.diarized).toBe(false);
  const silent = whisperLocalTranscript({ id: "note", durationMs: 60_000, channels: 2 }, "soniqo-parakeet-batch",
    soniqoResponse(60, [[null, null], [null, null]]));
  expect(silent).toMatchObject({ outcome: "no_speech", segments: [], engine: "parakeet-tdt-0.6b-v3" });
});

test("Whisper transcripts keep the whispercpp engine", () => {
  const transcript = whisperLocalTranscript({ id: "note", durationMs: 1000 }, "QuantizedTinyEn", soniqoResponse(1, [["Hi."]]));
  expect(transcript).toMatchObject({ engine: "whispercpp", model: "QuantizedTinyEn" });
});
