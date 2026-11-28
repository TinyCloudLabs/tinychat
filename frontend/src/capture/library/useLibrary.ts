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
import { FIREFLIES_SERVER_IMPORT_TAG } from "@tinyboilerplate/core";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { PHONE_AUDIO_UNAVAILABLE } from "@/chat/audioPlayback";
import { getAudio, getAudioManifest, manifestReceipt, type StoredAudioManifest } from "@/lib/audio/audioStore";
import {
  fetchFirefliesServerImportCapability,
  firefliesServerImportEnabled,
  type FirefliesServerImportCapabilities,
} from "@/lib/connectors/firefliesServerImportFeature";
import { createConnectorWebhooksClient } from "@/lib/connectors/webhooksApi";
import { onConnectorPurged } from "@/lib/connectors/connectorPurgeSignal";
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
import { captureEngineKind } from "@/lib/voiceNotes/captureEngine";
import { loadVoiceNoteAudioBlob, voiceNoteAudioKvKey, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { cachedSpaceAudio, cachedSpaceAudioOffline, hasVerifiedSpaceCopy, isMissingLocalAudio, isVerifiedSpaceReceipt, latestSpaceAudioIdentity, localPlaybackUrl,
  observeSpaceAudioIdentity } from "@/lib/voiceNotes/audioPlaybackCache";
import { readTranscriptPreviews, TranscriptPreviewsAbortedError, voiceNoteTranscriptLocator, type TranscriptProvenance } from "@/lib/voiceNotes/voiceNoteCommits";
import { accountCacheKey, readLocal, writeLocal } from "@/lib/localFirst/localCache";
import { captureEvents } from "../captureEvents";
import type { LibraryFilter } from "./libraryKinds";
import type { LibraryStatus } from "./LibraryListView";
import type { LibraryItem } from "./LibraryRow";
import type { AudioLoad, NoteAudio } from "./NoteDetailView";
import { noteSnippet, recordingIdOfOnPhoneId, withOnPhone } from "./onPhone";

/** This device keeps recordings in files of its own: a phone's plugin, or the Mac app's desktop engine. */
const deviceRecordingsAvailable = (): boolean => nativeVoiceNotesAvailable() || captureEngineKind() === "tauri";

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

/** What the device keeps of the Library list between opens. */
interface LocalLibrary {
  items: LibraryItem[];
  previews: ReadonlyMap<string, string>;
}

const settled = (read: { status: string } | undefined) => read !== undefined && read.status !== "failed";
const isServerImportedItem = (entry: Pick<LibraryItem, "importSource" | "metadata">): boolean =>
  entry.importSource === FIREFLIES_SERVER_IMPORT_TAG || entry.metadata?.import_source === FIREFLIES_SERVER_IMPORT_TAG;
const withoutServerImported = (entries: readonly LibraryItem[]): LibraryItem[] =>
  entries.filter((entry) => !isServerImportedItem(entry));
const noop = () => undefined;

export function useLibrary(
  tcw: TinyCloudWeb,
  options: {
    /** Capture is on screen. */
    visible: boolean;
    noteId: string | null;
    /** Voice notes this account still holds on the device; null when not known (not listed, listing failed, other account). */
    onPhone?: readonly PendingNote[] | null;
    /** Backend origin for `/api/server-info` capability and purge-ledger verification. */
    backendUrl?: string;
    /** Signed-in session store for authenticated Fireflies purge-ledger checks. */
    sessionStore?: SessionStore;
    /** The clock (tests). */
    now?: () => number;
  },
): Library {
  const space = useMemo(() => scheduledSpace(tcw), [tcw]);
  const [serverCapabilities, setServerCapabilities] = useState<FirefliesServerImportCapabilities | null>(null);
  const firefliesKvAllowed = firefliesServerImportEnabled(undefined, serverCapabilities);
  const firefliesPurgeChecker = useMemo(() => {
    if (!options.backendUrl || !options.sessionStore) return undefined;
    const webhooks = createConnectorWebhooksClient(options.backendUrl, { sessionStore: options.sessionStore });
    return (meetingId: string, writtenAt?: string) => webhooks.checkPurge(meetingId, writtenAt ?? null, "fireflies");
  }, [options.backendUrl, options.sessionStore]);

  useEffect(() => {
    if (!options.backendUrl) {
      setServerCapabilities(null);
      return;
    }
    const controller = new AbortController();
    void fetchFirefliesServerImportCapability(options.backendUrl, fetch, controller.signal).then((caps) => {
      if (!controller.signal.aborted) setServerCapabilities(caps);
    });
    return () => controller.abort();
  }, [options.backendUrl]);
  const accountScope = `${typeof tcw.did === "string" ? tcw.did : ""}::${typeof tcw.spaceId === "string" ? tcw.spaceId : ""}`;
  const activeScopeRef = useRef<{ scope: string; space: TinyCloudWeb }>({ scope: accountScope, space });
  const localKey = typeof tcw.did === "string" && tcw.did ? accountCacheKey(tcw.did, "library") : null;
  const loadedFromNetwork = useRef(false);
  const [list, setList] = useState<{ scope: string; status: LibraryStatus; items: LibraryItem[]; previews: ReadonlyMap<string, string> }>({
    scope: accountScope,
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

  // Account/space switch resets list and cached reads synchronously on render so Account A's
  // imported or SQL rows never flash for Account B.
  const scopeChanged = activeScopeRef.current.scope !== accountScope || activeScopeRef.current.space !== space;
  if (scopeChanged) {
    activeScopeRef.current = { scope: accountScope, space };
    loadedFromNetwork.current = false;
    listRun.current = { out: false, again: false };
    reads.current.clear();
    reading.current.clear();
    readVersions.current.clear();
    invalidated.current.clear();
    staleReads.current.clear();
    momentsLoaded.current.clear();
  }
  let currentList = list;
  if (list.scope !== accountScope || scopeChanged) {
    currentList = { scope: accountScope, status: "loading", items: [], previews: new Map() };
    setList(currentList);
  }

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

  const firefliesListOptionsRef = useRef<
    { includeFirefliesKv: true; isFirefliesPurged: typeof firefliesPurgeChecker } | undefined
  >(undefined);
  firefliesListOptionsRef.current = firefliesKvAllowed
    ? { includeFirefliesKv: true, isFirefliesPurged: firefliesPurgeChecker }
    : undefined;

  const refresh = useCallback(() => {
    const startedScope = accountScope;
    const startedSpace = space;
    const stillCurrent = () =>
      mounted.current &&
      activeScopeRef.current.scope === startedScope &&
      activeScopeRef.current.space === startedSpace;
    // A read is out: one more after it covers every ask that arrived meanwhile.
    if (listRun.current.out) {
      listRun.current.again = true;
      return;
    }
    listRun.current.out = true;
    setListing(true);
    // Try again shows the skeleton; rows already on screen stay until the list answers.
    setList((current) =>
      current.scope === startedScope && current.status === "failed"
        ? { ...current, status: "loading" }
        : current,
    );
    const readList = async (): Promise<void> => {
      const started = ++readsStarted.current;
      const read = await listMeetingsRead(
        startedSpace,
        undefined,
        firefliesListOptionsRef.current,
      );
      let previews: ReadonlyMap<string, string> | null = null;
      if (read.status === "ok" && stillCurrent()) {
        try {
          previews = await readTranscriptPreviews(startedSpace);
        } catch (caught) {
          // Sign-out (or a replaced session) cuts the read off; the list keeps the previews it has.
          if (!(caught instanceof TranscriptPreviewsAbortedError)) {
            console.error("Library: could not read transcript previews; voice notes without a moment keep the generic title", caught);
          }
        }
      }
      if (!stillCurrent()) return;
      if (read.status === "ok") loadedFromNetwork.current = true;
      setList((current) =>
        read.status === "ok"
          ? { scope: startedScope, status: "ready", items: read.meetings, previews: previews ?? current.previews }
          : { scope: startedScope, status: "failed", items: withoutServerImported(current.items), previews: current.previews },
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
  }, [accountScope, enqueue, firefliesKvAllowed, firefliesPurgeChecker, space]);

  // A purge from this page (Meeting sources, disconnect) clears Fireflies rows at once, not on the next focus.
  useEffect(() => onConnectorPurged("fireflies", refresh), [refresh]);

  // The device's last copy of the list shows at once; the read below replaces it.
  // Server-imported rows require the active flag and a fresh purge verdict, so they are never restored from cache.
  useEffect(() => {
    if (!localKey) return;
    const startedScope = accountScope;
    let alive = true;
    void readLocal<LocalLibrary>(localKey).then((local) => {
      if (!alive || !local || loadedFromNetwork.current || activeScopeRef.current.scope !== startedScope) return;
      const safeItems = withoutServerImported(local.value.items);
      setList((current) =>
        current.scope === startedScope && current.status === "loading"
          ? { scope: startedScope, status: "ready", items: safeItems, previews: local.value.previews }
          : current,
      );
    });
    return () => { alive = false; };
  }, [accountScope, localKey]);
  // Every list the network answered becomes the device's copy for the next open (excluding server-imported rows).
  useEffect(() => {
    if (localKey && loadedFromNetwork.current && currentList.scope === accountScope && currentList.status === "ready") {
      void writeLocal<LocalLibrary>(localKey, { items: withoutServerImported(currentList.items), previews: currentList.previews });
    }
  }, [accountScope, currentList, localKey]);

  // The first mount (Capture's first visit).
  useEffect(() => {
    refresh();
  }, [refresh]);

  const itemsRef = useRef(currentList.items);
  itemsRef.current = currentList.items;

  // Coming back to Capture after more than two minutes away, or immediately when server-imported
  // rows are visible so a purge that landed while away clears on return.
  const leftAt = useRef<number | null>(options.visible ? null : clock.current());
  useEffect(() => {
    if (!options.visible) {
      leftAt.current ??= clock.current();
      return;
    }
    const away = leftAt.current === null ? 0 : clock.current() - leftAt.current;
    const wasAway = leftAt.current !== null;
    leftAt.current = null;
    if (away > RELIST_AFTER_MS || (wasAway && itemsRef.current.some(isServerImportedItem))) refresh();
  }, [options.visible, refresh]);

  // Re-run the purge verdict when the browser window regains focus or tab visibility returns while
  // server-imported rows are on screen.
  const hasServerImported = useMemo(
    () => Boolean(firefliesKvAllowed && firefliesPurgeChecker) && currentList.items.some(isServerImportedItem),
    [currentList.items, firefliesKvAllowed, firefliesPurgeChecker],
  );
  useEffect(() => {
    if (!options.visible || !hasServerImported) return;
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") refresh();
    };
    const hasWindowEvents = typeof window !== "undefined" && typeof window.addEventListener === "function";
    const hasDocEvents = typeof document !== "undefined" && typeof document.addEventListener === "function";
    if (hasWindowEvents) window.addEventListener("focus", onFocus);
    if (hasDocEvents) document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (hasWindowEvents) window.removeEventListener("focus", onFocus);
      if (hasDocEvents) document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hasServerImported, options.visible, refresh]);
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

  const authorizedListItems = useMemo(
    () => (firefliesKvAllowed && firefliesPurgeChecker ? currentList.items : withoutServerImported(currentList.items)),
    [firefliesKvAllowed, firefliesPurgeChecker, currentList.items],
  );
  // A voice note's first moment titles its row, ahead of its transcript.
  const voiceSourceIds = useMemo(
    () => authorizedListItems.filter((entry) => entry.source === VOICE_NOTE_SOURCE && entry.metadata?.capture !== "pasted").map((entry) => entry.sourceId)
      .concat((onPhoneNotes ?? []).map((note) => note.id)),
    [authorizedListItems, onPhoneNotes],
  );
  const everyItem = useMemo(() => {
    const merged = withOnPhone(
      authorizedListItems,
      onPhoneNotes ?? [],
      [...currentHandoff.lingering.values()].map((entry) => entry.note).filter((note) => !wasDiscarded(note.id)),
    );
    return merged.map((entry) => {
      if (entry.source !== VOICE_NOTE_SOURCE || entry.metadata?.capture === "pasted") return entry;
      const snippet = moments.get(entry.sourceId) ?? noteSnippet(currentList.previews.get(entry.sourceId));
      return { ...entry, ...(snippet === null ? {} : { snippet }),
        ...(localAudioIds.has(entry.sourceId) ? { hasLocalAudio: true as const } : {}),
        ...(localAudioReadyIds.has(entry.sourceId) ? { localAudioReady: true as const } : {}) };
    });
  }, [authorizedListItems, currentList.previews, moments, onPhoneNotes, currentHandoff.lingering, localAudioIds, localAudioReadyIds]);

  // Captures a combined meeting stands in for, derived from the combined rows of this list read.
  const hiddenKeys = useMemo(() => hiddenMemberKeys(currentList.items), [currentList.items]);
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
    if (!deviceRecordingsAvailable()) {
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
  // The open note's own file on this device, probed by id: the pending list may not carry a saved note,
  // but a readable file there is the audio whatever the list says.
  const [deviceFileId, setDeviceFileId] = useState<string | null>(null);
  useEffect(() => {
    if (!options.visible || openRecordingId === null || !deviceRecordingsAvailable()) {
      setDeviceFileId(null);
      return;
    }
    let live = true;
    void Promise.resolve().then(() => VoiceNotes.localAudioSize({ id: openRecordingId })).then(
      ({ size }) => { if (live) setDeviceFileId(size > 0 ? openRecordingId : null); },
      (caught: unknown) => {
        if (live) setDeviceFileId(null);
        if (!isMissingLocalAudio(caught)) console.error("[Audio] Could not check local audio", openRecordingId, caught);
      });
    return () => { live = false; };
  }, [options.visible, openRecordingId, listingRevision, onPhoneNotes]);
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
          const note = await loadNote(id, tcw.did ?? null);
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
  }, [openRecordingId, voiceSourceIds, tcw.did]);

  const readNote = useCallback(
    (note: LibraryItem) => {
      // A note only on this phone has nothing in the space to read.
      if (note.onPhone) return;
      const imported = isServerImportedItem(note);
      if (imported && (!firefliesKvAllowed || !firefliesPurgeChecker)) {
        reads.current.set(note.id, {
          metadata: { status: "absent" },
          transcript: { transcript: { status: "absent" }, provenance: null },
        });
        bump();
        return;
      }
      const cached = reads.current.get(note.id) ?? {};
      const version = readVersions.current.get(note.id) ?? 0;
      if (reading.current.has(note.id)) return;
      const stale = invalidated.current.delete(note.id);
      const staleFields = staleReads.current.get(note.id);
      staleReads.current.delete(note.id);
      // Prior success is not current authorization for server-imported rows: always revalidate both
      // metadata and transcript against the active flag and a fresh purge verdict.
      if (!imported && !stale && !staleFields?.size && settled(cached.metadata) && settled(cached.transcript?.transcript)) return;
      // A saved note retains its reads during revalidation; server-imported rows clear prior reads
      // until the fresh purge check lands.
      if (imported) {
        reads.current.set(note.id, { metadata: undefined, transcript: undefined });
      } else if (!stale) {
        reads.current.set(note.id, {
          metadata: settled(cached.metadata) ? cached.metadata : undefined,
          transcript: settled(cached.transcript?.transcript) ? cached.transcript : undefined,
        });
      }
      reading.current.add(note.id);
      bump();
      const startedScope = accountScope;
      const startedSpace = space;
      const stillCurrent = () =>
        mounted.current &&
        activeScopeRef.current.scope === startedScope &&
        activeScopeRef.current.space === startedSpace;
      void enqueue(async () => {
        try {
          const locator = note.source === VOICE_NOTE_SOURCE
            ? await voiceNoteTranscriptLocator(startedSpace, note.sourceId) : null;
          if (!stillCurrent()) return;
          if (version === (readVersions.current.get(note.id) ?? 0) && (imported || stale || staleFields?.has("metadata") || !settled(reads.current.get(note.id)?.metadata))) {
            let metadata = await readMeetingMetadata(
              startedSpace,
              note.id,
              imported
                ? {
                    includeFirefliesKv: firefliesKvAllowed,
                    source: note.source,
                    sourceId: note.sourceId,
                    isFirefliesPurged: firefliesKvAllowed ? firefliesPurgeChecker : undefined,
                  }
                : undefined,
            );
            if (!stillCurrent()) return;
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
            if (!imported && version === (readVersions.current.get(note.id) ?? 0) && metadata.status === "failed" && cached.metadata?.status === "ok") {
              const fields = staleReads.current.get(note.id) ?? new Set<keyof NoteReads>();
              fields.add("metadata");
              staleReads.current.set(note.id, fields);
            }
            if (version === (readVersions.current.get(note.id) ?? 0)) {
              reads.current.set(note.id, {
                ...reads.current.get(note.id),
                metadata: !imported && metadata.status === "failed" && cached.metadata?.status === "ok"
                  ? cached.metadata : metadata,
              });
              if (stillCurrent()) bump();
            }
          }
          if (version === (readVersions.current.get(note.id) ?? 0) && (imported || stale || staleFields?.has("transcript") || !settled(reads.current.get(note.id)?.transcript?.transcript))) {
            const transcript = locator
              ? locator.bodyKey ? await readTranscript(startedSpace, note.source, note.sourceId, locator.bodyKey, locator.expectedText)
                : { status: "absent" as const }
              : await readTranscript(
                  startedSpace,
                  note.source,
                  note.sourceId,
                  undefined,
                  undefined,
                  imported
                    ? { requirePurgeCheck: true, isFirefliesPurged: firefliesKvAllowed ? firefliesPurgeChecker : undefined }
                    : undefined,
                );
            if (!stillCurrent()) return;
            if (!imported && version === (readVersions.current.get(note.id) ?? 0) && transcript.status === "failed" && cached.transcript?.transcript.status === "ok") {
              const fields = staleReads.current.get(note.id) ?? new Set<keyof NoteReads>();
              fields.add("transcript");
              staleReads.current.set(note.id, fields);
            }
            if (version === (readVersions.current.get(note.id) ?? 0)) {
              const keepCachedTranscript = !imported && transcript.status === "failed" && cached.transcript?.transcript.status === "ok";
              reads.current.set(note.id, {
                ...reads.current.get(note.id),
                transcript: keepCachedTranscript ? cached.transcript : {
                  transcript,
                  provenance: locator?.committed ? locator.provenance ?? { engine: null, provider: null, model: null } : null,
                },
              });
              if (stillCurrent()) bump();
            }
          }
        } finally {
          if (activeScopeRef.current.scope === startedScope && activeScopeRef.current.space === startedSpace) {
            reading.current.delete(note.id);
            if (mounted.current && version !== (readVersions.current.get(note.id) ?? 0)) setInvalidationRevision((n) => n + 1);
          }
        }
      });
    },
    [accountScope, bump, enqueue, firefliesKvAllowed, firefliesPurgeChecker, space],
  );

  // An invalidation that arrives during an in-flight read is retried once that
  // read settles; otherwise opening a cached note reads only when needed.
  useEffect(() => {
    if (item) readNote(item);
  }, [item, readNote, invalidationRevision]);

  const noteReads: NoteReads = item?.onPhone
    ? { metadata: { status: "ok", metadata: {} }, transcript: { transcript: { status: "absent" }, provenance: null } }
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
  // Metadata that says the space holds no audio makes this device's file the only audio, whether or not the
  // pending list still carries the note (it does not once the note is saved and its transcript committed).
  const phoneFirst = item?.onPhone === true || (onThisPhone && audioBase === null)
    || (voiceSourceId !== null && localOnlyAudio && deviceFileId === voiceSourceId);
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
    // A pasted transcript never had audio: it is the only voice note with no space load.
    const pastedRow = voiceSourceId !== null && item?.metadata?.capture === "pasted";
    if (voiceSourceId !== null && !pastedRow && metadataLoaded && !pendingAudioRow && !localOnlyAudio) return { load: spaceLoad(voiceSourceId) };
    if (audioBase !== null && !localOnlyAudio) return { load: (signal, onProgress) => getAudio(space.kv, audioBase, { signal, onProgress }) };
    return null;
  }, [audioBase, item?.saving, item?.metadata, phoneFirst, phoneChannels, localOnlyAudio, metadataLoaded, pendingAudioRow, space, voiceSourceId]);

  const retry = useCallback(() => {
    if (currentList.status === "failed") refresh();
    if (item) {
      if (reads.current.get(item.id)?.transcript?.transcript.status === "absent") {
        const fields = staleReads.current.get(item.id) ?? new Set<keyof NoteReads>();
        fields.add("transcript");
        staleReads.current.set(item.id, fields);
      }
      readNote(item);
    }
  }, [currentList.status, item, readNote, refresh]);

  return {
    status: currentList.status,
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
