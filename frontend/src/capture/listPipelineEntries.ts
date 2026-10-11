import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { LibraryItem } from "./library/LibraryRow";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import type { NotePipelineSource } from "@/lib/voiceNotes/useNotePipeline";

/** The one list-hook input for each voice note, including metadata already returned by the listing. */
export function listPipelineEntries(items: readonly LibraryItem[], tcw: TinyCloudWeb) {
  return items
    .filter((item) => item.source === VOICE_NOTE_SOURCE)
    .map((item) => ({
      id: item.sourceId,
      // Preserve the listing's three pipeline fields when present. `null`
      // means the query confirmed no row metadata; `undefined` lets P4 batch
      // read metadata when the listing could not provide it.
      source: { tcw, saved: !item.onPhone, metadata: item.metadata } satisfies NotePipelineSource,
    }));
}
