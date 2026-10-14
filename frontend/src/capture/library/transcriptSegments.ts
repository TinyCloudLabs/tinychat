import type { TranscriptProvenance } from "@/lib/voiceNotes/voiceNoteCommits";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { formatClockDuration } from "./formatters";
import { MAX_TURN_SECONDS } from "@/lib/localTranscriptTurns";

export function hasPrivateCloudTimingProvenance(metadata: unknown, committed?: TranscriptProvenance | null): boolean {
  if (committed !== undefined && committed !== null) {
    return committed.engine === "private-cloud"
      || committed.provider === "tinycloud-private-transcription";
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const fields = metadata as Record<string, unknown>;
  return fields.transcription_engine === "private-cloud"
    || fields.transcript_provider === "tinycloud-private-transcription";
}
export function sentenceTime(sentence: FirefliesSentence, isPrivateCloud = false): number | null {
  if ("timing" in sentence && sentence.timing !== "engine") return null;
  const { start_time: start, end_time: end } = sentence;
  const maxSpan = isPrivateCloud ? MAX_TURN_SECONDS : 30;
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end - start <= maxSpan ? start : null;
}

/** Legacy 0/0 bodies and coarse whole-note spans have no useful seek point. */
export function hasSegmentTimes(sentences: readonly FirefliesSentence[], isPrivateCloud = false): boolean {
  return sentences.length > 0 && sentences.filter((sentence) => sentenceTime(sentence, isPrivateCloud) !== null).length > sentences.length / 2;
}

export function transcriptWithTimestamps(sentences: readonly FirefliesSentence[], isPrivateCloud = false): string {
  return sentences.map((sentence) => {
    const time = sentenceTime(sentence, isPrivateCloud);
    const clock = time === null ? null : formatClockDuration(Math.floor(time));
    const prefix = clock === null ? "" : `[${clock.split(":").length === 2 ? clock.padStart(5, "0") : clock}] `;
    return `${prefix}${sentence.speaker_name ? `${sentence.speaker_name}: ` : ""}${sentence.text}`;
  }).join("\n");
}

export function transcriptMarkdown(title: string, date: string | null, sentences: readonly FirefliesSentence[],
  isPrivateCloud = false): string {
  const heading = `# ${title.replaceAll(/\s+/g, " ").trim() || "Untitled"}`;
  return [heading, date ? new Date(date).toLocaleString() : null, "## Transcript", transcriptWithTimestamps(sentences, isPrivateCloud)]
    .filter((part): part is string => part !== null).join("\n\n") + "\n";
}
