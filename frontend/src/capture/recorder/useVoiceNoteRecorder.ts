// The voice-note recorder for React: one controller
// (voiceNoteRecorderController.ts) per signed-in session, its listeners
// attached while mounted. RecorderProvider calls this exactly once; every
// recorder view reads it through useRecorder().
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { nativeVoiceNotesAvailable, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { pendingStore, type PendingSnapshot } from "@/lib/voiceNotes/recorderSaves";
import { voiceNoteTranscriberFor } from "@/lib/voiceNotes/voiceNoteTranscription";
import type { RecorderState } from "./recorderReducer";
import { HIDDEN_SNAPSHOT, noSubscription, transcriptionProps, type VoiceNoteTranscriptionProps } from "./transcriptionProps";
import { createVoiceNoteRecorderController } from "./voiceNoteRecorderController";
import type { RecorderTranscriberChoice, TranscriberChoiceResult, TranscriberChoiceScope } from "./voiceNoteRecorderController";
import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";

export interface VoiceNoteRecorderOptions {
  tcw: TinyCloudWeb;
  /** False turns the recorder off until the session's native defaults are set. */
  enabled?: boolean;
  backendUrl?: string;
  sessionStore?: SessionStore;
  /** A recording landed in the space (by Stop, the limit, or a pending save). */
  onSaved?: (recording: VoiceNoteRecording) => void;
}

export interface VoiceNoteRecorder {
  /** The Exo mobile app with its VoiceNotes plugin; nothing else records. */
  available: boolean;
  state: RecorderState;
  transcriber: RecorderTranscriberChoice;
  setTranscriber(id: TranscriberId, options: { scope: TranscriberChoiceScope; waitForModel?: boolean }): Promise<TranscriberChoiceResult>;
  setIdentifySpeakers(on: boolean, scope: "recording" | "default"): Promise<"ok" | "needs_consent" | "locked_signed_out" | "unavailable">;
  pending: PendingSnapshot;
  transcription: VoiceNoteTranscriptionProps | undefined;
  record(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Stop the live recording and delete it; nothing is saved. */
  discard(): void;
  retryPending(): void;
  openSettings(): Promise<void>;
  dismissShortcutRecovery(): Promise<void>;
  /** The receipt was read. */
  dismissOutcome(): void;
  setOnPresent(onPresent: (() => void) | undefined): void;
  /** Input levels (0..1), fanned out without React state. */
  subscribeLevel(listener: (level: number) => void): () => void;
}

export function useVoiceNoteRecorder({ tcw, enabled = true, backendUrl, sessionStore, onSaved }: VoiceNoteRecorderOptions): VoiceNoteRecorder {
  const available = enabled && nativeVoiceNotesAvailable();

  // Private cloud transcription for this account (null without one), shared across mounts.
  const transcriber = useMemo(
    () =>
      available && backendUrl !== undefined && sessionStore !== undefined
        ? voiceNoteTranscriberFor(tcw, backendUrl, sessionStore)
        : null,
    [available, backendUrl, sessionStore, tcw],
  );
  const controller = useMemo(() => createVoiceNoteRecorderController({ tcw, available, transcriber }), [available, tcw, transcriber]);
  useEffect(() => controller.setOnSaved(onSaved), [controller, onSaved]);
  useEffect(() => controller.attach(), [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const transcriberChoice = useSyncExternalStore(controller.subscribe, controller.getTranscriber);
  const snapshot = useSyncExternalStore(
    transcriber ? transcriber.subscribe : noSubscription,
    () => transcriber?.snapshot() ?? HIDDEN_SNAPSHOT,
  );
  const pending = useSyncExternalStore(pendingStore.subscribe, pendingStore.snapshot);

  return useMemo(
    () => ({
      available,
      state,
      transcriber: transcriberChoice,
      setTranscriber: controller.setTranscriber,
      setIdentifySpeakers: controller.setIdentifySpeakers,
      pending,
      transcription: transcriptionProps(transcriber, snapshot),
      record: () => void controller.record(),
      stop: () => void controller.stop(),
      pause: () => void controller.pause(),
      resume: () => void controller.resume(),
      discard: () => void controller.discard(),
      retryPending: () => void controller.retryPending(),
      openSettings: () => controller.openSettings(),
      dismissShortcutRecovery: () => controller.dismissShortcutRecovery(),
      dismissOutcome: controller.dismissOutcome,
      setOnPresent: controller.setOnPresent,
      subscribeLevel: controller.subscribeLevel,
    }),
    [available, controller, pending, snapshot, state, transcriber, transcriberChoice],
  );
}
