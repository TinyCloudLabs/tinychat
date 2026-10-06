// What is capturing the microphone right now, for display only: the Live Edge
// and the other views that follow a recording. The recorders publish here
// (the voice-note recorder, the offline recorder, the desktop app's local
// recorder); nothing here ever calls the plugin. Levels fan out to
// subscribers without React state, so a sample never re-renders anything.
import { useSyncExternalStore } from "react";

export type LiveCaptureSource = "voice-note" | "offline-voice-note" | "desktop-local";

export interface LiveCapture {
  source: LiveCaptureSource;
  /** The mic is silenced or hears nothing: the edge turns amber and holds still. */
  warning: boolean;
  startedAt: number | null;
}

let current: LiveCapture | null = null;
const listeners = new Set<() => void>();
const levelListeners = new Set<(level: number) => void>();

function same(a: LiveCapture | null, b: LiveCapture | null): boolean {
  if (a === null || b === null) return a === b;
  return a.source === b.source && a.warning === b.warning && a.startedAt === b.startedAt;
}

export const liveCapture = {
  get(): LiveCapture | null {
    return current;
  },
  /** Publish (or clear, with null) the capture; subscribers hear only real changes. */
  set(next: LiveCapture | null): void {
    if (same(current, next)) return;
    current = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** One input level sample, 0..1. */
  setLevel(level: number): void {
    for (const listener of levelListeners) listener(level);
  },
  subscribeLevel(listener: (level: number) => void): () => void {
    levelListeners.add(listener);
    return () => {
      levelListeners.delete(listener);
    };
  },
};

export function useLiveCapture(): LiveCapture | null {
  return useSyncExternalStore(liveCapture.subscribe, liveCapture.get, () => null);
}

/**
 * The edge's brightness from a level sample: the square root lifts quiet
 * speech, and a peak decays by 30% a sample rather than dropping at once.
 */
export function edgeLevel(sample: number, previous: number): number {
  const level = Math.sqrt(Math.min(1, Math.max(0, sample)));
  return Math.max(level, previous * 0.7);
}
