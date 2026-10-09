import { useEffect, useRef } from "react";
import { hapticLight } from "@/lib/haptics";
import { useRecordedElapsed } from "../../useRecordedElapsed";
import { useRecorder, type RecorderValue } from "../../RecorderProvider";
import { useResolvedTheme } from "@/lib/theme";
import { LevelBars } from "../halo";
import { NoteRenderer, NoteWriter } from "../notes";
import { NOTES_COPY } from "../notesCopy";
import type { NotesView } from "../notesViewPreference";
import { selectRecorderView } from "../recorderView";
import type { RecorderLayout } from "../shellCapabilities";
import { CheckIcon, ChevronDownIcon, PauseIcon, PlayIcon } from "../softIcons";
import { recorderState } from "../useFinalRecorderControls";
import "../soft.css";
import "../phone.css";
import "../phoneNotes.css";
import "./desktop.css";
import "./noteView.css";

export interface NoteViewProps {
  layout: Exclude<RecorderLayout, "phone">;
  /** The note as typed so far: the unsaved draft if there is one, else the saved note. Kept above the view. */
  md: string;
  /** Every keystroke; the owner above the view saves it. */
  onChange: (md: string) => void;
  view: NotesView;
  onViewChange: (view: NotesView) => void;
  /** Mirrors `recorder.noteStatus`: nothing is typed until the note is ready. */
  noteStatus: RecorderValue["noteStatus"];
  /** An edit is waiting to be saved. */
  pending: boolean;
  /** The last save failed; what was typed is kept. */
  saveFailed: boolean;
  /** Back to the ring view. The owner saves what is unsaved. */
  onExpand: () => void;
  /** Puts the recorder away. The owner saves what is unsaved. */
  onMinimise: () => void;
  /** Done. The owner saves the note first. */
  onDone: () => void;
}

/** The note beside the recording, in the main region: the same recorder, smaller, under the note. */
export function NoteView({
  layout,
  md,
  onChange,
  view,
  onViewChange,
  noteStatus,
  pending,
  saveFailed,
  onExpand,
  onMinimise,
  onDone,
}: NoteViewProps) {
  const recorder = useRecorder();
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  const elapsedMs = useRecordedElapsed(recorder.elapsedMs, recorder);
  const state = selectRecorderView(recorderState(recorder), {
    nowMs: Date.now(),
    elapsedMs,
    inputName: recorder.mic.input?.name ?? null,
    silencedSinceMs: null,
  });
  const root = useRef<HTMLDivElement>(null);
  const ready = noteStatus === "ready";
  // The Write view focuses its field itself; Preview has nothing to focus but the view.
  useEffect(() => {
    if (view === "preview") root.current?.focus({ preventScroll: true });
  }, [view]);
  const resume = state.controls.resume;
  const paused = state.ring === "paused";

  return (
    <div
      ref={root}
      role="region"
      aria-label={NOTES_COPY.notesTitle}
      tabIndex={-1}
      className={`soft-skin soft-${theme} pr dr nv`}
      data-layout={layout}
      data-testid="desktop-note-view"
    >
      <div className="pr-blob a" aria-hidden="true" />
      <div className="pr-blob b" aria-hidden="true" />
      <div className="nv-col">
        <div className="nv-top">
          <button
            type="button"
            className="pr-ibtn nv-min"
            aria-label="Minimise recorder"
            onClick={onMinimise}
          >
            <ChevronDownIcon size={19} />
          </button>
          <h2 className="soft-title nv-title">{NOTES_COPY.notesTitle}</h2>
          <span
            className="pr-nsaved"
            data-shown={!ready || (!pending && !saveFailed)}
            data-testid="desktop-note-saved"
          >
            {ready ? NOTES_COPY.saved : NOTES_COPY.noteLoading}
          </span>
          <div className="pr-ntabs" role="group" aria-label={NOTES_COPY.viewTabs}>
            {(["write", "preview"] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => id !== view && onViewChange(id)}
              >
                {id === "write" ? NOTES_COPY.write : NOTES_COPY.preview}
              </button>
            ))}
          </div>
        </div>
        {(noteStatus === "error" || saveFailed) && (
          <p className="pr-nerr nv-err" role="alert">
            {noteStatus === "error"
              ? NOTES_COPY.noteLoadFailed
              : NOTES_COPY.noteSaveFailed}
          </p>
        )}
        {recorder.noteSyncError !== null && !saveFailed && (
          <p className="pr-nerr nv-err" role="status">
            {NOTES_COPY.noteNotSynced}
          </p>
        )}
        {recorder.error && (
          <p className="pr-nerr nv-err" role="alert">
            {recorder.error}
          </p>
        )}
        <div className="nv-body">
          {view === "write" ? (
            ready ? (
              // Mounted only once the note is ready, with the text it loaded: a field that mounted before then
              // would hold the empty note and save it over the loaded one on the next keystroke.
              <NoteWriter initialValue={md} onChange={onChange} autoFocus />
            ) : noteStatus === "loading" ? (
              <p className="pr-nwait">{NOTES_COPY.noteLoading}</p>
            ) : null
          ) : (
            <div className="pr-nprev">
              <NoteRenderer md={md} label={NOTES_COPY.preview} />
            </div>
          )}
        </div>
        <div className="nv-bar">
          <button
            type="button"
            className="nv-rec"
            disabled={!(resume || state.controls.pause)}
            aria-label={
              paused
                ? NOTES_COPY.resumeRecording(state.timer.text)
                : NOTES_COPY.pauseRecording(state.timer.text)
            }
            onClick={() => {
              hapticLight();
              if (resume) recorder.resume();
              else recorder.pause();
            }}
          >
            <LevelBars
              subscribe={recorder.subscribeLevel}
              bars={5}
              paused={paused}
              theme={theme}
            />
            <span className="soft-title nv-time" role="timer" data-dim={paused}>
              {state.timer.text}
            </span>
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <span className="nv-status" data-testid="desktop-note-status">
            {state.statusLine}
          </span>
          <button
            type="button"
            className="pr-b main nv-done"
            disabled={!state.controls.stop}
            onClick={onDone}
          >
            <CheckIcon />
            Done
          </button>
          <button type="button" className="nv-expand" onClick={onExpand}>
            Expand
          </button>
        </div>
      </div>
    </div>
  );
}
