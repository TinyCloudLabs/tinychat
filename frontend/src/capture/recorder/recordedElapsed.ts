import type { RecorderState } from "./recorderReducer";

/** Native recorded-time checkpoint plus wall time since receipt; user Pause freezes it. */
export function recordedElapsedAt(state: Pick<RecorderState, "phase" | "mic" | "elapsedMs" | "elapsedAt">,
  now = Date.now()): number {
  const running = state.phase === "recording" && state.mic.state !== "paused";
  return state.elapsedMs + (running && state.elapsedAt !== null ? Math.max(0, now - state.elapsedAt) : 0);
}
