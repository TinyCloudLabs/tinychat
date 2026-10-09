import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { hapticLight } from "@/lib/haptics";
import { PlatformContext } from "@/lib/platform";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder, type RecorderValue } from "../RecorderProvider";
import type { RecorderState } from "../recorderReducer";
import { useRecordedElapsed } from "../useRecordedElapsed";
import { selectRecorderView } from "./recorderView";
import { shellForPlatform } from "./shellCapabilities";
import {
  identifySpeakersControl,
  modeShortLabel,
  MODE_STOPS,
} from "./transcriptionModes";
import { useAudioInputs, type AudioInputsSource } from "./useAudioInputs";
import { useSilencedSince } from "./useSilencedSince";
import {
  useOnDeviceModel,
  useTranscriptionChoice,
  type TranscriberApi,
} from "./useTranscriptionChoice";

/** What the selector reads of the recorder; the fields it does not use are inert. */
export function recorderState(recorder: RecorderValue): RecorderState {
  return {
    phase: recorder.phase,
    recordingId: null,
    finalizationPendingId: null,
    startedAt: recorder.startedAt,
    audioMs: recorder.audioMs,
    elapsedMs: recorder.elapsedMs,
    elapsedAt: recorder.elapsedAt,
    maxDurationMs: recorder.maxDurationMs,
    mic: recorder.mic,
    controlPending: recorder.controlPending,
    limitNotice: recorder.limitNotice,
    savePercent: recorder.savePercent,
    error: recorder.error,
    outcome: recorder.outcome,
    localUpload: recorder.localUpload,
    lastSaved: recorder.lastSaved,
    failedRecording: null,
    autoSaving: false,
    ready: recorder.ready,
    permissionDenied: recorder.permissionDenied,
    captureIssues: {},
    recoveryScanFailure: null,
  };
}

export interface FinalRecorderControlsOptions {
  /** Where the microphone list comes from; the native plugin unless a harness says otherwise. */
  inputs?: AudioInputsSource | null;
  /** Starts the silence timer earlier than now (the harness). */
  silencedSinceMs?: number | null;
  /** Replaces the provider's transcriber API (the harness passes a logging one). */
  transcriberApi?: TranscriberApi;
  /** Starts with one surface open (the harness). */
  defaultOpen?: "modes" | "via" | "discard";
  /** Tells the user something that did not work; each surface shows it its own way. */
  notify: (message: string) => void;
}

/**
 * Everything the phone and desktop recorder views share: the recorder's view
 * model, the microphone list, the privacy scale's choice, the control calls, the
 * alerts and the state of the surfaces that open over the view. What differs
 * between the views is only how they lay this out.
 */
