// Something new landed in the user's space (TC-761): a voice note saved from
// the Capture card or the chat bar, an upload's transcript, a notetaker's
// transcript copied in. The Library listens and re-lists while it is open.
// Emitting never reads storage; listeners decide whether to.

export type CaptureEvent = "library-changed" | "note-deleted";
/** Identity in connector_meeting; omitted for a list-only refresh. */
export interface LibraryChangedDetail { source: string; sourceId: string }

const listeners = new Map<CaptureEvent, Set<(detail?: LibraryChangedDetail) => void>>();

export const captureEvents = {
  emit(event: CaptureEvent, detail?: LibraryChangedDetail): void {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(detail);
  },
  /** Returns the unsubscribe. */
  on(event: CaptureEvent, listener: (detail?: LibraryChangedDetail) => void): () => void {
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
