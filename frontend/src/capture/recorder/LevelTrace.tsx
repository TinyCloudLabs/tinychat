// The tape-style level trace: the last few seconds of input level as a strip
// of bars, newest on the right (sound in, then Stop below it). Samples are
// written straight to the bars; React never renders per sample. Decoration:
// the status line carries the same state.
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/** The flat line a silent bar draws, as a share of the trace's height. */
const FLOOR = 0.08;

export function barScale(level: number): number {
  return FLOOR + (1 - FLOOR) * Math.min(1, Math.max(0, level));
}

export function LevelTrace(props: {
  subscribe: (listener: (level: number) => void) => () => void;
  /** `live` while the mic hears; `warning` while it is silenced or hears nothing. */
  tone?: "live" | "warning";
  bars?: number;
  className?: string;
}) {
  const { subscribe, tone = "live", bars = 48 } = props;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const spans = [...element.children] as HTMLElement[];
    const samples: number[] = new Array(spans.length).fill(0);
    return subscribe((level) => {
      samples.shift();
      samples.push(level);
      spans.forEach((span, index) => {
        span.style.transform = `scaleY(${barScale(samples[index]).toFixed(3)})`;
      });
    });
  }, [subscribe, bars]);
  return (
    <div
      ref={root}
      aria-hidden="true"
      data-level-trace=""
      data-tone={tone}
      className={cn("flex h-10 w-full items-center gap-[3px]", props.className)}
    >
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          className={cn("h-full min-w-0 flex-1 rounded-full", tone === "warning" ? "bg-warning" : "bg-live")}
          style={{ transform: `scaleY(${FLOOR})` }}
        />
      ))}
    </div>
  );
}
