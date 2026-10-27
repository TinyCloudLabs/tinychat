import { useCallback, useEffect, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "../captureEvents";
import { readSpeakerNames, speakerDisplayName, withSpeakerName, type SpeakerNames } from "./speakerNames";
import { patchRowSpeakerNames } from "@/lib/voiceNotes/voiceNoteRows";

export interface SpeakerNameChange {
  original: string;
  /** What the label showed before, and after. */
  from: string;
  to: string;
  undone: boolean;
}

export interface SpeakerNamesController {
  names: SpeakerNames;
  rename: (original: string, shown: string) => void;
  /** Puts the last rename back; null when there is nothing to undo. */
  undo: (() => void) | null;
  change: SpeakerNameChange | null;
  failed: boolean;
}

/**
 * The open note's speaker names: read from its metadata, shown at once when changed and saved to its row one write
 * at a time. A failed save puts the names back as they were. Undefined when the note has no row to write.
 */
export function useSpeakerNames(options: {
  tcw: TinyCloudWeb;
  /** The note's row id and source; null when it has no row (a note only on this phone). */
  row: { id: string; source: string; sourceId: string } | null;
  metadata: unknown;
}): SpeakerNamesController | undefined {
  const { tcw, row, metadata } = options;
  const rowId = row?.id ?? null;
  const [local, setLocal] = useState<{ rowId: string; names: SpeakerNames } | null>(null);
  const [change, setChange] = useState<{ rowId: string; value: SpeakerNameChange; previous: SpeakerNames } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const pending = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const current = useRef<SpeakerNames>(readSpeakerNames(metadata));

  // A fresh read of the row is the truth again once our own writes have landed.
  useEffect(() => { if (pending.current === 0) setLocal(null); }, [metadata]);
  useEffect(() => { setLocal(null); setChange(null); setFailure(null); }, [rowId]);

  const names = local?.rowId === rowId ? local.names : readSpeakerNames(metadata);
  current.current = names;

  const commit = useCallback((next: SpeakerNames, previous: SpeakerNames) => {
    if (row === null) return;
    current.current = next;
    setLocal({ rowId: row.id, names: next });
    setFailure(null);
    pending.current += 1;
    chain.current = chain.current.then(async () => {
      try {
        await patchRowSpeakerNames(tcw, row.id, next);
        captureEvents.emit("library-changed", { source: row.source, sourceId: row.sourceId });
      } catch {
        current.current = previous;
        setLocal({ rowId: row.id, names: previous });
        setChange(null);
        setFailure(row.id);
      } finally {
        pending.current -= 1;
      }
    });
  }, [tcw, row]);

  const rename = useCallback((original: string, shown: string) => {
    if (row === null) return;
    const previous = current.current;
    const next = withSpeakerName(previous, original, shown);
    const from = speakerDisplayName(previous, original);
    const to = speakerDisplayName(next, original);
    if (from === to) return;
    setChange({ rowId: row.id, value: { original, from, to, undone: false }, previous });
    commit(next, previous);
  }, [row, commit]);

  const undo = useCallback(() => {
    if (change === null || change.rowId !== rowId || change.value.undone) return;
    const { original, from, to } = change.value;
    setChange({ rowId: change.rowId, value: { original, from: to, to: from, undone: true }, previous: current.current });
    commit(change.previous, current.current);
  }, [change, rowId, commit]);

  if (row === null) return undefined;
  const shown = change?.rowId === rowId ? change : null;
  return { names, rename, undo: shown !== null && !shown.value.undone ? undo : null, change: shown?.value ?? null, failed: failure === rowId };
}
