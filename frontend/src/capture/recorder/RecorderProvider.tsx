import { readableError } from "@/lib/readableError";
// The one voice-note recorder, shared by every view of it: the full-page view,
// the island, the rail and sidebar live controls and the header chip.
// RecorderProvider calls useVoiceNoteRecorder once (a second controller would
// race the first for the microphone and its saves); the views are context
// consumers that own no listeners. It also owns whether the overlay is open,
// and gives feedback: haptics, and a polite announcement of each change.
//
// StaticRecorderProvider serves a fixed value, for the screenshot harness.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { Button } from "@/components/ui/button";
import { PlatformContext, deviceName } from "@/lib/platform";
import { getDesktopCaptureExtras, type DesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { chooseSystemAudio, needsSystemAudioDisclosure, SYSTEM_AUDIO_BODY, SYSTEM_AUDIO_MIC_ONLY, SYSTEM_AUDIO_RECORD, SYSTEM_AUDIO_TITLE } from "@/capture/home/desktop/systemAudioDisclosure";
import { SheetDialog } from "./final/SheetDialog";
import { PRIVATE_CONSENT_ACTION, PRIVATE_CONSENT_TITLE, POWERFUL_CONSENT_ACTION, POWERFUL_CONSENT_BODY, POWERFUL_CONSENT_TITLE, privateConsentBody } from "./final/finalCopy";
import { privateConsentDevice } from "./final/finalCopy";
import { markPrivateConsentPrompted, privateConsentWasPrompted } from "./privateConsentPrompt";
import "@/capture/home/desktop/systemAudioStart.css";
import { hapticRecordStarted, hapticSaved, hapticWarning } from "@/lib/haptics";
import { VOICE_NOTE_MAX_DURATION_MS, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";
import { captureEngineAvailable } from "@/lib/voiceNotes/captureEngine";
import { writeAccountDefaults } from "@/lib/voiceNotes/transcriberPreference";
import type { PendingSnapshot } from "@/lib/voiceNotes/recorderSaves";
import { DISCARDED, micWarning, recorderStatusText, RECEIPT_KEPT } from "./recorderCopy";
import type { RecorderCaptureIssue, RecorderMic, RecorderPhase, RecorderState } from "./recorderReducer";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";
import type { RecorderTranscriberChoice, TranscriberChoiceResult, TranscriberChoiceScope, VoiceNoteRecorderController } from "./voiceNoteRecorderController";
import type { RecorderNote, RecorderNoteStatus } from "./voiceNoteRecorderController";
import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { VoiceNotePipeline } from "@/lib/voiceNotes/voiceNotePipeline";
import { useVoiceNoteRecorder } from "./useVoiceNoteRecorder";
import { shouldScheduleReceiptDismissal } from "./receiptBehavior";
import { useLimitNotifications } from "./limitNotifications";

/** How long a saved receipt stays, once its content is actually visible, before the sheet closes
 * and the island lets go. */
export const RECEIPT_MS = 3000;
/** The same, while the receipt offers something to press (Get model, Use Private instead, Retry). */
export const RECEIPT_ACTION_MS = 10000;

/** A hard ceiling on how long a receipt may hold the sheet open waiting for that content — a
 * native read that never resolves must not keep Stop from ever returning to Capture home. */
export const RECEIPT_MAX_MS = 15000;

/** How long a receipt with everything on show stays open: longer while it offers something to press. */
export const receiptWindowMs = (actionable: boolean) => (actionable ? RECEIPT_ACTION_MS : RECEIPT_MS);

export function permissionDeniedAnnouncement(wasDenied: boolean, denied: boolean): string | null {
  return !wasDenied && denied ? "Microphone access is off" : null;
}

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
  /** Native recorded-time checkpoint; useRecordedElapsed ticks it from elapsedAt except during user Pause. */
  elapsedMs: number;
  elapsedAt: number | null;
  captureIssues: Record<string, RecorderCaptureIssue>;
  dismissCaptureIssue(id: string): boolean;
  recoveryScanFailure: string | null;
  captureSourceUnconfirmed: boolean;
  controlPending: RecorderState["controlPending"];
  maxDurationMs: number;
  /** Whether this recording stops by itself at `maxDurationMs`; false under the silent safety cap (no countdown, warning or prompt). */
  autoStop: boolean;
  limitNotice: string | null;
  savePercent: number | null;
  error: string | null;
  /** How the last recording ended; drives the receipt. */
  outcome: "local" | "saved" | "failed" | null;
  localUpload: RecorderState["localUpload"];
  localUploadHeldReason?: RecorderState["localUploadHeldReason"];
  lastSaved: RecorderState["lastSaved"];
  /** The recording in progress, or stopping: its capture issue and error belong to it. */
  recordingId: RecorderState["recordingId"];
  /** A recording that failed to finish, kept for its receipt. */
  failedRecording: RecorderState["failedRecording"];
  /** The recording whose stop timed out finalizing while `error` is the finalizing promise. */
  finalizationPendingId: RecorderState["finalizationPendingId"];
  pending: PendingSnapshot;
  transcription: VoiceNoteTranscriptionProps | undefined;
  /** Native options while recording; otherwise the signed-in effective JS default. */
  transcriber: RecorderTranscriberChoice;
  /** The current recording's Markdown; moments are parsed from its timestamp lines. */
  note: RecorderNote | null;
  /** The editor can write only after this recording's local note has loaded. */
  noteStatus: RecorderNoteStatus;
  /** Short account-scoped code for the current recording's Markdown sync; audio save is separate. */
  noteSyncError: string | null;
  setNoteText(md: string): Promise<void>;
  markMoment(): number;
  /** Keeps an automatically stopped receipt open until an active moment commits or cancels. */
  setMomentFieldFocused(focused: boolean): void;
  setTranscriber(id: TranscriberId, options: { scope: TranscriberChoiceScope }): Promise<TranscriberChoiceResult>;
  setIdentifySpeakers(on: boolean, scope: "recording" | "default"): Promise<"ok" | "needs_consent" | "locked_signed_out" | "unavailable">;
  /** Capture always forces on-device while signed out (CaptureEngine), so the transcription route
   * must too — never offer "Off" or "Private cloud" without an account. */
  signedIn: boolean;
  /** The app's sign-in entry, for a note that is waiting on the account; null where the app gave none. */
  signIn: (() => void | Promise<void>) | null;
  /** The account's space client, for the receipt's per-note pipeline; null signed out. */
  tcw: TinyCloudWeb | null;
  sheetOpen: boolean;
  record(): void;
  reviewPrivateConsent(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  /** Stop the live recording and delete it; the sheet closes once it is gone. */
  discard(): void;
  retryPending(): void | Promise<void>;
  openSettings(): Promise<void>;
  /** "Keep going": raise the live recording's limit by one hour. Undefined where the engine cannot change a running limit. */
  extendLimit: (() => Promise<void>) | undefined;
  /** The receipt was read (Done, Open): it goes, and the sheet closes. */
  dismissOutcome(): void;
  openSheet(): void;
  minimiseSheet(): void | Promise<void>;
  setReceiptPlaying(playing: boolean): void;
  /** The receipt is offering something to press: it stays open longer (RECEIPT_ACTION_MS). */
  setReceiptActionable(actionable: boolean): void;
  /** The receipt's local Play control is ready (or has visibly failed to load): starts the
   * display clock, so it can never close the sheet before there is anything to show. */
  setReceiptReady(): void;
  subscribeLevel(listener: (level: number) => void): () => void;
  subscribeLevels: VoiceNoteRecorderController["subscribeLevels"];
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
  tcw: TinyCloudWeb | null;
  /** False turns the recorder off for this session (local validation). */
  enabled?: boolean;
  backendUrl?: string;
  sessionStore?: SessionStore;
  /** A recording landed in the space. */
  onSaved?: (recording: VoiceNoteRecording) => void;
  onAccountReady?: (tcw: TinyCloudWeb) => void;
  pipeline?: VoiceNotePipeline | null;
  signedOut?: boolean;
  onSignedOut?: () => Promise<boolean>;
  onSignIn?: () => void | Promise<void>;
  /** The sign-in opens a screen of its own: the sheet minimises first, so it is not left covering it. */
  minimiseOnSignIn?: boolean;
  children: ReactNode;
}

export function RecorderProvider({ tcw, enabled, backendUrl, sessionStore, onSaved, onAccountReady, pipeline, signedOut, onSignedOut, onSignIn, minimiseOnSignIn, children }: RecorderProviderProps) {
  const platform = useContext(PlatformContext);
  const disclosureTitleId = useId();
  const disclosureDescriptionId = useId();
  const device = deviceName(platform);
  const [configured, setConfigured] = useState<{ tcw: TinyCloudWeb; did: string | null } | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [defaultsAttempt, setDefaultsAttempt] = useState(0);
  const defaultsReady = tcw === null || (configured?.tcw === tcw && configured.did === (tcw.did ?? null));
  useEffect(() => {
    if (enabled !== false && signedOut && captureEngineAvailable()) void onSignedOut?.();
  }, [enabled, signedOut, onSignedOut]);
  useEffect(() => {
    if (enabled === false || !captureEngineAvailable() || tcw === null) return;
    let active = true;
    setConfigured(null);
    void (async () => {
      try {
        const key = "exo.capture.transitionGen";
        const written = await writeAccountDefaults((native) => {
          if (!active) return null;
          const local = Number(globalThis.localStorage?.getItem(key) ?? 0) || 0;
          // A preference sync is not an account transition. Only an owner change advances the generation.
          const transitionGen = native.accountDid === (tcw.did ?? null) && native.status === "signed_in"
            ? native.transitionGen : Math.max(native.transitionGen, local) + 1;
          return { accountDid: tcw.did ?? null, transitionGen };
        });
        if (!written) return;
        globalThis.localStorage?.setItem(key, String(written.transitionGen));
        if (active) { setDefaultsError(null); setConfigured({ tcw, did: tcw.did ?? null }); if (tcw.did) onAccountReady?.(tcw); }
      } catch (caught) {
        if (active) setDefaultsError(`Could not set ${device}'s recording account: ${readableError(caught)}`);
      }
    })();
    return () => { active = false; };
  }, [enabled, tcw, defaultsAttempt, onAccountReady]);
  const recorder = useVoiceNoteRecorder({ tcw, enabled: enabled !== false && defaultsReady, backendUrl, sessionStore, onSaved, pipeline });
  const { state, dismissOutcome, subscribeLevel, subscribeLevels, record: startRecording } = recorder;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [receiptPlaying, setReceiptPlaying] = useState(false);
  const [receiptActionable, setReceiptActionable] = useState(false);
  const [receiptReady, setReceiptReadyState] = useState(false);
  const [momentFieldFocused, setMomentFieldFocused] = useState(false);
  const [disclosure, setDisclosure] = useState<{ kind: "system-audio"; extras: DesktopCaptureExtras } | { kind: "private" | "powerful"; startAfter: boolean } | null>(null);
  const [disclosureBusy, setDisclosureBusy] = useState(false);
  const [disclosureError, setDisclosureError] = useState<string | null>(null);
  const disclosureOpener = useRef<HTMLElement | null>(null);
  const promptedAccounts = useRef(new Set<string>());
  const setReceiptReady = useCallback(() => setReceiptReadyState(true), []);
  // A new note's receipt starts unready again — each one waits for its own Play control (or
  // load error), not whatever the previous note left behind.
  useEffect(() => { setReceiptReadyState(false); }, [state.lastSaved?.id]);
  const [announcement, setAnnouncement] = useState("");


  // Feedback for each change: a haptic and a polite announcement.
  const previous = useRef(state);
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    const deniedAnnouncement = permissionDeniedAnnouncement(before.permissionDenied, state.permissionDenied);
    if (deniedAnnouncement) {
      hapticWarning();
      setAnnouncement(deniedAnnouncement);
    } else if (before.phase === "starting" && state.phase === "recording") {
      hapticRecordStarted();
      setAnnouncement("Recording started");
    } else if (before.phase === "recording" && state.phase === "recording" && before.mic.state !== state.mic.state) {
      setAnnouncement(recorderStatusText(state.phase, state.mic, null));
    } else if (before.phase === "recording" && state.phase === "recording" && micWarning(before.mic) !== micWarning(state.mic)) {
      setAnnouncement(recorderStatusText(state.phase, state.mic, null));
    } else if (before.outcome !== state.outcome && state.outcome === "local") {
      hapticSaved();
      setAnnouncement(`Saved on ${device}`);
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

  // The receipt clock starts once its content is actually visible — the local Play control, or
  // its load error (receiptReady) — not at commit: a native read slow enough to still be loading
  // must not let the sheet close before the user ever sees it. Playback keeps it open past that.
  // A hard ceiling (RECEIPT_MAX_MS) bounds only the *wait* for that content: it stops counting the
  // instant readiness arrives, so a read that lands late (even near the ceiling itself) still gets
  // its own full, playback-aware RECEIPT_MS window below, not whatever was left of the ceiling.
  useEffect(() => {
    if (state.outcome !== "local" && state.outcome !== "saved") return;
    if (state.permissionDenied) return;
    if (!shouldScheduleReceiptDismissal(state, momentFieldFocused)) return;
    if (receiptReady) return;
    const ceiling = setTimeout(() => {
      setSheetOpen(false);
      dismissOutcome();
    }, RECEIPT_MAX_MS);
    return () => clearTimeout(ceiling);
  }, [dismissOutcome, momentFieldFocused, receiptReady, state.outcome, state.lastSaved, state.permissionDenied, state.limitNotice]);

  useEffect(() => {
    if (state.outcome !== "local" && state.outcome !== "saved") return;
    if (state.permissionDenied) return;
    if (!shouldScheduleReceiptDismissal(state, momentFieldFocused)) return;
    if (!receiptReady) return;
    if (receiptPlaying) return;
    const timer = setTimeout(() => {
      setSheetOpen(false);
      dismissOutcome();
    }, receiptWindowMs(receiptActionable));
    return () => clearTimeout(timer);
  }, [dismissOutcome, momentFieldFocused, receiptActionable, receiptPlaying, receiptReady, state.outcome, state.lastSaved, state.permissionDenied, state.limitNotice]);

  useEffect(() => recorder.setOnPresent(() => setSheetOpen(true)), [recorder.setOnPresent]);

  const beginRecording = useCallback(() => {
    setMomentFieldFocused(false);
    setSheetOpen(true);
    startRecording();
  }, [startRecording]);
  const maybePromptPrivate = useCallback((startAfter: boolean) => {
    const did = tcw?.did;
    if (!did || !recorder.transcription || recorder.transcription.consented) return false;
    if (promptedAccounts.current.has(did) || privateConsentWasPrompted(did)) return false;
    promptedAccounts.current.add(did);
    markPrivateConsentPrompted(did);
    setDisclosure({ kind: "private", startAfter });
    return true;
  }, [tcw?.did, recorder.transcription]);
  const maybePromptPowerful = useCallback((startAfter: boolean) => {
    if (!tcw?.did || recorder.transcription?.powerfulConsented) return false;
    setDisclosure({ kind: "powerful", startAfter });
    return true;
  }, [tcw?.did, recorder.transcription?.powerfulConsented]);
  const afterSystemAudio = useCallback(() => {
    if (recorder.transcriber.id === "private-cloud" && maybePromptPrivate(true)) return;
    if (recorder.transcriber.id === "assemblyai" && maybePromptPowerful(true)) return;
    beginRecording();
  }, [beginRecording, maybePromptPrivate, maybePromptPowerful, recorder.transcriber.id]);
  const record = useCallback(() => {
    if (disclosureBusy || disclosure) return;
    disclosureOpener.current = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDisclosureError(null);
    if (platform !== "tauri") { afterSystemAudio(); return; }
    setDisclosureBusy(true);
    void (async () => {
      try {
        const extras = getDesktopCaptureExtras();
        if (!extras) throw Object.assign(new Error("System audio consent is unavailable."), { code: "system_audio_consent_unavailable" as const });
        if (await needsSystemAudioDisclosure(extras)) setDisclosure({ kind: "system-audio", extras });
        else afterSystemAudio();
      } catch (error) {
        setDisclosureError(`Could not start recording: ${readableError(error)}`);
      } finally { setDisclosureBusy(false); }
    })();
  }, [afterSystemAudio, disclosure, disclosureBusy, platform]);
  const reviewPrivateConsent = useCallback(() => {
    disclosureOpener.current = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDisclosureError(null);
    setDisclosure({ kind: "private", startAfter: false });
  }, []);
  useEffect(() => {
    const accountDid = tcw?.did;
    const transcription = recorder.transcription;
    if (!accountDid || !state.ready || state.phase !== "idle" || !transcription || transcription.consented || disclosure || disclosureBusy) return;
    if (![...transcription.jobs.values()].some((job) => job.kind === "blocked")) return;
    disclosureOpener.current = null;
    maybePromptPrivate(false);
  }, [tcw?.did, recorder.transcription, state.ready, state.phase, disclosure, disclosureBusy, maybePromptPrivate]);
  const chooseAudio = useCallback((choice: "record" | "mic-only") => {
    if (disclosure?.kind !== "system-audio" || disclosureBusy) return;
    setDisclosureBusy(true);
    void chooseSystemAudio(disclosure.extras, choice).then(() => {
      setDisclosure(null);
      afterSystemAudio();
    }, (error: unknown) => setDisclosureError(`Could not save your choice: ${readableError(error)}`))
      .finally(() => setDisclosureBusy(false));
  }, [afterSystemAudio, disclosure, disclosureBusy]);
  const closePrivate = useCallback((confirmed: boolean) => {
    if (disclosure?.kind !== "private" && disclosure?.kind !== "powerful") return;
    if (confirmed) {
      if (disclosure.kind === "powerful") recorder.transcription?.onPowerfulConsent?.();
      else recorder.transcription?.onConsent();
    }
    const startAfter = disclosure.startAfter;
    setDisclosure(null);
    if (startAfter && confirmed) beginRecording();
  }, [beginRecording, disclosure, recorder.transcription]);
  const dismiss = useCallback(() => {
    setMomentFieldFocused(false);
    setSheetOpen(false);
    dismissOutcome();
  }, [dismissOutcome]);
  const openSheet = useCallback(() => setSheetOpen(true), []);
  useLimitNotifications(state, openSheet);
  const minimiseSheet = useCallback(async () => {
    if (state.permissionDenied) await recorder.dismissShortcutRecovery();
    setMomentFieldFocused(false);
    setSheetOpen(false);
  }, [recorder.dismissShortcutRecovery, state.permissionDenied]);

  const signIn = useMemo(() => {
    if (!onSignIn) return null;
    if (!minimiseOnSignIn) return onSignIn;
    return async () => {
      await minimiseSheet();
      await onSignIn();
    };
  }, [minimiseOnSignIn, minimiseSheet, onSignIn]);

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
      elapsedAt: state.elapsedAt,
      captureIssues: state.captureIssues,
      dismissCaptureIssue: recorder.dismissCaptureIssue,
      recoveryScanFailure: state.recoveryScanFailure,
      controlPending: state.controlPending,
      captureSourceUnconfirmed: state.captureSourceUnconfirmed,
      maxDurationMs: state.maxDurationMs,
      autoStop: state.autoStop,
      limitNotice: state.limitNotice,
      savePercent: state.savePercent,
      error: state.error ?? defaultsError,
      outcome: state.outcome,
      localUpload: state.localUpload,
      localUploadHeldReason: state.localUploadHeldReason,
      lastSaved: state.lastSaved,
      ...recordingIdentity(state),
      pending: recorder.pending,
      transcription: recorder.transcription,
      transcriber: recorder.transcriber,
      note: recorder.note,
      noteStatus: recorder.noteStatus,
      noteSyncError: recorder.noteSyncError,
      setNoteText: recorder.setNoteText,
      markMoment: recorder.markMoment,
      setMomentFieldFocused,
      setTranscriber: recorder.setTranscriber,
      setIdentifySpeakers: recorder.setIdentifySpeakers,
      signedIn: tcw?.did != null,
      signIn,
      tcw,
      sheetOpen,
      record,
      reviewPrivateConsent,
      stop: recorder.stop,
      pause: recorder.pause,
      resume: recorder.resume,
      discard: recorder.discard,
      retryPending: recorder.retryPending,
      openSettings: recorder.openSettings,
      extendLimit: recorder.extendLimit,
      dismissOutcome: dismiss,
      openSheet,
      minimiseSheet,
      setReceiptPlaying,
      setReceiptActionable,
      setReceiptReady,
      subscribeLevel,
      subscribeLevels,
    }),
    [
      dismiss,
      minimiseSheet,
      openSheet,
      record,
      reviewPrivateConsent,
      recorder.available,
      recorder.discard,
      recorder.dismissCaptureIssue,
      recorder.note,
      recorder.noteStatus,
      recorder.noteSyncError,
      recorder.setNoteText,
      recorder.markMoment,
      setMomentFieldFocused,
      recorder.pending,
      recorder.retryPending,
      recorder.openSettings,
      recorder.extendLimit,
      recorder.stop,
      recorder.pause,
      recorder.resume,
      recorder.transcription,
      recorder.transcriber,
      recorder.setTranscriber,
      recorder.setIdentifySpeakers,
      defaultsError,
      signIn,
      tcw,
      setReceiptReady,
      sheetOpen,
      state,
      subscribeLevel,
      subscribeLevels,
      tcw?.did,
    ],
  );

  return (
    <RecorderContext.Provider value={value}>
      {children}
      {disclosureError && !disclosure && <p role="alert">{disclosureError}</p>}
      {disclosure && <div className="dch-system-audio" data-testid={disclosure.kind === "system-audio" ? "system-audio-disclosure" : disclosure.kind === "powerful" ? "powerful-consent-disclosure" : "private-consent-disclosure"}>
        <SheetDialog role="dialog" titleId={disclosureTitleId} descriptionId={disclosureDescriptionId}
          title={disclosure.kind === "system-audio" ? SYSTEM_AUDIO_TITLE : disclosure.kind === "powerful" ? POWERFUL_CONSENT_TITLE : PRIVATE_CONSENT_TITLE}
          description={disclosure.kind === "system-audio" ? SYSTEM_AUDIO_BODY : disclosure.kind === "powerful" ? POWERFUL_CONSENT_BODY : privateConsentBody(privateConsentDevice(platform))}
          onCancel={() => disclosure.kind === "system-audio" ? setDisclosure(null) : closePrivate(false)} returnFocus={disclosureOpener}>
          {disclosureError && <p role="alert">{disclosureError}</p>}
          <div className="dch-system-audio-actions">
            {disclosure.kind === "system-audio" ? <>
              <Button type="button" variant="outline" data-initial="" disabled={disclosureBusy} onClick={() => chooseAudio("mic-only")}>{SYSTEM_AUDIO_MIC_ONLY}</Button>
              <Button type="button" disabled={disclosureBusy} onClick={() => chooseAudio("record")}>{SYSTEM_AUDIO_RECORD}</Button>
            </> : <>
              <Button type="button" variant="outline" data-initial="" onClick={() => closePrivate(false)}>Not now</Button>
              <Button type="button" onClick={() => closePrivate(true)}>{disclosure.kind === "powerful" ? POWERFUL_CONSENT_ACTION : PRIVATE_CONSENT_ACTION}</Button>
            </>}
          </div>
        </SheetDialog>
      </div>}
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

/** The live provider's read-only passthrough of the ids that tie an error line to its recording. */
export function recordingIdentity(
  state: Pick<RecorderState, "recordingId" | "failedRecording" | "finalizationPendingId">,
): Pick<RecorderValue, "recordingId" | "failedRecording" | "finalizationPendingId"> {
  return {
    recordingId: state.recordingId,
    failedRecording: state.failedRecording,
    finalizationPendingId: state.finalizationPendingId,
  };
}

const NO_PENDING: PendingSnapshot = { listing: { state: "ok", count: 0 }, running: false, lastError: null, uploadingId: null, online: true };
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
      elapsedAt: null,
      captureIssues: {},
      dismissCaptureIssue: () => false,
      recoveryScanFailure: null,
      captureSourceUnconfirmed: false,
      controlPending: null,
      maxDurationMs: VOICE_NOTE_MAX_DURATION_MS,
      autoStop: true,
      limitNotice: null,
      savePercent: null,
      error: null,
      outcome: null,
      localUpload: null,
      lastSaved: null,
      recordingId: null,
      failedRecording: null,
      finalizationPendingId: null,
      pending: NO_PENDING,
      transcription: undefined,
      transcriber: { id: "on-device", identifySpeakers: false, source: "default" },
      note: null,
      noteStatus: "ready",
      noteSyncError: null,
      setNoteText: async () => {},
      markMoment: () => 0,
      setMomentFieldFocused: noop,
      setTranscriber: async () => "unavailable",
      setIdentifySpeakers: async () => "unavailable",
      signedIn: true,
      signIn: null,
      tcw: null,
      sheetOpen: false,
      record: noop,
      reviewPrivateConsent: noop,
      stop: noop,
      pause: noop,
      resume: noop,
      discard: noop,
      retryPending: noop,
      openSettings: async () => {},
      extendLimit: undefined,
      dismissOutcome: noop,
      openSheet: noop,
      minimiseSheet: noop,
      setReceiptPlaying: noop,
      setReceiptActionable: noop,
      setReceiptReady: noop,
      subscribeLevel: (listener) => {
        for (const level of levels ?? []) listener(level);
        return noop;
      },
      subscribeLevels: () => noop,
      ...patch,
    }),
    [levels, patch],
  );
  return <RecorderContext.Provider value={value}>{props.children}</RecorderContext.Provider>;
}
