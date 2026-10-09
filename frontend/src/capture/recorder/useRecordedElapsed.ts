import { useEffect, useState } from "react";
import type { RecorderState } from "./recorderReducer";

/** Every view ticks from the controller's checkpoint receipt time, including views mounted later. */
export function useRecordedElapsed(elapsedMs: number, recorder: Pick<RecorderState, "phase" | "mic" | "elapsedAt">): number {
  const running = recorder.phase === "recording" && recorder.mic.state !== "paused";
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    setClock(Date.now());
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, [recorder.elapsedAt, running]);
  return elapsedMs + (running && recorder.elapsedAt !== null ? Math.max(0, clock - recorder.elapsedAt) : 0);
}
