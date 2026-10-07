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

/** Native audio time advances only while frames are being recorded. */
export function useAudioElapsed(audioMs: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const [checkpoint, setCheckpoint] = useState(() => Date.now());
  useEffect(() => {
    const at = Date.now();
    setCheckpoint(at);
    setNow(at);
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [audioMs, running]);
  return audioMs + (running ? Math.max(0, now - checkpoint) : 0);
}

/** "12:48", ticking from native audio time when provided; `fixedMs` shows a finished length. */
export function RecorderTimer(props: { startedAt: number | null; audioMs?: number; running?: boolean; fixedMs?: number; className?: string }) {
  const elapsed = useElapsed(props.fixedMs === undefined ? props.startedAt : null);
  const audioElapsed = useAudioElapsed(props.audioMs ?? 0, props.running ?? false);
  return (
    <span data-recorder-timer="" className={cn("tnum", props.className)}>
      {formatDuration(props.fixedMs ?? (props.audioMs === undefined ? elapsed : audioElapsed))}
    </span>
  );
}
