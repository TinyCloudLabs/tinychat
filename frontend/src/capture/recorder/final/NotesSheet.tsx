import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { LevelBars } from "./halo";
import { createAutosave } from "./autosave";
import { trapTab } from "./focusTrap";
import { markKeyboardOpened } from "./inputModality";
import { NoteRenderer, NoteWriter } from "./notes";
import { NOTES_COPY } from "./notesCopy";
import type { NotesView } from "./notesViewPreference";
import "./phoneNotes.css";

const AUTOSAVE_MS = 500;

export interface NotesSheetProps {
  /** The note when the sheet opens; the writer owns it while open. */
  initialMd: string;
  view: NotesView;
  onViewChange: (view: NotesView) => void;
  /** Saves the note (debounced while typing, at once on close). */
  onSave: (md: string) => void;
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
  initialMd,
  view,
  onViewChange,
  onSave,
  onClose,
  recording,
  keyboardInset,
  returnFocus,
  fallbackFocus,
}: NotesSheetProps) {
  const ids = useId();
  const root = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(initialMd);
  const [pending, setPending] = useState(false);
  const save = useRef(onSave);
  save.current = onSave;
  const autosave = useRef<ReturnType<typeof createAutosave> | null>(null);
  autosave.current ??= createAutosave(
    (md) => save.current(md),
    AUTOSAVE_MS,
    setPending,
  );
  const back = useRef({ returnFocus, fallbackFocus });
  back.current = { returnFocus, fallbackFocus };
  const mounted = useRef(false);

  useEffect(() => {
    markKeyboardOpened(root.current);
    return () => {
      autosave.current!.flush();
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

  const change = (md: string) => {
    setDraft(md);
    autosave.current!.schedule(md);
  };
  const choose = (next: NotesView) => {
    if (next === view) return;
    autosave.current!.flush();
    onViewChange(next);
  };
  const close = () => {
    autosave.current!.flush();
    onClose();
  };
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
          <span className="pr-nsaved" data-shown={!pending}>
            {NOTES_COPY.saved}
          </span>
          <button ref={done} type="button" className="pr-ndone" onClick={close}>
            {NOTES_COPY.notesDone}
          </button>
        </div>
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
            <NoteWriter initialValue={draft} onChange={change} autoFocus />
          ) : (
            <div className="pr-nprev">
              <NoteRenderer md={draft} label={NOTES_COPY.preview} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
