// The voice-note recorder's state, as a pure reducer (plan §4.2). The phases
// are the card's: idle → starting → recording → stopping → saving → idle, and
// recording → discarding → idle when the user discards it (PR5). While it is
// discarding, nothing else moves the phase: the limit's auto-stop is not shown
// (autoStopIsCurrent), and its save meets the discard guard (recorderSaves.ts),
// which deletes the recording instead.
// `useVoiceNoteRecorder` turns the plugin's answers and events into these
// events; every view reads the result through RecorderProvider.
import { VOICE_NOTE_MAX_DURATION_MS, type AudioInput, type MicState, type MicStateReason } from "@/lib/voiceNotes/nativeVoiceNotes";
import { FINALIZATION_PENDING } from "./recorderCopy";

export type RecorderPhase = "idle" | "starting" | "recording" | "stopping" | "saving" | "discarding";

export interface RecorderMic {
  state: MicState;
  reason: MicStateReason;
  input?: AudioInput | null;
}

export type RecorderCaptureIssue =
  | { kind: "finalization_timed_out" }
  | { kind: "recoveryFailed"; detail: string }
  | { kind: "write_failed"; detail: string }
  | { kind: "partial_audio"; missingMs?: number; spans?: { startMs: number; endMs: number; reason: string }[] };

export interface RecorderState {
  phase: RecorderPhase;
  recordingId: string | null;
  startedAt: number | null;
  /** Last native audio clock checkpoint; paused time is excluded. */
  audioMs: number;
  /** Native recorded-time checkpoint: wall time minus user pauses, including interruptions. */
  elapsedMs: number;
  /** Wall-clock time when this elapsed checkpoint reached the controller. */
  elapsedAt: number | null;
  /** Capture issues keyed by recording ID, including saved partial audio. */
  captureIssues: Record<string, RecorderCaptureIssue>;
  /** A recovery scan can fail before native knows which recording caused it. */
  recoveryScanFailure: string | null;
  maxDurationMs: number;
  mic: RecorderMic;
  /** A native Pause or Resume call is outstanding; repeat taps stay disabled. */
  controlPending: "pause" | "resume" | null;
  /** Set when the recorder stopped itself at the limit, e.g. "Stopped at the 3-hour limit." */
  limitNotice: string | null;
  /** How much of the note being saved is stored. */
  savePercent: number | null;
  error: string | null;
  /** How the last recording ended; drives the receipt until dismissed. */
  outcome: "local" | "saved" | "failed" | null;
  /** The phone receipt distinguishes an active upload from a held note or another saver. */
  localUpload: "uploading" | "held" | "in-flight" | null;
  lastSaved: { id: string; durationMs: number; at: number } | null;
  /** The recording behind a "Kept on this phone" receipt, so a later Save now can land it. */
  failedRecording: { id: string; durationMs: number } | null;
  /**
   * The limit stopped the recording and its save is running: a Stop that lost
   * that race (`not_recording`) must not reset the recorder under it.
   */
  autoSaving: boolean;
  /**
   * The plugin's status() and its retained events have been heard since the
   * listeners were attached; until then Record waits (a retained auto-stop
   * from before a reload must never land on a new recording).
   */
  ready: boolean;
  permissionDenied: boolean;
}

