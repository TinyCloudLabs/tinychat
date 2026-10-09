import { readNotesUi, retainUnsavedNote } from "./notes/notesUiState";

export interface DoneGate {
  /** The unsaved text whose failed save the user has already been shown; Done for that same text goes through. */
  acknowledged: string | null;
}

/**
 * Done: waits for the note to be saved before the recording stops. If the save fails it stops there and leaves the
 * failure showing (the saver reported it); Done again for the same unsaved text ends the recording anyway, and `onUnsaved`
 * gets the error and the text that was lost, to keep it where the saved receipt can show it.
 */
export async function finishWithNote(
  gate: DoneGate,
  deps: {
    flush(): Promise<void>;
    unsaved(): string | null;
    stop(): void;
    onUnsaved(error: unknown, unsaved: string): void;
  },
): Promise<"stopped" | "blocked"> {
  try {
    await deps.flush();
  } catch (error) {
    const unsaved = deps.unsaved() ?? "";
    if (gate.acknowledged !== unsaved) {
      gate.acknowledged = unsaved;
      return "blocked";
    }
    deps.onUnsaved(error, unsaved);
  }
  deps.stop();
  return "stopped";
}

/**
 * Done as the phone recorder does it: `finishWithNote` over the notes UI state of recording `key`. When the second
 * Done ends the recording with its note unsaved, the lost text is retained (`retainUnsavedNote`) for the saved
 * receipt, which outlives the recorder view and the recording's own state.
 */
export function finishRecording(
  gate: DoneGate,
  key: string | null,
  deps: { flush(): Promise<void>; stop(): void },
): Promise<"stopped" | "blocked"> {
  return finishWithNote(gate, {
    flush: deps.flush,
    unsaved: () => (key === null ? null : (readNotesUi(key)?.draft ?? null)),
    stop: deps.stop,
    onUnsaved: (error, lost) => {
      console.error("[Recorder] Finishing with an unsaved note", error);
      if (key !== null) retainUnsavedNote(key, lost);
    },
  });
}
