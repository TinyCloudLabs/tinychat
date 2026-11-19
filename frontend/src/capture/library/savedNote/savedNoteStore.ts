import { currentAccountGeneration } from "@/lib/voiceNotes/accountContext";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  adoptNote,
  assertRecordingNoteAccount,
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
 * it), and every save through the same local-first write the recorder's note uses. `hasSpaceRow` is read when the
 * note is loaded; false keeps the load off the network.
 */
export function spaceSavedNoteStore(tcw: TinyCloudWeb, hasSpaceRow: () => boolean = () => true): SavedNoteStore {
  const generation = currentAccountGeneration();
  const check = async () => {
    if (generation !== currentAccountGeneration()) throw new Error("Recording note account changed");
    await assertRecordingNoteAccount(tcw.did ?? null);
  };
  return {
    async load(id) {
      await check();
      let note = await loadNote(id, tcw.did ?? null);
      // A recording with no row in the space has no note there either: its note is the device's, read or not.
      if (!note && hasSpaceRow()) {
        const remote = await readRecordingNoteFromSpace(tcw, id);
        await check();
        if (remote) note = await adoptNote(remote, tcw.did ?? null);
      }
      await check();
      return note ? { md: note.md, savedEditAt: note.savedEditAt } : null;
    },
    async save(id, md) {
      await check();
      const note = await saveNote(id, md, { savedEdit: true, owner: tcw.did ?? null });
      await check();
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

export const savedNoteStoreFor = (tcw: TinyCloudWeb, hasSpaceRow?: () => boolean): SavedNoteStore =>
  override ?? spaceSavedNoteStore(tcw, hasSpaceRow);
