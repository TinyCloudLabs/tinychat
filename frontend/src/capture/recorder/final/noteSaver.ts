import type { RecorderNoteStatus } from "../voiceNoteRecorderController";

export interface NoteSaverDeps {
  /** Writes the note; rejects until the note is ready, or when the write fails. */
  commit(md: string): Promise<void>;
  delayMs: number;
  /** Text typed earlier and never committed (kept in the notes UI state across a layout switch). */
  unsaved: string | null;
  status: RecorderNoteStatus;
  onPending(pending: boolean): void;
  /** A write failed (the error), or the next one worked (null). The text stays unsaved. */
  onError(error: unknown | null): void;
}

export interface NoteSaver {
  /** The user typed `md`; it is committed after the delay, once the note is ready. */
  change(md: string): void;
  setStatus(status: RecorderNoteStatus): void;
  /**
   * Commits what is unsaved now and resolves when it is durable (also when it was already). Rejects, after
   * `onError` has seen it, if the note is not ready or the write fails; the text stays unsaved.
   */
  flush(): Promise<void>;
  /** Stops the timer without writing: the recording this saver served is gone. */
  cancel(): void;
  readonly unsaved: string | null;
}

/**
 * Commits typed note text through `setNoteText`, only once the note is ready. Text typed before then, or whose
 * commit failed, stays unsaved and is committed when the note is ready, or on the next flush. It is never dropped
 * and never committed early. A failure is reported once; nothing retries on its own.
 */
export function createNoteSaver(deps: NoteSaverDeps): NoteSaver {
  let unsaved = deps.unsaved;
  let status = deps.status;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: { md: string; done: Promise<void> } | null = null;

  const stopTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    deps.onPending(false);
  };
  const write = (md: string): Promise<void> => {
    const after = inflight ? inflight.done.catch(() => {}) : Promise.resolve();
    const done: Promise<void> = after
      .then(() => deps.commit(md))
      .then(
        () => {
          if (unsaved === md) unsaved = null;
          deps.onError(null);
        },
        (error: unknown) => {
          deps.onError(error);
          throw error;
        },
      )
      .finally(() => {
        if (inflight?.done === done) inflight = null;
      });
    inflight = { md, done };
    return done;
  };
  const flush = (): Promise<void> => {
    stopTimer();
    if (unsaved === null) return inflight?.done ?? Promise.resolve();
    if (inflight?.md === unsaved) return inflight.done;
    if (status !== "ready") {
      const error = new Error(`The note is ${status}, not ready`);
      deps.onError(error);
      return Promise.reject(error);
    }
    return write(unsaved);
  };
  const schedule = () => {
    if (status !== "ready" || unsaved === null) return;
    stopTimer();
    deps.onPending(true);
    timer = setTimeout(() => {
      timer = undefined;
      deps.onPending(false);
      // A failure is already reported through `onError`; the text stays unsaved for the next flush.
      flush().catch(() => {});
    }, deps.delayMs);
  };

  return {
    change(md) {
      unsaved = md;
      schedule();
    },
    setStatus(next) {
      status = next;
      schedule();
    },
    flush,
    cancel: stopTimer,
    get unsaved() {
      return unsaved;
    },
  };
}
