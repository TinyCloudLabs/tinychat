import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { formatClockDuration } from "./formatters";

export function sentenceTime(sentence: FirefliesSentence): number | null {
  if ("timing" in sentence && sentence.timing !== "engine") return null;
  const { start_time: start, end_time: end } = sentence;
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end - start <= 30 ? start : null;
}

/** Legacy 0/0 bodies and coarse whole-note spans have no useful seek point. */
export function hasSegmentTimes(sentences: readonly FirefliesSentence[]): boolean {
  return sentences.length > 0 && sentences.filter((sentence) => sentenceTime(sentence) !== null).length > sentences.length / 2;
}

export function transcriptWithTimestamps(sentences: readonly FirefliesSentence[]): string {
  return sentences.map((sentence) => {
    const time = sentenceTime(sentence);
    const clock = time === null ? null : formatClockDuration(Math.floor(time));
    const prefix = clock === null ? "" : `[${clock.split(":").length === 2 ? clock.padStart(5, "0") : clock}] `;
    return `${prefix}${sentence.speaker_name ? `${sentence.speaker_name}: ` : ""}${sentence.text}`;
  }).join("\n");
}

export function transcriptMarkdown(title: string, date: string | null, sentences: readonly FirefliesSentence[]): string {
  const heading = `# ${title.replaceAll(/\s+/g, " ").trim() || "Untitled"}`;
  return [heading, date ? new Date(date).toLocaleString() : null, "## Transcript", transcriptWithTimestamps(sentences)]
    .filter((part): part is string => part !== null).join("\n\n") + "\n";
}
