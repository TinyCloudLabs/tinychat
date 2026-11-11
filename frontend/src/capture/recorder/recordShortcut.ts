// The Mac app's Start recording: its global shortcut (⌘⇧⌥R) and menu-bar item. The native side
// (desktop/src-tauri/src/record_launch.rs) brings the window forward, holds the request and sends
// this event; the recorder claims the request and answers it the way its own Record control would.
import { useEffect, useState } from "react";

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

export function useRecordShortcut(enabled: boolean, target: RecordShortcutTarget,
  requests: StartRequests = tauriStartRequests, waitMs = START_REQUEST_WAIT_MS): void {
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let stop: (() => void) | null = null;
    const claim = () => void requests.take().then((pending) => { if (live && pending) setRequested(true); },
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
    if (!requested) return;
    const timer = setTimeout(() => setRequested(false), waitMs);
    return () => clearTimeout(timer);
  }, [requested, waitMs]);
  const { available, ready, active, record, openSheet } = target;
  useEffect(() => {
    if (!requested) return;
    const action = recordShortcutAction({ available, ready, active });
    if (action === "wait") return;
    setRequested(false);
    if (action === "open") openSheet();
    else record();
  }, [requested, available, ready, active, record, openSheet]);
}
