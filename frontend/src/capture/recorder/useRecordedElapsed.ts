import { useEffect, useState } from "react";
import type { RecorderState } from "./recorderReducer";
import { recordedElapsedAt } from "./recordedElapsed";

/**
 * Every view ticks from the controller's checkpoint receipt time, including views mounted later. A paused recording
 * still re-renders now and then: its elapsed time is frozen, but its "Stops at" clock time moves later.
 */
export function useRecordedElapsed(elapsedMs: number, recorder: Pick<RecorderState, "phase" | "mic" | "elapsedAt">): number {
  const recording = recorder.phase === "recording";
  const running = recording && recorder.mic.state !== "paused";
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    setClock(Date.now());
    if (!recording) return;
    const timer = setInterval(() => setClock(Date.now()), running ? 500 : 15_000);
    return () => clearInterval(timer);
  }, [recorder.elapsedAt, recording, running]);
  return recordedElapsedAt({ ...recorder, elapsedMs }, clock);
}
