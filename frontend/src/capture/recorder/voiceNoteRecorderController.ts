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

import {
  VoiceNotes,
  voiceNoteMaxDurationMs,
  type VoiceNoteAutoStopEvent,
  type VoiceNoteRecording,
  type CaptureStatus,
  type MicStateEvent,
  type CaptureOptions,
  type TranscriberId,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { isOnDeviceReady } from "@/lib/voiceNotes/onDeviceStt";
import { setQuarantineAccount } from "@/lib/voiceNotes/quarantine";
import { onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { effectiveCaptureOptions, readTranscriberPreference, setDefaultIdentifySpeakers,
  setDefaultTranscriber, subscribeTranscriberPreference } from "@/lib/voiceNotes/transcriberPreference";
import {
  clearDiscarded,
  deleteDiscarded,
  errorCode,
  markDiscarded,
  messageOf,
  pendingStore,
  saveRecording,
  savePendingRecordings,
} from "@/lib/voiceNotes/recorderSaves";
import type { VoiceNoteTranscriber } from "@/lib/voiceNotes/voiceNoteTranscription";
import { saveDeferredForAccountTransition, type VoiceNotePipeline } from "@/lib/voiceNotes/voiceNotePipeline";
import { adoptNote, deleteNote, loadNote, parseMomentLines, saveNote, type RecordingMoment } from "@/lib/voiceNotes/recordingNotes";
import { readRecordingNoteFromSpace, recordingNoteSyncError, reportRecordingNoteSyncError,
  subscribeRecordingNoteSync, syncRecordingNote, type NoteSyncErrorCode } from "@/lib/voiceNotes/voiceNoteStore";
import { assertCurrent, currentAccountGeneration } from "@/lib/voiceNotes/accountContext";
import { FINALIZATION_PENDING, limitNoticeText } from "./recorderCopy";
import { autoStopIsCurrent, initialRecorderState, recorderReducer, type RecorderCaptureIssue, type RecorderEvent, type RecorderMic, type RecorderState } from "./recorderReducer";
import { recordedElapsedAt } from "./recordedElapsed";
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

export interface VoiceNoteRecorderControllerOptions {
  tcw: TinyCloudWeb | null;
  pipeline?: VoiceNotePipeline | null;
  /** The Exo mobile app with its VoiceNotes plugin; nothing else records. */
  available: boolean;
  /** Private cloud transcription for this account; null without one. */
  transcriber: Pick<VoiceNoteTranscriber, "noteSaved"> & Partial<Pick<VoiceNoteTranscriber, "snapshot">> | null;
  /** Test seam for model readiness; production reads the shared native STT snapshot. */
  onDeviceReady?: () => boolean;
  appleInterim?: () => boolean;
  /** Delayed/failing local reads can be exercised without changing the phone's storage adapter. */
  noteLoader?: typeof loadNote;
  /** Test clock for note-load retries; production uses setTimeout. */
  noteRetryScheduler?: (delayMs: number, retry: () => void) => () => void;
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
  setTranscriber(id: TranscriberId, options: { scope: TranscriberChoiceScope; waitForModel?: boolean }): Promise<TranscriberChoiceResult>;
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
  dismissShortcutRecovery(): Promise<void>;
  /** The receipt was read. */
  dismissOutcome(): void;
  /** Only a saved recording's partial-audio notice can be dismissed. */
  dismissCaptureIssue(id: string): void;
  /** Input levels (0..1), fanned out without React state. */
  subscribeLevel(listener: (level: number) => void): () => void;
}

export function createVoiceNoteRecorderController({ tcw, available, transcriber, pipeline, onDeviceReady,
  appleInterim, noteLoader = loadNote, noteRetryScheduler = (delayMs, retry) => {
    const timer = setTimeout(retry, delayMs);
    return () => clearTimeout(timer);
  } }: VoiceNoteRecorderControllerOptions): VoiceNoteRecorderController {
  let state = initialRecorderState;
  let preference = readTranscriberPreference();
  let nativeOptions: CaptureOptions | null = null;
  const signedIn = tcw?.did != null;
  const defaultChoice = (): RecorderTranscriberChoice => {
    const options = effectiveCaptureOptions(preference, signedIn);
    return { id: options.transcriber, identifySpeakers: options.identifySpeakers, source: "default" };
  };
  let choice = defaultChoice();
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
  const listeners = new Set<() => void>();
  const levelListeners = new Set<(level: number) => void>();
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
  const currentNoteId = () => state.recordingId ?? state.lastSaved?.id ?? null;
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
      noteLoadError = error instanceof Error ? error : new Error(String(error));
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
    const live = state.phase === "recording" && state.recordingId !== null && nativeOptions !== null;
    const next: RecorderTranscriberChoice = live
      ? { id: nativeOptions!.transcriber, identifySpeakers: nativeOptions!.identifySpeakers, source: "recording" }
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

  // The reducer runs synchronously, so a second tap sees the phase the first one
  // set (Stop must never call stop() twice).
  const send = (event: RecorderEvent) => {
    const before = state;
    const next = recorderReducer(state, event);
    if (next === state) return;
    state = next;
    refreshChoice();
    followNote(next.outcome === "saved" && before.outcome !== "saved" && note === null && noteStatus === "ready");
    notify();
  };

  const sendMicState = (status: CaptureStatus | MicStateEvent) => {
    const event = { type: "MIC_STATE" as const, mic: micFromStatus(status), audioMs: status.audioMs };
    send(status.elapsedMs === undefined ? event : { ...event, elapsedMs: status.elapsedMs, elapsedAt: Date.now() });
  };

  const activePickup = (status: Awaited<ReturnType<typeof VoiceNotes.status>>): Extract<RecorderEvent, { type: "PICKED_UP" }> => {
    if (!status.id || status.startedAt === null) throw new Error("Native recording status has no active id or start time");
    return { type: "PICKED_UP", id: status.id, startedAt: status.startedAt,
      maxDurationMs: status.maxDurationMs, audioMs: status.audioMs, elapsedMs: status.elapsedMs, elapsedAt: Date.now(),
      mic: micFromStatus(status) };
  };

  const reconcileFailedStop = async (error: string | null, id?: string | null) => {
    try {
      const status = await VoiceNotes.status();
      if (state.phase !== "stopping") return;
      if (status.state === "idle") {
        send({ type: "STOP_FAILED", status: "idle", error, id });
        void pendingStore.refresh();
      } else if (status.id === state.recordingId) {
        acceptNativeOptions(status);
        send({ type: "STOP_FAILED", status: "active", error, id,
          mic: micFromStatus(status), audioMs: status.audioMs, elapsedMs: status.elapsedMs, elapsedAt: Date.now() });
      } else {
        send({ type: "STOP_FAILED", status: "idle", error: error ?? "Another recording is active on this phone.", id });
        acceptNativeOptions(status);
        send(activePickup(status));
      }
    } catch (caught) {
      send({ type: "STOP_FAILED", status: "unknown", error: `Could not check whether this phone stopped recording: ${messageOf(caught)}`, id });
    }
  };

  const reconcileDiscardFailure = async (shown: string | null, error: string) => {
    try {
      const status = await VoiceNotes.status();
      if (state.phase !== "discarding") return;
      if (status.state === "idle") {
        send({ type: "DISCARD_FAILED", id: shown, committed: true,
          error: `${error} The recording ended; its audio remains on this phone.` });
        void pendingStore.refresh();
      } else if (status.id === shown) {
        acceptNativeOptions(status);
        send({ type: "DISCARD_FAILED", id: shown, error });
        sendMicState(status);
      } else {
        send({ type: "DISCARD_FAILED", id: shown, committed: true, error });
        acceptNativeOptions(status);
        send(activePickup(status));
      }
    } catch (caught) {
      send({ type: "DISCARD_FAILED", id: shown, uncertain: true,
        error: `${error} Could not check whether recording continues: ${messageOf(caught)}` });
    }
  };

  const landed = (recording: VoiceNoteRecording, audio?: Parameters<VoiceNoteTranscriber["noteSaved"]>[1]) => {
    transcriber?.noteSaved(recording, audio);
    onSaved?.(recording);
  };

  /** A native commit is enough for the receipt; cloud work follows independently. */
  const saveStopped = async (recording: VoiceNoteRecording) => {
    send({ type: "LOCAL_COMMITTED", id: recording.id, durationMs: recording.durationMs, at: Date.now() });
    void pendingStore.refresh();
    if (!tcw || (pipeline && !pipeline.isAccepting())) {
      send({ type: "LOCAL_UPLOAD_HELD", id: recording.id });
      return;
    }
    if (pipeline) {
      if (recording.owner !== tcw.did || !tcw.did || !tcw.spaceId) {
        send({ type: "LOCAL_UPLOAD_HELD", id: recording.id });
        return;
      }
      try {
        await pipeline.process({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() }, recording.id);
        send({ type: "SAVED", id: recording.id, durationMs: recording.durationMs, at: Date.now() });
        landed(recording);
      } catch (caught) {
        if (!pipeline.isAccepting() || saveDeferredForAccountTransition(caught)) {
          send({ type: "LOCAL_UPLOAD_HELD", id: recording.id });
          void pendingStore.refresh();
          return;
        }
        send({ type: "SAVE_FAILED", error: `Saved on this phone, but uploading to your space failed: ${messageOf(caught)}`,
          recording: { id: recording.id, durationMs: recording.durationMs } });
      }
      void pendingStore.refresh();
      return;
    }
    send({ type: "SAVE_PROGRESS", percent: null });
    const outcome = await saveRecording(tcw, recording, (stored, total) => {
      if (total > 0) send({ type: "SAVE_PROGRESS", percent: Math.floor((stored / total) * 100) });
    });
    switch (outcome.kind) {
      case "saved":
        reportSavedNoteSyncError(recording.id, outcome.noteSyncError);
        send({ type: "SAVED", id: recording.id, durationMs: recording.durationMs, at: Date.now() });
        landed(recording, outcome.audio ?? undefined);
        void pendingStore.refresh(outcome.cleanupError);
        return;
      case "failed":
        // The committed audio stays on the device and is playable.
        send({
          type: "SAVE_FAILED",
          error: `Saved on this phone, but uploading to your space failed: ${outcome.failure}`,
          recording: { id: recording.id, durationMs: recording.durationMs },
        });
        void pendingStore.refresh(outcome.failure);
        return;
      case "already-saved":
        send({ type: "SAVED", id: recording.id, durationMs: recording.durationMs, at: Date.now() });
        void pendingStore.refresh(outcome.cleanupError);
        return;
      case "discarded":
        void pendingStore.refresh(outcome.cleanupError);
        send({ type: "RESET" });
        return;
      case "held":
        send({ type: "LOCAL_UPLOAD_HELD", id: recording.id });
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
    if (!tcw || (pipeline && !pipeline.isAccepting())) { void pendingStore.refresh(); return; }
    if (pipeline) {
      if (recording.owner === tcw.did && tcw.did && tcw.spaceId) {
        try {
          await pipeline.process({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() }, recording.id);
          landed(recording);
        } catch (caught) {
          if (!saveDeferredForAccountTransition(caught) && pipeline.isAccepting()) throw caught;
        }
      }
      void pendingStore.refresh();
      return;
    }
    const outcome = await saveRecording(tcw, recording);
    if (outcome.kind === "saved") reportSavedNoteSyncError(recording.id, outcome.noteSyncError);
    if (outcome.kind === "saved") landed(recording, outcome.audio ?? undefined);
    if (outcome.kind === "failed") void pendingStore.refresh(outcome.failure);
    else if (outcome.kind === "already-saved" || outcome.kind === "discarded") void pendingStore.refresh(outcome.cleanupError ?? undefined);
    else if (outcome.kind === "held") void pendingStore.refresh();
  };

  const onAutoStopped = (event: VoiceNoteAutoStopEvent) => {
    const recording = event.recording;
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
    send({ type: "AUTO_STOPPED", id: recording?.id ?? null, notice: limitNoticeText(event.maxDurationMs),
      captured: recording !== null, at: Date.now(), elapsedMs: finalElapsed, error: event.error,
      pendingId: event.error === "finalization_timed_out" ? event.id ?? state.recordingId : null });
    if (!recording) return;
    void saveStopped(recording).catch((caught: unknown) =>
      send({ type: "SAVE_FAILED", error: messageOf(caught), recording: { id: recording.id, durationMs: recording.durationMs } }),
    );
  };

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
    async setTranscriber(id, { scope, waitForModel = false }) {
      if (!available || id === "assemblyai") return "unavailable";
      if (id === "on-device" && !captureCapabilities().localTranscription) return "unavailable";
      if (!signedIn && id !== "on-device") return "locked_signed_out";
      if (id === "on-device" && !waitForModel && !(onDeviceReady?.() ?? isOnDeviceReady(onDeviceSttStore.snapshot())))
        return "unavailable";
      if (id === "private-cloud") {
        const snapshot = transcriber?.snapshot?.();
        if (!snapshot?.consented) return "needs_consent";
        if (snapshot.availability !== "available") return "unavailable";
      }
      if (scope === "recording") {
        if (state.phase !== "recording" || !state.recordingId) return "unavailable";
        const identifySpeakers = id === "on-device" && !(appleInterim?.() ?? onDeviceSttStore.snapshot().engine === "apple-speech")
          ? preference.identifySpeakers : false;
        await VoiceNotes.setRecordingOptions({ transcriber: id, identifySpeakers });
        acceptNativeOptions(await VoiceNotes.status());
      } else {
        await setDefaultTranscriber(id);
        preference = readTranscriberPreference();
        if (refreshChoice()) notify();
      }
      return "ok";
    },
    async setIdentifySpeakers(on, scope) {
      if (!available) return "unavailable";
      const id = scope === "recording" ? choice.id : effectiveCaptureOptions(preference, signedIn).transcriber;
      if (scope === "recording" && (state.phase !== "recording" || choice.source !== "recording")) return "unavailable";
      if (id !== "on-device" && id !== "assemblyai") return "unavailable";
      if (id === "on-device" && !captureCapabilities().localTranscription) return "unavailable";
      if (id === "assemblyai" || (id === "on-device" && (appleInterim?.() ?? onDeviceSttStore.snapshot().engine === "apple-speech")))
        return "unavailable";
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
    },
    attach() {
      const key = scope();
      if (!available) return () => {};
      setQuarantineAccount(tcw?.did ?? null);
      let attached = true;
      noteAttached = true;
      if (noteId && noteStatus === "error" && !cancelNoteRetry) scheduleNoteRetry(noteId, noteLoadVersion);
      const unsubscribeNoteSync = subscribeRecordingNoteSync(notify);
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
          for (const listener of levelListeners) listener(event.level);
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
          captureCommitted(id, event.recording);
          if (!event.recording) inspectSidecar(id);
        }),
        VoiceNotes.addListener("presentRecorder", async (event) => {
          if (event.reason === "permission_denied" && event.id === null) {
            const status = await VoiceNotes.status();
            if (attached && status.micDeniedPresentation) {
              send({ type: "PERMISSION_DENIED" });
              onPresent?.();
            }
            return;
          }
          if (event.reason === "permission_granted" && event.id === null) {
            const status = await VoiceNotes.status();
            if (attached && !status.micDeniedPresentation && status.microphonePermissionGranted) {
              send({ type: "PERMISSION_GRANTED" });
              if (status.shortcutRecordPending && captureCapabilities().nativeShortcuts) {
                onPresent?.();
                void VoiceNotes.consumeShortcutRecord().catch((caught: unknown) =>
                  console.warn("[VoiceNotes] Could not consume the shortcut Record offer", caught));
              }
            }
            return;
          }
          try {
            const status = await VoiceNotes.status();
            if (!attached || status.state === "idle" || status.id !== event.id) return;
            if (state.phase === "idle") {
              send(activePickup(status));
            }
            if (state.recordingId === status.id && state.phase === "recording") onPresent?.();
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
              onPresent?.();
            } else if (capabilities.nativeShortcuts && status.shortcutRecordPending && status.microphonePermissionGranted) {
              send({ type: "PERMISSION_GRANTED" });
              onPresent?.();
              void VoiceNotes.consumeShortcutRecord().catch((caught: unknown) =>
                console.warn("[VoiceNotes] Could not consume the shortcut Record offer", caught));
            }
            if (status.state === "idle") return;
            acceptNativeOptions(status);
            send(activePickup(status));
            if (status.source === "app_shortcut" || status.source === "notification") onPresent?.();
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
        for (const handle of handles) void handle.then((h) => h.remove());
      };
    },
    async record() {
      // Never before the recorder is reconciled, over a recording, or over a receipt still being shown.
      if (!available || !state.ready || state.phase !== "idle" || state.outcome !== null) return;
      send({ type: "START_REQUESTED" });
      const requested = voiceNoteMaxDurationMs();
      try {
        const started = await VoiceNotes.start({ maxDurationMs: requested });
        const elapsedAt = Date.now();
        nativeOptions = null;
        try {
          const status = await VoiceNotes.status();
          if (status.id === started.id) acceptNativeOptions(status);
        } catch (caught) {
          console.warn("[VoiceNotes] Started, but recording options could not be read", caught);
        }
        send({
          type: "STARTED",
          id: started.id,
          startedAt: started.startedAt,
          elapsedAt,
          maxDurationMs: typeof started.maxDurationMs === "number" ? started.maxDurationMs : requested,
        });
      } catch (caught) {
        send({ type: "START_FAILED", error: messageOf(caught) });
        if (errorCode(caught) === "permission_denied") {
          send({ type: "PERMISSION_DENIED" });
          onPresent?.();
        }
      }
    },
    async openSettings() {
      if (!captureCapabilities().openSettings) throw Object.assign(new Error("This shell cannot open settings"), { code: "unsupported" });
      await VoiceNotes.openSettings();
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
      send({ type: "STOP_REQUESTED", at: Date.now() });
      let recording: VoiceNoteRecording;
      try {
        recording = await VoiceNotes.stop();
      } catch (caught) {
        // "not_recording": the limit stopped it first, and its "autoStopped" event saves it.
        const code = errorCode(caught);
        if (code === "finalization_timed_out") {
          send({ type: "CAPTURE_ISSUE", id: state.recordingId, issue: { kind: "finalization_timed_out" } });
        }
        await reconcileFailedStop(code === "not_recording" ? null
          : code === "finalization_timed_out" ? FINALIZATION_PENDING
          : `Could not stop: ${messageOf(caught)}`, code === "finalization_timed_out" ? state.recordingId : null);
        return;
      }
      captureCommitted(recording.id, recording);
      void saveStopped(recording).catch((caught: unknown) =>
        send({ type: "SAVE_FAILED", error: messageOf(caught), recording: { id: recording.id, durationMs: recording.durationMs } }),
      );
    },
    async pause() {
      if (state.phase !== "recording" || state.controlPending || (state.mic.state !== "recording" && state.mic.state !== "silenced")) return;
      send({ type: "PAUSE_REQUESTED" });
      try {
        await VoiceNotes.pause();
      } catch (caught) {
        send({ type: "PAUSE_FAILED", error: `Could not pause: ${messageOf(caught)}` });
        return;
      }
      try {
        const status = await VoiceNotes.status();
        acceptNativeOptions(status);
        sendMicState(status);
      } catch (caught) {
        console.warn("[VoiceNotes] Pause succeeded, but status could not be read", caught);
        send({ type: "MIC_STATE", mic: { state: "paused", reason: "user" } });
      }
      send({ type: "PAUSE_CONFIRMED" });
    },
    async resume() {
      if (state.phase !== "recording" || state.controlPending || (state.mic.state !== "paused" && state.mic.state !== "interrupted" && state.mic.state !== "needs_user")) return;
      send({ type: "RESUME_REQUESTED" });
      try {
        await VoiceNotes.resume();
      } catch (caught) {
        send({ type: "RESUME_FAILED", error: `Could not resume: ${messageOf(caught)}` });
        return;
      }
      try {
        const status = await VoiceNotes.status();
        acceptNativeOptions(status);
        sendMicState(status);
      } catch (caught) {
        console.warn("[VoiceNotes] Resume succeeded, but status could not be read", caught);
        send({ type: "MIC_STATE", mic: { state: "recording", reason: null } });
      }
      send({ type: "RESUME_CONFIRMED" });
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
        const discarded = await VoiceNotes.discard();
        if (discarded.id && discarded.id !== id) {
          if (shown) clearDiscarded(shown);
          id = discarded.id;
          markDiscarded(id);
        }
      } catch (caught) {
        // not_recording: the limit stopped it first, and its save meets the mark.
        // no_audio_captured: the phone kept nothing.
        const code = errorCode(caught);
        if (code === "already_committed") {
          if (shown) clearDiscarded(shown);
          await reconcileDiscardFailure(shown, "Already saved on this phone. The note is still available.");
          return;
        }
        if (code !== "not_recording" && code !== "no_audio_captured") {
          if (shown) clearDiscarded(shown);
          if (id && id !== shown) clearDiscarded(id);
          await reconcileDiscardFailure(shown, `Could not discard the recording: ${messageOf(caught)}`);
          return;
        }
        needDeleteCommitted = code === "not_recording";
      }
      if (!id) {
        if (shown) clearDiscarded(shown);
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
        send({ type: "CAPTURE_RESOLVED", id });
        const key = scope();
        if (key !== null) clearPartialAudioIssue(key, id);
        committedIds.delete(id); lostAudioIds.delete(id);
      }
    },
    async retryPending() {
      if (!available) return;
      if (pipeline && pipeline.isAccepting() && tcw?.did && tcw.spaceId) {
        try { await pipeline.reconcileAll({ did: tcw.did, spaceId: tcw.spaceId, generation: currentAccountGeneration() }); }
        catch (caught) { console.warn("[VoiceNotes] Saving notes left on this phone failed", caught); }
        await pendingStore.refresh();
        return;
      }
      let run;
      try {
        if (!tcw) { await pendingStore.refresh(); return; }
        run = await savePendingRecordings(tcw);
      } catch (caught) {
        console.warn("[VoiceNotes] Saving notes left on this phone failed", caught);
        return;
      }
      for (const recording of run.saved) landed(recording);
      // The note behind a "Kept on this phone" receipt is in the space now: the receipt says so.
      const failed = state.failedRecording;
      if (failed && state.outcome === "failed" && run.saved.some((recording) => recording.id === failed.id)) {
        send({ type: "SAVED", id: failed.id, durationMs: failed.durationMs, at: Date.now() });
      }
    },
    dismissOutcome() {
      send({ type: "DISMISSED" });
    },
    dismissCaptureIssue(id) {
      if (state.captureIssues[id]?.kind !== "partial_audio") return;
      const key = scope();
      if (key !== null && dismissPartialAudioIssue(key, id)) send({ type: "CAPTURE_DISMISSED", id });
    },
    subscribeLevel(listener) {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
  };
}
