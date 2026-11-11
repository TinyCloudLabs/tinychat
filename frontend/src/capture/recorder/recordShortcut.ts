// The Mac app's Start recording: its global shortcut (⌘⇧⌥R) and menu-bar item. The native side
// (desktop/src-tauri/src/record_launch.rs) brings the window forward and sends this event; the
// recorder answers it the way its own Record control would.
import { useEffect, useState } from "react";

export const START_REQUESTED_EVENT = "exo://recorder-start-requested";

export interface RecordShortcutTarget {
  available: boolean;
  ready: boolean;
  /** A recording is under way, or its receipt is still showing (recorderActive). */
  active: boolean;
  record(): void;
  openSheet(): void;
}

export type RecordShortcutAction = "open" | "record" | "wait" | "drop";

/**
 * A recording under way (or its receipt) is shown, never restarted. Until the recorder has heard
 * what is already running, the request waits, as Record does. Without a recorder it is dropped.
 */
export function recordShortcutAction(target: Pick<RecordShortcutTarget, "available" | "ready" | "active">): RecordShortcutAction {
  if (!target.available) return "drop";
  if (target.active) return "open";
  return target.ready ? "record" : "wait";
}

export type SubscribeStartRequests = (handler: () => void) => Promise<() => void>;

export const listenForStartRequests: SubscribeStartRequests = async (handler) => {
  // Lazy: @tauri-apps/api must never enter the web bundle's main chunk.
  const { listen } = await import("@tauri-apps/api/event");
  return listen(START_REQUESTED_EVENT, () => handler());
};

export function useRecordShortcut(enabled: boolean, target: RecordShortcutTarget,
  subscribe: SubscribeStartRequests = listenForStartRequests): void {
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let stop: (() => void) | null = null;
    void subscribe(() => setRequested(true)).then((unlisten) => {
      if (live) stop = unlisten;
      else unlisten();
    }, (error: unknown) => console.warn("[recordShortcut] Could not listen for Start recording", error));
    return () => {
      live = false;
      stop?.();
    };
  }, [enabled, subscribe]);
  const { available, ready, active, record, openSheet } = target;
  useEffect(() => {
    if (!requested) return;
    const action = recordShortcutAction({ available, ready, active });
    if (action === "wait") return;
    setRequested(false);
    if (action === "open") openSheet();
    else if (action === "record") record();
  }, [requested, available, ready, active, record, openSheet]);
}
