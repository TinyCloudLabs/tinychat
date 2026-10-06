// The recorder's elapsed time. Each view ticks its own (the provider never
// does), from the recording's start, so a minimised recorder costs nothing.
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { formatDuration } from "./recorderCopy";

/** Milliseconds since `startedAt`, re-read twice a second; 0 without a start. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

/** "12:48", ticking from `startedAt`; `fixedMs` shows a finished recording's length instead. */
export function RecorderTimer(props: { startedAt: number | null; fixedMs?: number; className?: string }) {
  const elapsed = useElapsed(props.fixedMs === undefined ? props.startedAt : null);
  return (
    <span data-recorder-timer="" className={cn("tnum", props.className)}>
      {formatDuration(props.fixedMs ?? elapsed)}
    </span>
  );
}
