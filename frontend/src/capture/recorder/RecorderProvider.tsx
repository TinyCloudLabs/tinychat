// The one voice-note recorder, shared by every view of it: the full-page view,
// the island, the rail and sidebar live controls and the header chip.
// RecorderProvider calls useVoiceNoteRecorder once (a second controller would
// race the first for the microphone and its saves); the views are context
// consumers that own no listeners. It also owns whether the overlay is open,
// publishes the live microphone to liveCapture (the Live Edge), and gives
// feedback: haptics, and a polite announcement of each change.
//
// StaticRecorderProvider serves a fixed value, for the screenshot harness.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { Button } from "@/components/ui/button";
import { hapticRecordStarted, hapticSaved, hapticWarning } from "@/lib/haptics";
import { VOICE_NOTE_MAX_DURATION_MS, VoiceNotes, nativeVoiceNotesAvailable, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { PendingSnapshot } from "@/lib/voiceNotes/recorderSaves";
import { liveCapture } from "./liveCapture";
import { DISCARDED, micWarning, recorderStatusText, RECEIPT_KEPT } from "./recorderCopy";
import type { RecorderCaptureIssue, RecorderMic, RecorderPhase, RecorderState } from "./recorderReducer";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";
import { useVoiceNoteRecorder } from "./useVoiceNoteRecorder";

/** How long a saved receipt stays before the sheet closes and the island lets go. */
export const RECEIPT_MS = 3000;

export interface RecorderValue {
  available: boolean;
  /** The recorder has heard status() and its retained events; Record waits until then. */
  ready: boolean;
  phase: RecorderPhase;
  permissionDenied: boolean;
  mic: RecorderMic;
  /** Wall-clock start of this recording. */
  startedAt: number | null;
  audioMs: number;
  /** Native recorded-time checkpoint; useRecordedElapsed ticks it through interruptions and blocked resumes, except user Pause. */
  elapsedMs: number;
  captureIssues: Record<string, RecorderCaptureIssue>;
  recoveryScanFailure: string | null;
  controlPending: RecorderState["controlPending"];
  maxDurationMs: number;
  limitNotice: string | null;
  savePercent: number | null;
  error: string | null;
  /** How the last recording ended; drives the receipt. */
  outcome: "local" | "saved" | "failed" | null;
  localUpload: RecorderState["localUpload"];
  lastSaved: RecorderState["lastSaved"];
  pending: PendingSnapshot;
  transcription: VoiceNoteTranscriptionProps | undefined;
  sheetOpen: boolean;
  record(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Stop the live recording and delete it; the sheet closes once it is gone. */
  discard(): void;
  retryPending(): void;
  openSettings(): Promise<void>;
  /** The receipt was read (Done, Open): it goes, and the sheet closes. */
  dismissOutcome(): void;
  openSheet(): void;
  minimiseSheet(): void | Promise<void>;
  setReceiptPlaying(playing: boolean): void;
  subscribeLevel(listener: (level: number) => void): () => void;
}

const RecorderContext = createContext<RecorderValue | null>(null);

export function useRecorder(): RecorderValue {
  const value = useContext(RecorderContext);
  if (value === null) throw new Error("useRecorder() outside a RecorderProvider");
  return value;
}

/**
 * A recording is under way or has just ended: the views that follow it show.
 * One being discarded is already gone as far as they go; the sheet that
 * discarded it says so until it closes.
 */
export function recorderActive(value: Pick<RecorderValue, "phase" | "outcome">): boolean {
  return (value.phase !== "idle" && value.phase !== "discarding") || value.outcome !== null;
}

/** The island (and the rail and sidebar controls) show while the sheet is minimised. */
export function islandShown(value: Pick<RecorderValue, "phase" | "outcome" | "sheetOpen">): boolean {
  return !value.sheetOpen && recorderActive(value);
}

export interface RecorderProviderProps {
  tcw: TinyCloudWeb;
  /** False turns the recorder off for this session (local validation). */
  enabled?: boolean;
  backendUrl?: string;
  sessionStore?: SessionStore;
  /** A recording landed in the space. */
  onSaved?: (recording: VoiceNoteRecording) => void;
  children: ReactNode;
}

export function RecorderProvider({ tcw, enabled, backendUrl, sessionStore, onSaved, children }: RecorderProviderProps) {
  const [configured, setConfigured] = useState<{ tcw: TinyCloudWeb; did: string | null } | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [defaultsAttempt, setDefaultsAttempt] = useState(0);
  const defaultsReady = configured?.tcw === tcw && configured.did === (tcw.did ?? null);
  useEffect(() => {
    if (enabled === false || !nativeVoiceNotesAvailable()) return;
    let active = true;
    setConfigured(null);
    void (async () => {
      try {
        const native = await VoiceNotes.getCaptureDefaults();
        if (!active) return;
        const key = "exo.capture.transitionGen";
        const local = Number(globalThis.localStorage?.getItem(key) ?? 0) || 0;
        const transitionGen = Math.max(native.transitionGen, local) + 1;
        await VoiceNotes.setCaptureDefaults({ ...native, accountDid: tcw.did ?? null, transitionGen });
        globalThis.localStorage?.setItem(key, String(transitionGen));
        if (active) { setDefaultsError(null); setConfigured({ tcw, did: tcw.did ?? null }); }
      } catch (caught) {
        if (active) setDefaultsError(`Could not set this phone's recording account: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    })();
    return () => { active = false; };
  }, [enabled, tcw, defaultsAttempt]);
  const recorder = useVoiceNoteRecorder({ tcw, enabled: enabled !== false && defaultsReady, backendUrl, sessionStore, onSaved });
  const { state, dismissOutcome, subscribeLevel, record: startRecording } = recorder;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [receiptPlaying, setReceiptPlaying] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  // The Live Edge follows the live microphone.
  const live = state.phase === "recording" && (state.mic.state === "recording" || state.mic.state === "silenced");
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
    } else if (before.phase === "recording" && state.phase === "recording" && before.mic.state !== state.mic.state) {
      setAnnouncement(recorderStatusText(state.phase, state.mic, null));
    } else if (before.phase === "recording" && state.phase === "recording" && micWarning(before.mic) !== micWarning(state.mic)) {
      setAnnouncement(recorderStatusText(state.phase, state.mic, null));
    } else if (before.outcome !== state.outcome && state.outcome === "local") {
      hapticSaved();
      setAnnouncement("Saved on this phone");
    } else if (before.outcome !== state.outcome && state.outcome === "failed") {
      hapticWarning();
      setAnnouncement(RECEIPT_KEPT);
    } else if (before.phase === "discarding" && state.phase === "idle" && state.error === null) {
      // Discarded (a failure stays in the sheet as its alert): nothing is left to show.
      hapticWarning();
      setAnnouncement(DISCARDED);
      setSheetOpen(false);
    }
  }, [state]);

  // Local commit starts the receipt clock. Playback keeps it open.
  useEffect(() => {
    if (state.outcome !== "local" && state.outcome !== "saved") return;
    if (state.permissionDenied) return;
    if (receiptPlaying) return;
    const timer = setTimeout(() => {
      setSheetOpen(false);
      dismissOutcome();
    }, RECEIPT_MS);
    return () => clearTimeout(timer);
  }, [dismissOutcome, receiptPlaying, state.outcome, state.lastSaved, state.permissionDenied]);

  useEffect(() => recorder.setOnPresent(() => setSheetOpen(true)), [recorder.setOnPresent]);

  const record = useCallback(() => {
    setSheetOpen(true);
    startRecording();
  }, [startRecording]);
  const dismiss = useCallback(() => {
    setSheetOpen(false);
    dismissOutcome();
  }, [dismissOutcome]);
  const openSheet = useCallback(() => setSheetOpen(true), []);
  const minimiseSheet = useCallback(async () => {
    if (state.permissionDenied) await recorder.dismissShortcutRecovery();
    setSheetOpen(false);
  }, [recorder.dismissShortcutRecovery, state.permissionDenied]);

  const value = useMemo<RecorderValue>(
    () => ({
      available: recorder.available,
      ready: state.ready,
      phase: state.phase,
      permissionDenied: state.permissionDenied,
      mic: state.mic,
      startedAt: state.startedAt,
      audioMs: state.audioMs,
      elapsedMs: state.elapsedMs,
      captureIssues: state.captureIssues,
      recoveryScanFailure: state.recoveryScanFailure,
      controlPending: state.controlPending,
      maxDurationMs: state.maxDurationMs,
      limitNotice: state.limitNotice,
      savePercent: state.savePercent,
      error: state.error ?? defaultsError,
      outcome: state.outcome,
      localUpload: state.localUpload,
      lastSaved: state.lastSaved,
      pending: recorder.pending,
      transcription: recorder.transcription,
      sheetOpen,
      record,
      stop: recorder.stop,
      pause: recorder.pause,
      resume: recorder.resume,
      discard: recorder.discard,
      retryPending: recorder.retryPending,
      openSettings: recorder.openSettings,
      dismissOutcome: dismiss,
      openSheet,
      minimiseSheet,
      setReceiptPlaying,
      subscribeLevel,
    }),
    [
      dismiss,
      minimiseSheet,
      openSheet,
      record,
      recorder.available,
      recorder.discard,
      recorder.pending,
      recorder.retryPending,
      recorder.openSettings,
      recorder.stop,
      recorder.pause,
      recorder.resume,
      recorder.transcription,
      defaultsError,
      sheetOpen,
      state,
      subscribeLevel,
    ],
  );

  return (
    <RecorderContext.Provider value={value}>
      {children}
      {defaultsError && <div role="alert" className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-xl items-center gap-3 rounded-xl bg-card p-4 text-callout text-card-foreground shadow-float">
        <span className="min-w-0 flex-1">{defaultsError}</span>
        <Button type="button" variant="outline" onClick={() => setDefaultsAttempt((n) => n + 1)}>Retry</Button>
      </div>}
      <p role="status" aria-live="polite" className="sr-only" data-testid="recorder-announcer">
        {announcement}
      </p>
    </RecorderContext.Provider>
  );
}

const NO_PENDING: PendingSnapshot = { listing: { state: "ok", count: 0 }, running: false, lastError: null };
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
      ready: true,
      phase: "idle",
      permissionDenied: false,
      mic: { state: "idle", reason: null },
      startedAt: null,
      audioMs: 0,
      elapsedMs: 0,
      captureIssues: {},
      recoveryScanFailure: null,
      controlPending: null,
      maxDurationMs: VOICE_NOTE_MAX_DURATION_MS,
      limitNotice: null,
      savePercent: null,
      error: null,
      outcome: null,
      localUpload: null,
      lastSaved: null,
      pending: NO_PENDING,
      transcription: undefined,
      sheetOpen: false,
      record: noop,
      stop: noop,
      pause: noop,
      resume: noop,
      discard: noop,
      retryPending: noop,
      openSettings: async () => {},
      dismissOutcome: noop,
      openSheet: noop,
      minimiseSheet: noop,
      setReceiptPlaying: noop,
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
