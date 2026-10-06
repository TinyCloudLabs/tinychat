// The one voice-note recorder, shared by every view of it: the recorder
// sheet, the island, the rail and sidebar live controls and the header chip.
// RecorderProvider calls useVoiceNoteRecorder once (a second controller would
// race the first for the microphone and its saves); the views are context
// consumers that own no listeners. It also owns whether the sheet is open,
// publishes the live microphone to liveCapture (the Live Edge), and gives
// feedback: haptics, and a polite announcement of each change.
//
// StaticRecorderProvider serves a fixed value, for the screenshot harness.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { hapticRecordStarted, hapticSaved, hapticWarning } from "@/lib/haptics";
import { VOICE_NOTE_MAX_DURATION_MS, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { PendingSnapshot } from "@/lib/voiceNotes/recorderSaves";
import { liveCapture } from "./liveCapture";
import { micWarning, recorderStatusText, RECEIPT_KEPT, RECEIPT_SAVED } from "./recorderCopy";
import type { RecorderMic, RecorderPhase, RecorderState } from "./recorderReducer";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";
import { useVoiceNoteRecorder } from "./useVoiceNoteRecorder";

/** How long a saved receipt stays before the sheet closes and the island lets go. */
export const RECEIPT_MS = 3000;

export interface RecorderValue {
  available: boolean;
  phase: RecorderPhase;
  mic: RecorderMic;
  /** Views tick their own timers from this (useElapsed); the provider never ticks. */
  startedAt: number | null;
  maxDurationMs: number;
  limitNotice: string | null;
  savePercent: number | null;
  error: string | null;
  /** How the last recording ended; drives the receipt. */
  outcome: "saved" | "failed" | null;
  lastSaved: RecorderState["lastSaved"];
  pending: PendingSnapshot;
  transcription: VoiceNoteTranscriptionProps | undefined;
  sheetOpen: boolean;
  record(): void;
  stop(): void;
  retryPending(): void;
  /** The receipt was read (Done, Open): it goes, and the sheet closes. */
  dismissOutcome(): void;
  openSheet(): void;
  minimiseSheet(): void;
  subscribeLevel(listener: (level: number) => void): () => void;
}

const RecorderContext = createContext<RecorderValue | null>(null);

export function useRecorder(): RecorderValue {
  const value = useContext(RecorderContext);
  if (value === null) throw new Error("useRecorder() outside a RecorderProvider");
  return value;
}

/** A recording is under way or has just ended: the views that follow it show. */
export function recorderActive(value: Pick<RecorderValue, "phase" | "outcome">): boolean {
  return value.phase !== "idle" || value.outcome !== null;
}

/** The island (and the rail and sidebar controls) show while the sheet is minimised. */
export function islandShown(value: Pick<RecorderValue, "phase" | "outcome" | "sheetOpen">): boolean {
  return !value.sheetOpen && recorderActive(value);
}

export interface RecorderProviderProps {
  tcw: TinyCloudWeb;
  backendUrl?: string;
  sessionStore?: SessionStore;
  /** A recording landed in the space. */
  onSaved?: (recording: VoiceNoteRecording) => void;
  children: ReactNode;
}

export function RecorderProvider({ tcw, backendUrl, sessionStore, onSaved, children }: RecorderProviderProps) {
  const recorder = useVoiceNoteRecorder({ tcw, backendUrl, sessionStore, onSaved });
  const { state, dismissOutcome, subscribeLevel, record: startRecording } = recorder;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  // The Live Edge follows the live microphone.
  const live = state.phase === "recording";
  const warning = live && micWarning(state.mic) !== null;
  useEffect(() => {
    liveCapture.set(live ? { source: "voice-note", warning, startedAt: state.startedAt } : null);
  }, [live, warning, state.startedAt]);
  useEffect(
    () => () => {
      if (liveCapture.get()?.source === "voice-note") liveCapture.set(null);
    },
    [],
  );
  useEffect(() => subscribeLevel((level) => liveCapture.setLevel(level)), [subscribeLevel]);

  // Feedback for each change: a haptic and a polite announcement.
  const previous = useRef(state);
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before.phase === "starting" && state.phase === "recording") {
      hapticRecordStarted();
      setAnnouncement("Recording started");
    } else if (before.phase === "recording" && state.phase === "recording" && micWarning(before.mic) !== micWarning(state.mic)) {
      setAnnouncement(recorderStatusText(state.phase, state.mic, null));
    } else if (before.outcome !== state.outcome && state.outcome === "saved") {
      hapticSaved();
      setAnnouncement(RECEIPT_SAVED);
    } else if (before.outcome !== state.outcome && state.outcome === "failed") {
      hapticWarning();
      setAnnouncement(RECEIPT_KEPT);
    }
  }, [state]);

  // A saved receipt stays 3 s, then the sheet closes; a failure stays until it is read.
  useEffect(() => {
    if (state.outcome !== "saved") return;
    const timer = setTimeout(() => {
      setSheetOpen(false);
      dismissOutcome();
    }, RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [dismissOutcome, state.outcome, state.lastSaved]);

  const record = useCallback(() => {
    setSheetOpen(true);
    startRecording();
  }, [startRecording]);
  const dismiss = useCallback(() => {
    setSheetOpen(false);
    dismissOutcome();
  }, [dismissOutcome]);
  const openSheet = useCallback(() => setSheetOpen(true), []);
  const minimiseSheet = useCallback(() => setSheetOpen(false), []);

  const value = useMemo<RecorderValue>(
    () => ({
      available: recorder.available,
      phase: state.phase,
      mic: state.mic,
      startedAt: state.startedAt,
      maxDurationMs: state.maxDurationMs,
      limitNotice: state.limitNotice,
      savePercent: state.savePercent,
      error: state.error,
      outcome: state.outcome,
      lastSaved: state.lastSaved,
      pending: recorder.pending,
      transcription: recorder.transcription,
      sheetOpen,
      record,
      stop: recorder.stop,
      retryPending: recorder.retryPending,
      dismissOutcome: dismiss,
      openSheet,
      minimiseSheet,
      subscribeLevel,
    }),
    [
      dismiss,
      minimiseSheet,
      openSheet,
      record,
      recorder.available,
      recorder.pending,
      recorder.retryPending,
      recorder.stop,
      recorder.transcription,
      sheetOpen,
      state,
      subscribeLevel,
    ],
  );

  return (
    <RecorderContext.Provider value={value}>
      {children}
      <p role="status" aria-live="polite" className="sr-only" data-testid="recorder-announcer">
        {announcement}
      </p>
    </RecorderContext.Provider>
  );
}

const NO_PENDING: PendingSnapshot = { count: 0, running: false, lastError: null };
const noop = () => {};

/**
 * A recorder frozen in one state, for the screenshot harness. `levels` are
 * replayed to each level subscriber at once, so a trace shows real-looking samples.
 */
export function StaticRecorderProvider(props: { value?: Partial<RecorderValue>; levels?: readonly number[]; children: ReactNode }) {
  const { value: patch, levels } = props;
  const value = useMemo<RecorderValue>(
    () => ({
      available: true,
      phase: "idle",
      mic: { state: "idle", reason: null },
      startedAt: null,
      maxDurationMs: VOICE_NOTE_MAX_DURATION_MS,
      limitNotice: null,
      savePercent: null,
      error: null,
      outcome: null,
      lastSaved: null,
      pending: NO_PENDING,
      transcription: undefined,
      sheetOpen: false,
      record: noop,
      stop: noop,
      retryPending: noop,
      dismissOutcome: noop,
      openSheet: noop,
      minimiseSheet: noop,
      subscribeLevel: (listener) => {
        for (const level of levels ?? []) listener(level);
        return noop;
      },
      ...patch,
    }),
    [levels, patch],
  );
  return <RecorderContext.Provider value={value}>{props.children}</RecorderContext.Provider>;
}
