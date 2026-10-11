import { createContext } from "react";

import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";

/** The pipeline of the note an open saved-note sheet or page shows, for the transcript section inside it; null outside one. */
export const NotePipelineContext = createContext<NotePipelineView | null>(null);
