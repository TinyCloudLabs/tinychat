// The voice-note recorder's controller: the Voice notes card's controller
// (VoiceNotesSection.tsx) moved onto recorderReducer, without the notes list,
// playback or the mount-time retry of pending saves (PendingVoiceNotesSaver
// stays the only saver at startup). RecorderProvider calls it exactly once;
// every recorder view reads it through useRecorder().
//
// It owns the plugin's three listeners (micState, level, autoStopped), picks a
// running recording back up after a WebView reload (status()), saves a stopped
// recording through the shared single-flight guards (recorderSaves.ts), and
// hands each saved note to private cloud transcription.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  VoiceNotes,
  nativeVoiceNotesAvailable,
  voiceNoteMaxDurationMs,
  type VoiceNoteAutoStopEvent,
  type VoiceNoteRecording,
} from "@/lib/voiceNotes/nativeVoiceNotes";
import {
  errorCode,
  messageOf,
  pendingStore,
  saveRecording,
  savePendingRecordings,
  type PendingSnapshot,
} from "@/lib/voiceNotes/recorderSaves";
import { voiceNoteTranscriberFor } from "@/lib/voiceNotes/voiceNoteTranscription";
import { limitNoticeText } from "./recorderCopy";
import { initialRecorderState, recorderReducer, type RecorderEvent, type RecorderState } from "./recorderReducer";
import {
  HIDDEN_SNAPSHOT,
  noSubscription,
  transcriptionProps,
  type VoiceNoteTranscriptionProps,
} from "./transcriptionProps";

export interface VoiceNoteRecorderOptions {
  tcw: TinyCloudWeb;
  backendUrl?: string;
  sessionStore?: SessionStore;
  /** A recording landed in the space (by Stop, the limit, or a pending save). */
  onSaved?: (recording: VoiceNoteRecording) => void;
}

export interface VoiceNoteRecorder {
  /** The Exo mobile app with its VoiceNotes plugin; nothing else records. */
  available: boolean;
  state: RecorderState;
  pending: PendingSnapshot;
  transcription: VoiceNoteTranscriptionProps | undefined;
  record(): void;
  stop(): void;
  retryPending(): void;
  /** The receipt was read. */
  dismissOutcome(): void;
  /** Input levels (0..1), fanned out without React state. */
  subscribeLevel(listener: (level: number) => void): () => void;
}

