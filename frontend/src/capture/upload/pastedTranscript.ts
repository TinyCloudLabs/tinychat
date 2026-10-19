import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { captureEvents } from "@/capture/captureEvents";
import { commitVoiceNoteTranscript, createPastedTranscriptRow } from "@/lib/voiceNotes/voiceNoteRows";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";

export const PASTED_TRANSCRIPT_MAX_BYTES = 1_000_000;

export function pastedTranscriptProblem(text: string): string | null {
  if (!text.trim()) return "Paste a transcript to continue.";
  if (new TextEncoder().encode(text).byteLength > PASTED_TRANSCRIPT_MAX_BYTES)
    return "Transcript is too large (maximum 1 MB).";
  return null;
}

/** Keep plain prose intact; split only lines that carry a speaker or clock. */
export function parsePastedTranscript(text: string): FirefliesSentence[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const structured = lines.some((line) => /^\s*(?:\[(?:\d+:)?\d{1,2}:\d{2}\]|[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,60}:\s+\S)/u.test(line));
  if (!structured) return [{ index: 0, speaker_name: null, text: lines.join("\n"), start_time: 0, end_time: 0 }];
  const sentences: FirefliesSentence[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:\[((?:\d+:)?\d{1,2}:\d{2})\]\s*)?(?:([\p{L}\p{N}][\p{L}\p{N} ._'-]{0,60}):\s+)?(.*)$/u);
    if (!match) continue;
    const [, clock, speaker, body] = match;
    if (!body?.trim()) {
      if (sentences.length) sentences[sentences.length - 1]!.text += "\n";
      continue;
    }
    const parts = clock?.split(":").map(Number) ?? [];
    const start = parts.reduce((seconds, value) => seconds * 60 + value, 0);
    sentences.push({ index: sentences.length, speaker_name: speaker?.trim() ?? null,
      text: body, start_time: start, end_time: start });
  }
  return sentences.length ? sentences : [{ index: 0, speaker_name: null, text, start_time: 0, end_time: 0 }];
}

export async function savePastedTranscript(tcw: TinyCloudWeb, input: { text: string; title?: string; date?: string }): Promise<string> {
  const problem = pastedTranscriptProblem(input.text);
  if (problem) throw new Error(problem);
  const sourceId = crypto.randomUUID();
  const sentences = parsePastedTranscript(input.text);
  const title = input.title?.trim() || "Pasted transcript";
  const startedAt = input.date ? new Date(`${input.date}T12:00:00`).toISOString() : new Date().toISOString();
  await createPastedTranscriptRow(tcw, sourceId, title, startedAt);
  await commitVoiceNoteTranscript(tcw, sourceId, {
    rev: 1, sentences, outcome: "transcribed", text: input.text.replaceAll("\r\n", "\n"),
    engine: "pasted", provider: "pasted", speakerLabels: sentences.some((sentence) => sentence.speaker_name !== null),
    participants: [...new Set(sentences.map((sentence) => sentence.speaker_name).filter((name): name is string => name !== null))],
  });
  captureEvents.emit("library-changed", { source: VOICE_NOTE_SOURCE, sourceId });
  return sourceId;
}
