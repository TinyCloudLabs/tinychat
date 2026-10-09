import { useEffect, useRef } from "react";
import { useRecorder } from "../../RecorderProvider";
import { clearNotesUi, clearNotesUiExcept } from "./notesUiState";
import { recordingKey } from "./recordingKey";

/**
 * Drops the notes UI state when its recording is over (Done, discard) or another one has started. Mount it above
 * the views (they unmount at Done); its unmount also counts as the end when the recording is no longer live, so
 * a view that is only mounted while the recorder is open can host it.
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
