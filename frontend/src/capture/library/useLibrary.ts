// The Library's data (TC-761, plan §4.11), called once in CaptureSurface: the
// list for Recent, the Library and the list pane, and the open note's reads.
//
// Every storage call goes through the per-space queue (scheduledSpace), so it
// takes turns with an upload's, and through one chain here, so two of these
// reads are never in flight at once (TinyCloud drops concurrent responses on
// one space). No Promise.all over storage.
//
// The list is read on mount, each time Capture comes on screen or the Library
// is entered, when something lands (`library-changed`), when a voice note's
// transcript is saved, and from Refresh or Try again. A note's settled reads
// are cached; a failed one is read again when the note is next opened (or on
// Try again), never pinned.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { getAudio } from "@/lib/audio/audioStore";
import {
  listMeetingsRead,
  meetingAudioFrom,
  readMeetingMetadata,
  readTranscript,
  type MeetingMetadataRead,
  type TranscriptRead,
} from "@/lib/connectors/meetingExplorer";
import { scheduledSpace } from "@/lib/spaceQueue";
import { loadVoiceNoteAudioBlob, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { voiceNoteTranscriberFor } from "@/lib/voiceNotes/voiceNoteTranscription";
import { captureEvents } from "../captureEvents";
import type { LibraryFilter } from "./libraryKinds";
import type { LibraryStatus } from "./LibraryListView";
import type { LibraryItem } from "./LibraryRow";
import type { AudioLoad } from "./NoteDetailView";

export interface NoteReads {
  metadata?: MeetingMetadataRead;
  transcript?: TranscriptRead;
}

export interface Library {
  status: LibraryStatus;
  items: LibraryItem[];
  filter: LibraryFilter;
  setFilter: (filter: LibraryFilter) => void;
  refresh: () => void;
  /** The open note's row (null until the list has it), its reads, and its audio. */
  note: { item: LibraryItem | null; reads: NoteReads; loadAudio: AudioLoad | null };
  /** Reads again what failed: the list, and the open note's reads. */
  retry: () => void;
}

const settled = (read: { status: string } | undefined) => read !== undefined && read.status !== "failed";
const noop = () => undefined;

export function useLibrary(
  tcw: TinyCloudWeb,
  options: {
    /** Capture is on screen. */
    visible: boolean;
    /** The Library screen (or a note) is on screen. */
    libraryShown: boolean;
    noteId: string | null;
    /** The phone app's voice-note transcriber, to hear when a transcript is saved; absent elsewhere. */
    transcriber?: { backendUrl: string; sessionStore: SessionStore } | null;
  },
): Library {
  const space = useMemo(() => scheduledSpace(tcw), [tcw]);
  const [list, setList] = useState<{ status: LibraryStatus; items: LibraryItem[] }>({ status: "loading", items: [] });
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const reads = useRef(new Map<string, NoteReads>());
  const reading = useRef(new Set<string>());
  const [, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((n) => n + 1), []);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const listRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** After every read already queued here, whether it resolved or rejected. */
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(task, task);
    chain.current = run.then(noop, noop);
    return run;
  }, []);

  const refresh = useCallback(() => {
    const request = ++listRequest.current;
    // Try again shows the skeleton; rows already on screen stay until the list answers.
    setList((current) => (current.status === "failed" ? { ...current, status: "loading" } : current));
    void enqueue(async () => {
      const read = await listMeetingsRead(space);
      if (!mounted.current || request !== listRequest.current) return;
      setList((current) => (read.status === "ok" ? { status: "ready", items: read.meetings } : { status: "failed", items: current.items }));
    });
  }, [enqueue, space]);

  // Read on mount, and each time Capture comes on screen or the Library is entered.
  useEffect(() => {
    if (options.visible) refresh();
  }, [options.visible, options.libraryShown, refresh]);

  // Something landed (a voice note saved, an upload's or a notetaker's transcript).
  const visibleRef = useRef(options.visible);
  visibleRef.current = options.visible;
  const stale = useRef(false);
  useEffect(
    () =>
      captureEvents.on("library-changed", () => {
        if (visibleRef.current) refresh();
        else stale.current = true;
      }),
    [refresh],
  );
  useEffect(() => {
    if (options.visible && stale.current) {
      stale.current = false;
      refresh();
    }
  }, [options.visible, refresh]);

  const item = options.noteId === null ? null : (list.items.find((entry) => entry.id === options.noteId) ?? null);

  const readNote = useCallback(
    (note: LibraryItem) => {
      const cached = reads.current.get(note.id) ?? {};
      if ((settled(cached.metadata) && settled(cached.transcript)) || reading.current.has(note.id)) return;
      // Drop a previous failure, so the note reads "loading" rather than restating it.
      reads.current.set(note.id, {
        metadata: settled(cached.metadata) ? cached.metadata : undefined,
        transcript: settled(cached.transcript) ? cached.transcript : undefined,
      });
      reading.current.add(note.id);
      bump();
      void enqueue(async () => {
        try {
          if (!settled(reads.current.get(note.id)?.metadata)) {
            const metadata = await readMeetingMetadata(space, note.id);
            reads.current.set(note.id, { ...reads.current.get(note.id), metadata });
            if (mounted.current) bump();
          }
          if (!settled(reads.current.get(note.id)?.transcript)) {
            const transcript = await readTranscript(space, note.source, note.sourceId);
            reads.current.set(note.id, { ...reads.current.get(note.id), transcript });
            if (mounted.current) bump();
          }
        } finally {
          reading.current.delete(note.id);
        }
      });
    },
    [bump, enqueue, space],
  );

  useEffect(() => {
    if (item) readNote(item);
  }, [item, readNote]);

  // A voice note's transcript was saved: its reads are stale, and so is the list.
  const transcriberBackend = options.transcriber?.backendUrl;
  const transcriberSession = options.transcriber?.sessionStore;
  const itemsRef = useRef(list.items);
  itemsRef.current = list.items;
  useEffect(() => {
    if (!transcriberBackend || !transcriberSession) return;
    return voiceNoteTranscriberFor(tcw, transcriberBackend, transcriberSession)?.subscribe((event) => {
      if (event.kind !== "saved") return;
      const saved = itemsRef.current.find((entry) => entry.source === VOICE_NOTE_SOURCE && entry.sourceId === event.sourceId);
      if (saved) reads.current.delete(saved.id);
      captureEvents.emit("library-changed");
    });
  }, [tcw, transcriberBackend, transcriberSession]);

  // Re-read the open note once its reads were dropped (a transcript saved).
  const noteReads = item ? (reads.current.get(item.id) ?? {}) : {};
  useEffect(() => {
    if (item && noteReads.metadata === undefined && noteReads.transcript === undefined) readNote(item);
  });

  const meta = noteReads.metadata?.status === "ok" ? noteReads.metadata.metadata : null;
  const audio = item ? meetingAudioFrom(meta) : null;
  const audioBase = audio?.status === "stored" ? audio.base : null;
  const voiceSourceId = item?.source === VOICE_NOTE_SOURCE ? item.sourceId : null;
  // The stored file is read only when the player asks, on the same chain.
  const loadAudio = useMemo<AudioLoad | null>(() => {
    if (voiceSourceId !== null) {
      return (_signal, onProgress) =>
        enqueue(async () => {
          const res = await loadVoiceNoteAudioBlob(space, voiceSourceId, { onProgress });
          if (!res.ok) throw new Error(res.error.message);
          return res.data;
        });
    }
    if (audioBase !== null) return (signal, onProgress) => enqueue(() => getAudio(space.kv, audioBase, { signal, onProgress }));
    return null;
  }, [audioBase, enqueue, space, voiceSourceId]);

  const retry = useCallback(() => {
    if (list.status === "failed") refresh();
    if (item) readNote(item);
  }, [item, list.status, readNote, refresh]);

  return {
    status: list.status,
    items: list.items,
    filter,
    setFilter,
    refresh,
    note: { item, reads: noteReads, loadAudio },
    retry,
  };
}
