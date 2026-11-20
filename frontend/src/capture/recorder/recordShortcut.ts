// The Mac app's Start recording: its global shortcut (⌘⇧⌥R) and menu-bar item. The native side
// (desktop/src-tauri/src/record_launch.rs) brings the window forward, holds the request and sends
// this event; the recorder claims the request and answers it the way its own Record control would.
// The call prompt tile's Stop works the same way, with its own event and claim (useStopShortcut below).
import { useEffect, useRef, useState } from "react";

export const START_REQUESTED_EVENT = "exo://recorder-start-requested";
/** A claimed request waits this long for the recorder (engine install, account setup) before it is dropped. */
export const START_REQUEST_WAIT_MS = 15_000;

export interface RecordShortcutTarget {
  available: boolean;
  ready: boolean;
  /** A recording is under way, or its receipt is still showing (recorderActive). */
  active: boolean;
  record(): void;
  openSheet(): void;
}

export type RecordShortcutAction = "open" | "record" | "wait";

/**
 * A recording under way (or its receipt) is shown, never restarted. Until the recorder exists and
 * has heard what is already running, the request waits, as Record does.
 */
export function recordShortcutAction(target: Pick<RecordShortcutTarget, "available" | "ready" | "active">): RecordShortcutAction {
  if (!target.available) return "wait";
  if (target.active) return "open";
  return target.ready ? "record" : "wait";
}

export interface StartRequests {
  /** Calls the handler whenever the native side has a new request. */
  subscribe(handler: () => void): Promise<() => void>;
  /** True once per request (record_launch.rs `recorder_take_start_request`). */
  take(): Promise<boolean>;
}

export const tauriStartRequests: StartRequests = {
  async subscribe(handler) {
    // Lazy: @tauri-apps/api must never enter the web bundle's main chunk.
    const { listen } = await import("@tauri-apps/api/event");
    return listen(START_REQUESTED_EVENT, () => handler());
  },
  async take() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("recorder_take_start_request");
  },
};

/** The call prompt tile's Stop (record_launch.rs `StopRequest`). */
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
 * Stops the recording when the call prompt tile asks to. Each claimed request stops at most once, and only a live
 * or paused recording; a request claimed at any other time is spent and does nothing. It never starts anything.
 */
export function useStopShortcut(enabled: boolean, target: StopShortcutTarget,
  requests: StopRequests = tauriStopRequests): void {
  // The latest target: a claim answers with the recorder as it is when the claim lands.
  const latest = useRef(target);
  latest.current = target;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let unlisten: (() => void) | null = null;
    const claim = () => void requests.take().then((pending) => {
      if (!live || !pending || !latest.current.recording) return;
      try {
        latest.current.stop();
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
  }, [enabled, requests]);
}

export function useRecordShortcut(enabled: boolean, target: RecordShortcutTarget,
  requests: StartRequests = tauriStartRequests, waitMs = START_REQUEST_WAIT_MS): void {
  // 0: none. Each claim is a new value, so a later press restarts the wait.
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let stop: (() => void) | null = null;
    const claim = () => void requests.take().then((pending) => { if (live && pending) setRequest((n) => n + 1); },
      (error: unknown) => console.warn("[recordShortcut] Could not claim the Start recording request", error));
    void requests.subscribe(claim).then((unlisten) => {
      if (!live) { unlisten(); return; }
      stop = unlisten;
      // A press made before this listener existed (the webview was still loading) is still held natively.
      claim();
    }, (error: unknown) => console.warn("[recordShortcut] Could not listen for Start recording", error));
    return () => {
      live = false;
      stop?.();
    };
  }, [enabled, requests]);
  useEffect(() => {
    if (request === 0) return;
    const timer = setTimeout(() => setRequest(0), waitMs);
    return () => clearTimeout(timer);
  }, [request, waitMs]);
  const { available, ready, active, record, openSheet } = target;
  useEffect(() => {
    if (request === 0) return;
    const action = recordShortcutAction({ available, ready, active });
    if (action === "wait") return;
    setRequest(0);
    if (action === "open") openSheet();
    else record();
  }, [request, available, ready, active, record, openSheet]);
}
