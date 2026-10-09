import { useEffect, useRef } from "react";
import { useRecorder } from "../../RecorderProvider";
import { finishRecording, type DoneGate } from "../doneGate";
import { updateNotesUi, useNotesUi } from "../notes/notesUiState";
import { recordingKey } from "../notes/recordingKey";
import { warmRenderer } from "../notes/renderMarkdown";
import { useNoteSaver } from "../useNoteSaver";
import type { RecorderLayout } from "../shellCapabilities";
import {
  LazyDesktopRecorder,
  type DesktopRecorderLoader,
} from "./LazyDesktopRecorder";
import { LazyNoteView, type NoteViewLoader } from "./LazyNoteView";

const WARM_RENDERER_MS = 4000;

/**
 * What the desktop recorder shows: the ring view, or the note beside the recording. It owns what both share, the
 * notes UI state, the note saver and Done's wait for the note, so switching between them loses nothing.
 */
export function DesktopRecorderHost({
  layout,
  loadDesktopRecorder,
  loadNoteView,
}: {
  layout: Exclude<RecorderLayout, "phone">;
  loadDesktopRecorder?: DesktopRecorderLoader;
  loadNoteView?: NoteViewLoader;
}) {
  const recorder = useRecorder();
  const key = recordingKey(recorder);
  const ui = useNotesUi(key);
  const saving = useNoteSaver(key, recorder);
  const doneGate = useRef<DoneGate>({ acknowledged: null });
  const recordingNow = recorder.phase === "recording";
  useEffect(() => {
    if (!recordingNow) return;
    const timer = setTimeout(warmRenderer, WARM_RENDERER_MS);
    return () => clearTimeout(timer);
  }, [recordingNow]);

  const finish = (stop: () => void) =>
    void finishRecording(doneGate.current, key, { flush: saving.flush, stop });

  if (ui.open && key !== null) {
    const leave = () => {
      saving.saveNow();
      ui.closeNotes();
    };
    return (
      <LazyNoteView
        load={loadNoteView}
        layout={layout}
        md={ui.draft ?? recorder.note?.md ?? ""}
        onChange={(md) => {
          updateNotesUi(key, () => ({ draft: md }));
          saving.change(md);
        }}
        view={ui.view}
        onViewChange={(next) => {
          saving.saveNow();
          ui.setView(next);
        }}
        noteStatus={recorder.noteStatus}
        pending={saving.pending}
        saveFailed={ui.saveFailed}
        onExpand={leave}
        onMinimise={() => {
          leave();
          void recorder.minimiseSheet();
        }}
        onDone={() => finish(recorder.stop)}
      />
    );
  }
  return (
    <LazyDesktopRecorder
      layout={layout}
      load={loadDesktopRecorder}
      onOpenNotes={key === null ? undefined : () => ui.openNotes("write")}
      noteSaveFailed={ui.saveFailed}
      onDone={finish}
    />
  );
}
