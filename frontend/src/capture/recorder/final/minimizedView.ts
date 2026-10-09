import type { RecorderValue } from "../RecorderProvider";
import type { RecorderState } from "../recorderReducer";
import { selectRecorderView, type RecorderView } from "./recorderView";

export interface MinimizedView extends RecorderView {
  /** The state in one word for assistive technology. */
  status: string;
}

/** What the selector reads of the recorder; the fields it does not use are inert. */
function recorderState(recorder: RecorderValue): RecorderState {
  return {
    phase: recorder.phase,
    recordingId: null,
    startedAt: recorder.startedAt,
    audioMs: recorder.audioMs,
    elapsedMs: recorder.elapsedMs,
    maxDurationMs: recorder.maxDurationMs,
    mic: recorder.mic,
    controlPending: recorder.controlPending,
    limitNotice: recorder.limitNotice,
    savePercent: recorder.savePercent,
    error: recorder.error,
    outcome: recorder.outcome,
    localUpload: recorder.localUpload,
    lastSaved: recorder.lastSaved,
    failedRecording: null,
    autoSaving: false,
    ready: recorder.ready,
    permissionDenied: recorder.permissionDenied,
    captureIssues: {},
    recoveryScanFailure: null,
  };
}

/** What the Ribbon, the dock and the Capture dot show, from the view-model's pill and ring. */
export function minimizedView(
  recorder: RecorderValue,
  elapsedMs: number,
): MinimizedView {
  const view = selectRecorderView(recorderState(recorder), {
    nowMs: Date.now(),
    elapsedMs,
    inputName: null,
    silencedSinceMs: null,
  });
  const status =
    view.ring === "live"
      ? "Recording"
      : view.ring === "paused"
        ? "Paused"
        : view.pill.label;
  return { ...view, status };
}
