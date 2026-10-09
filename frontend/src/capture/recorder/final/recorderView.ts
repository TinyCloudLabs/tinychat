import type { MicState, MicStateReason } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { RecorderState } from "../recorderReducer";
import { FINAL_COPY } from "./finalCopy";

/** Boundary extension for native interruption reasons being added alongside TC-781. */
export type FinalMicReason = MicStateReason | "stalled" | "resume_not_allowed" | "resume_blocked" | "mic_unavailable" | (string & {});
export type FinalMicState = MicState;
export interface RecorderViewInput {
  nowMs: number;
  /** Native elapsed wall time less user-paused time. Never infer this from audioMs. */
  elapsedMs: number;
  shell: "phone" | "desktop" | "web";
  inputName?: string;
  silencedSinceMs?: number | null;
}
export interface RecorderView {
  ring: "live" | "paused" | "still" | "still-resumable" | "idle";
  flat: boolean;
  pill: { label: string; dot: "red" | "filled-grey" | "hollow" };
  statusLine: string | null;
  timer: { text: string; countdown?: { text: string } };
  controls: { pause: boolean; resume: boolean; stop: boolean; discard: boolean; busy: boolean; openSettings: boolean };
  micDenied: boolean;
  tapRingAction: "pause" | "resume" | null;
}
const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const LIMIT_MS = 3 * 60 * 60 * 1000;
const WARNING_AT_MS = LIMIT_MS - 10 * 60 * 1000;

export function selectRecorderView(state: RecorderState, input: RecorderViewInput): RecorderView {
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) throw new RangeError("elapsedMs must be a non-negative finite number");
  const busy = state.phase === "starting" || state.phase === "stopping" || state.phase === "saving" || state.phase === "discarding";
  const denied = state.phase === "idle" && state.permissionDenied;
  let ring: RecorderView["ring"] = "idle";
  let flat = false;
  let pill: RecorderView["pill"] = { label: FINAL_COPY.idle, dot: "hollow" };
  let statusLine: string | null = null;
  if (state.phase === "starting") pill = { label: FINAL_COPY.starting, dot: "hollow" };
  else if (state.phase === "stopping" || state.phase === "saving") pill = { label: FINAL_COPY.saving, dot: "hollow" };
  else if (state.phase === "discarding") pill = { label: FINAL_COPY.discarding, dot: "hollow" };
  else if (denied) { pill = { label: FINAL_COPY.microphoneOff, dot: "hollow" }; statusLine = FINAL_COPY.denied; }
  else if (state.phase === "recording") {
    const { state: micState, reason } = state.mic as { state: FinalMicState; reason: FinalMicReason };
    if (micState === "paused") { ring = "paused"; pill = { label: FINAL_COPY.resting, dot: "filled-grey" }; }
    else if (micState === "interrupted") {
      if (reason === "resume_not_allowed") { ring = "still-resumable"; pill = { label: FINAL_COPY.tapToResume, dot: "hollow" }; }
      else { ring = "still"; pill = { label: FINAL_COPY.interrupted, dot: "hollow" }; statusLine = reason === "stalled" ? FINAL_COPY.resumesWhenCallEnds : FINAL_COPY.resumeBlocked; }
    } else if (micState === "needs_user") { ring = "still-resumable"; pill = { label: FINAL_COPY.tapToResume, dot: "hollow" }; }
    else if (micState === "silenced") {
      ring = "live"; flat = true; pill = { label: FINAL_COPY.listening, dot: "red" };
      if (input.silencedSinceMs != null && input.nowMs - input.silencedSinceMs >= 5000) statusLine = FINAL_COPY.noSoundFrom(input.inputName ?? "microphone");
    } else if (micState === "recording") { ring = "live"; pill = { label: FINAL_COPY.listening, dot: "red" }; }
    else if (micState === "idle") { ring = "still"; pill = { label: FINAL_COPY.interrupted, dot: "hollow" }; }
    else throw new Error(`Unsupported microphone state: ${String(micState)}`);
  }
  const controls = {
    pause: ring === "live" && !busy && state.controlPending !== "pause" && !state.controlPending,
    resume: (ring === "paused" || ring === "still-resumable") && !busy && !state.controlPending,
    stop: state.phase === "recording" && !busy,
    discard: state.phase === "recording" && !busy,
    busy,
    openSettings: denied,
  };
  const countdown = input.elapsedMs >= WARNING_AT_MS ? { text: FINAL_COPY.stopAt(fmt(LIMIT_MS)) } : undefined;
  return {
    ring, flat, pill, statusLine,
    timer: { text: fmt(input.elapsedMs), ...(countdown ? { countdown } : {}) },
    controls, micDenied: denied,
    tapRingAction: controls.resume ? "resume" : controls.pause ? "pause" : null,
  };
}
