import { createAutosave } from "./autosave";
import type { NoteStatus } from "./notesApiStub";

export interface NoteSaverDeps {
  /** Writes the note; rejects until the note is ready, or when the write fails. */
  commit(md: string): Promise<void>;
  delayMs: number;
  /** Text typed earlier and never committed (kept in the notes UI state across a layout switch). */
  unsaved: string | null;
  status: NoteStatus;
  onPending(pending: boolean): void;
  /** The last commit failed (the error), or the next one worked (null). The text stays unsaved. */
  onError(error: unknown | null): void;
}

/**
 * Commits typed note text through `setNoteText`, only once the note is ready. Text typed before then, or whose
 * commit failed, stays unsaved and is committed when the note is ready, or on the next flush. It is never dropped
 * and never committed early. A failure is reported once; nothing retries on its own.
 */
export function createNoteSaver(deps: NoteSaverDeps) {
  let unsaved = deps.unsaved;
  let status = deps.status;
  const run = (md: string) => {
    deps.commit(md).then(
      () => {
        if (unsaved === md) unsaved = null;
        deps.onError(null);
      },
      (error: unknown) => deps.onError(error),
    );
  };
  const autosave = createAutosave(run, deps.delayMs, deps.onPending);
  const commitUnsaved = () => {
    if (status === "ready" && unsaved !== null) autosave.schedule(unsaved);
  };

  return {
    change(md: string): void {
      unsaved = md;
      commitUnsaved();
    },
    setStatus(next: NoteStatus): void {
      status = next;
      commitUnsaved();
    },
    /** Commits now whatever is unsaved, if the note is ready. */
    flush(): void {
      commitUnsaved();
      autosave.flush();
    },
    get unsaved(): string | null {
      return unsaved;
    },
  };
}
