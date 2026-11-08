import { readableError } from "@/lib/readableError";
import { captureEvents } from "../captureEvents";
import { pruneDeletedFailureNotification } from "../activity/failureNotifications";
// The voice-note recorder's controller, without React: the old Voice notes
// card's controller moved onto recorderReducer, without the notes list and
// playback (the Library and a note's detail, capture/library) or the
// mount-time retry of pending saves (PendingVoiceNotesSaver stays the only
// saver at startup). useVoiceNoteRecorder wraps it for RecorderProvider, which
// mounts it exactly once; the tests drive it directly against the fake plugin.
//
// It owns the plugin's four listeners (micState, level, autoStopped, presentRecorder), picks a
// running recording back up after a WebView reload (status()), saves a stopped
// recording through the shared single-flight guards (recorderSaves.ts), and
// hands each saved note to private cloud transcription. Discard (PR5) marks the
// recording before stopping it, so no save that meets it keeps it.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { App } from "@capacitor/app";
import { setCapturePlaybackBlocked, stopAllPlayback } from "@/lib/audio/playback";
import { Capacitor } from "@capacitor/core";

import {
  VoiceNotes,
  voiceNoteMaxDurationMs,
  VOICE_NOTE_EXTENSION_MS,
  type LimitExtension,
  VOICE_NOTE_SAFETY_CAP_MS,
  type VoiceNoteAutoStopEvent,
  type VoiceNoteRecording,
  type CaptureStatus,
  type MicStateEvent,
  type LevelEvent,
  type CaptureOptions,
  type TranscriberId,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { captureCapabilities, captureEngineKind, onDeviceTranscriptionAvailable } from "@/lib/voiceNotes/captureEngine";
import { levelFromAmplitude } from "@/lib/voiceNotes/web/webLevels";
import { isOnDeviceReady } from "@/lib/voiceNotes/onDeviceStt";
import { isLegacyNote } from "@/lib/voiceNotes/legacyMigration";
import { setQuarantineAccount } from "@/lib/voiceNotes/quarantine";
import { ensureAppleSpeechAssets, ensureOnDeviceModel, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { autoStopEnabled, effectiveCaptureOptions, readTranscriberPreference, readUploadAudioPreference, recordingLimitMs,
  setDefaultIdentifySpeakers, setDefaultTranscriber, settleDefaults, subscribeTranscriberPreference, writeAccountDefaults,
  } from "@/lib/voiceNotes/transcriberPreference";
import { recorderLayout } from "./final/shellCapabilities";
import {
  clearDiscarded,
  unmarkDiscarded,
  deleteDiscarded,
  errorCode,
  markDiscarded,
  messageOf,
  pendingStore,
  pendingSaveMessage,
  saveRecording,
  savePendingRecordings,
  TINYCLOUD_NETWORK_FAILURE_MESSAGE,
} from "@/lib/voiceNotes/recorderSaves";
import { transcribeSavedNote, type VoiceNoteTranscriber } from "@/lib/voiceNotes/voiceNoteTranscription";
import { saveDeferredForAccountTransition, type VoiceNotePipeline } from "@/lib/voiceNotes/voiceNotePipeline";
import { adoptNote, deleteNote, loadNote, parseMomentLines, saveNote, type RecordingMoment } from "@/lib/voiceNotes/recordingNotes";
import { readRecordingNoteFromSpace, recordingNoteSyncError, reportRecordingNoteSyncError,
  subscribeRecordingNoteSync, syncRecordingNote, type NoteSyncErrorCode } from "@/lib/voiceNotes/voiceNoteStore";
import { assertCurrent, currentAccountGeneration } from "@/lib/voiceNotes/accountContext";
import { withCaptureDeadline } from "@/lib/voiceNotes/accountHandoff";
import { autoStopNoticeText, FINALIZATION_PENDING } from "./recorderCopy";
import { autoStopIsCurrent, initialRecorderState, recorderReducer, type RecorderCaptureIssue, type RecorderEvent, type RecorderMic, type RecorderState } from "./recorderReducer";
import { recordedElapsedAt } from "./recordedElapsed";
import { admitHomeWork, holdHomeWork } from "@/lib/homeReauthorizing";
import { clearPartialAudioIssue, dismissPartialAudioIssue, partialAudioDismissed, partialAudioScope,
  pendingAudioLossIds, prunePartialAudioIssues, savedPartialAudioIssues, savePartialAudioIssue,
  savePendingAudioLoss } from "./partialAudioIssues";

/** Sidecar spans are wall timestamps; the notice exposes offsets from recording start. */
function partialFromSidecar(recording: VoiceNoteRecording): Extract<RecorderCaptureIssue, { kind: "partial_audio" }> | null {
  const spans = recording.spans?.filter((span) => span.kind === "omitted" && span.reason === "writer_stalled")
    .flatMap((span) => {
      const end = span.endedAt ?? recording.captureStoppedAt;
      return end !== null && end !== undefined && end >= span.startedAt
        ? [{ startMs: Math.max(0, span.startedAt - recording.startedAt),
          endMs: Math.max(0, end - recording.startedAt), reason: span.reason }]
        : [];
    });
  return spans?.length ? { kind: "partial_audio", spans,
    missingMs: spans.reduce((total, span) => total + span.endMs - span.startMs, 0) } : null;
}

const micFromStatus = (status: CaptureStatus | MicStateEvent): RecorderMic =>
  ({ state: status.state, reason: status.reason, input: status.input ?? null });

const recorderDevice = () => captureEngineKind() === "tauri" ? "Mac" : "phone";

export interface VoiceNoteRecorderControllerOptions {
  tcw: TinyCloudWeb | null;
  pipeline?: VoiceNotePipeline | null;
  /** The Exo mobile app with its VoiceNotes plugin; nothing else records. */
  available: boolean;
  /** Private cloud transcription for this account; null without one. */
  transcriber: Pick<VoiceNoteTranscriber, "check" | "noteSaved"> & Partial<Pick<VoiceNoteTranscriber, "snapshot" | "subscribe">> | null;
  /** Test seam for model readiness; production reads the shared native STT snapshot. */
  onDeviceReady?: () => boolean;
  appleInterim?: () => boolean;
  /** Delayed/failing local reads can be exercised without changing the phone's storage adapter. */
  noteLoader?: typeof loadNote;
  /** Test clock for note-load retries; production uses setTimeout. */
  noteRetryScheduler?: (delayMs: number, retry: () => void) => () => void;
  /** A native foreground subscription; injected in tests to exercise a missed grant event. */
  subscribeAppActive?: (listener: () => void) => Promise<{ remove(): Promise<void> }>;
}

export type TranscriberChoiceResult = "ok" | "needs_consent" | "locked_signed_out" | "unavailable";
export type TranscriberChoiceScope = "recording" | "default";
export interface RecorderTranscriberChoice {
  id: TranscriberId;
  identifySpeakers: boolean;
  source: TranscriberChoiceScope;
}
export type SetTranscriberResult = TranscriberChoiceResult;
export type TranscriberScope = TranscriberChoiceScope;
export type RecorderTranscriber = RecorderTranscriberChoice;
export interface RecorderNote { md: string; moments: RecordingMoment[] }
export type RecorderNoteStatus = "loading" | "ready" | "error";

export interface VoiceNoteRecorderController {
  getState(): RecorderState;
  getTranscriber(): RecorderTranscriberChoice;
  getNote(): RecorderNote | null;
  getNoteStatus(): RecorderNoteStatus;
  getNoteSyncError(): string | null;
  /** Resolves after the Markdown is durable on this phone; space sync is debounced. */
  setNoteText(md: string): Promise<void>;
  /** Tap-time recorded clock only. The UI writes a Markdown line if the moment is kept. */
  markMoment(): number;
  setTranscriber(id: TranscriberId, options: { scope: TranscriberChoiceScope }): Promise<TranscriberChoiceResult>;
  setIdentifySpeakers(on: boolean, scope: "recording" | "default"): Promise<"ok" | "needs_consent" | "locked_signed_out" | "unavailable">;
  subscribe(listener: () => void): () => void;
  setOnPresent(onPresent: (() => void) | undefined): void;
  /** A recording landed in the space (by Stop, the limit, or Save now). */
  setOnSaved(onSaved: ((recording: VoiceNoteRecording) => void) | undefined): void;
  /** Adds the plugin's listeners and picks up a running recording; returns their teardown. */
  attach(): () => void;
  record(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Stop the live recording and delete it from the phone; nothing is saved. */
  discard(): Promise<void>;
  retryPending(): Promise<void>;
  openSettings(): Promise<void>;
  /** Raise the live recording's limit by `extension` (default one hour: "Keep going"), or drop it ("none"); absent where the engine fixes the limit at start. */
  extendLimit?(extension?: LimitExtension): Promise<void>;
  dismissShortcutRecovery(): Promise<void>;
  /** The receipt was read. */
  dismissOutcome(): void;
  /** Only a saved recording's partial-audio notice can be dismissed. False: it was not (no such notice, or the dismissal could not be saved). */
  dismissCaptureIssue(id: string): boolean;
  /** Input levels (0..1), fanned out without React state. */
  subscribeLevel(listener: (level: number) => void): () => void;
  /** Source-aware levels for the Mac's separate Them trace. */
  subscribeLevels(listener: (levels: LevelEvent) => void): () => void;
}

// Ownership. A live recording has at most one owner: the attached recorder that started or picked it up, or a closed
// recorder's cleanup. Owners claim it here at the moment they take it (synchronously, after every await), so two
// recorders can never both hold it. A closed (detached) recorder never writes recorder state, playback or Home work
// of anyone else; what it leaves live is followed by a tracker (trackDetachedRecording) until it ends or an attached
// recorder takes it.
// Kept per capture engine (recording ids are unique within one).
interface EngineRecordings {
  owners: Map<string, object>;
  // How many times an attached recorder has taken each recording. A tracker whose recording was taken since it began
  // stops: from then on that recorder, or the tracker its own detach starts, answers for it.
  takes: Map<string, number>;
}
let recordingsByEngine = new WeakMap<object, EngineRecordings>();
const engineRecordings = (): EngineRecordings => {
  let recordings = recordingsByEngine.get(VoiceNotes);
  if (!recordings) {
    recordings = { owners: new Map(), takes: new Map() };
    recordingsByEngine.set(VoiceNotes, recordings);
  }
  return recordings;
};
const claimRecording = (id: string, claimant: object): boolean => {
  const { owners } = engineRecordings();
  const held = owners.get(id);
  if (held !== undefined && held !== claimant) return false;
  owners.set(id, claimant);
  return true;
};
const releaseRecording = (id: string, claimant: object) => {
  const { owners } = engineRecordings();
  if (owners.get(id) === claimant) owners.delete(id);
};
// A recording that has ended (stopped, discarded, saved) can never be taken again, not even from a status read
// answered before it ended.
const ENDED = {};
const endRecording = (id: string) => {
  engineRecordings().owners.set(id, ENDED);
};
// Attached recorders in attach order; a recording nobody owns is offered to the most recent one.
const attachedRecorders: Array<(id: string) => void> = [];
const announceUnownedRecording = (id: string) => {
  attachedRecorders.at(-1)?.(id);
};
// Recordings detached recorders left live, each with its trackers and whether a tracker may discard it (a start that
// finished after its recorder closed: nobody chose to record it). A recording its owner was showing is never discarded.
const trackedRecordings = new Map<string, Set<{ mayDiscard: boolean }>>();
// Each recorder blocks note playback while it captures; playback is blocked while any one does.
const playbackBlockers = new Set<object>();
const blockPlayback = (blocker: object, blocked: boolean) => {
  if (blocked) playbackBlockers.add(blocker); else playbackBlockers.delete(blocker);
  setCapturePlaybackBlocked(playbackBlockers.size > 0);
};

// A tracker's waits between turns (the last repeats).
const TRACKER_WAITS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
let trackerWaitsMs = TRACKER_WAITS_MS;
let trackerSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
/** Test seam: the tracker's waits between turns and how it sleeps (null: the real ones). */
export function __setRecorderTrackerForTests(options: { waits?: readonly number[]; sleep?: (ms: number) => Promise<void> } | null) {
  trackerWaitsMs = options?.waits ?? TRACKER_WAITS_MS;
  trackerSleep = options?.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
}
// Bumped by the test reset: trackers from before it stop, and leave the reset Home work count alone.
let trackerEpoch = 0;
/** Tests only: forget recorders, claims and trackers left by other test files sharing this module. */
export function __resetRecorderOwnershipForTests() {
  attachedRecorders.length = 0;
  recordingsByEngine = new WeakMap();
  trackedRecordings.clear();
  playbackBlockers.clear();
  trackerEpoch += 1;
}
/** Tests only: what the ownership model holds now. */
export function __recorderOwnershipForTests() {
  const tracked = new Map<string, { mayDiscard: boolean }>();
  for (const [id, trackers] of trackedRecordings) tracked.set(id, { mayDiscard: [...trackers].some((tracker) => tracker.mayDiscard) });
  return { owners: new Map(engineRecordings().owners), tracked, attached: attachedRecorders.length };
}

/** Follows a recording a detached recorder left live, holding that recorder's Home work place (`release`) until the
 * recording is no longer live or an attached recorder has taken it. Each turn: taken → done; a recorder attached →
 * offered to it; none attached, and the recording may be discarded on an engine that discards by id → discarded by
 * its id under a claim (refused if another recording is live; retried on later turns if the engine fails); then one
 * status read (a read that never answers is waited for, never repeated). A stop or discard its owner had already
 * sent (`ending`) settles first, with the recording claimed by this tracker meanwhile: nobody takes a recording that
 * may be ending. */
async function trackDetachedRecording(id: string, mayDiscard: boolean, release: (() => void) | null, ending: Promise<unknown> | null = null) {
  const tracker = { mayDiscard };
  const trackers = trackedRecordings.get(id) ?? new Set();
  trackers.add(tracker);
  trackedRecordings.set(id, trackers);
  const cleanup = {};
  const epoch = trackerEpoch;
  const { owners, takes } = engineRecordings();
  const takesAtStart = takes.get(id) ?? 0;
  try {
    if (ending) {
      if (owners.get(id) !== ENDED) owners.set(id, cleanup);
      await ending.catch(() => undefined);
      releaseRecording(id, cleanup);
    }
    for (let turn = 0; ; turn += 1) {
      if (turn > 0) await trackerSleep(trackerWaitsMs[Math.min(turn - 1, trackerWaitsMs.length - 1)]);
      if (epoch !== trackerEpoch) return;
      // Taken by an attached recorder (now or since this began): that recorder, or its own tracker, answers for it.
      if ((takes.get(id) ?? 0) !== takesAtStart) return;
      const owner = owners.get(id);
      if (owner !== undefined && owner !== cleanup) return;
      if (attachedRecorders.length > 0) {
        announceUnownedRecording(id);
      } else if (mayDiscard && captureCapabilities().scopedDiscard && claimRecording(id, cleanup)) {
        let gone = false;
        try {
          await VoiceNotes.discard({ id });
          gone = true;
        } catch (caught) {
          // recording_changed: another recording is live, which this never touches.
          gone = errorCode(caught) === "recording_changed";
          if (!gone) console.warn("[VoiceNotes] Could not discard a recording started after its recorder closed", caught);
        }
        if (gone) {
          endRecording(id);
          return;
        }
        releaseRecording(id, cleanup);
        continue;
      }
      const status = await VoiceNotes.status().catch(() => null);
      if (status !== null && (status.state === "idle" || status.id !== id)) {
        endRecording(id);
        return;
      }
    }
  } finally {
    trackers.delete(tracker);
    if (trackers.size === 0 && trackedRecordings.get(id) === trackers) trackedRecordings.delete(id);
    if (epoch === trackerEpoch) release?.();
  }
}

export function createVoiceNoteRecorderController({ tcw, available, transcriber, pipeline, onDeviceReady,
  subscribeAppActive, noteLoader = loadNote, noteRetryScheduler = (delayMs, retry) => {
    const timer = setTimeout(retry, delayMs);
    return () => clearTimeout(timer);
  } }: VoiceNoteRecorderControllerOptions): VoiceNoteRecorderController {
  let state = initialRecorderState;
  let nativeStopPending = false;
  let preference = readTranscriberPreference();
  let nativeOptions: CaptureOptions | null = null;
  const signedIn = tcw?.did != null;
  const privateDiarization = () => transcriber?.snapshot?.().capabilities?.diarization === true;
  const defaultChoice = (): RecorderTranscriberChoice => {
    const options = effectiveCaptureOptions(preference, signedIn);
    return { id: options.transcriber, identifySpeakers: options.identifySpeakers, source: "default" };
  };
  let choice = defaultChoice();
  // Local needs the on-device model: this starts its download once the user has chosen Local or recorded on it, and
  // the model is not on the phone. Merely being on Local by default starts no Android download (iOS fetches its free,
  // OS-managed speech assets below). Recording never waits for the download; the note's Local transcription queues
  // natively until the model is ready.
  const ensureLocalModel = (retry = false) => {
    if (!available || !captureCapabilities().localTranscription) return;
    if (onDeviceReady?.() ?? isOnDeviceReady(onDeviceSttStore.snapshot())) return;
    ensureOnDeviceModel({ retry });
  };
  if (available && captureCapabilities().localTranscription && choice.id === "on-device") {
    ensureAppleSpeechAssets().catch((caught: unknown) => console.warn("[Recorder] Could not start the iOS speech install", caught));
  }
  let note: RecorderNote | null = null;
  let noteId: string | null = null;
  let noteStatus: RecorderNoteStatus = "ready";
  let noteLoadError: Error | null = null;
  let noteLoadVersion = 0;
  let noteRetryAttempts = 0;
  let cancelNoteRetry: (() => void) | null = null;
  let noteAttached = false;
  let noteSyncTimer: ReturnType<typeof setTimeout> | null = null;
  // Signed out (no tcw), notes stay local-first and never sync.
  const noteClient = tcw?.did && tcw.spaceId ? tcw : null;
  const noteAccount = noteClient?.did && noteClient.spaceId ? { did: noteClient.did, spaceId: noteClient.spaceId,
    generation: currentAccountGeneration() } : null;
  const checkNoteAccount = () => {
    if (!noteAccount) throw new Error("No account owns this recording note");
    assertCurrent(noteAccount);
    if (tcw?.did !== noteAccount.did || tcw?.spaceId !== noteAccount.spaceId) throw new Error("Recording note account changed");
  };
  let onSaved: ((recording: VoiceNoteRecording) => void) | undefined;
  let onPresent: (() => void) | undefined;
  let presentWhenReady = false;
  const present = () => {
    if (onPresent) onPresent();
    else presentWhenReady = true;
  };
  const listeners = new Set<() => void>();
  const levelListeners = new Set<(level: number) => void>();
  const levelsListeners = new Set<(levels: LevelEvent) => void>();
  // Resolve only after mount. An invalid SDK identity is logged, while the
  // recorder remains usable and never writes notices into another account.
  let issueScope: string | null | undefined;
  const scope = (): string | null => {
    if (issueScope !== undefined) return issueScope;
    try { return (issueScope = partialAudioScope(tcw?.did, tcw?.spaceId)); }
    catch (caught) {
      console.error("[VoiceNotes] Invalid account identifiers for capture issues", caught);
      issueScope = null;
      return null;
    }
  };
  const dismissed = (id: string) => {
    const key = scope();
    return key !== null && partialAudioDismissed(key, id);
  };
  const belongsToAccount = (recording: VoiceNoteRecording) =>
    (recording.owner == null || recording.owner === tcw?.did) &&
    (!recording.ledger?.spaceId || !tcw?.spaceId || recording.ledger.spaceId === tcw.spaceId);
  const committedIds = new Set<string>();
  const lostAudioIds = new Set<string>();
  const captureCommitted = (id: string | undefined, recording?: VoiceNoteRecording) => {
    if (!id) return;
    if (recording && !belongsToAccount(recording)) return;
    committedIds.add(id);
    const partial = recording ? partialFromSidecar(recording) : null;
    if (dismissed(id)) {
      send({ type: "CAPTURE_RESOLVED", id });
    } else {
      send({ type: "CAPTURE_COMMITTED", id, ...(partial ? { partial } :
        lostAudioIds.has(id) ? { partial: { kind: "partial_audio" } as const } : {}) });
      const issue = state.captureIssues[id];
      const key = scope();
      if (key !== null && issue?.kind === "partial_audio") savePartialAudioIssue(key, id, issue);
    }
  };

  const notify = () => { for (const listener of [...listeners]) listener(); };
  const currentNoteId = () => state.phase === "starting" ? null : state.recordingId ?? state.lastSaved?.id ?? null;
  const noteAccountCurrent = () => noteAccount && noteAccount.generation === currentAccountGeneration() &&
    tcw?.did === noteAccount.did && tcw?.spaceId === noteAccount.spaceId;
  const getNoteSyncError = () => {
    const id = currentNoteId();
    return id && noteClient && noteAccountCurrent()
      ? recordingNoteSyncError(noteClient, id) : null;
  };
  const reportSavedNoteSyncError = (id: string, code: NoteSyncErrorCode | undefined) => {
    if (code && noteClient && noteAccountCurrent()) reportRecordingNoteSyncError(noteClient, id, code);
  };
  const clearNoteRetry = () => { cancelNoteRetry?.(); cancelNoteRetry = null; };
  function scheduleNoteRetry(id: string, version: number): void {
    if (!noteAttached || noteId !== id || version !== noteLoadVersion) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(noteRetryAttempts, 5));
    noteRetryAttempts++;
    clearNoteRetry();
    cancelNoteRetry = noteRetryScheduler(delayMs, () => {
      cancelNoteRetry = null;
      if (noteAttached && noteId === id && version === noteLoadVersion) beginNoteLoad(id);
    });
  }
  function beginNoteLoad(id: string): void {
    const version = ++noteLoadVersion;
    void (async () => {
      let stored = await noteLoader(id);
      if (!stored && noteClient && state.phase === "idle" && state.outcome === "saved") {
        checkNoteAccount();
        const remote = await readRecordingNoteFromSpace(noteClient, id);
        checkNoteAccount();
        if (version !== noteLoadVersion || noteId !== id) return;
        if (remote) stored = await adoptNote(remote);
      }
      if (version !== noteLoadVersion || noteId !== id) return;
      clearNoteRetry();
      noteRetryAttempts = 0;
      noteLoadError = null;
      note = stored ? { md: stored.md, moments: stored.moments } : null;
      noteStatus = "ready";
      notify();
    })().catch((error: unknown) => {
      if (version !== noteLoadVersion || noteId !== id) return;
      noteLoadError = error instanceof Error ? error : new Error(readableError(error));
      noteStatus = "error";
      notify();
      console.warn("[VoiceNotes] Could not load recording note", error);
      scheduleNoteRetry(id, version);
    });
  }
  const followNote = (force = false) => {
    const id = currentNoteId();
    if (id === noteId && !force) return;
    clearNoteRetry();
    noteRetryAttempts = 0;
    noteId = id;
    note = null;
    noteStatus = id ? "loading" : "ready";
    noteLoadError = null;
    if (!id) { ++noteLoadVersion; return; }
    beginNoteLoad(id);
  };
  const scheduleNoteSync = (id: string) => {
    if (!noteAccount || !noteClient || state.outcome !== "saved" || state.lastSaved?.id !== id) return;
    if (noteSyncTimer) clearTimeout(noteSyncTimer);
    noteSyncTimer = setTimeout(() => {
      noteSyncTimer = null;
      void syncRecordingNote(noteClient, id, checkNoteAccount).catch((error: unknown) =>
        console.warn("[VoiceNotes] Could not sync recording note", error));
    }, 500);
  };
  const refreshChoice = () => {
    // recordingId lives from STARTED through stopping/saving until the recorder is idle, so the
    // mode the note was recorded under stays on screen until the receipt.
    const live = state.recordingId !== null && nativeOptions !== null;
    const next: RecorderTranscriberChoice = live
      ? { id: nativeOptions!.transcriber,
        identifySpeakers: nativeOptions!.identifySpeakers, source: "recording" }
      : defaultChoice();
    if (choice.id === next.id && choice.identifySpeakers === next.identifySpeakers && choice.source === next.source) return false;
    choice = next;
    return true;
  };
  const acceptNativeOptions = (status: CaptureStatus | MicStateEvent) => {
    if (!status.options || (status.id && state.recordingId && status.id !== state.recordingId)) return;
    nativeOptions = status.options;
    if (refreshChoice()) notify();
  };

  // A recording holds its place at the Home work boundary (lib/homeReauthorizing.ts) from the moment it starts
  // (before the microphone is even asked) until the recorder is idle again, so a session swap never cuts it off.
  let homeWork: (() => void) | null = null;
  // A detached recorder (signed out, unmounted) holds nothing, whatever late events it still hears.
  let homeWorkDetached = false;
  // The start in progress (waiting on the defaults or the microphone). Detach cancels it and hands it the place.
  interface PendingStart {
    cancelled: boolean;
    release: (() => void) | null;
    whenCancelled: Promise<void>;
    signalCancelled: () => void;
    /** The recording this start started, once the engine has answered. */
    startedId: string | null;
  }
  let pendingStart: PendingStart | null = null;

  // This recorder's claimant while attached (a new one per attach), and the live recording it owns.
  let attachment: object | null = null;
  let ownedId: string | null = null;
  // The owner's stop or discard in flight at the engine (it may end the recording).
  let endingControl: Promise<unknown> | null = null;
  /** Takes `id` for this attached recorder; false if another owner holds it. */
  const own = (id: string): boolean => {
    if (attachment === null || !claimRecording(id, attachment)) return false;
    if (ownedId !== null && ownedId !== id) releaseRecording(ownedId, attachment);
    if (ownedId !== id) {
      const { takes } = engineRecordings();
      takes.set(id, (takes.get(id) ?? 0) + 1);
    }
    ownedId = id;
    return true;
  };
  const disown = () => {
    if (ownedId !== null && attachment !== null) releaseRecording(ownedId, attachment);
    ownedId = null;
  };
  /** Picks up a recording already running, if this recorder can show it and nobody else owns it. */
  const pickUp = (status: CaptureStatus): boolean => {
    if ((state.phase !== "idle" && state.phase !== "starting") || !status.id || status.startedAt === null || !own(status.id)) return false;
    acceptNativeOptions(status);
    send(activePickup(status));
    return true;
  };
  // This recorder's own playback block (playback is blocked while any recorder blocks it).
  const playbackBlocker = {};

  /** A recording its start left behind (detach cancelled that start): tracked until it ends or a recorder takes it,
   * and discarded by its id where nobody can take it. The start's place is kept until then. */
  const handOverCancelledStart = (id: string, attempt: PendingStart) => {
    void trackDetachedRecording(id, true, attempt.release);
    attempt.release = null;
  };

  // The reducer runs synchronously, so a second tap sees the phase the first one
  // set (Stop must never call stop() twice).
  const send = (event: RecorderEvent) => {
    const before = state;
    const next = recorderReducer(state, event);
    if (next === state) return;
    state = next;
    // Owned until the recorder is idle again or shows another recording.
    if (ownedId !== null && (next.phase === "idle" || next.recordingId !== ownedId)) disown();
    // A recording the recorder picks up (one already running) holds its place too; idle releases it.
    if (next.phase !== "idle" && homeWork === null && !homeWorkDetached) homeWork = holdHomeWork("recording");
    if (next.phase === "idle" && homeWork !== null) { homeWork(); homeWork = null; }
    if (!homeWorkDetached) blockPlayback(playbackBlocker, next.phase === "starting" || next.phase === "stopping" || next.phase === "discarding" ||
      (next.phase === "recording" && (next.controlPending === "resume" ||
        (next.mic.state !== "paused" && next.mic.state !== "interrupted" && next.mic.state !== "needs_user"))));
    refreshChoice();
    followNote(next.outcome === "saved" && before.outcome !== "saved" && note === null && noteStatus === "ready");
    notify();
  };

  const sendMicState = (status: CaptureStatus | MicStateEvent) => {
    const event = { type: "MIC_STATE" as const, mic: micFromStatus(status), audioMs: status.audioMs,
      captureSourceUnconfirmed: status.captureSourceUnconfirmed };
    send(status.elapsedMs === undefined ? event : { ...event, elapsedMs: status.elapsedMs, elapsedAt: Date.now() });
  };

  /** Whether this device stops recordings by itself now: its choice, else the layout's default (off at the phone layout). */
  const autoStopNow = () => autoStopEnabled(typeof window !== "undefined" && Number.isFinite(window.innerWidth) && recorderLayout(window.innerWidth) === "phone");

  const activePickup = (status: CaptureStatus): Extract<RecorderEvent, { type: "PICKED_UP" }> => {
    if (!status.id || status.startedAt === null) throw new Error("Native recording status has no active id or start time");
    return { type: "PICKED_UP", id: status.id, startedAt: status.startedAt,
      maxDurationMs: status.maxDurationMs, audioMs: status.audioMs, elapsedMs: status.elapsedMs, elapsedAt: Date.now(),
      mic: micFromStatus(status), autoStop: autoStopNow() && status.maxDurationMs < VOICE_NOTE_SAFETY_CAP_MS };
  };

  // Both reconcilers write only for the attachment that started them: a detached (or re-attached) recorder ignores
  // what it learns here, and the tracker or the next recorder deals with the recording.
  const reconcileFailedStop = async (error: string | null, id?: string | null) => {
    const mine = attachment;
    try {
      const status = await VoiceNotes.status();
      if (mine === null || attachment !== mine) return;
      if (state.phase !== "stopping") return;
      if (status.state === "idle") {
        send({ type: "STOP_FAILED", status: "idle", error, id });
        void pendingStore.refresh();
      } else if (status.id === state.recordingId) {
        acceptNativeOptions(status);
        const statusError = status.reason === "snapshot_unavailable" || status.reason === "snapshot_empty" ? null : error;
        send({ type: "STOP_FAILED", status: "active", error: statusError, id,
          mic: micFromStatus(status), audioMs: status.audioMs, elapsedMs: status.elapsedMs, elapsedAt: Date.now() });
      } else {
        send({ type: "STOP_FAILED", status: "idle", error: error ?? `Another recording is active on this ${recorderDevice()}.`, id });
        pickUp(status);
      }
    } catch (caught) {
      if (mine === null || attachment !== mine) return;
      send({ type: "STOP_FAILED", status: "unknown", error: `Could not check whether this ${recorderDevice()} stopped recording: ${messageOf(caught)}`, id });
    }
  };

  const reconcileDiscardFailure = async (shown: string | null, error: string) => {
    const mine = attachment;
    try {
      const status = await VoiceNotes.status();
      if (mine === null || attachment !== mine) return;
      if (state.phase !== "discarding") return;
      if (status.state === "idle") {
        send({ type: "DISCARD_FAILED", id: shown, committed: true,
          error: `${error} The recording ended; its audio remains on this ${recorderDevice()}.` });
        void pendingStore.refresh();
      } else if (status.id === shown) {
        acceptNativeOptions(status);
        send({ type: "DISCARD_FAILED", id: shown, error });
        sendMicState(status);
      } else {
        send({ type: "DISCARD_FAILED", id: shown, committed: true, error });
        pickUp(status);
      }
    } catch (caught) {
      if (mine === null || attachment !== mine) return;
      send({ type: "DISCARD_FAILED", id: shown, uncertain: true,
        error: `${error} Could not check whether recording continues: ${messageOf(caught)}` });
    }
  };

  /** One deadline covers the native control and every status reconciliation read. */
  const CONTROL_TIMEOUT_MS = 45_000;
  let controlOperationId = 0;
  const controlStillCurrent = (operationId: number, recordingId: string | null) =>
    operationId === controlOperationId && state.phase === "recording" && state.recordingId === recordingId;

  const uncertainControlError = (control: "pause" | "resume") => control === "pause"
    ? "Could not confirm that recording paused. Recording may still be running. Try again or stop."
    : "Could not confirm that recording resumed. Try again or stop.";

  const runControl = async (control: "pause" | "resume"): Promise<void> => {
    const operationId = ++controlOperationId;
    const recordingId = state.recordingId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = (async () => {
      let error: string | null = null;
      try {
        await (control === "pause" ? VoiceNotes.pause() : VoiceNotes.resume());
      } catch (caught) {
        error = `${control === "pause" ? "Could not pause" : "Could not resume"}: ${messageOf(caught)}`;
      }
      if (!controlStillCurrent(operationId, recordingId)) return;

      let status: CaptureStatus | undefined;
      try {
        status = await VoiceNotes.status();
      } catch (caught) {
        console.warn(`[VoiceNotes] Could not read status after ${control}`, caught);
      }
      if (!controlStillCurrent(operationId, recordingId)) return;

      if (!status) {
        send(control === "pause"
          ? { type: "PAUSE_FAILED", error: uncertainControlError(control) }
          : { type: "RESUME_FAILED", error: uncertainControlError(control) });
        send({ type: "MIC_STATE", mic: { state: "needs_user", reason: "status_unknown" } });
        return;
      }

      acceptNativeOptions(status);
      if (error) {
        send(control === "pause" ? { type: "PAUSE_FAILED", error } : { type: "RESUME_FAILED", error });
      } else {
        send(control === "pause" ? { type: "PAUSE_CONFIRMED" } : { type: "RESUME_CONFIRMED" });
      }
      // Native state is authoritative when a bridge call fails after making progress.
      sendMicState(status);
    })();
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (controlStillCurrent(operationId, recordingId)) {
          send(control === "pause"
            ? { type: "PAUSE_FAILED", error: uncertainControlError(control) }
            : { type: "RESUME_FAILED", error: uncertainControlError(control) });
          send({ type: "MIC_STATE", mic: { state: "needs_user", reason: "status_unknown" } });
          // The timeout ends this operation; neither its native call nor a late status may mutate state.
          ++controlOperationId;
        }
        resolve();
      }, CONTROL_TIMEOUT_MS);
    });
    try {
      await Promise.race([operation, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  /** `generation` is the account generation when the save began: a save finishing after an account change never transcribes. */
  const landed = (generation: number, recording: VoiceNoteRecording, audio?: Parameters<VoiceNoteTranscriber["noteSaved"]>[1]) => {
    if (transcriber) {
      transcribeSavedNote(transcriber, recording, () => generation === currentAccountGeneration(), audio);
    }
    onSaved?.(recording);
  };

  /** A native commit is enough for the receipt; cloud work follows independently. */
  const saveStopped = async (recording: VoiceNoteRecording) => {
    const generation = currentAccountGeneration();
    const accountCurrent = () => generation === currentAccountGeneration();
    // Admission can run as soon as the local file is committed. The row
    // callback below supplies the cloud identity before the PTX job starts.
    const privateCheck = recording.options?.transcriber === "private-cloud" && transcriber && tcw
      ? Promise.resolve().then(() => transcriber.check({ automatic: true, current: accountCurrent }))
        .then(() => true, (error: unknown) => {
          console.warn("[VoiceNotes] Private transcription admission failed", error);
          return false;
        }) : null;
    let privateStarted = false;
    const startPrivate = () => {
      if (privateStarted || recording.options?.transcriber !== "private-cloud" || !transcriber) return;
      privateStarted = true;
      void privateCheck?.then((ready) => { if (ready && accountCurrent()) transcriber.noteSaved(recording); });
    };
    const completeSaved = (saved: VoiceNoteRecording) => {
      if (!accountCurrent()) return;
      send({ type: "SAVED", id: saved.id, durationMs: saved.durationMs, channels: saved.channels, at: Date.now() });
      if (privateStarted) onSaved?.(saved);
      else landed(generation, saved);
    };
    send({ type: "LOCAL_COMMITTED", id: recording.id, durationMs: recording.durationMs, channels: recording.channels, at: Date.now() });
    void pendingStore.refresh();
    // The Mac receipt is backed by durable stopped sources. Readers and all
    // downstream work wait for the imported playable file before proceeding.
    if (recording.ledger?.localAudio?.state === "preparing") {
      try { await VoiceNotes.awaitAudioReady?.(recording.id); }
      catch (error) {
        send({ type: "SAVE_FAILED", error: `Recording saved. Couldn't prepare audio: ${messageOf(error)}`,
          recording: { id: recording.id, durationMs: recording.durationMs } });
        return;
      }
    }
    if (recording.options?.transcriber === "assemblyai" && transcriber && generation === currentAccountGeneration()) {
      transcriber.noteSaved(recording);
    }
    if (!tcw || (pipeline && !pipeline.isAccepting())) {
      pendingStore.setHeld(recording.id, "signed-out");
      send({ type: "LOCAL_UPLOAD_HELD", id: recording.id, reason: "signed-out" });
      return;
    }
    if (pipeline) {
      if (recording.owner !== tcw.did || !tcw.did || !tcw.spaceId) {
        const reason = !tcw.did || !tcw.spaceId ? "signed-out" : isLegacyNote(recording) ? "legacy" : recording.owner ? "other-account" : "unowned";
        pendingStore.setHeld(recording.id, reason);
        send({ type: "LOCAL_UPLOAD_HELD", id: recording.id, reason });
        return;
      }
      try {
        const finish = pendingStore.beginAutomaticSave();
        try {
          const result = await pipeline.process({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() }, recording.id, "stop", startPrivate, completeSaved);
          if (result === "owned-by-another-run" || result === "retry-scheduled") {
            send({ type: "LOCAL_UPLOAD_IN_FLIGHT", id: recording.id });
            void pendingStore.refresh();
            return;
          }
          completeSaved(recording);
        } finally { finish(); }
      } catch (caught) {
        if (!pipeline.isAccepting() || saveDeferredForAccountTransition(caught)) {
          pendingStore.setHeld(recording.id, "signed-out");
          send({ type: "LOCAL_UPLOAD_HELD", id: recording.id, reason: "signed-out" });
          void pendingStore.refresh();
          return;
        }
        const failure = messageOf(caught);
        send({ type: "SAVE_FAILED", error: failure === TINYCLOUD_NETWORK_FAILURE_MESSAGE ? "Waiting for a connection · syncs by itself" : "Couldn't sync to your TinyCloud space.",
          recording: { id: recording.id, durationMs: recording.durationMs } });
        pendingStore.reportNoteFailure(recording.id, caught);
        void pendingStore.refresh();
        return;
      }
      void pendingStore.refresh(null);
      return;
    }
    send({ type: "SAVE_PROGRESS", percent: null });
    const outcome = await saveRecording(tcw, recording, (stored, total) => {
      if (total > 0) send({ type: "SAVE_PROGRESS", percent: Math.floor((stored / total) * 100) });
    }, startPrivate);
    switch (outcome.kind) {
      case "saved":
        reportSavedNoteSyncError(recording.id, outcome.noteSyncError);
        send({ type: "SAVED", id: recording.id, durationMs: recording.durationMs, channels: recording.channels, at: Date.now() });
        if (privateStarted) onSaved?.(recording);
        else landed(generation, recording, outcome.audio ?? undefined);
        void pendingStore.refresh(outcome.cleanupError);
        return;
      case "failed":
        // The committed audio stays on the device and is playable.
        send({
          type: "SAVE_FAILED",
          error: outcome.failure === TINYCLOUD_NETWORK_FAILURE_MESSAGE ? "Waiting for a connection · syncs by itself" : "Couldn't sync to your TinyCloud space.",
          recording: { id: recording.id, durationMs: recording.durationMs },
        });
        pendingStore.reportNoteFailure(recording.id, { message: outcome.failure, failureKind: outcome.failureKind, cause: outcome.failureCause });
        void pendingStore.refresh();
        return;
      case "already-saved":
        send({ type: "SAVED", id: recording.id, durationMs: recording.durationMs, channels: recording.channels, at: Date.now() });
        void pendingStore.refresh(outcome.cleanupError);
        return;
      case "discarded":
        void pendingStore.refresh(outcome.cleanupError);
        send({ type: "RESET" });
        return;
      case "held":
        pendingStore.setHeld(recording.id, outcome.reason);
        send({ type: "LOCAL_UPLOAD_HELD", id: recording.id, reason: outcome.reason });
        void pendingStore.refresh();
        return;
      case "in-flight":
        // Another run is uploading it; keep the local receipt visible.
        send({ type: "LOCAL_UPLOAD_IN_FLIGHT", id: recording.id });
        return;
    }
  };

  /**
   * Save another recording than the one on screen (a retained auto-stop from before
   * a reload) without touching the recorder's state: it lands, or stays on the phone
   * and is counted there.
   */
  const saveInBackground = async (recording: VoiceNoteRecording) => {
    const generation = currentAccountGeneration();
    if (!tcw || (pipeline && !pipeline.isAccepting())) { void pendingStore.refresh(); return; }
    if (pipeline) {
      if (recording.owner === tcw.did && tcw.did && tcw.spaceId) {
        const finish = pendingStore.beginAutomaticSave();
        try {
          const result = await pipeline.process({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() }, recording.id, "background", undefined,
            (saved) => landed(generation, saved));
          if (result === "owned-by-another-run" || result === "retry-scheduled") {
            send({ type: "LOCAL_UPLOAD_IN_FLIGHT", id: recording.id });
            return;
          }
          landed(generation, recording);
        } catch (caught) {
          if (!saveDeferredForAccountTransition(caught) && pipeline.isAccepting()) {
            pendingStore.reportNoteFailure(recording.id, caught);
            void pendingStore.refresh();
            return;
          }
        } finally { finish(); }
      }
      void pendingStore.refresh();
      return;
    }
    const outcome = await saveRecording(tcw, recording);
    if (outcome.kind === "saved") reportSavedNoteSyncError(recording.id, outcome.noteSyncError);
    if (outcome.kind === "saved") landed(generation, recording, outcome.audio ?? undefined);
    if (outcome.kind === "failed") {
      pendingStore.reportNoteFailure(recording.id, { message: outcome.failure, failureKind: outcome.failureKind, cause: outcome.failureCause });
      void pendingStore.refresh();
    }
    else if (outcome.kind === "already-saved" || outcome.kind === "discarded") void pendingStore.refresh(outcome.cleanupError ?? undefined);
    else if (outcome.kind === "held") void pendingStore.refresh();
  };

  const onAutoStopped = (event: VoiceNoteAutoStopEvent) => {
    const recording = event.recording;
    const ended = event.id ?? recording?.id;
    if (ended) endRecording(ended);
    if (recording) captureCommitted(recording.id, recording);
    if (!recording && event.error === "finalization_timed_out") {
      send({ type: "CAPTURE_ISSUE", id: event.id ?? state.recordingId, issue: { kind: "finalization_timed_out" } });
    }
    if (recording && state.phase === "idle" && state.lastSaved?.id === recording.id) return;
    if (!autoStopIsCurrent(state, recording?.id ?? null)) {
      if (recording) void saveInBackground(recording);
      return;
    }
    const finalElapsed = recording && typeof recording.wallMs === "number" && typeof recording.pausedMs === "number"
      ? Math.max(0, recording.wallMs - recording.pausedMs) : undefined;
    send({ type: "AUTO_STOPPED", id: recording?.id ?? null, notice: autoStopNoticeText(event.reason, event.maxDurationMs),
      captured: recording !== null, at: Date.now(), elapsedMs: finalElapsed, error: event.error,
      pendingId: event.error === "finalization_timed_out" ? event.id ?? state.recordingId : null,
      ...(event.reason === "max_duration" ? { limitMs: event.maxDurationMs } : {}) });
    if (!recording) return;
    void saveStopped(recording).catch((caught: unknown) =>
      send({ type: "SAVE_FAILED", error: messageOf(caught), recording: { id: recording.id, durationMs: recording.durationMs } }),
    );
  };

  let retryPendingInFlight: Promise<void> | null = null;
  return {
    getState: () => state,
    getTranscriber: () => choice,
    getNote: () => note,
    getNoteStatus: () => noteStatus,
    getNoteSyncError,
    async setNoteText(md) {
      const id = currentNoteId();
      if (!id) throw new Error("No recording is selected for notes");
      if (noteId !== id || noteStatus === "loading")
        throw Object.assign(new Error("Recording note is still loading"), { code: "note_not_loaded" });
      if (noteStatus === "error") {
        throw noteLoadError ?? new Error("Could not load recording note");
      }
      const before = note;
      const version = ++noteLoadVersion;
      note = { md, moments: parseMomentLines(md) };
      notify();
      try {
        const saved = await saveNote(id, md);
        if (noteId === id && version === noteLoadVersion) {
          note = { md: saved.md, moments: saved.moments };
          notify();
        }
        scheduleNoteSync(id);
      } catch (error) {
        if (noteId === id && version === noteLoadVersion) { note = before; notify(); }
        throw error;
      }
    },
    markMoment() {
      if (state.phase !== "recording" || !state.recordingId) throw new Error("No live recording to mark");
      return Math.floor(recordedElapsedAt(state));
    },
    async setTranscriber(id, { scope }) {
      if (!available) return "unavailable";
      if (id === "on-device" && captureEngineKind() === "tauri") {
        try { await (await import("@/lib/voiceNotes/desktop/desktopVoiceNotes")).refreshDesktopWhisperCapability(); }
        catch { return "unavailable"; }
      }
      if (id === "on-device" && !onDeviceTranscriptionAvailable()) return "unavailable";
      if (!signedIn && id !== "on-device") return "locked_signed_out";
      if (id === "private-cloud") {
        const snapshot = transcriber?.snapshot?.();
        if (!snapshot?.consented) return "needs_consent";
        if (snapshot.availability !== "available") return "unavailable";
      }
      if (id === "assemblyai") {
        const snapshot = transcriber?.snapshot?.();
        if (!snapshot?.powerfulConsented) return "needs_consent";
        if (!snapshot.powerfulAvailable) return "unavailable";
      }
      if (scope === "recording") {
        if (state.phase !== "recording" || !state.recordingId) return "unavailable";
        const identifySpeakers = (id === "assemblyai" || (id === "private-cloud" && privateDiarization())) && preference.identifySpeakers;
        await VoiceNotes.setRecordingOptions({ transcriber: id, identifySpeakers });
        acceptNativeOptions(await VoiceNotes.status());
      } else {
        await setDefaultTranscriber(id);
        preference = readTranscriberPreference();
        if (refreshChoice()) notify();
      }
      // Choosing Local again is also the way to retry a download that failed.
      if (id === "on-device") ensureLocalModel(true);
      return "ok";
    },
    async setIdentifySpeakers(on, scope) {
      if (!available) return "unavailable";
      const id = scope === "recording" ? choice.id : effectiveCaptureOptions(preference, signedIn).transcriber;
      if (scope === "recording" && (state.phase !== "recording" || choice.source !== "recording")) return "unavailable";
      if (id !== "private-cloud" && id !== "assemblyai") return "unavailable";
      if (id === "private-cloud" && !privateDiarization()) return "unavailable";
      if (scope === "recording") {
        await VoiceNotes.setRecordingOptions({ identifySpeakers: on });
        acceptNativeOptions(await VoiceNotes.status());
      } else {
        await setDefaultIdentifySpeakers(on);
        preference = readTranscriberPreference();
        if (refreshChoice()) notify();
      }
      return "ok";
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOnSaved(next) {
      onSaved = next;
    },
    setOnPresent(next) {
      onPresent = next;
      if (next && presentWhenReady) { presentWhenReady = false; next(); }
    },
    attach() {
      const key = scope();
      if (!available) return () => {};
      setQuarantineAccount(tcw?.did ?? null);
      let attached = true;
      homeWorkDetached = false;
      attachment = {};
      noteAttached = true;
      if (noteId && noteStatus === "error" && !cancelNoteRetry) scheduleNoteRetry(noteId, noteLoadVersion);
      const unsubscribeNoteSync = subscribeRecordingNoteSync(notify);
      const recheckPermission = async () => {
        if (!attached || !state.permissionDenied) return;
        try {
          const status = await VoiceNotes.status();
          if (attached && status.microphonePermissionGranted) send({ type: "PERMISSION_GRANTED" });
        } catch (caught) {
          console.warn("[VoiceNotes] Could not recheck microphone permission", caught);
        }
      };
      const appActiveHandle = (subscribeAppActive
        ? subscribeAppActive(() => { void recheckPermission(); })
        : Capacitor.isNativePlatform()
          ? App.addListener("appStateChange", ({ isActive }) => { if (isActive) void recheckPermission(); })
          : null)?.catch((caught: unknown) => {
            console.warn("[VoiceNotes] Could not watch app activity", caught);
            return null;
          });
      if (key !== null) {
        for (const [id, issue] of Object.entries(savedPartialAudioIssues(key))) {
          if (!partialAudioDismissed(key, id)) send({ type: "CAPTURE_ISSUE", id, issue });
          committedIds.add(id);
          lostAudioIds.add(id);
        }
        for (const id of pendingAudioLossIds(key)) lostAudioIds.add(id);
      }
      const onCaptureDeleted = (event: Event) => {
        const id = (event as CustomEvent<{ id: string }>).detail?.id;
        if (id) { send({ type: "CAPTURE_RESOLVED", id }); committedIds.delete(id); lostAudioIds.delete(id); }
      };
      if (typeof window !== "undefined") window.addEventListener("exo:captureIssueDeleted", onCaptureDeleted);
      // A recording nobody owns (a closed recorder left it live) is this recorder's now, if it is idle and claims it.
      const onUnownedRecording = (id: string) => {
        if (state.phase !== "idle") return;
        void VoiceNotes.status().then((status) => {
          if (!attached || status.state === "idle" || status.id !== id) return;
          pickUp(status);
        }).catch((caught: unknown) => console.warn("[VoiceNotes] Could not pick up a recording left by a closed recorder", caught));
      };
      attachedRecorders.push(onUnownedRecording);
      const inspectSidecar = (id: string | undefined) => {
        if (!id) return;
        void VoiceNotes.listPending().then(({ recordings }) => {
          if (!attached) return;
          const sidecar = recordings.find((recording) => recording.id === id);
          if (sidecar && belongsToAccount(sidecar)) captureCommitted(id, sidecar);
        }).catch((caught: unknown) => console.warn("[VoiceNotes] Could not inspect committed capture spans", caught));
      };
      const unsubscribePreference = subscribeTranscriberPreference(() => {
        preference = readTranscriberPreference();
        if (refreshChoice()) notify();
      });
      const handles = [
        VoiceNotes.addListener("micState", (event) => {
          if (event.id && state.recordingId && event.id !== state.recordingId) return;
          acceptNativeOptions(event);
          sendMicState(event);
        }),
        VoiceNotes.addListener("level", (event) => {
          // Every capture engine emits linear RMS. Convert once at the boundary to the
          // perceptual 0..1 level shared by the halo, bars, trace, and activity gate.
          for (const listener of levelListeners) listener(levelFromAmplitude(event.sources?.mic.level ?? event.level));
          for (const listener of levelsListeners) listener(event);
        }),
        // Retained by the shell until heard, so a reload mid-recording still saves the note.
        VoiceNotes.addListener("autoStopped", onAutoStopped),
        // Retained events replay when each listener is added after a WebView reload.
        // Register failures before recovered/committed: retained native events replay
        // in listener order after a WebView reload, then commit preserves audio loss.
        VoiceNotes.addListener("recoveryFailed", (event) => {
          // The browser engine tells every attaching controller about every failed recording; only its owner sees it.
          if (event.owner != null && event.owner !== tcw?.did) return;
          send({ type: "CAPTURE_ISSUE", id: event.id ?? null,
            issue: { kind: "recoveryFailed", detail: event.reason ?? event.error ?? "recovery_failed" } });
        }),
        VoiceNotes.addListener("writeFailure", (event) => {
          if (dismissed(event.id)) return;
          lostAudioIds.add(event.id);
          const key = scope();
          if (key !== null) savePendingAudioLoss(key, event.id);
          if (state.captureIssues[event.id]?.kind === "partial_audio") return;
          send({ type: "CAPTURE_ISSUE", id: event.id,
            issue: committedIds.has(event.id) ? { kind: "partial_audio" } : { kind: "write_failed", detail: event.error } });
          const issue = state.captureIssues[event.id];
          if (key !== null && issue?.kind === "partial_audio") savePartialAudioIssue(key, event.id, issue);
        }),
        VoiceNotes.addListener("recovered", (event) => {
          const id = event.id ?? event.recording?.id;
          captureCommitted(id, event.recording);
          if (!event.recording) inspectSidecar(id);
        }),
        VoiceNotes.addListener("committed", (event) => {
          const id = event.id ?? event.recording?.id;
          if (id) endRecording(id);
          captureCommitted(id, event.recording);
          if (!event.recording) inspectSidecar(id);
        }),
        VoiceNotes.addListener("presentRecorder", async (event) => {
          if (event.reason === "permission_denied" && event.id === null) {
            const status = await VoiceNotes.status();
            if (attached && status.micDeniedPresentation) {
              send({ type: "PERMISSION_DENIED" });
              present();
            }
            return;
          }
          if (event.reason === "permission_granted" && event.id === null) {
            const status = await VoiceNotes.status();
            if (attached && !status.micDeniedPresentation && status.microphonePermissionGranted) {
              send({ type: "PERMISSION_GRANTED" });
              if (status.shortcutRecordPending && captureCapabilities().nativeShortcuts) {
                present();
                void VoiceNotes.consumeShortcutRecord().catch((caught: unknown) =>
                  console.warn("[VoiceNotes] Could not consume the shortcut Record offer", caught));
              }
            }
            return;
          }
          try {
            const status = await VoiceNotes.status();
            if (!attached || status.state === "idle" || status.id !== event.id) return;
            if (state.phase === "idle") pickUp(status);
            if (state.recordingId === status.id && state.phase === "recording") present();
          } catch (caught) {
            console.warn("[VoiceNotes] Could not present the native recording", caught);
          }
        }),
      ];
      // A WebView reload mid-recording still picks up the active native session.
      const reconcile = Promise.all(handles)
        .then(() => VoiceNotes.status())
        .then(
          (status) => {
            if (!attached) return;
            const capabilities = captureCapabilities();
            if (capabilities.micDeniedPresentation && status.micDeniedPresentation) {
              send({ type: "PERMISSION_DENIED" });
              present();
            } else if (capabilities.nativeShortcuts && status.shortcutRecordPending && status.microphonePermissionGranted) {
              send({ type: "PERMISSION_GRANTED" });
              present();
              void VoiceNotes.consumeShortcutRecord().catch((caught: unknown) =>
                console.warn("[VoiceNotes] Could not consume the shortcut Record offer", caught));
            }
            if (status.state === "idle") { sendMicState(status); return; }
            // Only a recording nobody else owns (another recorder's, or a closed recorder's being discarded, is not this one's).
            if (!pickUp(status)) return;
            sendMicState(status);
            if (status.source && status.source !== "in_app") present();
          },
          (caught: unknown) => console.warn("[VoiceNotes] Could not ask the recorder what is running", caught),
        )
        .catch((caught: unknown) => console.warn("[VoiceNotes] Native recorder status was incomplete", caught))
        .finally(() => {
          if (attached) send({ type: "RECONCILED" });
        });
      // The sidecar scan is best effort, after readiness. Unsupported or slow
      // listPending implementations cannot delay native status or the first Record.
      void reconcile.then(async () => {
        try {
          const { recordings } = await VoiceNotes.listPending();
          if (!attached) return;
          const visible = recordings.filter(belongsToAccount);
          const key = scope();
          if (key !== null) prunePartialAudioIssues(key, new Set(visible.map((recording) => recording.id)));
          for (const recording of visible) {
            if (partialFromSidecar(recording)) captureCommitted(recording.id, recording);
          }
        } catch (caught) { console.warn("[VoiceNotes] Could not inspect committed capture spans", caught); }
      }).catch((caught: unknown) => console.warn("[VoiceNotes] Could not attach capture scan", caught));
      return () => {
        attached = false;
        const listed = attachedRecorders.indexOf(onUnownedRecording);
        if (listed !== -1) attachedRecorders.splice(listed, 1);
        // Detached (signed out or unmounted): this recorder no longer holds anything at the Home work boundary itself.
        // A recording it owned is followed by a tracker with a place of its own (offered to the next recorder, never
        // discarded); a start still waiting (on the microphone) is cancelled and keeps this recorder's place until it
        // has ended (its recording, if it already claimed one, is handed over by record() itself).
        homeWorkDetached = true;
        if (ownedId !== null && ownedId !== pendingStart?.startedId) {
          const left = ownedId;
          disown();
          void trackDetachedRecording(left, false, holdHomeWork("recording"), endingControl);
        }
        if (pendingStart) {
          pendingStart.cancelled = true;
          pendingStart.release = homeWork;
          disown();
          pendingStart.signalCancelled();
        } else homeWork?.();
        homeWork = null;
        attachment = null;
        blockPlayback(playbackBlocker, false);
        noteAttached = false;
        clearNoteRetry();
        if (noteSyncTimer) {
          clearTimeout(noteSyncTimer);
          noteSyncTimer = null;
          if (noteAccount && noteClient && noteId) void syncRecordingNote(noteClient, noteId, checkNoteAccount).catch((error: unknown) =>
            console.warn("[VoiceNotes] Could not sync recording note", error));
        }
        if (typeof window !== "undefined") window.removeEventListener("exo:captureIssueDeleted", onCaptureDeleted);
        unsubscribePreference();
        unsubscribeNoteSync();
        if (appActiveHandle) void appActiveHandle.then((handle) => handle?.remove());
        for (const handle of handles) void handle.then((h) => h.remove());
      };
    },
    async record() {
      // Never before the recorder is reconciled, over a recording, or over a receipt still being shown.
      if (!available || !state.ready || nativeStopPending || state.phase !== "idle" || state.outcome !== null) return;
      // Refused while a Home re-authorise is in progress; admitted, it is reserved before anything awaits.
      const admitted = admitHomeWork("recording");
      if (!admitted) return;
      homeWork?.();
      homeWork = admitted;
      let signalCancelled = () => {};
      const whenCancelled = new Promise<void>((resolve) => { signalCancelled = resolve; });
      const attempt: PendingStart = { cancelled: false, release: null, whenCancelled, signalCancelled, startedId: null };
      pendingStart = attempt;
      // Set once a started recording is handed over (handOverCancelledStart), which then owns the place.
      let handedOver = false;
      stopAllPlayback();
      send({ type: "START_REQUESTED" });
      if (choice.id === "on-device") ensureLocalModel(true);
      // Settings' Stop recordings automatically: on, Stop recording after (never above the test override or the 3-hour limit); off, the silent 8-hour cap.
      const autoStop = autoStopNow();
      const requested = recordingLimitMs(autoStop, voiceNoteMaxDurationMs());
      try {
        // The recording starts from the engine's default: wait for any default write in flight, and refuse to start on one that could not be put right.
        await settleDefaults();
        if (attempt.cancelled) return;
        if (captureEngineKind() === "web" && typeof navigator !== "undefined")
          void navigator.storage?.persist?.().catch(() => undefined);
        const started = await VoiceNotes.start({ maxDurationMs: requested,
          uploadAudio: readUploadAudioPreference(),
          ...(!privateDiarization() ? { identifySpeakers: false } : {}) });
        attempt.startedId = started.id;
        if (attempt.cancelled) {
          // Detached while the microphone was being asked: the recording is handed to the recorder attached now.
          handedOver = true;
          handOverCancelledStart(started.id, attempt);
          return;
        }
        // Claimed before anything else awaits; another recorder that picked it up first keeps it.
        if (!own(started.id)) {
          send({ type: "RESET" });
          return;
        }
        const elapsedAt = Date.now();
        nativeOptions = null;
        // A detach while this read is still out hands the recording over at once, without waiting for the read.
        await Promise.race([
          VoiceNotes.status().then((status) => {
            if (!attempt.cancelled && status.id === started.id) acceptNativeOptions(status);
          }, (caught: unknown) => {
            if (!attempt.cancelled) console.warn("[VoiceNotes] Started, but recording options could not be read", caught);
          }),
          attempt.whenCancelled,
        ]);
        if (attempt.cancelled) {
          handedOver = true;
          handOverCancelledStart(started.id, attempt);
          return;
        }
        send({
          type: "STARTED",
          id: started.id,
          startedAt: started.startedAt,
          elapsedAt,
          maxDurationMs: typeof started.maxDurationMs === "number" ? started.maxDurationMs : requested,
          autoStop,
        });
      } catch (caught) {
        if (attempt.cancelled) return;
        send({ type: "START_FAILED", error: messageOf(caught) });
        if (errorCode(caught) === "permission_denied") {
          send({ type: "PERMISSION_DENIED" });
          present();
        }
      } finally {
        if (pendingStart === attempt) pendingStart = null;
        // A cancelled start that started nothing lets go of its place now; one that started a recording keeps it
        // until that recording is no longer live.
        if (!handedOver) attempt.release?.();
      }
    },
    async openSettings() {
      if (!captureCapabilities().openSettings) throw Object.assign(new Error("This shell cannot open settings"), { code: "unsupported" });
      await VoiceNotes.openSettings();
    },
    /** Present only where the engine can change a running recording's limit (web and desktop); native mobile fixes it at start. */
    get extendLimit() {
      if (typeof VoiceNotes.setMaxDuration !== "function") return undefined;
      return async (extension: LimitExtension = VOICE_NOTE_EXTENSION_MS) => {
        if (state.phase !== "recording" || !state.autoStop) return;
        const noLimit = extension === "none";
        const target = noLimit ? VOICE_NOTE_SAFETY_CAP_MS : Math.min(VOICE_NOTE_SAFETY_CAP_MS, state.maxDurationMs + extension);
        const applied = await VoiceNotes.setMaxDuration!({ maxDurationMs: target });
        send({ type: "LIMIT_EXTENDED", maxDurationMs: applied.maxDurationMs, ...(noLimit && applied.maxDurationMs >= VOICE_NOTE_SAFETY_CAP_MS ? { noLimit: true } : {}) });
      };
    },
    async dismissShortcutRecovery() {
      if (captureCapabilities().nativeShortcuts) {
        const status = await VoiceNotes.status();
        if (status.micDeniedPresentation !== undefined) await VoiceNotes.dismissShortcutRecovery();
      }
      send({ type: "PERMISSION_GRANTED" });
    },
    async stop() {
      // Stop waits for STARTED: the plugin cannot cancel a start in flight.
      if (state.phase === "stopping" && state.error) {
        await reconcileFailedStop(state.error, state.finalizationPendingId);
        return;
      }
      if (state.phase !== "recording") return;
      ++controlOperationId;
      nativeStopPending = true;
      send({ type: "STOP_REQUESTED", at: Date.now() });
      let recording: VoiceNoteRecording;
      try {
        const stopping = VoiceNotes.stop();
        endingControl = stopping;
        recording = await stopping.finally(() => { if (endingControl === stopping) endingControl = null; });
      } catch (caught) {
        // "not_recording": the limit stopped it first, and its "autoStopped" event saves it.
        const code = errorCode(caught);
        if (code === "finalization_timed_out") {
          send({ type: "CAPTURE_ISSUE", id: state.recordingId, issue: { kind: "finalization_timed_out" } });
        }
        const handledByNativeStatus = code === "not_recording" || code === "capture_snapshot_unavailable" || code === "no_audio_captured";
        await reconcileFailedStop(handledByNativeStatus ? null
          : code === "finalization_timed_out" ? FINALIZATION_PENDING
          : `Could not stop: ${messageOf(caught)}`, code === "finalization_timed_out" ? state.recordingId : null);
        return;
      } finally {
        nativeStopPending = false;
      }
      endRecording(recording.id);
      captureCommitted(recording.id, recording);
      void saveStopped(recording).catch((caught: unknown) =>
        send({ type: "SAVE_FAILED", error: messageOf(caught), recording: { id: recording.id, durationMs: recording.durationMs } }),
      );
    },
    async pause() {
      if (state.phase !== "recording" || state.controlPending || (state.mic.state !== "recording" && state.mic.state !== "silenced")) return;
      send({ type: "PAUSE_REQUESTED" });
      await runControl("pause");
    },
    async resume() {
      if (state.phase !== "recording" || state.controlPending || (state.mic.state !== "paused" && state.mic.state !== "interrupted" && state.mic.state !== "needs_user")) return;
      if (!homeWorkDetached) blockPlayback(playbackBlocker, true);
      stopAllPlayback();
      send({ type: "RESUME_REQUESTED" });
      await runControl("resume");
    },
    async discard() {
      if (state.phase === "discarding" && state.error) {
        await reconcileDiscardFailure(state.recordingId, state.error);
        return;
      }
      // Only a live recording: the plugin cannot cancel a start, and a stopped one is being saved.
      if (state.phase !== "recording") return;
      // The recording on screen: the discard's events carry its id, as the save events do.
      const shown = state.recordingId;
      send({ type: "DISCARD_REQUESTED", id: shown });
      // Marked before stop(): from then on a pending run, the limit's "autoStopped" save,
      // or a relaunch after the app is killed deletes this recording instead of saving it.
      if (shown) markDiscarded(shown);
      let id = shown;
      let needDeleteCommitted = false;
      try {
        // By its id where the engine can: refused, rather than discarding another recording, if this one ended first.
        const discarding = VoiceNotes.discard(captureCapabilities().scopedDiscard && shown ? { id: shown } : undefined);
        endingControl = discarding;
        const discarded = await discarding.finally(() => { if (endingControl === discarding) endingControl = null; });
        if (shown) endRecording(shown);
        if (discarded.id) endRecording(discarded.id);
        if (discarded.id && discarded.id !== id) {
          if (shown) unmarkDiscarded(shown);
          id = discarded.id;
          markDiscarded(id);
        }
      } catch (caught) {
        // not_recording / recording_changed: the limit stopped it first, and its save meets the mark.
        // no_audio_captured: the phone kept nothing.
        const code = errorCode(caught) === "recording_changed" ? "not_recording" : errorCode(caught);
        if (shown && (code === "already_committed" || code === "not_recording" || code === "no_audio_captured")) endRecording(shown);
        if (code === "already_committed") {
          if (shown) unmarkDiscarded(shown);
          await reconcileDiscardFailure(shown, `Already saved on this ${recorderDevice()}. The note is still available.`);
          return;
        }
        if (code !== "not_recording" && code !== "no_audio_captured") {
          if (shown) unmarkDiscarded(shown);
          if (id && id !== shown) unmarkDiscarded(id);
          await reconcileDiscardFailure(shown, `Could not discard the recording: ${messageOf(caught)}`);
          return;
        }
        needDeleteCommitted = code === "not_recording";
      }
      if (!id) {
        if (shown) unmarkDiscarded(shown);
        await reconcileDiscardFailure(shown, "Could not discard the recording.");
        return;
      }
      if (needDeleteCommitted) {
        const cleanupError = await deleteDiscarded(id);
        if (cleanupError) {
          send({ type: "DISCARD_FAILED", id: shown, error: cleanupError, committed: true });
          void pendingStore.refresh(cleanupError);
          return;
        }
      } else {
        try { await deleteNote(id); }
        catch (caught) {
          send({ type: "DISCARD_FAILED", id: shown, error: `Could not delete the recording note: ${messageOf(caught)}`, committed: true });
          return;
        }
        clearDiscarded(id);
        if (shown && shown !== id) clearDiscarded(shown);
      }
      send({ type: "DISCARDED", id: shown });
      if (id) {
        if (tcw?.did) pruneDeletedFailureNotification(tcw.did, id);
        captureEvents.emit("note-deleted", { source: "exo-voice-note", sourceId: id });
        send({ type: "CAPTURE_RESOLVED", id });
        const key = scope();
        if (key !== null) clearPartialAudioIssue(key, id);
        committedIds.delete(id); lostAudioIds.delete(id);
      }
    },
    retryPending() {
      if (retryPendingInFlight) return retryPendingInFlight;
      const run = async () => {
        if (!available) return;
        if (!tcw?.did || !tcw.spaceId) {
          pendingStore.reportError("Your account space is not ready to save this note. Try again after sign-in finishes.");
          return;
        }
        if (pipeline) {
          const finishSaving = pendingStore.beginManualSave();
          const account = pendingStore.forAccount(tcw.did);
          const generation = currentAccountGeneration();
          try {
            // The same generation can claim a v2 note left unowned during sign-in.
            const claimed = await withCaptureDeadline(writeAccountDefaults((native) =>
              native.status === "signed_in" && native.accountDid === tcw.did
                ? { accountDid: native.accountDid, transitionGen: native.transitionGen } : null));
            if (!claimed) {
              account.reportError(`This ${recorderDevice()}'s recording account is not ready. Try again shortly.`);
              return;
            }
            if (generation !== currentAccountGeneration()) {
              account.reportError("The recording account changed while saving. Try again from the current account.");
              return;
            }
            pipeline.resume();
            // The pipeline announces each save to the Library itself, so onSaved is not called here.
            await pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation }, "manual", (recording) => {
              if (transcriber) transcribeSavedNote(transcriber, recording, () => generation === currentAccountGeneration());
            });
            await account.refresh(null);
          } catch (caught) {
            account.reportError(pendingSaveMessage(caught));
          } finally { finishSaving(); }
          return;
        }
        const account = pendingStore.forAccount(tcw.did);
        const generation = currentAccountGeneration();
        let savedRun;
        try {
          savedRun = await savePendingRecordings(tcw);
        } catch (caught) {
          account.reportError(pendingSaveMessage(caught));
          return;
        }
        for (const recording of savedRun.saved) landed(generation, recording);
        // The note behind a "Kept on this phone" receipt is in the space now: the receipt says so.
        const failed = state.failedRecording;
        const saved = failed && state.outcome === "failed"
          ? savedRun.saved.find((recording) => recording.id === failed.id) : undefined;
        if (saved) {
          send({ type: "SAVED", id: saved.id, durationMs: saved.durationMs, channels: saved.channels, at: Date.now() });
        }
      };
      const inFlight = run().finally(() => { if (retryPendingInFlight === inFlight) retryPendingInFlight = null; });
      retryPendingInFlight = inFlight;
      return inFlight;
    },
    dismissOutcome() {
      send({ type: "DISMISSED" });
    },
    dismissCaptureIssue(id) {
      if (state.captureIssues[id]?.kind !== "partial_audio") return false;
      const key = scope();
      if (key === null || !dismissPartialAudioIssue(key, id)) return false;
      send({ type: "CAPTURE_DISMISSED", id });
      return true;
    },
    subscribeLevel(listener) {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
    subscribeLevels(listener) {
      levelsListeners.add(listener);
      return () => { levelsListeners.delete(listener); };
    },
  };
}
