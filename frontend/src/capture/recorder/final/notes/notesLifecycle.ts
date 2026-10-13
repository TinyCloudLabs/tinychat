import { useEffect, useRef } from "react";
import { useRecorder } from "../../RecorderProvider";
import { clearNotesUi, clearNotesUiExcept } from "./notesUiState";
import { recordingKey } from "./recordingKey";

/**
 * Drops the notes UI state when its recording is over (Done, discard) or another one has started. Mount it in an
 * owner that stays mounted across minimise and stop (RecorderShell), never in a view: the views unmount when
 * the sheet is minimised, and a recording stopped or discarded then would never be cleared. Its unmount also counts
 * as the end when the recording is no longer live.
 */
export function useNotesLifecycle(): void {
  const recorder = useRecorder();
  const key = recordingKey(recorder);
  useEffect(() => clearNotesUiExcept(key), [key]);
  const live = recorder.phase === "starting" || recorder.phase === "recording";
  const wasLive = useRef(live);
  wasLive.current = live;
  useEffect(
    () => () => {
      if (!wasLive.current) clearNotesUi();
    },
    [],
  );
}
