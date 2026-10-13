import { useEffect, useRef, useState } from "react";
import type { RecorderValue } from "../RecorderProvider";
import { createNoteSaver, type NoteSaver } from "./noteSaver";
import { patchNotesUi, readNotesUi } from "./notes/notesUiState";

const AUTOSAVE_MS = 500;

export interface NoteSaving {
  /** The user typed `md`: kept as the draft, committed after a pause. */
  change(md: string): void;
  /** Commits the draft now; rejects (and the failure shows at the recorder level) if it could not be saved. */
  flush(): Promise<void>;
  /** `flush`, for callers with nowhere to show a rejection: it is already shown. */
  saveNow(): void;
  /** An edit is waiting for its pause to end. */
  pending: boolean;
}

/**
 * The note saver, above the sheet: it outlives the sheet closing, and its failures land in the notes UI state, where
 * the recorder shows them. `key` is the recording; a new recording starts a new saver.
 */
export function useNoteSaver(
  key: string | null,
  recorder: Pick<RecorderValue, "noteStatus" | "setNoteText">,
): NoteSaving {
  const [pending, setPending] = useState(false);
  const latest = useRef({ key, recorder });
  latest.current = { key, recorder };
  const held = useRef<{ key: string | null; saver: NoteSaver } | null>(null);

  if (held.current === null || held.current.key !== key) {
    held.current?.saver.cancel();
    held.current = {
      key,
      saver: createNoteSaver({
        commit: async (md) => {
          await latest.current.recorder.setNoteText(md);
          if (key !== null)
            patchNotesUi(key, (f) => (f.draft === md ? { draft: null } : {}));
        },
        delayMs: AUTOSAVE_MS,
        unsaved: key === null ? null : (readNotesUi(key)?.draft ?? null),
        status: recorder.noteStatus,
        onPending: setPending,
        onError: (error) => {
          if (error !== null)
            console.error("[Recorder] Could not save the note", error);
          if (key !== null)
            patchNotesUi(key, () => ({ saveFailed: error !== null }));
        },
      }),
    };
  }
  const saver = held.current.saver;

  useEffect(() => {
    saver.setStatus(recorder.noteStatus);
  }, [saver, recorder.noteStatus]);
  // The view is going away (minimised, or the recording ended): what is typed is committed, and a failure is already
  // in the state. A saver replaced by a new recording's must not write its text into that recording's note.
  useEffect(
    () => () => {
      if (held.current?.saver === saver) saver.flush().catch(() => {});
    },
    [saver],
  );

  return {
    change: (md) => saver.change(md),
    flush: () => saver.flush(),
    saveNow: () => void saver.flush().catch(() => {}),
    pending,
  };
}
