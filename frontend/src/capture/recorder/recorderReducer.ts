// The voice-note recorder's state, as a pure reducer (plan §4.2). The phases
// are the card's: idle → starting → recording → stopping → saving → idle.
// `useVoiceNoteRecorder` turns the plugin's answers and events into these
// events; every view reads the result through RecorderProvider.
import { VOICE_NOTE_MAX_DURATION_MS, type MicState, type MicStateReason } from "@/lib/voiceNotes/nativeVoiceNotes";

export type RecorderPhase = "idle" | "starting" | "recording" | "stopping" | "saving";

export interface RecorderMic {
  state: MicState;
  reason: MicStateReason;
}

export interface RecorderState {
  phase: RecorderPhase;
  recordingId: string | null;
  startedAt: number | null;
  maxDurationMs: number;
  mic: RecorderMic;
  /** Set when the recorder stopped itself at the limit, e.g. "Stopped at the 60-minute limit." */
  limitNotice: string | null;
  /** How much of the note being saved is stored. */
  savePercent: number | null;
  error: string | null;
  /** How the last recording ended; drives the receipt until dismissed. */
  outcome: "saved" | "failed" | null;
  lastSaved: { id: string; durationMs: number; at: number } | null;
  /**
   * The limit stopped the recording and its save is running: a Stop that lost
   * that race (`not_recording`) must not reset the recorder under it.
   */
  autoSaving: boolean;
}

export type RecorderEvent =
  | { type: "START_REQUESTED" }
  | { type: "STARTED"; id: string; startedAt: number; maxDurationMs: number }
  | { type: "START_FAILED"; error: string }
  /** A recording was already running (a WebView reload, or one started offline). */
  | { type: "PICKED_UP"; id: string | null; startedAt: number; maxDurationMs?: number; mic: RecorderMic }
  | { type: "MIC_STATE"; mic: RecorderMic }
  | { type: "STOP_REQUESTED" }
  /** stop() rejected; `error` is null for `not_recording` (the limit's save takes over). */
  | { type: "STOP_FAILED"; error: string | null }
  /** The save started (percent null) or moved on. */
  | { type: "SAVE_PROGRESS"; percent: number | null }
  | { type: "SAVED"; id: string; durationMs: number; at: number }
  | { type: "SAVE_FAILED"; error: string }
  /** The recorder stopped itself at its limit; `captured` is false when it recorded nothing. */
  | { type: "AUTO_STOPPED"; notice: string; captured: boolean }
  /** Back to idle without an outcome (the recording is being saved elsewhere). */
  | { type: "RESET" }
  /** The receipt was read: Done, Open, or its time ran out. */
  | { type: "DISMISSED" };

const IDLE_MIC: RecorderMic = { state: "idle", reason: null };

export const initialRecorderState: RecorderState = {
  phase: "idle",
  recordingId: null,
  startedAt: null,
  maxDurationMs: VOICE_NOTE_MAX_DURATION_MS,
  mic: IDLE_MIC,
  limitNotice: null,
  savePercent: null,
  error: null,
  outcome: null,
  lastSaved: null,
  autoSaving: false,
};

/** Idle again, keeping what the user still has to read (the error, the limit notice, the outcome). */
function toIdle(state: RecorderState): RecorderState {
  return { ...state, phase: "idle", recordingId: null, startedAt: null, mic: IDLE_MIC, savePercent: null, autoSaving: false };
}

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case "START_REQUESTED":
      if (state.phase !== "idle") return state;
      return { ...state, phase: "starting", error: null, limitNotice: null, outcome: null, savePercent: null };
    case "STARTED":
      if (state.phase !== "starting") return state;
      return {
        ...state,
        phase: "recording",
        recordingId: event.id,
        startedAt: event.startedAt,
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
        recordingId: event.id,
        startedAt: event.startedAt,
        maxDurationMs: event.maxDurationMs ?? state.maxDurationMs,
        mic: event.mic,
        outcome: null,
      };
    case "MIC_STATE":
      if (state.phase !== "recording") return state;
      return { ...state, mic: event.mic };
    case "STOP_REQUESTED":
      if (state.phase !== "recording") return state;
      return { ...state, phase: "stopping" };
    case "STOP_FAILED":
      if (state.autoSaving) return state;
      return { ...toIdle(state), error: event.error ?? state.error };
    case "SAVE_PROGRESS":
      if (state.phase !== "stopping" && state.phase !== "saving") return state;
      return { ...state, phase: "saving", savePercent: event.percent };
    case "SAVED":
      return {
        ...toIdle(state),
        outcome: "saved",
        error: null,
        lastSaved: { id: event.id, durationMs: event.durationMs, at: event.at },
      };
    case "SAVE_FAILED":
      return { ...toIdle(state), outcome: "failed", error: event.error };
    case "AUTO_STOPPED":
      if (!event.captured) {
        const failed = { ...state, limitNotice: event.notice, error: `${event.notice} The recording captured no audio.` };
        return state.autoSaving ? failed : toIdle(failed);
      }
      return { ...state, phase: "saving", savePercent: null, limitNotice: event.notice, error: null, autoSaving: true };
    case "RESET":
      return toIdle(state);
    case "DISMISSED":
      return { ...state, outcome: null, error: null };
  }
}
