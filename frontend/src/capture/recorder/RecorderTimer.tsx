// The recorder's audio time. Each view ticks its own (the provider never
// does), so a minimised recorder costs nothing.
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { formatDuration } from "./recorderCopy";

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

/** "12:48", ticking from native audio time; `fixedMs` shows a finished length. */
export function RecorderTimer(props: { audioMs: number; running: boolean; fixedMs?: number; className?: string }) {
  const audioElapsed = useAudioElapsed(props.audioMs, props.running);
  return (
    <span data-recorder-timer="" className={cn("tnum", props.className)}>
      {formatDuration(props.fixedMs ?? audioElapsed)}
    </span>
  );
}
