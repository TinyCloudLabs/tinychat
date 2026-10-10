import type { VoiceNoteHoldState, VoiceNoteHoldStore } from "@/lib/voiceNotes/voiceNoteTranscription";

/** A hold store kept in memory; share one between transcribers to stand in for a relaunch on the same account. */
export function memoryHoldStore(initial: Record<string, VoiceNoteHoldState> = {}) {
  const store = {
    entries: { ...initial } as Record<string, VoiceNoteHoldState>,
    read: () => ({ ...store.entries }),
    write: (holds: Record<string, VoiceNoteHoldState>) => {
      store.entries = { ...holds };
    },
    /** The notes currently held. */
    get held() {
      return Object.keys(store.entries).filter((id) => store.entries[id] === "held");
    },
  };
  return store satisfies VoiceNoteHoldStore & { held: string[] };
}
