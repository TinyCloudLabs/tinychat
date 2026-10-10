import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  adoptNote,
  loadNote,
  saveNote,
} from "@/lib/voiceNotes/recordingNotes";
import {
  readRecordingNoteFromSpace,
  syncRecordingNote,
} from "@/lib/voiceNotes/voiceNoteStore";

export interface SavedNoteRecord {
  md: string;
  /** ISO time of the last saved edit; null when the note has only been written during recording. */
  savedEditAt: string | null;
}

/** Where a saved recording's note is read and rewritten. The app's is the device's note store plus the space. */
export interface SavedNoteStore {
  /** The note, or null when the recording has none. Rejects when it could not be read. */
  load(id: string): Promise<SavedNoteRecord | null>;
  /** Durable on this device when the promise resolves; `synced` settles when the space has it too, and rejects if it could not. */
  save(
    id: string,
    md: string,
  ): Promise<{ record: SavedNoteRecord; synced: Promise<void> }>;
}

/**
 * The note of a saved recording: the device's copy first, else the space's (adopted, so the first edit is a revision of
 * it), and every save through the same local-first write the recorder's note uses.
 */
export function spaceSavedNoteStore(tcw: TinyCloudWeb): SavedNoteStore {
  return {
    async load(id) {
      let note = await loadNote(id);
      if (!note) {
        const remote = await readRecordingNoteFromSpace(tcw, id);
        if (remote) note = await adoptNote(remote);
      }
      return note ? { md: note.md, savedEditAt: note.savedEditAt } : null;
    },
    async save(id, md) {
      const note = await saveNote(id, md, { savedEdit: true });
      return {
        record: { md: note.md, savedEditAt: note.savedEditAt },
        synced: syncRecordingNote(tcw, id).then(() => undefined),
      };
    },
  };
}

let override: SavedNoteStore | null = null;

/** The screenshot harness has no device note store or space to hold notes; it supplies its own. Never called by the app. */
export function __setSavedNoteStoreForTests(store: SavedNoteStore | null): void {
  override = store;
}

export const savedNoteStoreFor = (tcw: TinyCloudWeb): SavedNoteStore =>
  override ?? spaceSavedNoteStore(tcw);
