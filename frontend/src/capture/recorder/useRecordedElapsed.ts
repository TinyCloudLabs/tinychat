import { useEffect, useState } from "react";

/** Tick a native recorded-time checkpoint only while recording or silenced; pauses freeze it. */
export function useRecordedElapsed(elapsedMs: number, running: boolean): number {
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
