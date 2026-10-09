import { useEffect, useState } from "react";
import type { RecorderState } from "./recorderReducer";

/** Native recorded time advances through interruptions and blocked resumes, but freezes on user Pause. */
export function useRecordedElapsed(elapsedMs: number, recorder: Pick<RecorderState, "phase" | "mic">): number {
  const running = recorder.phase === "recording" && recorder.mic.state !== "paused";
  const [clock, setClock] = useState(() => Date.now());
  const [checkpointAt, setCheckpointAt] = useState(() => Date.now());
  useEffect(() => {
    const at = Date.now();
    setCheckpointAt(at);
    setClock(at);
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, [elapsedMs, running]);
  return elapsedMs + (running ? Math.max(0, clock - checkpointAt) : 0);
}
