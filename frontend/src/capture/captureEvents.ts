// Something new landed in the user's space (TC-761): a voice note saved from
// the Capture card or the chat bar, an upload's transcript, a notetaker's
// transcript copied in. The Library listens and re-lists while it is open.
// Emitting never reads storage; listeners decide whether to.

export type CaptureEvent = "library-changed";

const listeners = new Map<CaptureEvent, Set<() => void>>();

export const captureEvents = {
  emit(event: CaptureEvent): void {
    for (const listener of [...(listeners.get(event) ?? [])]) listener();
  },
  /** Returns the unsubscribe. */
  on(event: CaptureEvent, listener: () => void): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  },
};
