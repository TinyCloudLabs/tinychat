import type { BatchResponse } from "@/lib/anarlog/transcription.gen";
import type { WhisperModel } from "@/lib/localTranscriber";
import type { LocalTranscript } from "../nativeVoiceNotes";
import { localTranscriptSentences } from "@/lib/localTranscriptTurns";

/** Convert the desktop Whisper response without changing the persisted mono transcript. */
export function whisperLocalTranscript(
  note: { id: string; durationMs: number; channels?: 1 | 2 }, model: WhisperModel, response: BatchResponse,
  { detail = false, envelope }: { detail?: boolean; envelope?: readonly (readonly [number, number])[] } = {},
): LocalTranscript {
  if (note.channels === 2) {
    const loudness = envelope ? (channel: number, start: number, end: number) => {
      const first = Math.max(0, Math.floor(start * 10));
      const last = Math.max(first + 1, Math.ceil(end * 10));
      let sum = 0;
      let count = 0;
      for (let bin = first; bin < last && bin < envelope.length; bin++) {
        sum += envelope[bin]?.[channel] ?? 0;
        count++;
      }
      return count ? sum / count : 0;
    } : undefined;
    const turns = localTranscriptSentences(response, { detail, loudness });
    const segments: LocalTranscript["segments"] = turns.map((turn) => ({
      start: Math.max(0, Math.round(turn.start_time * 1000)),
      end: Math.max(0, Math.round(turn.end_time * 1000)),
      text: turn.text, speaker: turn.speaker_name,
    }));
    return { version: 1, noteId: note.id, transcriber: "on-device", rev: 1, engine: "whispercpp", model,
      language: "en", outcome: segments.length ? "transcribed" : "no_speech", diarized: true,
      segments, createdAt: new Date().toISOString() };
  }
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
  return { version: 1, noteId: note.id, transcriber: "on-device", rev: 1, engine: "whispercpp", model, language: "en",
    outcome: segments.length ? "transcribed" : "no_speech", diarized: false, segments, createdAt: new Date().toISOString() };
}
