import type { BatchResponse, StreamResponse } from "@/lib/anarlog/transcription.gen";
import type { WhisperModel } from "@/lib/localTranscriber";
import { localTranscriptSentences } from "@/lib/localTranscriptTurns";
import type { LocalTranscript } from "../nativeVoiceNotes";
import { splitLongTimedSegment } from "../timedSegments";

/** Stream result ranges are the VAD chunk bounds; Whisper word offsets are interpolated. */
export function whisperLocalTranscript(
  note: { id: string; durationMs: number; channels?: 1 | 2 }, model: WhisperModel, response: BatchResponse,
  { detail = false, chunks = [] }: { detail?: boolean; chunks?: StreamResponse[] } = {},
): LocalTranscript {
  const alternative = response.results.channels[0]?.alternatives[0];
  const words = alternative?.words ?? [];
  const text = alternative?.transcript.trim() || words.map((word) => word.punctuated_word ?? word.word).join(" ").trim();
  const timedChunks = chunks.filter((chunk): chunk is Extract<StreamResponse, { type: "Results" }> =>
    chunk.type === "Results" && chunk.is_final)
    .map((chunk) => ({ start: Math.max(0, Math.round(chunk.start * 1000)),
      end: Math.min(note.durationMs, Math.round((chunk.start + chunk.duration) * 1000)),
      text: chunk.channel.alternatives[0]?.transcript.trim() ?? "",
      speaker: note.channels === 2 ? chunk.channel_index[0] === 0 ? "Me" : "Them" : null,
      timing: "engine" as const,
      ...(note.channels === 2 && (chunk.channel_index[0] === 0 || chunk.channel_index[0] === 1)
        ? { channel: chunk.channel_index[0] as 0 | 1 } : {}) }))
    .filter((chunk) => chunk.text && chunk.end >= chunk.start)
    .sort((a, b) => a.start - b.start);
  const stereoFallback: LocalTranscript["segments"] = note.channels === 2 ? localTranscriptSentences(response)
    .flatMap((sentence) => splitLongTimedSegment({ start: Math.round(sentence.start_time * 1000),
      end: Math.round(sentence.end_time * 1000), text: sentence.text,
      speaker: sentence.speaker_name === "Others" ? "Them" : "Me",
      channel: sentence.speaker_name === "Others" ? 1 as const : 0 as const,
      timing: "coarse" as const }, 30_000)) : [];
  const segments: LocalTranscript["segments"] = timedChunks.length
    ? timedChunks.flatMap((chunk) => splitLongTimedSegment(chunk, 30_000))
    : stereoFallback.length ? stereoFallback : text ? splitLongTimedSegment({ start: words.length ? Math.max(0, Math.round(words[0]!.start * 1000)) : 0,
      end: words.length ? Math.max(0, Math.round(words.at(-1)!.end * 1000)) : note.durationMs,
      text, speaker: null, timing: "coarse" as const }, 30_000) : [];
  if (detail && segments[0]) {
    segments[0].words = words.length ? words.map((word) => ({
      text: word.punctuated_word ?? word.word, start: word.start, end: word.end,
      channel: word.channel ?? 0, timing: "fallback" as const,
    })) : text.split(/\s+/).map((part) => ({
      text: part, start: 0, end: note.durationMs / 1000, channel: 0, timing: "none" as const,
    }));
  }
  return { version: 2, noteId: note.id, transcriber: "on-device", rev: 1, engine: "whispercpp", model, language: "en",
    outcome: segments.length ? "transcribed" : "no_speech", diarized: note.channels === 2, segments, createdAt: new Date().toISOString() };
}
