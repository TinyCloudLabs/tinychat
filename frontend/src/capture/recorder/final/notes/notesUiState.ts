import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { NotesView } from "../notesViewPreference";

/** What the notes UI holds for the recording in progress, above whichever layout is mounted. */
export interface NotesUiFields {
  /** The notes sheet (phone) or note view (desktop) is open. */
  open: boolean;
  view: NotesView;
  /** Typed text the autosave has not committed through `setNoteText` yet; null when nothing is waiting. */
  draft: string | null;
  // TODO(TC-878): the provider owns the note; delete this field with notesApiStub.ts.
  noteMd: string | null;
}

export interface NotesUi extends NotesUiFields {
  /** Opens the notes in `view`. The desktop note view always passes "write". */
  openNotes(view: NotesView): void;
  closeNotes(): void;
  setView(view: NotesView): void;
  setDraft(md: string): void;
  /** The autosave committed `md`: the draft is settled unless newer text has been typed since. */
  settleDraft(md: string): void;
  setNoteMd(md: string): void;
}

const INITIAL: NotesUiFields = {
  open: false,
  view: "preview",
  draft: null,
  noteMd: null,
};

// One recording is in progress at a time. `key` is its wall-clock start; state for any other key is not used.
let stored: { key: number; fields: NotesUiFields } | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => stored;

function update(
  key: number,
  seed: Partial<NotesUiFields> | undefined,
  patch: (fields: NotesUiFields) => Partial<NotesUiFields>,
): void {
  const base = stored?.key === key ? stored.fields : { ...INITIAL, ...seed };
  stored = { key, fields: { ...base, ...patch(base) } };
  for (const listener of [...listeners]) listener();
}

/** Forgets everything: the recording ended (Done or discard), or a test starts clean. */
export function clearNotesUi(): void {
  if (stored === null) return;
  stored = null;
  for (const listener of [...listeners]) listener();
}

/**
 * The notes UI state of the recording started at `recordingKey`, shared by every layout, so a phone ⇄ desktop
 * switch (unmount, remount) loses nothing. It clears itself once that recording is gone. `seed` is the state
 * before anything has been changed (the harness).
 */
export function useNotesUi(
  recordingKey: number | null,
  seed?: Partial<NotesUiFields>,
): NotesUi {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const seedRef = useRef(seed);
  seedRef.current = seed;

  useEffect(() => {
    if (stored !== null && stored.key !== recordingKey) clearNotesUi();
  }, [recordingKey]);

  const live = current !== null && current.key === recordingKey;
  const fields = live ? current.fields : undefined;
  return useMemo(() => {
    const now = fields ?? { ...INITIAL, ...seedRef.current };
    const set = (patch: (f: NotesUiFields) => Partial<NotesUiFields>) => {
      // No recording in progress (it just ended): there is nothing for this state to belong to.
      if (recordingKey === null) return;
      update(recordingKey, seedRef.current, patch);
    };
    return {
      ...now,
      openNotes: (view) => set(() => ({ open: true, view })),
      closeNotes: () => set(() => ({ open: false })),
      setView: (view) => set(() => ({ view })),
      setDraft: (md) => set(() => ({ draft: md })),
      settleDraft: (md) => set((f) => (f.draft === md ? { draft: null } : {})),
      setNoteMd: (md) => set(() => ({ noteMd: md })),
    };
  }, [fields, recordingKey]);
}
