import { useCallback, useEffect, useRef, useState } from "react";
import type { SavedNoteRecord, SavedNoteStore } from "./savedNoteStore";

export type SavedNoteLoad =
  | { status: "loading" }
  | { status: "ready"; record: SavedNoteRecord | null }
  | { status: "failed"; message: string };

export type SyncState = "idle" | "syncing" | "synced" | "failed";

export interface SavedNote {
  load: SavedNoteLoad;
  retryLoad(): void;
  /** Writing the note now. */
  saving: boolean;
  /** The last save did not work (the message); cleared by the next one that does. */
  saveError: string | null;
  sync: SyncState;
  /** Writes `md`; resolves whether it is durable on this device. */
  save(md: string): Promise<boolean>;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The note of recording `id`: read once, rewritten by `save`, with every failure kept for the screen to show. */
export function useSavedNote(id: string, store: SavedNoteStore): SavedNote {
  const [load, setLoad] = useState<SavedNoteLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState>("idle");
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoad({ status: "loading" });
    store.load(id).then(
      (record) => current && setLoad({ status: "ready", record }),
      (error: unknown) => {
        console.error("[SavedNote] Could not read the note", error);
        if (current) setLoad({ status: "failed", message: message(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [id, store, attempt]);

  const save = useCallback(
    async (md: string): Promise<boolean> => {
      setSaving(true);
      try {
        const { record, synced } = await store.save(id, md);
        if (!live.current) return true;
        setSaving(false);
        setSaveError(null);
        setLoad({ status: "ready", record });
        setSync("syncing");
        synced.then(
          () => live.current && setSync("synced"),
          (error: unknown) => {
            console.error("[SavedNote] Could not sync the note", error);
            if (live.current) setSync("failed");
          },
        );
        return true;
      } catch (error) {
        console.error("[SavedNote] Could not save the note", error);
        if (live.current) {
          setSaving(false);
          setSaveError(message(error));
        }
        return false;
      }
    },
    [id, store],
  );

  return {
    load,
    retryLoad: () => setAttempt((n) => n + 1),
    saving,
    saveError,
    sync,
    save,
  };
}