export function useFinalRecorderControls({
  inputs: inputsSource,
  silencedSinceMs: silencedSeed = null,
  transcriberApi,
  defaultOpen,
  notify,
}: FinalRecorderControlsOptions) {
  const recorder = useRecorder();
  const shell = shellForPlatform(useContext(PlatformContext));
  const theme: "day" | "night" =
    useResolvedTheme() === "dark" ? "night" : "day";
  const { phase, mic } = recorder;

  const elapsedMs = useRecordedElapsed(recorder.elapsedMs, recorder);
  const silent =
    phase === "recording" &&
    (mic.state === "silenced" ||
      (mic.state === "recording" && mic.reason === "no_signal"));
  const silencedSinceMs = useSilencedSince(silent, silencedSeed);

  const audio = useAudioInputs(inputsSource);
  const input = mic.input ?? audio.current;
  const onDevice = useOnDeviceModel();
  const choice = useTranscriptionChoice({
    shell,
    transcription: recorder.transcription,
    model: onDevice.model,
    transcriber: transcriberApi ?? recorder,
    signedIn: recorder.signedIn,
    notify,
  });

  const view = selectRecorderView(recorderState(recorder), {
    nowMs: Date.now(),
    elapsedMs,
    inputName: input?.name ?? null,
    silencedSinceMs,
  });

  const [modesOpen, setModesOpen] = useState(defaultOpen === "modes");
  const [discardOpen, setDiscardOpen] = useState(defaultOpen === "discard");
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const scale = useRef<HTMLDivElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  // What opened the consent surface: the scale, the caption link, or the modes card's button.
  const consentOpener = useRef<HTMLElement | null>(null);
  const ids = useId();

  // The recorder provider announces every recording transition; this region only says what is new in this screen.
  const [said, setSaid] = useState("");
  const shownMode = useRef(choice.mode);
  useEffect(() => {
    if (shownMode.current === choice.mode) return;
    shownMode.current = choice.mode;
    setSaid(`${modeShortLabel(choice.mode, false)} selected`);
  }, [choice.mode]);

  const closeModes = useCallback(() => {
    setModesOpen(false);
    opener.current?.focus();
  }, []);

  const choose = (id: Parameters<typeof choice.select>[0]) => {
    const changed = id !== choice.mode;
    const reason = choice.select(id);
    if (reason !== null) {
      notify(reason);
      return reason;
    }
    if (changed) hapticLight();
    return null;
  };

  // The controller reports a rejected Pause, Resume, Stop or Discard only as `recorder.error`.
  const lastControl = useRef<string | null>(null);
  const control = (name: "pause" | "resume" | "stop" | "discard") => {
    lastControl.current = name;
    recorder[name]();
  };
  useEffect(() => {
    if (!recorder.error) return;
    console.error(
      `[Recorder] ${lastControl.current ? `${lastControl.current} failed` : "Recorder error"}`,
      { error: recorder.error, phase, mic },
    );
    lastControl.current = null;
  }, [recorder.error]);

  const ringKind =
    view.tapRingAction ??
    (view.ring === "live"
      ? "pause"
      : view.ring === "paused" || view.ring === "still-resumable"
        ? "resume"
        : null);
  const ringAction =
    ringKind === null
      ? null
      : {
          label: ringKind === "pause" ? "Pause recording" : "Resume recording",
          disabled: view.tapRingAction === null,
          onPress: () => {
            hapticLight();
            control(ringKind);
          },
        };

  const stop = MODE_STOPS.find((s) => s.id === choice.mode)!;
  const sheetOpen = discardOpen || choice.asking;
  const mustSave = view.emphasis === "stop";
  const inputName = input?.name ?? "Microphone";
  const resume = view.controls.resume;
  // A stop or discard whose outcome is unknown stays in its phase with the error; the same control checks again.
  const stopUnknown = phase === "stopping" && recorder.error !== null;
  const discardUnknown = phase === "discarding" && recorder.error !== null;
  const denied = view.micDenied;
  const idleDenied = denied && phase === "idle";
  const speakers = identifySpeakersControl(
    choice.mode,
    choice.identifySpeakers,
  );

  const openSettings = () => {
    setSettingsError(null);
    recorder.openSettings().catch((error: unknown) => {
      console.error("[Recorder] Could not open Settings", error);
      setSettingsError(
        `Could not open Settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };
  const alerts = [
    recorder.error ? { message: recorder.error, retry: undefined } : null,
    settingsError ? { message: settingsError, retry: openSettings } : null,
    audio.error ? { message: audio.error, retry: audio.retry } : null,
    onDevice.error ? { message: onDevice.error, retry: onDevice.retry } : null,
  ].filter((alert) => alert !== null);

  return {
    recorder,
    shell,
    theme,
    phase,
    view,
    choice,
    stop,
    audio,
    input,
    inputName,
    alerts,
    said,
    mustSave,
    resume,
    stopUnknown,
    discardUnknown,
    denied,
    idleDenied,
    speakers,
    ringKind,
    ringAction,
    actions: { choose, control, openSettings, closeModes },
    dialog: {
      modesOpen,
      setModesOpen,
      discardOpen,
      setDiscardOpen,
      /** A dialog is open over the view, so the view behind it is inert. */
      open: sheetOpen,
      opener,
      scale,
      discardButton,
      consentOpener,
      ids,
    },
  };
}
