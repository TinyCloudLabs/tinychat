import type { VoiceNoteHoldStore } from "@/lib/voiceNotes/voiceNoteTranscription";

/** A hold store kept in memory; share one between transcribers to stand in for a relaunch on the same account. */
export function memoryHoldStore(initial: string[] = []): VoiceNoteHoldStore & { ids: string[] } {
  const store = {
    ids: [...initial],
    read: () => [...store.ids],
    write: (sourceIds: string[]) => {
      store.ids = [...sourceIds];
    },
  };
  return store;
}
