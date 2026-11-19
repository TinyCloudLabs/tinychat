import { useMemo } from "react";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { TRANSCRIPT_FALLBACK_NOTE } from "./transcriptProvenanceCopy";

/** One quiet line above a transcript when any sentence was filled in automatically (recovered or backup): once for the whole list, never per row. */
export function TranscriptProvenanceNote({ sentences }: { sentences: readonly FirefliesSentence[] }) {
  const filled = useMemo(() => sentences.some((sentence) => sentence.source === "fallback" || sentence.source === "recording"), [sentences]);
  return filled ? <p className="text-meta text-muted-foreground" data-testid="transcript-provenance-note">{TRANSCRIPT_FALLBACK_NOTE}</p> : null;
}