export type RecorderEvent =
  | { type: "START_REQUESTED" }
  | { type: "STARTED"; id: string; startedAt: number; maxDurationMs: number; elapsedAt: number }
  | { type: "START_FAILED"; error: string }
  /** A recording was already running (a WebView reload, or one started offline). */
  | { type: "PICKED_UP"; id: string | null; startedAt: number; maxDurationMs: number; audioMs: number; elapsedMs: number; elapsedAt: number; mic: RecorderMic }
  | ({ type: "MIC_STATE"; mic: RecorderMic; audioMs?: number } & (
    { elapsedMs: number; elapsedAt: number } | { elapsedMs?: never; elapsedAt?: never }))
  | { type: "CAPTURE_ISSUE"; id: string | null; issue: RecorderCaptureIssue }
  | { type: "CAPTURE_RESOLVED"; id: string }
  | { type: "CAPTURE_COMMITTED"; id: string; partial?: Extract<RecorderCaptureIssue, { kind: "partial_audio" }> }
  | { type: "CAPTURE_DISMISSED"; id: string }
  | { type: "PAUSE_REQUESTED" }
  | { type: "PAUSE_CONFIRMED" }
  | { type: "PAUSE_FAILED"; error: string }
  | { type: "RESUME_REQUESTED" }
  | { type: "RESUME_CONFIRMED" }
  | { type: "RESUME_FAILED"; error: string }
  | { type: "STOP_REQUESTED"; at: number }
  /** A failed stop was checked against native status; unknown keeps the view in stopping. */
  | { type: "STOP_FAILED"; error: string | null; status: "active"; mic: RecorderMic; audioMs: number; elapsedMs: number; elapsedAt: number }
  | { type: "STOP_FAILED"; error: string | null; status: "idle" | "unknown" }
  /** The save started (percent null) or moved on. */
  | { type: "SAVE_PROGRESS"; percent: number | null }
  | { type: "LOCAL_COMMITTED"; id: string; durationMs: number; at: number }
  | { type: "LOCAL_UPLOAD_HELD"; id: string }
  | { type: "LOCAL_UPLOAD_IN_FLIGHT"; id: string }
  | { type: "SAVED"; id: string; durationMs: number; at: number }
  | { type: "SAVE_FAILED"; error: string; recording: { id: string; durationMs: number } | null }
  /**
   * A recorder stopped itself at its limit: `id` is that recording's (null when it
   * captured nothing). Applied only when it is the recording on screen (autoStopIsCurrent).
   */
  | { type: "AUTO_STOPPED"; id: string | null; notice: string; captured: boolean; at: number; elapsedMs?: number; error?: string | null }
  /** status() and the retained events have been heard: Record may start. */
  | { type: "RECONCILED" }
  | { type: "PERMISSION_DENIED" }
  | { type: "PERMISSION_GRANTED" }
  /** Back to idle without an outcome (the recording is being saved elsewhere). */
  | { type: "RESET" }
  /** The receipt was read: Done, Open, or its time ran out. */
  | { type: "DISMISSED" }
  /** The user confirmed Discard on the live recording `id`. */
  | { type: "DISCARD_REQUESTED"; id: string | null }
  /** Stopped and deleted from the phone; nothing was saved. */
  | { type: "DISCARDED"; id: string | null }
  /** Native discard or the delete failed; `committed` means the mic has stopped. */
  | { type: "DISCARD_FAILED"; id: string | null; error: string; committed?: boolean; uncertain?: boolean };

const IDLE_MIC: RecorderMic = { state: "idle", reason: null };

export const initialRecorderState: RecorderState = {
  phase: "idle",
  recordingId: null,
  startedAt: null,
  audioMs: 0,
  elapsedMs: 0,
  elapsedAt: null,
  captureIssues: {},
  recoveryScanFailure: null,
  maxDurationMs: VOICE_NOTE_MAX_DURATION_MS,
  mic: IDLE_MIC,
  controlPending: null,
  limitNotice: null,
  savePercent: null,
  error: null,
  outcome: null,
  localUpload: null,
  lastSaved: null,
  failedRecording: null,
  autoSaving: false,
  ready: false,
  permissionDenied: false,
};

/** Idle again, keeping what the user still has to read (the error, the limit notice, the outcome). */
function toIdle(state: RecorderState): RecorderState {
  return { ...state, phase: "idle", recordingId: null, startedAt: null, mic: IDLE_MIC,
    controlPending: null, savePercent: null, autoSaving: false };
}

/** Preserve the displayed recorded time when a live view stops ticking. */
function freezeElapsed(state: RecorderState, at: number): RecorderState {
  if (state.phase !== "recording" || state.mic.state === "paused" || state.elapsedAt === null) return state;
  return { ...state, elapsedMs: state.elapsedMs + Math.max(0, at - state.elapsedAt), elapsedAt: at };
}

/**
 * Whether a limit's auto-stop belongs to what the recorder shows. With nothing under
 * way it does (a retained event after a reload: its save is shown). While a recording
 * starts, or another one saves, it is someone else's; while one is discarded, its save
 * meets the discard guard out of sight. While recording or stopping, it must be that
 * recording's.
 */
export function autoStopIsCurrent(state: Pick<RecorderState, "phase" | "recordingId">, id: string | null): boolean {
  switch (state.phase) {
    case "idle":
      return true;
    case "starting":
    case "saving":
    case "discarding":
      return false;
    case "recording":
    case "stopping":
      return id === null || state.recordingId === null || id === state.recordingId;
  }
}

