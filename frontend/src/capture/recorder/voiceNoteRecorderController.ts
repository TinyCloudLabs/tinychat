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
} from "@/lib/voiceNotes/nativeVoiceNotes";
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
import { limitNoticeText } from "./recorderCopy";
import { autoStopIsCurrent, initialRecorderState, recorderReducer, type RecorderEvent, type RecorderState } from "./recorderReducer";

export interface VoiceNoteRecorderControllerOptions {
  tcw: TinyCloudWeb;
  /** The Exo mobile app with its VoiceNotes plugin; nothing else records. */
  available: boolean;
  /** Private cloud transcription for this account; null without one. */
  transcriber: Pick<VoiceNoteTranscriber, "noteSaved"> | null;
}

export interface VoiceNoteRecorderController {
  getState(): RecorderState;
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
  /** The receipt was read. */
  dismissOutcome(): void;
  /** Input levels (0..1), fanned out without React state. */
  subscribeLevel(listener: (level: number) => void): () => void;
}

export function createVoiceNoteRecorderController({ tcw, available, transcriber }: VoiceNoteRecorderControllerOptions): VoiceNoteRecorderController {
  let state = initialRecorderState;
  let onSaved: ((recording: VoiceNoteRecording) => void) | undefined;
  let onPresent: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const levelListeners = new Set<(level: number) => void>();

  // The reducer runs synchronously, so a second tap sees the phase the first one
  // set (Stop must never call stop() twice).
  const send = (event: RecorderEvent) => {
    const next = recorderReducer(state, event);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const landed = (recording: VoiceNoteRecording, audio?: Parameters<VoiceNoteTranscriber["noteSaved"]>[1]) => {
    transcriber?.noteSaved(recording, audio);
    onSaved?.(recording);
  };

  /** A native commit is enough for the receipt; cloud work follows independently. */
  const saveStopped = async (recording: VoiceNoteRecording) => {
    send({ type: "LOCAL_COMMITTED", id: recording.id, durationMs: recording.durationMs, at: Date.now() });
    void pendingStore.refresh();
    send({ type: "SAVE_PROGRESS", percent: null });
    const outcome = await saveRecording(tcw, recording, (stored, total) => {
      if (total > 0) send({ type: "SAVE_PROGRESS", percent: Math.floor((stored / total) * 100) });
    });
    switch (outcome.kind) {
      case "saved":
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
        void pendingStore.refresh();
        return;
      case "in-flight":
        // Another run is uploading it; keep the local receipt visible.
        return;
    }
  };

  /**
   * Save another recording than the one on screen (a retained auto-stop from before
   * a reload) without touching the recorder's state: it lands, or stays on the phone
   * and is counted there.
   */
  const saveInBackground = async (recording: VoiceNoteRecording) => {
    const outcome = await saveRecording(tcw, recording);
    if (outcome.kind === "saved") landed(recording, outcome.audio ?? undefined);
    if (outcome.kind === "failed") void pendingStore.refresh(outcome.failure);
    else if (outcome.kind === "already-saved" || outcome.kind === "discarded") void pendingStore.refresh(outcome.cleanupError ?? undefined);
    else if (outcome.kind === "held") void pendingStore.refresh();
  };

  const onAutoStopped = (event: VoiceNoteAutoStopEvent) => {
    const recording = event.recording;
    if (recording && state.phase === "idle" && state.lastSaved?.id === recording.id) return;
    if (!autoStopIsCurrent(state, recording?.id ?? null)) {
      if (recording) void saveInBackground(recording);
      return;
    }
    send({ type: "AUTO_STOPPED", id: recording?.id ?? null, notice: limitNoticeText(event.maxDurationMs), captured: recording !== null });
    if (!recording) return;
    void saveStopped(recording).catch((caught: unknown) =>
      send({ type: "SAVE_FAILED", error: messageOf(caught), recording: { id: recording.id, durationMs: recording.durationMs } }),
    );
  };

  return {
    getState: () => state,
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
      if (!available) return () => {};
      let attached = true;
      const handles = [
        VoiceNotes.addListener("micState", (event) => {
          if (event.id && state.recordingId && event.id !== state.recordingId) return;
          send({ type: "MIC_STATE", mic: { state: event.state, reason: event.reason }, audioMs: event.audioMs });
        }),
        VoiceNotes.addListener("level", (event) => {
          for (const listener of levelListeners) listener(event.level);
        }),
        // Retained by the shell until heard, so a reload mid-recording still saves the note.
        VoiceNotes.addListener("autoStopped", onAutoStopped),
        VoiceNotes.addListener("presentRecorder", async (event) => {
          try {
            const status = await VoiceNotes.status();
            if (!attached || status.state === "idle" || !status.id || status.id !== event.id) return;
            if (state.phase === "idle") {
              send({ type: "PICKED_UP", id: status.id, startedAt: status.startedAt ?? Date.now() - status.elapsedMs,
                maxDurationMs: status.maxDurationMs, audioMs: status.audioMs, mic: { state: status.state, reason: status.reason } });
            }
            if (state.recordingId === status.id && state.phase === "recording") onPresent?.();
          } catch (caught) {
            console.warn("[VoiceNotes] Could not present the native recording", caught);
          }
        }),
      ];
      // Once the listeners are in (the shell hands them its retained events as they
      // attach), ask what is running: a WebView reload mid-recording, or a recording
      // started offline, leaves the native recorder running. Record waits for both.
      void Promise.all(handles)
        .then(() => VoiceNotes.status())
        .then(
          (status) => {
            if (!attached || status.state === "idle") return;
            send({
              type: "PICKED_UP",
              id: status.id,
              startedAt: status.startedAt ?? Date.now() - status.elapsedMs,
              maxDurationMs: status.maxDurationMs,
              audioMs: status.audioMs,
              mic: { state: status.state, reason: status.reason },
            });
          },
          (caught: unknown) => console.warn("[VoiceNotes] Could not ask the recorder what is running", caught),
        )
        .finally(() => {
          if (attached) send({ type: "RECONCILED" });
        });
      return () => {
        attached = false;
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
        send({
          type: "STARTED",
          id: started.id,
          startedAt: started.startedAt,
          maxDurationMs: typeof started.maxDurationMs === "number" ? started.maxDurationMs : requested,
        });
      } catch (caught) {
        send({ type: "START_FAILED", error: messageOf(caught) });
      }
    },
    async stop() {
      // Stop waits for STARTED: the plugin cannot cancel a start in flight.
      if (state.phase !== "recording") return;
      send({ type: "STOP_REQUESTED" });
      let recording: VoiceNoteRecording;
      try {
        recording = await VoiceNotes.stop();
      } catch (caught) {
        // "not_recording": the limit stopped it first, and its "autoStopped" event saves it.
        send({ type: "STOP_FAILED", error: errorCode(caught) === "not_recording" ? null : messageOf(caught) });
        return;
      }
      void saveStopped(recording).catch((caught: unknown) =>
        send({ type: "SAVE_FAILED", error: messageOf(caught), recording: { id: recording.id, durationMs: recording.durationMs } }),
      );
    },
    async pause() {
      if (state.phase !== "recording" || (state.mic.state !== "recording" && state.mic.state !== "silenced")) return;
      try {
        await VoiceNotes.pause();
        const status = await VoiceNotes.status();
        send({ type: "MIC_STATE", mic: { state: status.state, reason: status.reason }, audioMs: status.audioMs });
      } catch (caught) { send({ type: "PAUSE_FAILED", error: `Could not pause: ${messageOf(caught)}` }); }
    },
    async resume() {
      if (state.phase !== "recording" || (state.mic.state !== "paused" && state.mic.state !== "interrupted" && state.mic.state !== "needs_user")) return;
      try {
        await VoiceNotes.resume();
        const status = await VoiceNotes.status();
        send({ type: "MIC_STATE", mic: { state: status.state, reason: status.reason }, audioMs: status.audioMs });
      } catch (caught) { send({ type: "RESUME_FAILED", error: `Could not resume: ${messageOf(caught)}` }); }
    },
    async discard() {
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
        if (discarded.id && discarded.id !== id) { id = discarded.id; markDiscarded(discarded.id); }
      } catch (caught) {
        // not_recording: the limit stopped it first, and its save meets the mark.
        // no_audio_captured: the phone kept nothing.
        const code = errorCode(caught);
        if (code !== "not_recording" && code !== "no_audio_captured") {
          send({ type: "DISCARD_FAILED", id: shown, error: `Could not discard the recording: ${messageOf(caught)}` });
          return;
        }
        needDeleteCommitted = code === "not_recording";
      }
      if (!id) {
        send({ type: "DISCARD_FAILED", id: shown, error: "Could not discard the recording." });
        return;
      }
      if (needDeleteCommitted) {
        const cleanupError = await deleteDiscarded(id);
        if (cleanupError) {
          send({ type: "DISCARD_FAILED", id: shown, error: cleanupError, committed: true });
          void pendingStore.refresh(cleanupError);
          return;
        }
      } else clearDiscarded(id);
      send({ type: "DISCARDED", id: shown });
    },
    async retryPending() {
      if (!available) return;
      let run;
      try {
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
    subscribeLevel(listener) {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
  };
}
