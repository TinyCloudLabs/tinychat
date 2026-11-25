// The call prompt tile's Stop (desktop/src-tauri/src/record_launch.rs `StopRequest`): the tile asks, the native side
// holds the request and sends this event, and the recorder claims it and stops the way its own Stop does. Desktop only:
// the main app loads this with its own chunk (recordShortcut.ts `watchStopRequestsLater`, TC-2882).
import { useEffect, useRef } from "react";
import type { StartRequests } from "./recordShortcut";

export const STOP_REQUESTED_EVENT = "exo://recorder-stop-requested";

/** The same shape as StartRequests: `take` is true once per request (`recorder_take_stop_request`). */
export type StopRequests = StartRequests;

export const tauriStopRequests: StopRequests = {
  async subscribe(handler) {
    // Lazy: @tauri-apps/api must never enter the web bundle's main chunk.
    const { listen } = await import("@tauri-apps/api/event");
    return listen(STOP_REQUESTED_EVENT, () => handler());
  },
  async take() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("recorder_take_stop_request");
  },
};

/**
 * Whether a stop request applies to the recorder in this state: a recording that is live or paused (paused is the
 * recording phase with the microphone paused). Starting, stopping, saving and idle: no.
 */
export function stopRequestApplies(state: { phase: string }): boolean {
  return state.phase === "recording";
}

export interface StopShortcutTarget {
  /** A recording is live or paused: the only time a stop request does anything. */
  recording: boolean;
  /** The app's own Stop, so the note is finalized and saved the usual way. */
  stop(): void;
}

/**
 * Listens for the tile's Stop until the returned function is called. Each claimed request stops at most once, and only
 * a live or paused recording (`target()` as it is when the claim lands); a request claimed at any other time is spent
 * and does nothing. It never starts anything.
 */
export function watchStopRequests(requests: StopRequests, target: () => StopShortcutTarget): () => void {
  let live = true;
  let unlisten: (() => void) | null = null;
  const claim = () => void requests.take().then((pending) => {
    if (!live || !pending) return;
    const current = target();
    if (!current.recording) return;
    try {
      current.stop();
    } catch (error) {
      console.warn("[recordShortcut] Could not stop the recording", error);
    }
  }, (error: unknown) => console.warn("[recordShortcut] Could not claim the Stop recording request", error));
  void requests.subscribe(claim).then((stop) => {
    if (!live) { stop(); return; }
    unlisten = stop;
    // A Stop pressed before this listener existed is still held natively.
    claim();
  }, (error: unknown) => console.warn("[recordShortcut] Could not listen for Stop recording", error));
  return () => {
    live = false;
    unlisten?.();
  };
}

/** `watchStopRequests` while `enabled`, with the latest `target`. */
export function useStopShortcut(enabled: boolean, target: StopShortcutTarget,
  requests: StopRequests = tauriStopRequests): void {
  // The latest target: a claim answers with the recorder as it is when the claim lands.
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => enabled ? watchStopRequests(requests, () => latest.current) : undefined, [enabled, requests]);
}
