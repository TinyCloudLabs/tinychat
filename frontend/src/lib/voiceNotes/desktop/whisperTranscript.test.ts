import { expect, test } from "bun:test";
import { whisperLocalTranscript } from "./whisperTranscript";

test("stereo Whisper words become time ordered Me and Them turns", () => {
  const response = { results: { channels: [
    { alternatives: [{ transcript: "Ask again", words: [
      { word: "Ask", start: 0, end: 0.4, channel: 0 },
      { word: "again", start: 0.5, end: 1, channel: 0 },
    ] }] },
    { alternatives: [{ transcript: "Yes", words: [
      { word: "Yes", start: 0.6, end: 1.1, channel: 1 },
    ] }] },
  ] } };
  const transcript = whisperLocalTranscript({ id: "note", durationMs: 2000, channels: 2 }, "QuantizedTinyEn", response as never);
  expect(transcript.segments).toEqual([
    { start: 0, end: 1000, text: "Ask again", speaker: "Me" },
    { start: 600, end: 1100, text: "Yes", speaker: "Them" },
  ]);
  expect(transcript.diarized).toBe(true);
});

test("a silent right channel produces no Them turn", () => {
  const response = { results: { channels: [
    { alternatives: [{ transcript: "Hello", words: [{ word: "Hello", start: 0.2, end: 0.6, channel: 0 }] }] },
    { alternatives: [{ transcript: "", words: [] }] },
  ] } };
  const transcript = whisperLocalTranscript({ id: "note", durationMs: 1000, channels: 2 }, "QuantizedTinyEn", response as never);
  expect(transcript.segments.map((segment) => segment.speaker)).toEqual(["Me"]);
});
