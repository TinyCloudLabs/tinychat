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
//
// Voice notes still on this phone are listed with the space's rows (`onPhone`):
// one with no row yet is a stand-in that opens from the phone's own copy (its
// audio, its notes and moments); one with a row is that row, marked "saving".
// A note that leaves the phone keeps its stand-in until a list read that began
// after it left has come back, so it never drops out between the two. The
// stand-in is kept in the same render that drops the note, never an effect
// later; it is dropped at once when the phone's notes become unknown or the
// space changes, and for a note that was discarded rather than uploaded.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { PHONE_AUDIO_UNAVAILABLE } from "@/chat/audioPlayback";
import { getAudio, getAudioManifest, manifestReceipt, type StoredAudioManifest } from "@/lib/audio/audioStore";
import {
  hiddenMemberKeys,
  listMeetingsRead,
  memberKey,
  meetingAudioFrom,
  readMeetingMetadata,
  readTranscript,
  type MeetingMetadataRead,
  type TranscriptRead,
} from "@/lib/connectors/meetingExplorer";
import { scheduledSpace } from "@/lib/spaceQueue";
import { loadNote } from "@/lib/voiceNotes/recordingNotes";
import { wasDiscarded, type PendingNote } from "@/lib/voiceNotes/recorderSaves";
import { nativeVoiceNotesAvailable, VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { loadVoiceNoteAudioBlob, voiceNoteAudioKvKey, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { cachedSpaceAudio, cachedSpaceAudioOffline, hasVerifiedSpaceCopy, isVerifiedSpaceReceipt, latestSpaceAudioIdentity, localPlaybackUrl,
  observeSpaceAudioIdentity } from "@/lib/voiceNotes/audioPlaybackCache";
import { readTranscriptPreviews, voiceNoteTranscriptLocator, type TranscriptProvenance } from "@/lib/voiceNotes/voiceNoteCommits";
import { captureEvents } from "../captureEvents";
import type { LibraryFilter } from "./libraryKinds";
import type { LibraryStatus } from "./LibraryListView";
import type { LibraryItem } from "./LibraryRow";
import type { AudioLoad, NoteAudio } from "./NoteDetailView";
import { noteSnippet, recordingIdOfOnPhoneId, withOnPhone } from "./onPhone";

export interface SelectedTranscript {
  transcript: TranscriptRead;
  /** Null means this selected body was read without a transcript commit. */
  provenance: TranscriptProvenance | null;
}
export interface NoteReads {
  metadata?: MeetingMetadataRead;
  transcript?: SelectedTranscript;
}

const manifestIdentity = (manifest: StoredAudioManifest) => JSON.stringify([
  manifest.sha256, manifest.createdAt, manifest.size,
  manifest.parts.map((part) => [part.size, part.sha256]),
]);

const isOfflineRead = (error: unknown) => {
  const code = (error as { code?: string })?.code ?? "";
  return /(?:NETWORK|OFFLINE|TIMEOUT|TIMED_OUT|FETCH_FAILED)/i.test(code)
    || (error instanceof TypeError && /fetch|network/i.test(error.message));
};

export interface Library {
  status: LibraryStatus;
  /** What the Library lists: every row except the captures a combined meeting stands in for (TC-1152). */
  items: LibraryItem[];
  /** Every row, hidden members included: a combined page resolves its sources here, and a hidden source still opens. */
  all: LibraryItem[];
  /** The capture is a member of a combined meeting: hidden from the list, and not combinable again. */
  isCombinedMember: (item: Pick<LibraryItem, "source" | "sourceId">) => boolean;
  /** A list read is out (Refresh shows it; a note not listed yet waits for it). */
  listing: boolean;
  filter: LibraryFilter;
  setFilter: (filter: LibraryFilter) => void;
  refresh: () => void;
  /** The open note's row (null until the list has it), its reads, and its audio. */
  note: { item: LibraryItem | null; reads: NoteReads; audio: NoteAudio | null };
  /** Reads again what failed: the list, and the open note's reads. */
  retry: () => void;
}

/** Capture away for longer than this re-reads the list when it comes back (plan §4.11). */
export const RELIST_AFTER_MS = 2 * 60 * 1000;

/**
 * The note's audio while it is on this phone, read through the player's `load` when the user taps Play.
 * The fresh ledger decides first: a verified space copy is what plays, so the phone's file (possibly
 * replaced since the note was opened) is not read. Otherwise the phone's file plays, handed to the audio
 * element as a URL and never fetched (the WKWebView scheme handler answers a fetch of it with status 0).
 * An unverified phone copy plays while its file exists. When the file is gone, an owned unverified copy
 * is an error, and a `localOnly` note (cached metadata says the space holds no audio) is an error too;
 * any other note reads the space through `spaceLoad`. A verified receipt, fresh at Play, reads the space
 * first. The player owns the object URL a Blob becomes.
 *
 * Any failure shows the calm phone copy; the detail goes to the console.
 */
function phoneFirstAudio(recordingId: string, channels: 1 | 2 | undefined, owner: string, spaceLoad: AudioLoad, localOnly: boolean): NoteAudio {
  const fromSpace = async (signal: AbortSignal, onProgress: (loaded: number, total: number) => void): Promise<Blob | string> => {
    const audio = await spaceLoad(signal, onProgress);
    if (audio === null) throw new Error("Audio is no longer on this device");
    return audio;
  };
  return {
    channels,
    onPhone: true,
    load: async (signal, onProgress) => {
      try {
        const local = await Promise.resolve().then(() => VoiceNotes.listPending())
          .then(({ recordings }) => recordings.find((note) => note.id === recordingId))
          .catch(() => undefined);
        if (local?.owner === owner && hasVerifiedSpaceCopy(local)) return await fromSpace(signal, onProgress);
        const url = await localPlaybackUrl(recordingId);
        if (url) return url;
        if (localOnly || local?.owner === owner) throw new Error("Audio is no longer on this device");
        return await fromSpace(signal, onProgress);
      } catch (caught) {
        console.error("[Audio] Could not open local audio", caught);
        throw new Error(PHONE_AUDIO_UNAVAILABLE, { cause: caught });
      }
    },
  };
}

/** Voice notes on the phone, and those that just left it and wait for the list to catch up. */
interface Handoff {
  space: unknown;
  notes: readonly PendingNote[] | null;
  lingering: ReadonlyMap<string, { note: PendingNote; since: number }>;
  /** Counts notes that left, so each departure asks for one list read. */
  departures: number;
}

function handoffAfter(previous: Handoff, space: unknown, notes: readonly PendingNote[] | null, since: number): Handoff {
  if (previous.space !== space || previous.notes === null || notes === null) {
    return { space, notes, lingering: new Map(), departures: previous.departures };
  }
  const still = new Set(notes.map((note) => note.id));
  const lingering = new Map([...previous.lingering].filter(([id]) => !still.has(id)));
  let departures = previous.departures;
  for (const note of previous.notes) {
    if (still.has(note.id) || wasDiscarded(note.id)) continue;
    lingering.set(note.id, { note, since });
    departures++;
  }
  return { space, notes, lingering, departures };
}

const settled = (read: { status: string } | undefined) => read !== undefined && read.status !== "failed";
const noop = () => undefined;

export function useLibrary(
  tcw: TinyCloudWeb,
  options: {
    /** Capture is on screen. */
    visible: boolean;
    noteId: string | null;
    /** Voice notes this account still holds on the device; null when not known (not listed, listing failed, other account). */
    onPhone?: readonly PendingNote[] | null;
    /** The clock (tests). */
    now?: () => number;
  },
): Library {
  const space = useMemo(() => scheduledSpace(tcw), [tcw]);
  const [list, setList] = useState<{ status: LibraryStatus; items: LibraryItem[]; previews: ReadonlyMap<string, string> }>({
    status: "loading",
    items: [],
    previews: new Map(),
  });
  const [listing, setListing] = useState(false);
  const [localAudioIds, setLocalAudioIds] = useState<ReadonlySet<string>>(new Set());
  const [localAudioReadyIds, setLocalAudioReadyIds] = useState<ReadonlySet<string>>(new Set());
  // The subset whose space copy is not verified: the phone's copy is the only audio to play. Each entry keeps the note's channel count.
  const [phoneOnlyAudio, setPhoneOnlyAudio] = useState<ReadonlyMap<string, 1 | 2 | undefined>>(new Map());
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const reads = useRef(new Map<string, NoteReads>());
  const reading = useRef(new Set<string>());
  const readVersions = useRef(new Map<string, number>());
  const invalidated = useRef(new Set<string>());
  // A failed revalidation keeps the last successful value on screen, but the
  // failed field must still be fetched on Try again or when reopening.
  const staleReads = useRef(new Map<string, Set<keyof NoteReads>>());
  const [invalidationRevision, setInvalidationRevision] = useState(0);
  const [listingRevision, setListingRevision] = useState(0);
  const [, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((n) => n + 1), []);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const listRun = useRef({ out: false, again: false });
  const readsStarted = useRef(0);
  const onPhoneNotes = options.onPhone ?? null;
  const [handoff, setHandoff] = useState<Handoff>({ space, notes: onPhoneNotes, lingering: new Map(), departures: 0 });
  // Derived while rendering, so no render shows the note gone before its stand-in is kept.
  let currentHandoff = handoff;
  if (handoff.space !== space || handoff.notes !== onPhoneNotes) {
    currentHandoff = handoffAfter(handoff, space, onPhoneNotes, readsStarted.current);
    setHandoff(currentHandoff);
  }
  const [moments, setMoments] = useState<ReadonlyMap<string, string>>(new Map());
  const momentsLoaded = useRef(new Set<string>());
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
      const started = ++readsStarted.current;
      const read = await listMeetingsRead(space);
      let previews: ReadonlyMap<string, string> | null = null;
      if (read.status === "ok") {
        try {
          previews = await readTranscriptPreviews(space);
        } catch (caught) {
          console.error("Library: could not read transcript previews; voice notes without a moment keep the generic title", caught);
        }
      }
      if (!mounted.current) return;
      setList((current) =>
        read.status === "ok"
          ? { status: "ready", items: read.meetings, previews: previews ?? current.previews }
          : { status: "failed", items: current.items, previews: current.previews },
      );
      if (read.status === "ok") {
        setHandoff((current) => {
          const lingering = new Map([...current.lingering].filter(([, entry]) => entry.since >= started));
          return lingering.size === current.lingering.size ? current : { ...current, lingering };
        });
      }
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
  // The open note as the sheet resolved it: a stand-in route (`on-phone:<id>`) and its saved row are one note.
  const openItemId = useRef<string | null>(null);
  // Only the saved row's reads are stale. A list-only change never interrupts
  // the open note's audio or transcript.
  useEffect(() => captureEvents.on("library-changed", (detail) => {
    // A receipt for a saved note's audio lands without a row change; the local-audio list must read again.
    if (detail?.source === VOICE_NOTE_SOURCE) setListingRevision((n) => n + 1);
    const saved = detail && itemsRef.current.find((entry) => entry.source === detail.source && entry.sourceId === detail.sourceId);
    if (saved) {
      invalidated.current.add(saved.id);
      readVersions.current.set(saved.id, (readVersions.current.get(saved.id) ?? 0) + 1);
      if (saved.id === openItemId.current) setInvalidationRevision((n) => n + 1);
    }
    refresh();
  }), [refresh]);

  // Each note that leaves the phone asks for one list read to catch up.
  useEffect(() => {
    if (handoff.departures > 0) refresh();
  }, [handoff.departures, refresh]);

  // A voice note's first moment titles its row, ahead of its transcript.
  const voiceSourceIds = useMemo(
    () => list.items.filter((entry) => entry.source === VOICE_NOTE_SOURCE && entry.metadata?.capture !== "pasted").map((entry) => entry.sourceId)
      .concat((onPhoneNotes ?? []).map((note) => note.id)),
    [list.items, onPhoneNotes],
  );
  const everyItem = useMemo(() => {
    const merged = withOnPhone(
      list.items,
      onPhoneNotes ?? [],
      [...currentHandoff.lingering.values()].map((entry) => entry.note).filter((note) => !wasDiscarded(note.id)),
    );
    return merged.map((entry) => {
      if (entry.source !== VOICE_NOTE_SOURCE || entry.metadata?.capture === "pasted") return entry;
      const snippet = moments.get(entry.sourceId) ?? noteSnippet(list.previews.get(entry.sourceId));
      return { ...entry, ...(snippet === null ? {} : { snippet }),
        ...(localAudioIds.has(entry.sourceId) ? { hasLocalAudio: true as const } : {}),
        ...(localAudioReadyIds.has(entry.sourceId) ? { localAudioReady: true as const } : {}) };
    });
  }, [list.items, list.previews, moments, onPhoneNotes, currentHandoff.lingering, localAudioIds, localAudioReadyIds]);

  // Captures a combined meeting stands in for, derived from the combined rows of this list read.
  const hiddenKeys = useMemo(() => hiddenMemberKeys(list.items), [list.items]);
  const isCombinedMember = useCallback(
    (entry: Pick<LibraryItem, "source" | "sourceId">) => hiddenKeys.has(memberKey(entry.source, entry.sourceId)),
    [hiddenKeys],
  );
  // With no combined rows this is `everyItem` itself: the list renders exactly as before.
  const items = useMemo(
    () => (hiddenKeys.size === 0 ? everyItem : everyItem.filter((entry) => !hiddenKeys.has(memberKey(entry.source, entry.sourceId)))),
    [everyItem, hiddenKeys],
  );

  // The open note by its id, from EVERY row: a hidden source still opens (stale link, or from its combined page).
  // A stand-in's sheet stays open when its row replaces it.
  const item = useMemo(() => {
    if (options.noteId === null) return null;
    const exact = everyItem.find((entry) => entry.id === options.noteId);
    if (exact) return exact;
    const recordingId = recordingIdOfOnPhoneId(options.noteId);
    return recordingId === null ? null : (everyItem.find((entry) => entry.source === VOICE_NOTE_SOURCE && entry.sourceId === recordingId) ?? null);
  }, [everyItem, options.noteId]);
  openItemId.current = item?.id ?? null;

  // The open voice note, by recording: a stand-in and its row are one note.
  const openRecordingId = item?.source === VOICE_NOTE_SOURCE ? item.sourceId : null;
  useEffect(() => {
    if (!options.visible) return;
    if (!nativeVoiceNotesAvailable()) {
      setLocalAudioIds(new Set());
      setLocalAudioReadyIds(new Set());
      setPhoneOnlyAudio(new Map());
      return;
    }
    let live = true;
    void Promise.resolve().then(() => VoiceNotes.listPending()).then(({ recordings }) => {
      if (!live) return;
      const owned = recordings.filter((note) => note.owner === tcw.did);
      setLocalAudioIds(new Set(owned.map((note) => note.id)));
      // The transcript copy may claim local audio only when the native ledger says it is ready.
      setLocalAudioReadyIds(new Set(owned.filter((note) => note.ledger?.localAudio?.state === "ready").map((note) => note.id)));
      // Keep phone playback while the space copy is not verified; channels come from this owned recording.
      setPhoneOnlyAudio(new Map(owned.filter((note) => !hasVerifiedSpaceCopy(note)).map((note) => [note.id, note.channels] as const)));
    }, () => {
      if (!live) return;
      setLocalAudioIds(new Set());
      setLocalAudioReadyIds(new Set());
      setPhoneOnlyAudio(new Map());
    });
    return () => { live = false; };
  }, [options.visible, tcw.did, listingRevision, onPhoneNotes]);
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    // A note just closed may have had its moments edited: read them again.
    const closed = lastOpened.current !== openRecordingId ? lastOpened.current : null;
    lastOpened.current = openRecordingId;
    const todo = [...new Set(voiceSourceIds)].filter((id) => !momentsLoaded.current.has(id) || id === closed);
    if (todo.length === 0) return;
    for (const id of todo) momentsLoaded.current.add(id);
    void (async () => {
      const found: [string, string | null][] = [];
      for (const id of todo) {
        try {
          const note = await loadNote(id);
          found.push([id, noteSnippet(note?.moments.find((moment) => noteSnippet(moment.label) !== null)?.label)]);
        } catch (caught) {
          momentsLoaded.current.delete(id);
          console.warn(`Library: could not read the moments of voice note ${id}; its row is titled without them`, caught);
        }
      }
      if (!mounted.current || found.length === 0) return;
      setMoments((current) => {
        const next = new Map(current);
        for (const [id, snippet] of found) {
          if (snippet === null) next.delete(id);
          else next.set(id, snippet);
        }
        return next;
      });
    })();
  }, [openRecordingId, voiceSourceIds]);

  const readNote = useCallback(
    (note: LibraryItem) => {
      // A note only on this phone has nothing in the space to read.
      if (note.onPhone) return;
      const cached = reads.current.get(note.id) ?? {};
      const version = readVersions.current.get(note.id) ?? 0;
      if (reading.current.has(note.id)) return;
      const stale = invalidated.current.delete(note.id);
      const staleFields = staleReads.current.get(note.id);
      staleReads.current.delete(note.id);
      if (!stale && !staleFields?.size && settled(cached.metadata) && settled(cached.transcript?.transcript)) return;
      // A saved note retains its reads during revalidation; only prior failures show loading.
      if (!stale) {
        reads.current.set(note.id, {
          metadata: settled(cached.metadata) ? cached.metadata : undefined,
          transcript: settled(cached.transcript?.transcript) ? cached.transcript : undefined,
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
              ...metadata.metadata,
              ...(locator.committed ? {
                transcription_engine: locator.provenance?.engine ?? null,
                transcript_provider: locator.provenance?.provider ?? null,
                transcription_model: locator.provenance?.model ?? null,
              } : {}),
              transcription_outcome: locator.outcome === "none"
                ? metadata.metadata.transcription_outcome ?? "none" : locator.outcome,
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
          if (version === (readVersions.current.get(note.id) ?? 0) && (stale || staleFields?.has("transcript") || !settled(reads.current.get(note.id)?.transcript?.transcript))) {
            const transcript = locator
              ? locator.bodyKey ? await readTranscript(space, note.source, note.sourceId, locator.bodyKey, locator.expectedText)
                : { status: "absent" as const }
              : await readTranscript(space, note.source, note.sourceId);
            if (version === (readVersions.current.get(note.id) ?? 0) && transcript.status === "failed" && cached.transcript?.transcript.status === "ok") {
              const fields = staleReads.current.get(note.id) ?? new Set<keyof NoteReads>();
              fields.add("transcript");
              staleReads.current.set(note.id, fields);
            }
            if (version === (readVersions.current.get(note.id) ?? 0)) {
              const keepCachedTranscript = transcript.status === "failed" && cached.transcript?.transcript.status === "ok";
              reads.current.set(note.id, {
                ...reads.current.get(note.id),
                transcript: keepCachedTranscript ? cached.transcript : {
                  transcript,
                  provenance: locator?.committed ? locator.provenance ?? { engine: null, provider: null, model: null } : null,
                },
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

  const noteReads: NoteReads = item?.onPhone
    ? { metadata: { status: "ok", metadata: {}, organizerEmail: null, participants: [] }, transcript: { transcript: { status: "absent" }, provenance: null } }
    : item ? (reads.current.get(item.id) ?? {}) : {};
  const meta = noteReads.metadata?.status === "ok" ? noteReads.metadata.metadata : null;
  const audio = item ? meetingAudioFrom(meta) : null;
  const audioBase = audio?.status === "stored" ? audio.base : null;
  const voiceSourceId = item?.source === VOICE_NOTE_SOURCE ? item.sourceId : null;
  const pendingAudioRow = voiceSourceId !== null && meta !== null && Object.keys(meta).length === 0;
  const metadataLoaded = meta !== null;
  // While the space does not verifiably hold the audio (the row is made before upload, and a local-only
  // note never uploads), the phone's own copy is the audio. A verified saved copy is read from the space.
  const onThisPhone = voiceSourceId !== null && (item?.onPhone === true || phoneOnlyAudio.has(voiceSourceId));
  // The phone's channel count: the on-phone row, else the local entry that made the note phone-only. Unknown stays undefined.
  const phoneChannels = voiceSourceId === null ? undefined
    : (onPhoneNotes?.find((note) => note.id === voiceSourceId)?.channels ?? phoneOnlyAudio.get(voiceSourceId));
  const localOnlyAudio = (meta?.audio as { stored?: unknown } | undefined)?.stored === false;
  // A note with no stored space audio plays the phone's copy while it has one. A stored space audio plays
  // from the space at Play time, unless this device's copy is not yet verified (checked in the load below).
  const phoneFirst = item?.onPhone === true || (onThisPhone && audioBase === null);
  // The stored file is read only when the player asks, one part per queued
  // call; the player's signal stops it when the note closes.
  const noteAudio = useMemo<NoteAudio | null>(() => {
    const spaceLoad = (recordingId: string): AudioLoad => async (signal, onProgress) => {
      const localNote = await Promise.resolve().then(() => VoiceNotes.listPending())
        .then(({ recordings }) => recordings.find((note) => note.id === recordingId))
        .catch(() => undefined);
      // A receipt that landed since the list was read stops the phone's copy: the ledger is read now.
      if (localNote?.owner === space.did && !hasVerifiedSpaceCopy(localNote)) {
        const local = await localPlaybackUrl(recordingId).catch(() => null);
        if (local) return local;
      }
      if (item?.saving && localNote?.ledger?.audio.state !== "saved") {
        const local = await localPlaybackUrl(recordingId);
        if (local) return local;
      }
      let manifest: StoredAudioManifest | null;
      try {
        manifest = await getAudioManifest(space.kv, voiceNoteAudioKvKey(recordingId), { signal, retryDelaysMs: [250] });
      } catch (error) {
        if (!isOfflineRead(error) || signal.aborted) throw error;
        const latest = await latestSpaceAudioIdentity(String(space.spaceId), String(space.did), VOICE_NOTE_SOURCE, recordingId);
        const receipt = localNote?.ledger?.audio.verifiedInSpace;
        if (localNote?.owner === space.did && localNote.ledger?.audio.state === "saved"
          && isVerifiedSpaceReceipt(receipt)
          && (!latest?.identity || (latest.receipt?.sha256 === receipt.sha256 && latest.receipt.size === receipt.size))) {
          const local = await localPlaybackUrl(recordingId);
          if (local) return local;
        }
        const cached = await cachedSpaceAudioOffline(String(space.spaceId), String(space.did), VOICE_NOTE_SOURCE, recordingId);
        if (cached) return cached;
        if (latest?.identity) throw new Error("This audio changed; reconnect to play the latest version", { cause: error });
        throw error;
      }
      const identityReceipt = manifest && await manifestReceipt(manifest);
      if (manifest) await observeSpaceAudioIdentity(String(space.spaceId), String(space.did), VOICE_NOTE_SOURCE,
        recordingId, manifestIdentity(manifest), identityReceipt);
      if (identityReceipt) {
        const receipt = localNote?.ledger?.audio.verifiedInSpace;
        if (localNote?.owner === space.did && localNote.ledger?.audio.state === "saved"
          && receipt?.sha256 === identityReceipt.sha256 && receipt.size === identityReceipt.size) {
          const local = await localPlaybackUrl(recordingId);
          if (local) return local;
        }
      }
      if (pendingAudioRow) return null;
      const load = async () => {
        const res = await loadVoiceNoteAudioBlob(space, recordingId, { signal, onProgress });
        if (!res.ok) throw new Error(res.error.message);
        return res.data;
      };
      // Legacy single-key audio has no revision to validate at a cache hit.
      if (!manifest) return load();
      const identity = manifestIdentity(manifest);
      return cachedSpaceAudio(String(space.spaceId), String(space.did), VOICE_NOTE_SOURCE, recordingId,
        identity, load, signal, async () => {
          const current = await getAudioManifest(space.kv, voiceNoteAudioKvKey(recordingId), { signal });
          return current !== null && manifestIdentity(current) === identity;
        });
    };
    // The phone's own copy, until the space has the audio; once the phone's copy is gone, the space's copy.
    // The space loader is always built: a verified receipt that lands after the cached metadata still plays it.
    if (voiceSourceId !== null && phoneFirst) return phoneFirstAudio(voiceSourceId,
      phoneChannels, space.did, spaceLoad(voiceSourceId), localOnlyAudio);
    if (voiceSourceId !== null && metadataLoaded && !pendingAudioRow && !localOnlyAudio) return { load: spaceLoad(voiceSourceId) };
    if (audioBase !== null && !localOnlyAudio) return { load: (signal, onProgress) => getAudio(space.kv, audioBase, { signal, onProgress }) };
    return null;
  }, [audioBase, item?.saving, phoneFirst, phoneChannels, localOnlyAudio, metadataLoaded, pendingAudioRow, space, voiceSourceId]);

  const retry = useCallback(() => {
    if (list.status === "failed") refresh();
    if (item) {
      if (reads.current.get(item.id)?.transcript?.transcript.status === "absent") {
        const fields = staleReads.current.get(item.id) ?? new Set<keyof NoteReads>();
        fields.add("transcript");
        staleReads.current.set(item.id, fields);
      }
      readNote(item);
    }
  }, [item, list.status, readNote, refresh]);

  return {
    status: list.status,
    items,
    all: everyItem,
    isCombinedMember,
    listing,
    filter,
    setFilter,
    refresh,
    note: { item, reads: noteReads, audio: noteAudio },
    retry,
  };
}
