import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/copyText";
import { isDirty, isEditing } from "./savedNoteEdit";
import { readSavedNoteDraft, useSavedNoteDraft } from "./savedNoteDraft";
import type { SavedNoteStore } from "./savedNoteStore";
import { useSavedNote } from "./useSavedNote";

const COPIED_MS = 1500;

/** What the saved note's page and sheet show and do: the note, its edit, its Copy and the moment the audio should play from. */
export function useSavedNoteScreen(id: string, store: SavedNoteStore) {
  const note = useSavedNote(id, store);
  const draft = useSavedNoteDraft(id);
  const savedMd = note.load.status === "ready" ? (note.load.record?.md ?? "") : "";
  const editing = isEditing(draft);
  const dirty = isDirty(draft, savedMd);

  const [seek, setSeek] = useState<{ seconds: number; nonce: number } | null>(
    null,
  );
  const playFrom = useCallback(
    (seconds: number) =>
      setSeek((current) => ({ seconds, nonce: (current?.nonce ?? 0) + 1 })),
    [],
  );

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const copy = useCallback(async () => {
    const ok = await copyText(savedMd);
    if (!live.current) return;
    setCopyState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState("idle"), COPIED_MS);
  }, [savedMd]);

  const save = useCallback(async () => {
    const md = readSavedNoteDraft(id).draft;
    if (md === null) return;
    if (md === savedMd) {
      draft.finish();
      return;
    }
    const ok = await note.save(md);
    // Typing while it saved is a newer draft: keep it.
    if (ok && readSavedNoteDraft(id).draft === md) draft.finish();
  }, [id, note, draft, savedMd]);

  return {
    note,
    draft,
    savedMd,
    editing,
    dirty,
    seek,
    playFrom,
    copyState,
    copy,
    save,
    startEdit: () => draft.edit(savedMd),
    cancel: () => draft.cancel(savedMd),
    /** The sheet's ✕, Escape or veil: whether it may close now. */
    requestClose: () => draft.close(savedMd),
  };
}

export type SavedNoteScreen = ReturnType<typeof useSavedNoteScreen>;