/** A save result belongs to the recording being saved (or to a failed one that Save now landed). */
function savingThis(state: RecorderState, id: string | null): boolean {
  return (state.phase === "stopping" || state.phase === "saving") && (id === null || state.recordingId === null || id === state.recordingId);
}

/** A discard event belongs to the recording on screen, by the same rule. */
function discardingThis(state: RecorderState, phase: "recording" | "discarding", id: string | null): boolean {
  return state.phase === phase && (id === null || state.recordingId === null || id === state.recordingId);
}

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case "START_REQUESTED":
      if (state.phase !== "idle") return state;
      return { ...state, phase: "starting", permissionDenied: false, error: null, limitNotice: null, outcome: null, localUpload: null, failedRecording: null, savePercent: null };
    case "STARTED":
      if (state.phase !== "starting") return state;
      return {
        ...state,
        phase: "recording",
        recordingId: event.id,
        startedAt: event.startedAt,
        audioMs: 0,
        elapsedMs: 0,
        elapsedAt: event.elapsedAt,
        maxDurationMs: event.maxDurationMs,
        mic: { state: "recording", reason: null },
      };
    case "START_FAILED":
      if (state.phase !== "starting") return state;
      return { ...toIdle(state), error: event.error };
    case "PICKED_UP":
      if (state.phase !== "idle" && state.phase !== "starting") return state;
      return {
        ...state,
        phase: "recording",
        permissionDenied: false,
        recordingId: event.id,
        startedAt: event.startedAt,
        audioMs: event.audioMs,
        elapsedMs: event.elapsedMs,
        elapsedAt: event.elapsedAt,
        maxDurationMs: event.maxDurationMs,
        mic: event.mic,
        outcome: null,
        localUpload: null,
      };
    case "MIC_STATE":
      if (state.phase !== "recording") return state;
      return { ...state, mic: event.mic, audioMs: event.audioMs ?? state.audioMs,
        elapsedMs: event.elapsedMs ?? state.elapsedMs,
        elapsedAt: event.elapsedMs === undefined ? state.elapsedAt : event.elapsedAt };
    case "CAPTURE_ISSUE":
      if (event.id === null) return event.issue.kind === "recoveryFailed"
        ? { ...state, recoveryScanFailure: event.issue.detail } : state;
      return { ...state, captureIssues: { ...state.captureIssues, [event.id]: event.issue } };
    case "CAPTURE_RESOLVED": {
      if (!(event.id in state.captureIssues)) return state;
      const captureIssues = { ...state.captureIssues };
      delete captureIssues[event.id];
      return { ...state, captureIssues };
    }
    case "CAPTURE_COMMITTED": {
      const previous = state.captureIssues[event.id];
      const captureIssues = { ...state.captureIssues };
      if (event.partial || previous?.kind === "write_failed" || previous?.kind === "partial_audio")
        captureIssues[event.id] = event.partial ?? (previous?.kind === "partial_audio" ? previous : { kind: "partial_audio" });
      else delete captureIssues[event.id];
      return { ...state, captureIssues };
    }
    case "CAPTURE_DISMISSED": {
      if (state.captureIssues[event.id]?.kind !== "partial_audio") return state;
      const captureIssues = { ...state.captureIssues };
      delete captureIssues[event.id];
      return { ...state, captureIssues };
    }
    case "PERMISSION_DENIED":
      if (state.phase === "recording" || state.phase === "stopping" || state.phase === "discarding") return state;
      return { ...state, permissionDenied: true, error: null };
    case "PERMISSION_GRANTED":
      return state.permissionDenied ? { ...state, permissionDenied: false } : state;
    case "PAUSE_REQUESTED":
      if (state.phase !== "recording" || state.controlPending || (state.mic.state !== "recording" && state.mic.state !== "silenced")) return state;
      // The native engine confirms release via MIC_STATE. Keep showing a live mic until then.
      return { ...state, controlPending: "pause", error: null };
    case "PAUSE_FAILED":
      if (state.phase !== "recording") return state;
      return { ...state, controlPending: null, error: event.error };
    case "PAUSE_CONFIRMED":
      if (state.phase !== "recording") return state;
      return { ...state, controlPending: null };
    case "RESUME_REQUESTED":
      if (state.phase !== "recording" || state.controlPending || !["paused", "interrupted", "needs_user"].includes(state.mic.state)) return state;
      return { ...state, controlPending: "resume", error: null };
    case "RESUME_FAILED":
      if (state.phase !== "recording") return state;
      return { ...state, mic: { state: "needs_user", reason: "resume_blocked" }, controlPending: null, error: event.error };
    case "RESUME_CONFIRMED":
      if (state.phase !== "recording") return state;
      return { ...state, controlPending: null };
    case "STOP_REQUESTED":
      if (state.phase !== "recording") return state;
      return { ...freezeElapsed(state, event.at), phase: "stopping", controlPending: null, error: null };
    case "STOP_FAILED":
      if (state.autoSaving || state.phase === "discarding") return state;
      if (state.phase !== "stopping") return state;
      if (event.status === "unknown") return { ...state, error: event.error };
      if (event.status === "active") return { ...state, phase: "recording", mic: event.mic, audioMs: event.audioMs,
        elapsedMs: event.elapsedMs, elapsedAt: event.elapsedAt, error: event.error };
      return { ...toIdle(state), error: event.error ?? state.error };
    case "SAVE_PROGRESS":
      if (state.phase === "idle" && state.outcome === "local") return { ...state, savePercent: event.percent };
      if (state.phase !== "stopping" && state.phase !== "saving") return state;
      return { ...state, phase: "saving", savePercent: event.percent };
    case "LOCAL_COMMITTED":
      if (!savingThis(state, event.id)) return state;
      return {
        ...toIdle(state), outcome: "local", localUpload: "uploading", audioMs: event.durationMs,
        lastSaved: { id: event.id, durationMs: event.durationMs, at: event.at },
        error: null,
      };
    case "LOCAL_UPLOAD_HELD":
      if (state.phase !== "idle" || state.outcome !== "local" || state.lastSaved?.id !== event.id) return state;
      return { ...state, localUpload: "held" };
    case "LOCAL_UPLOAD_IN_FLIGHT":
      if (state.phase !== "idle" || state.outcome !== "local" || state.lastSaved?.id !== event.id) return state;
      return { ...state, localUpload: "in-flight" };
    case "SAVED":
      // Only the save on screen, or the failed note behind a receipt; never another recording's.
      if (!savingThis(state, event.id) && !(state.phase === "idle" && ((state.outcome === "failed" && state.failedRecording?.id === event.id) || (state.outcome === "local" && state.lastSaved?.id === event.id)))) {
        return state;
      }
      return {
        ...toIdle(state),
        outcome: "saved",
        localUpload: null,
        error: null,
        failedRecording: null,
        lastSaved: { id: event.id, durationMs: event.durationMs, at: event.at },
      };
    case "SAVE_FAILED":
      if (!savingThis(state, event.recording?.id ?? null) && !(state.phase === "idle" && state.outcome === "local" && state.lastSaved?.id === event.recording?.id)) return state;
      return { ...toIdle(state), outcome: "failed", localUpload: null, error: event.error, failedRecording: event.recording };
    case "AUTO_STOPPED":
      if (!autoStopIsCurrent(state, event.id)) return state;
      state = freezeElapsed(state, event.at);
      if (event.elapsedMs !== undefined) state = { ...state, elapsedMs: event.elapsedMs, elapsedAt: event.at };
      if (!event.captured) {
        const failed = { ...state, limitNotice: event.notice,
          error: event.error === "finalization_timed_out"
            ? FINALIZATION_PENDING
            : `${event.notice} The recording captured no audio.` };
        return state.autoSaving ? failed : toIdle(failed);
      }
      return {
        ...state,
        phase: "saving",
        recordingId: event.id ?? state.recordingId,
        savePercent: null,
        limitNotice: event.notice,
        error: null,
        outcome: null,
        autoSaving: true,
      };
    case "RECONCILED":
      return state.ready ? state : { ...state, ready: true };
    case "RESET":
      if (state.phase === "discarding") return state;
      return toIdle(state);
    case "DISMISSED":
      return { ...state, outcome: null, localUpload: null, error: null, failedRecording: null };
    case "DISCARD_REQUESTED":
      // Only a live recording: once Stop or the limit has it, it is being saved.
      if (!discardingThis(state, "recording", event.id)) return state;
      return { ...state, phase: "discarding", controlPending: null, error: null };
    case "DISCARDED":
      if (!discardingThis(state, "discarding", event.id)) return state;
      return { ...toIdle(state), error: null, limitNotice: null };
    case "DISCARD_FAILED":
      if (!discardingThis(state, "discarding", event.id)) return state;
      if (event.uncertain) return { ...state, error: event.error };
      return event.committed ? { ...toIdle(state), error: event.error } : { ...state, phase: "recording", error: event.error };
  }
}
