import type { BatchResponse } from "@/lib/anarlog/transcription.gen";
import type { WhisperModel } from "@/lib/localTranscriber";
import type { LocalTranscript } from "../nativeVoiceNotes";

/** Convert the desktop Whisper response without changing the persisted mono transcript. */
export function whisperLocalTranscript(
  note: { id: string; durationMs: number }, model: WhisperModel, response: BatchResponse,
  { detail = false, rev = 1, rerunBase }: { detail?: boolean; rev?: number; rerunBase?: { rev: number; hash: string } } = {},
): LocalTranscript {
  const alternative = response.results.channels[0]?.alternatives[0];
  const words = alternative?.words ?? [];
  const text = alternative?.transcript.trim() || words.map((word) => word.punctuated_word ?? word.word).join(" ").trim();
  const segments: LocalTranscript["segments"] = text ? [{ start: words.length ? Math.max(0, Math.round(words[0]!.start * 1000)) : 0,
    end: words.length ? Math.max(0, Math.round(words.at(-1)!.end * 1000)) : note.durationMs,
    text, speaker: null }] : [];
  if (detail && segments[0]) {
    segments[0].words = words.length ? words.map((word) => ({
      text: word.punctuated_word ?? word.word, start: word.start, end: word.end,
      channel: word.channel ?? 0, timing: "fallback" as const,
    })) : text.split(/\s+/).map((part) => ({
      text: part, start: 0, end: note.durationMs / 1000, channel: 0, timing: "none" as const,
    }));
  }
  return { version: 1, noteId: note.id, transcriber: "on-device", rev, engine: "whispercpp", model, language: "en",
    outcome: segments.length ? "transcribed" : "no_speech", diarized: false, segments, createdAt: new Date().toISOString(),
    ...(rerunBase ? { rerunBase } : {}) };
}