export function useVoiceNoteRecorder({ tcw, backendUrl, sessionStore, onSaved }: VoiceNoteRecorderOptions): VoiceNoteRecorder {
  const [available] = useState(nativeVoiceNotesAvailable);
  const [state, setState] = useState(initialRecorderState);
  // The reducer runs here, synchronously, so a second tap in the same frame
  // sees the phase the first one set (Stop must never call stop() twice).
  const stateRef = useRef(initialRecorderState);
  const send = useCallback((event: RecorderEvent) => {
    const next = recorderReducer(stateRef.current, event);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const levelListeners = useRef(new Set<(level: number) => void>());
  const onAutoStoppedRef = useRef<(event: VoiceNoteAutoStopEvent) => void>(() => {});
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  // Private cloud transcription for this account (null without one), shared across mounts.
  const transcriber = useMemo(
    () =>
      available && backendUrl !== undefined && sessionStore !== undefined
        ? voiceNoteTranscriberFor(tcw, backendUrl, sessionStore)
        : null,
    [available, backendUrl, sessionStore, tcw],
  );
  const snapshot = useSyncExternalStore(
    transcriber ? transcriber.subscribe : noSubscription,
    () => transcriber?.snapshot() ?? HIDDEN_SNAPSHOT,
  );
  const pending = useSyncExternalStore(pendingStore.subscribe, pendingStore.snapshot);

  useEffect(() => {
    if (!available) return;
    let mounted = true;
    const handles = [
      VoiceNotes.addListener("micState", (event) => send({ type: "MIC_STATE", mic: { state: event.state, reason: event.reason } })),
      VoiceNotes.addListener("level", (event) => {
        for (const listener of levelListeners.current) listener(event.level);
      }),
      // Retained by the shell until heard, so a reload mid-recording still saves the note.
      VoiceNotes.addListener("autoStopped", (event) => onAutoStoppedRef.current(event)),
    ];
    // A WebView reload mid-recording (or a recording started offline) leaves the native recorder running.
    void VoiceNotes.status().then((status) => {
      if (!mounted || status.state === "idle") return;
      send({
        type: "PICKED_UP",
        id: status.id,
        startedAt: Date.now() - status.elapsedMs,
        maxDurationMs: status.maxDurationMs,
        mic: { state: status.state, reason: status.reason },
      });
    });
    return () => {
      mounted = false;
      for (const handle of handles) void handle.then((h) => h.remove());
    };
  }, [available, send]);

  /** Save a stopped recording (by Stop or by the limit); a failure leaves it pending on the phone. */
  const saveStopped = useCallback(
    async (recording: VoiceNoteRecording) => {
      send({ type: "SAVE_PROGRESS", percent: null });
      const outcome = await saveRecording(tcw, recording, (stored, total) => {
        if (total > 0) send({ type: "SAVE_PROGRESS", percent: Math.floor((stored / total) * 100) });
      });
      if (outcome.saved) {
        send({ type: "SAVED", id: recording.id, durationMs: recording.durationMs, at: Date.now() });
        transcriber?.noteSaved(recording, outcome.audio ?? undefined);
        onSavedRef.current?.(recording);
      } else if (outcome.failure !== null) {
        // The audio stays on the device; nothing is lost if the save failed.
        send({ type: "SAVE_FAILED", error: `Recorded, but saving to your space failed: ${outcome.failure}` });
        void pendingStore.refresh();
      } else {
        // Being saved, or already saved, by another run.
        send({ type: "RESET" });
      }
    },
    [send, tcw, transcriber],
  );

  useEffect(() => {
    onAutoStoppedRef.current = (event) => {
      send({ type: "AUTO_STOPPED", notice: limitNoticeText(event.maxDurationMs), captured: event.recording !== null });
      if (!event.recording) return;
      void saveStopped(event.recording).catch((caught: unknown) => send({ type: "SAVE_FAILED", error: messageOf(caught) }));
    };
  }, [saveStopped, send]);

  const record = useCallback(() => {
    if (!available || stateRef.current.phase !== "idle") return;
    send({ type: "START_REQUESTED" });
    void (async () => {
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
    })();
  }, [available, send]);

  const stop = useCallback(() => {
    // Stop waits for STARTED: the plugin cannot cancel a start in flight.
    if (stateRef.current.phase !== "recording") return;
    send({ type: "STOP_REQUESTED" });
    void (async () => {
      let recording: VoiceNoteRecording;
      try {
        recording = await VoiceNotes.stop();
      } catch (caught) {
        // "not_recording": the limit stopped it first, and its "autoStopped" event saves it.
        send({ type: "STOP_FAILED", error: errorCode(caught) === "not_recording" ? null : messageOf(caught) });
        return;
      }
      await saveStopped(recording);
    })();
  }, [saveStopped, send]);

  const retryPending = useCallback(() => {
    if (!available) return;
    void savePendingRecordings(tcw).then(
      (run) => {
        for (const recording of run.saved) {
          transcriber?.noteSaved(recording);
          onSavedRef.current?.(recording);
        }
      },
      (caught: unknown) => console.warn("[VoiceNotes] Saving notes left on this phone failed", caught),
    );
  }, [available, tcw, transcriber]);

  const dismissOutcome = useCallback(() => send({ type: "DISMISSED" }), [send]);

  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    const listeners = levelListeners.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return {
    available,
    state,
    pending,
    transcription: transcriptionProps(transcriber, snapshot),
    record,
    stop,
    retryPending,
    dismissOutcome,
    subscribeLevel,
  };
}
