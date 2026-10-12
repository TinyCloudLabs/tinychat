// The Library's data (TC-761, plan §4.11), called once in CaptureSurface: the
// list for Recent, the Library and the list pane, and the open note's reads.
//
// Every storage call goes through the per-space queue (scheduledSpace), so it
// takes turns with an upload's and never overlaps another (TinyCloud drops
// concurrent responses on one space). The list and the note's reads also wait
// on one chain here, so they run in the order they were asked for. A stored
// audio file is read part by part through the queue alone, so other reads go
// in between its parts, and closing the note's player cancels it. No
// Promise.all over storage.
//
// The list is read on the first mount, when something lands
// (`library-changed`, which a voice note's saved transcript also sends), from
// Refresh or Try again, and when Capture comes back on screen after more than
// two minutes away. One read at a time: asks that arrive while one is out
// become a single read after it; a read already out is never thrown away.
//
// A note's settled reads are cached. Failed revalidation keeps a prior
// successful read visible but marks only that field stale for Try again or
// reopening; initial failures are retried on the same actions.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { voiceNoteTranscriptLocator } from "@/lib/voiceNotes/voiceNoteCommits";
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
  /** A list read is out (Refresh shows it; a note not listed yet waits for it). */
  listing: boolean;
  filter: LibraryFilter;
  setFilter: (filter: LibraryFilter) => void;
  refresh: () => void;
  /** The open note's row (null until the list has it), its reads, and its audio. */
  note: { item: LibraryItem | null; reads: NoteReads; loadAudio: AudioLoad | null };
  /** Reads again what failed: the list, and the open note's reads. */
  retry: () => void;
}

/** Capture away for longer than this re-reads the list when it comes back (plan §4.11). */
export const RELIST_AFTER_MS = 2 * 60 * 1000;

const settled = (read: { status: string } | undefined) => read !== undefined && read.status !== "failed";
const noop = () => undefined;

