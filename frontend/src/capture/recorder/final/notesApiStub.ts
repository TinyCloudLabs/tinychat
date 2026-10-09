import { useRef, useState } from "react";
import { parseMoments, type Moment } from "./momentLines";
import type { NotesUi } from "./notes";

// TODO(TC-878): this file stands in for the provider's note API (option (a): Markdown is the one source of truth).
// When it lands, delete this file and have PhoneRecorder read `note`, `setNoteText` and `markMoment` from `useRecorder()`.

export interface RecorderNote {
  md: string;
  /** Parsed from `md`: only `m:ss` and `h:mm:ss` lines; every other line is ignored. */
  moments: Moment[];
}

/** Mirrors `recorder.noteStatus`: the note is read before it can be written. */
export type NoteStatus = "loading" | "ready" | "error";

export interface NotesApi {
  noteStatus: NoteStatus;
  note: RecorderNote | null;
  /** Rejects until `noteStatus` is "ready", and when the write fails. */
  setNoteText(md: string): void | Promise<void>;
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
    noteStatus: "ready",
    note: md === null ? null : { md, moments: parseMoments(md) },
    setNoteText: setMd,
    markMoment: () => clock.current(),
  };
}

/** The API over the notes UI state shared by both layouts, so a layout switch keeps the note. */
export function notesApiOver(
  ui: Pick<NotesUi, "noteMd" | "setNoteMd">,
  elapsedMs: () => number,
  noteStatus: NoteStatus = "ready",
): NotesApi {
  return {
    noteStatus,
    note:
      ui.noteMd === null
        ? null
        : { md: ui.noteMd, moments: parseMoments(ui.noteMd) },
    async setNoteText(md) {
      if (noteStatus !== "ready") {
        throw new Error(`The note is ${noteStatus}, not ready`);
      }
      ui.setNoteMd(md);
    },
    markMoment: () => elapsedMs(),
  };
}
