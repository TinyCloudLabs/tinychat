import { useMemo } from "react";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { TRANSCRIPT_FALLBACK_NOTE } from "./transcriptProvenanceCopy";

/** One quiet line above a transcript when any sentence came from the backup transcriber: once for the whole list, never per row. */
export function TranscriptProvenanceNote({ sentences }: { sentences: readonly FirefliesSentence[] }) {
  const fallback = useMemo(() => sentences.some((sentence) => sentence.source === "fallback"), [sentences]);
  return fallback ? <p className="text-meta text-muted-foreground" data-testid="transcript-provenance-note">{TRANSCRIPT_FALLBACK_NOTE}</p> : null;
}
