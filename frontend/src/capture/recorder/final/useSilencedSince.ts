import { useRef } from "react";

/** When a silence began, given the last answer and whether the mic is silenced now. */
export function nextSilencedSince(previous: number | null, silenced: boolean, now: number): number | null {
  if (!silenced) return null;
  return previous ?? now;
}

/**
 * UI timing only: the time of the first observation of silence. After a
 * WebView pickup that is when this view first sees it, not when the mic did.
 * `seed` starts the timer earlier (the harness).
 */
export function useSilencedSince(silenced: boolean, seed: number | null = null): number | null {
  const since = useRef<number | null>(seed);
  since.current = nextSilencedSince(since.current, silenced, Date.now());
  return since.current;
}
