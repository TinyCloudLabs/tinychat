import { useEffect, useId, useRef, type RefObject } from "react";
import { LevelBars } from "./halo";
import { trapTab } from "./focusTrap";
import { markKeyboardOpened } from "./inputModality";
import { useAccessoryBarHidden } from "./keyboardInset";
import { NoteRenderer, NoteWriter } from "./notes";
import { NOTES_COPY } from "./notesCopy";
import type { NotesView } from "./notesViewPreference";
import type { RecorderNoteStatus } from "../voiceNoteRecorderController";
import "./phoneNotes.css";

export interface NotesSheetProps {
  /** The note as typed so far: the unsaved draft if there is one, else the saved note. Kept above the sheet. */
  md: string;
  /** Every keystroke; the owner above the sheet saves it. */
  onChange: (md: string) => void;
  view: NotesView;
  onViewChange: (view: NotesView) => void;
  /** Mirrors `recorder.noteStatus`: nothing is typed until the note is ready. */
  noteStatus: RecorderNoteStatus;
  /** An edit is waiting to be saved. */
  pending: boolean;
  /** The last save failed; the owner shows it at the recorder level too, so closing the sheet does not hide it. */
  saveFailed: boolean;
  /** Closes the sheet. The owner saves what is unsaved and shows a failure after this returns. */
  onClose: () => void;
  /** The recording, kept in view: the timer, three level bars, and a tap to pause or resume. */
  recording: {
    timerText: string;
    paused: boolean;
    canToggle: boolean;
    onToggle: () => void;
    subscribeLevel: (listener: (level: number) => void) => () => void;
    theme: "night" | "day";
  };
  /** How much of the bottom the keyboard covers, in px. */
  keyboardInset: number;
  returnFocus: RefObject<HTMLElement | null>;
  fallbackFocus: RefObject<HTMLElement | null>;
}

/** The notes sheet over the recorder: a modal dialog that traps focus and returns it to its opener. */
export function NotesSheet({
  md,
  onChange,
  noteStatus,
  pending,
  saveFailed,
  view,
  onViewChange,
  onClose,
  recording,
  keyboardInset,
  returnFocus,
  fallbackFocus,
}: NotesSheetProps) {
  const ids = useId();
  const root = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const ready = noteStatus === "ready";
  const back = useRef({ returnFocus, fallbackFocus });
  back.current = { returnFocus, fallbackFocus };
  const mounted = useRef(false);
  useAccessoryBarHidden();

  useEffect(() => {
    markKeyboardOpened(root.current);
    return () => {
      const { returnFocus: opener, fallbackFocus: fallback } = back.current;
      (opener.current?.isConnected
        ? opener.current
        : fallback.current
      )?.focus();
    };
  }, []);

  // Opening in Preview focuses Done; the Write view focuses its field itself.
  useEffect(() => {
    if (!mounted.current && view === "preview") done.current?.focus();
    mounted.current = true;
  }, [view]);

  const choose = (next: NotesView) => {
    if (next !== view) onViewChange(next);
  };
  const close = onClose;
  const lifted = keyboardInset > 0;

  return (
    <>
      <div className="pr-veil" aria-hidden="true" onClick={close} />
      <div
        ref={root}
        className="pr-nsheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        data-lifted={lifted}
        style={lifted ? { bottom: keyboardInset + 8 } : undefined}
        tabIndex={-1}
        onKeyDown={(event) => {
          event.currentTarget.setAttribute("data-kbd", "");
          if (event.key === "Escape") {
            event.stopPropagation();
            event.preventDefault();
            close();
            return;
          }
          trapTab(event, event.currentTarget);
        }}
      >
        <div className="pr-nhead">
          <button
            type="button"
            className="pr-nrec"
            disabled={!recording.canToggle}
            aria-label={
              recording.paused
                ? NOTES_COPY.resumeRecording(recording.timerText)
                : NOTES_COPY.pauseRecording(recording.timerText)
            }
            onClick={recording.onToggle}
          >
            <LevelBars
              subscribe={recording.subscribeLevel}
              paused={recording.paused}
              theme={recording.theme}
            />
            <span className="soft-title" data-dim={recording.paused}>
              {recording.timerText}
            </span>
          </button>
          <h2 id={`${ids}-title`} className="soft-title">
            {NOTES_COPY.notesTitle}
          </h2>
          <span
            className="pr-nsaved"
            data-shown={
              noteStatus === "loading" || (ready && !pending && !saveFailed)
            }
          >
            {noteStatus === "loading"
              ? NOTES_COPY.noteLoading
              : NOTES_COPY.saved}
          </span>
          <button ref={done} type="button" className="pr-ndone" onClick={close}>
            {NOTES_COPY.notesDone}
          </button>
        </div>
        {(noteStatus === "error" || saveFailed) && (
          <p className="pr-nerr" role="alert">
            {noteStatus === "error"
              ? NOTES_COPY.noteLoadFailed
              : NOTES_COPY.noteSaveFailed}
          </p>
        )}
        <div className="pr-ntabs" role="group" aria-label={NOTES_COPY.viewTabs}>
          {(["write", "preview"] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => choose(id)}
            >
              {id === "write" ? NOTES_COPY.write : NOTES_COPY.preview}
            </button>
          ))}
        </div>
        <div className="pr-nbody">
          {view === "write" ? (
            ready ? (
              // Mounted only once the note is ready, with the text it loaded: a field that mounted before then
              // would hold the empty note and save it over the loaded one on the next keystroke.
              <NoteWriter initialValue={md} onChange={onChange} autoFocus />
            ) : noteStatus === "loading" ? (
              <p className="pr-nwait">
                {NOTES_COPY.noteLoading}
              </p>
            ) : null
          ) : (
            <div className="pr-nprev">
              <NoteRenderer md={md} label={NOTES_COPY.preview} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
