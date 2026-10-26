import type { RecorderValue } from "../RecorderProvider";
import type { RecorderState } from "../recorderReducer";
import { FINAL_COPY } from "./finalCopy";
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
    finalizationPendingId: null,
    startedAt: recorder.startedAt,
    audioMs: recorder.audioMs,
    elapsedMs: recorder.elapsedMs,
    elapsedAt: recorder.elapsedAt,
    maxDurationMs: recorder.maxDurationMs,
    captureSourceUnconfirmed: recorder.captureSourceUnconfirmed,
    mic: recorder.mic,
    controlPending: recorder.controlPending,
    limitNotice: recorder.limitNotice,
    limitStopMs: null,
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
  silencedSinceMs: number | null = null,
  device: "phone" | "mac" = "phone",
): MinimizedView {
  const view = selectRecorderView(recorderState(recorder), {
    nowMs: Date.now(),
    elapsedMs,
    inputName: null,
    silencedSinceMs,
    device,
  });
  const state =
    view.ring === "live"
      ? "Recording"
      : view.ring === "paused"
        ? "Paused"
        : view.pill.label;
  const status = view.statusLine ? `${state}. ${view.statusLine}` : state;
  return { ...view, status };
}

/** A rejected control leaves its error on the recorder while a phase is under way. */
export function showsMinimizedError(
  recorder: Pick<RecorderValue, "error" | "phase">,
): boolean {
  return recorder.error !== null && recorder.phase !== "idle";
}

export interface MinimizedLimit {
  /** "Stops in 29:54": the readout beside the timer. */
  stopsIn: string;
  /** "Recording stops at 3:38 PM": the exact local clock time, for the hover and the accessible description. */
  stopsAt: string;
  /** How much of the limit is used, 0 to 1. */
  fraction: number;
}

/** The minimised bar's limit line and readout; null (nothing extra shown) without a finite limit or a running countdown. */
export function minimizedLimit(
  view: Pick<MinimizedView, "timer">,
  maxDurationMs: number | null | undefined,
): MinimizedLimit | null {
  const countdown = view.timer.countdown;
  if (!countdown || typeof maxDurationMs !== "number") return null;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) return null;
  // The view's text is "Stops at <local clock time>"; the hover names what stops, with the same clock time.
  return {
    stopsIn: FINAL_COPY.stopsIn(countdown.remainingText),
    stopsAt: FINAL_COPY.recordingStopsAt(countdown.text.slice(FINAL_COPY.stopAt("").length)),
    fraction: Math.min(1, Math.max(0, 1 - countdown.remainingMs / maxDurationMs)),
  };
}
