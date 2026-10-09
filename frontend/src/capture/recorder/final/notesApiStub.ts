import { useRef, useState } from "react";
import { parseMoments, type Moment } from "./momentLines";

// TODO(TC-878): this file stands in for the provider's note API (option (a): Markdown is the one source of truth).
// When it lands, delete this file and have PhoneRecorder read `note`, `setNoteText` and `markMoment` from `useRecorder()`.

export interface RecorderNote {
  md: string;
  /** Parsed from `md`: only `m:ss` and `h:mm:ss` lines; every other line is ignored. */
  moments: Moment[];
}

export interface NotesApi {
  note: RecorderNote | null;
  setNoteText(md: string): void;
  /** The recording time in ms, taken now. Persists nothing. */
  markMoment(): number | Promise<number>;
}

/** The API over this screen's own memory. */
export function useNotesApi(
  elapsedMs: () => number,
  initialMd: string | null = null,
): NotesApi {
  const [md, setMd] = useState(initialMd);
  const clock = useRef(elapsedMs);
  clock.current = elapsedMs;
  return {
    note: md === null ? null : { md, moments: parseMoments(md) },
    setNoteText: setMd,
    markMoment: () => clock.current(),
  };
}
