// The voice-note recorder's controller, without React: the old Voice notes
// card's controller moved onto recorderReducer, without the notes list and
// playback (VoiceNotesListCard) or the mount-time retry of pending saves
// (PendingVoiceNotesSaver stays the only saver at startup). useVoiceNoteRecorder
// wraps it for RecorderProvider, which mounts it exactly once; the tests drive
// it directly against the fake plugin.
//
// It owns the plugin's three listeners (micState, level, autoStopped), picks a
// running recording back up after a WebView reload (status()), saves a stopped
// recording through the shared single-flight guards (recorderSaves.ts), and
// hands each saved note to private cloud transcription.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  VoiceNotes,
  voiceNoteMaxDurationMs,
  type VoiceNoteAutoStopEvent,
  type VoiceNoteRecording,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import { errorCode, messageOf, pendingStore, saveRecording, savePendingRecordings } from "@/lib/voiceNotes/recorderSaves";
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
  /** A recording landed in the space (by Stop, the limit, or Save now). */
  setOnSaved(onSaved: ((recording: VoiceNoteRecording) => void) | undefined): void;
  /** Adds the plugin's listeners and picks up a running recording; returns their teardown. */
  attach(): () => void;
  record(): Promise<void>;
  stop(): Promise<void>;
  retryPending(): Promise<void>;
  /** The receipt was read. */
  dismissOutcome(): void;
  /** Input levels (0..1), fanned out without React state. */
  subscribeLevel(listener: (level: number) => void): () => void;
}

export function createVoiceNoteRecorderController({ tcw, available, transcriber }: VoiceNoteRecorderControllerOptions): VoiceNoteRecorderController {
  let state = initialRecorderState;
  let onSaved: ((recording: VoiceNoteRecording) => void) | undefined;
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

  /** Save a stopped recording (by Stop or by the limit); a failure leaves it pending on the phone. */
  const saveStopped = async (recording: VoiceNoteRecording) => {
    send({ type: "SAVE_PROGRESS", percent: null });
    const outcome = await saveRecording(tcw, recording, (stored, total) => {
      if (total > 0) send({ type: "SAVE_PROGRESS", percent: Math.floor((stored / total) * 100) });
    });
    switch (outcome.kind) {
      case "saved":
        send({ type: "SAVED", id: recording.id, durationMs: recording.durationMs, at: Date.now() });
        landed(recording, outcome.audio ?? undefined);
        // A copy the phone kept is counted (and told) until Save now removes it.
        if (outcome.cleanupError) void pendingStore.refresh(outcome.cleanupError);
        return;
      case "failed":
        // The audio stays on the device; nothing is lost if the save failed.
        send({
          type: "SAVE_FAILED",
          error: `Recorded, but saving to your space failed: ${outcome.failure}`,
          recording: { id: recording.id, durationMs: recording.durationMs },
        });
        void pendingStore.refresh();
        return;
      case "already-saved":
        if (outcome.cleanupError) void pendingStore.refresh(outcome.cleanupError);
        send({ type: "RESET" });
        return;
      case "in-flight":
        // Another run is saving it.
        send({ type: "RESET" });
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
    else if (outcome.kind !== "in-flight") void pendingStore.refresh(outcome.cleanupError ?? undefined);
  };

  const onAutoStopped = (event: VoiceNoteAutoStopEvent) => {
    const recording = event.recording;
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
    attach() {
      if (!available) return () => {};
      let attached = true;
      const handles = [
        VoiceNotes.addListener("micState", (event) => send({ type: "MIC_STATE", mic: { state: event.state, reason: event.reason } })),
        VoiceNotes.addListener("level", (event) => {
          for (const listener of levelListeners) listener(event.level);
        }),
        // Retained by the shell until heard, so a reload mid-recording still saves the note.
        VoiceNotes.addListener("autoStopped", onAutoStopped),
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
              startedAt: Date.now() - status.elapsedMs,
              maxDurationMs: status.maxDurationMs,
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
      await saveStopped(recording);
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