export function useLibrary(
  tcw: TinyCloudWeb,
  options: {
    /** Capture is on screen. */
    visible: boolean;
    noteId: string | null;
    /** The clock (tests). */
    now?: () => number;
  },
): Library {
  const space = useMemo(() => scheduledSpace(tcw), [tcw]);
  const [list, setList] = useState<{ status: LibraryStatus; items: LibraryItem[] }>({ status: "loading", items: [] });
  const [listing, setListing] = useState(false);
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const reads = useRef(new Map<string, NoteReads>());
  const reading = useRef(new Set<string>());
  const readVersions = useRef(new Map<string, number>());
  const invalidated = useRef(new Set<string>());
  // A failed revalidation keeps the last successful value on screen, but the
  // failed field must still be fetched on Try again or when reopening.
  const staleReads = useRef(new Map<string, Set<keyof NoteReads>>());
  const [invalidationRevision, setInvalidationRevision] = useState(0);
  const [, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((n) => n + 1), []);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const listRun = useRef({ out: false, again: false });
  const clock = useRef(options.now ?? Date.now);
  clock.current = options.now ?? Date.now;

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
    // A read is out: one more after it covers every ask that arrived meanwhile.
    if (listRun.current.out) {
      listRun.current.again = true;
      return;
    }
    listRun.current.out = true;
    setListing(true);
    // Try again shows the skeleton; rows already on screen stay until the list answers.
    setList((current) => (current.status === "failed" ? { ...current, status: "loading" } : current));
    const readList = async (): Promise<void> => {
      const read = await listMeetingsRead(space);
      if (!mounted.current) return;
      setList((current) => (read.status === "ok" ? { status: "ready", items: read.meetings } : { status: "failed", items: current.items }));
      if (listRun.current.again) {
        listRun.current.again = false;
        void enqueue(readList);
        return;
      }
      listRun.current.out = false;
      setListing(false);
    };
    void enqueue(readList);
  }, [enqueue, space]);

  // The first mount (Capture's first visit).
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Coming back to Capture after more than two minutes away.
  const leftAt = useRef<number | null>(options.visible ? null : clock.current());
  useEffect(() => {
    if (!options.visible) {
      leftAt.current ??= clock.current();
      return;
    }
    const away = leftAt.current === null ? 0 : clock.current() - leftAt.current;
    leftAt.current = null;
    if (away > RELIST_AFTER_MS) refresh();
  }, [options.visible, refresh]);

  const itemsRef = useRef(list.items);
  itemsRef.current = list.items;
  // Only the saved row's reads are stale. A list-only change never interrupts
  // the open note's audio or transcript.
  useEffect(() => captureEvents.on("library-changed", (detail) => {
    const saved = detail && itemsRef.current.find((entry) => entry.source === detail.source && entry.sourceId === detail.sourceId);
    if (saved) {
      invalidated.current.add(saved.id);
      readVersions.current.set(saved.id, (readVersions.current.get(saved.id) ?? 0) + 1);
      if (saved.id === options.noteId) setInvalidationRevision((n) => n + 1);
    }
    refresh();
  }), [options.noteId, refresh]);

  const item = options.noteId === null ? null : (list.items.find((entry) => entry.id === options.noteId) ?? null);

  const readNote = useCallback(
    (note: LibraryItem) => {
      const cached = reads.current.get(note.id) ?? {};
      const version = readVersions.current.get(note.id) ?? 0;
      if (reading.current.has(note.id)) return;
      const stale = invalidated.current.delete(note.id);
      const staleFields = staleReads.current.get(note.id);
      staleReads.current.delete(note.id);
      if (!stale && !staleFields?.size && settled(cached.metadata) && settled(cached.transcript)) return;
      // A saved note retains its reads during revalidation; only prior failures show loading.
      if (!stale) {
        reads.current.set(note.id, {
          metadata: settled(cached.metadata) ? cached.metadata : undefined,
          transcript: settled(cached.transcript) ? cached.transcript : undefined,
        });
      }
      reading.current.add(note.id);
      bump();
      void enqueue(async () => {
        try {
          const locator = note.source === VOICE_NOTE_SOURCE
            ? await voiceNoteTranscriptLocator(space, note.sourceId) : null;
          if (version === (readVersions.current.get(note.id) ?? 0) && (stale || staleFields?.has("metadata") || !settled(reads.current.get(note.id)?.metadata))) {
            let metadata = await readMeetingMetadata(space, note.id);
            if (locator && metadata.status === "ok") metadata = { status: "ok", metadata: {
              ...metadata.metadata, transcription_outcome: locator.outcome,
              // The preview is bounded; only the body read may supply full transcript text.
              transcript_text: locator.committed ? null : locator.expectedText,
            } };
            if (version === (readVersions.current.get(note.id) ?? 0) && metadata.status === "failed" && cached.metadata?.status === "ok") {
              const fields = staleReads.current.get(note.id) ?? new Set<keyof NoteReads>();
              fields.add("metadata");
              staleReads.current.set(note.id, fields);
            }
            if (version === (readVersions.current.get(note.id) ?? 0)) {
              reads.current.set(note.id, {
                ...reads.current.get(note.id),
                metadata: metadata.status === "failed" && cached.metadata?.status === "ok"
                  ? cached.metadata : metadata,
              });
              if (mounted.current) bump();
            }
          }
          if (version === (readVersions.current.get(note.id) ?? 0) && (stale || staleFields?.has("transcript") || !settled(reads.current.get(note.id)?.transcript))) {
            const transcript = locator
              ? locator.bodyKey ? await readTranscript(space, note.source, note.sourceId, locator.bodyKey, locator.expectedText)
                : { status: "absent" as const }
              : await readTranscript(space, note.source, note.sourceId);
            if (version === (readVersions.current.get(note.id) ?? 0) && transcript.status === "failed" && cached.transcript?.status === "ok") {
              const fields = staleReads.current.get(note.id) ?? new Set<keyof NoteReads>();
              fields.add("transcript");
              staleReads.current.set(note.id, fields);
            }
            if (version === (readVersions.current.get(note.id) ?? 0)) {
              reads.current.set(note.id, {
                ...reads.current.get(note.id),
                transcript: transcript.status === "failed" && cached.transcript?.status === "ok"
                  ? cached.transcript : transcript,
              });
              if (mounted.current) bump();
            }
          }
        } finally {
          reading.current.delete(note.id);
          if (mounted.current && version !== (readVersions.current.get(note.id) ?? 0)) setInvalidationRevision((n) => n + 1);
        }
      });
    },
    [bump, enqueue, space],
  );

  // An invalidation that arrives during an in-flight read is retried once that
  // read settles; otherwise opening a cached note reads only when needed.
  useEffect(() => {
    if (item) readNote(item);
  }, [item, readNote, invalidationRevision]);

  const noteReads = item ? (reads.current.get(item.id) ?? {}) : {};
  const meta = noteReads.metadata?.status === "ok" ? noteReads.metadata.metadata : null;
  const audio = item ? meetingAudioFrom(meta) : null;
  const audioBase = audio?.status === "stored" ? audio.base : null;
  const voiceSourceId = item?.source === VOICE_NOTE_SOURCE ? item.sourceId : null;
  const pendingAudioRow = voiceSourceId !== null && meta !== null && Object.keys(meta).length === 0;
  // The stored file is read only when the player asks, one part per queued
  // call; the player's signal stops it when the note closes.
  const loadAudio = useMemo<AudioLoad | null>(() => {
    if (voiceSourceId !== null && !pendingAudioRow) {
      return async (signal, onProgress) => {
        const res = await loadVoiceNoteAudioBlob(space, voiceSourceId, { signal, onProgress });
        if (!res.ok) throw new Error(res.error.message);
        return res.data;
      };
    }
    if (audioBase !== null) return (signal, onProgress) => getAudio(space.kv, audioBase, { signal, onProgress });
    return null;
  }, [audioBase, pendingAudioRow, space, voiceSourceId]);

  const retry = useCallback(() => {
    if (list.status === "failed") refresh();
    if (item) readNote(item);
  }, [item, list.status, readNote, refresh]);

  return {
    status: list.status,
    items: list.items,
    listing,
    filter,
    setFilter,
    refresh,
    note: { item, reads: noteReads, loadAudio },
    retry,
  };
}
