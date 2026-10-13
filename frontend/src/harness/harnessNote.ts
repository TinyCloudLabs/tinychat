import { useState } from "react";
import type { RecorderValue } from "@/capture/recorder/RecorderProvider";
import { parseMomentLines } from "@/lib/voiceNotes/recordingNotes";

/** The note half of a RecorderValue over this screen's own memory: ready, writes land at once, a moment is at `atMs`. */
export function useHarnessNote(
  initialMd: string | null,
  atMs: number,
): Pick<RecorderValue, "note" | "noteStatus" | "setNoteText" | "markMoment"> {
  const [md, setMd] = useState(initialMd);
  return {
    note: md === null ? null : { md, moments: parseMomentLines(md) },
    noteStatus: "ready",
    setNoteText: async (next) => setMd(next),
    markMoment: () => atMs,
  };
}
