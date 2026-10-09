import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { hapticLight } from "@/lib/haptics";
import { PlatformContext } from "@/lib/platform";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder, type RecorderValue } from "../RecorderProvider";
import type { RecorderState } from "../recorderReducer";
import { useRecordedElapsed } from "../useRecordedElapsed";
import { ModesCard } from "./ModesCard";
import { PrivacyScale } from "./PrivacyScale";
import { RecorderRing } from "./RecorderRing";
import { selectRecorderView } from "./recorderView";
import { shellForPlatform } from "./shellCapabilities";
import { SheetDialog } from "./SheetDialog";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  InfoChevronIcon,
  PauseIcon,
  PlayIcon,
} from "./softIcons";
import {
  modeShortLabel,
  identifySpeakersControl,
  MODE_STOPS,
} from "./transcriptionModes";
import { useAudioInputs, type AudioInputsSource } from "./useAudioInputs";
import { useSilencedSince } from "./useSilencedSince";
import {
  useOnDeviceModel,
  useTranscriptionChoice,
  type TranscriberApi,
} from "./useTranscriptionChoice";
import { ViaMenu } from "./ViaMenu";
import "./soft.css";
import "./phone.css";

const TOAST_MS = 2400;

/** What the selector reads of the recorder; the fields it does not use are inert. */
function recorderState(recorder: RecorderValue): RecorderState {
  return {
    phase: recorder.phase,
    recordingId: null,
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

export interface PhoneRecorderProps {
  /** Where the microphone list comes from; the native plugin unless a harness says otherwise. */
  inputs?: AudioInputsSource | null;
  /** Starts the silence timer earlier than now (the harness). */
  silencedSinceMs?: number | null;
  /** Replaces the provider's transcriber API (the harness passes a logging one). */
  transcriberApi?: TranscriberApi;
  /** Starts with one surface open (the harness). */
  defaultOpen?: "modes" | "via" | "discard";
}

export function PhoneRecorder({
  inputs: inputsSource,
  silencedSinceMs: silencedSeed = null,
  transcriberApi,
  defaultOpen,
}: PhoneRecorderProps) {
  const recorder = useRecorder();
  const shell = shellForPlatform(useContext(PlatformContext));
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  const { phase, mic } = recorder;

  const elapsedMs = useRecordedElapsed(recorder.elapsedMs, recorder);
  const silent =
    phase === "recording" &&
    (mic.state === "silenced" ||
      (mic.state === "recording" && mic.reason === "no_signal"));
  const silencedSinceMs = useSilencedSince(silent, silencedSeed);

  const [toast, setToast] = useState<{ message: string; key: number } | null>(
    null,
  );
  const showToast = (message: string) => setToast({ message, key: Date.now() });

  const audio = useAudioInputs(inputsSource);
  const input = mic.input ?? audio.current;
  const onDevice = useOnDeviceModel();
  const choice = useTranscriptionChoice({
    shell,
    transcription: recorder.transcription,
    model: onDevice.model,
    transcriber: transcriberApi ?? recorder,
    notify: showToast,
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
  // What opened the consent sheet: the scale, the caption link, or the modes card's button.
  const consentOpener = useRef<HTMLElement | null>(null);
  const ids = useId();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

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
      showToast(reason);
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

  return (
    <div
      className={`soft-skin soft-${theme === "night" ? "night" : "day"} pr`}
      data-layout="phone"
      data-testid="phone-recorder"
      data-ring={view.ring}
    >
      <div className="pr-blob a" aria-hidden="true" />
      <div className="pr-blob b" aria-hidden="true" />
      <p
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="phone-recorder-announcer"
      >
        {said}
      </p>

      <div
        className="pr-main"
        inert={sheetOpen}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          flex: 1,
          minHeight: 0,
          width: "100%",
        }}
      >
        <div className="pr-top">
          <button
            type="button"
            className="pr-ibtn"
            aria-label="Minimise recorder"
            onClick={() => void recorder.minimiseSheet()}
          >
            <ChevronDownIcon size={19} />
          </button>
          <div className="pr-pill" data-testid="phone-recorder-pill">
            <span
              className="pr-dot"
              data-dot={view.pill.dot}
              aria-hidden="true"
            />
            <span>{view.pill.label}</span>
          </div>
        </div>

        <div className="pr-time-row">
          <div
            className="pr-time soft-timer"
            role="timer"
            data-dim={view.ring === "paused"}
          >
            <span>{view.timer.text}</span>
            <span className="pr-time-slot" aria-hidden="true" />
          </div>
          {view.timer.countdown && (
            <div className="pr-countdown">{view.timer.countdown.text}</div>
          )}
        </div>
        <div
          className="pr-extra"
          data-emphasis={mustSave}
          data-testid="phone-recorder-status"
        >
          {view.statusLine}
        </div>

        <div className="pr-stage">
          <RecorderRing
            ring={view.ring}
            flat={view.flat}
            theme={theme}
            subscribeLevel={recorder.subscribeLevel}
            action={ringAction}
            glyph={
              ringKind === "pause"
                ? "pause"
                : ringKind === "resume"
                  ? "play"
                  : null
            }
          />
        </div>

        <div className="pr-controls-wrap">
          <div className="pr-mrow">
            <button
              ref={opener}
              type="button"
              className="pr-minfo"
              aria-label="Transcription modes: compare and choose"
              aria-expanded={modesOpen}
              aria-haspopup="dialog"
              aria-controls={`${ids}-modes`}
              onClick={() => (modesOpen ? closeModes() : setModesOpen(true))}
            >
              <InfoChevronIcon />
            </button>
            <span className="pr-mname soft-title">
              {modeShortLabel(
                choice.mode,
                choice.identifySpeakers && !speakers.disabled,
              )}
            </span>
            <span className="pr-mshort">{stop.subLabel[shell]}</span>
          </div>
          <PrivacyScale
            ref={scale}
            stops={choice.stops}
            mode={choice.mode}
            onChoose={(id) => {
              consentOpener.current = scale.current;
              return choose(id);
            }}
            step={choice.step}
            onUnavailable={() => {}}
          />
          <div className="pr-ends" aria-hidden="true">
            <span>more private</span>
            <span>more capable</span>
          </div>
          <div className="pr-capline">{stop.captions[shell]}</div>
          {!idleDenied && !audio.unsupported && (
            <ViaMenu
              inputs={audio.inputs}
              currentId={input?.id ?? null}
              currentName={inputName}
              recording={view.ring === "live"}
              theme={theme}
              subscribeLevel={recorder.subscribeLevel}
              emphasis={view.emphasis === "input"}
              disabled={view.controls.busy}
              defaultOpen={defaultOpen === "via"}
              onSelect={(id) => void audio.select(id)}
            />
          )}
          {modesOpen && (
            <div id={`${ids}-modes`} style={{ display: "contents" }}>
              <ModesCard
                stops={choice.stops}
                mode={choice.mode}
                shell={shell}
                identifySpeakers={choice.identifySpeakers}
                opener={opener}
                onClose={closeModes}
                onChoose={(id) => {
                  consentOpener.current = opener.current;
                  if (choose(id) === null) closeModes();
                }}
                onToggleSpeakers={choice.setIdentifySpeakers}
              />
            </div>
          )}
        </div>

        {alerts.map(({ message, retry }) => (
          <p key={message} className="pr-alert" role="alert">
            {message}
            {retry && (
              <button type="button" className="pr-retry" onClick={retry}>
                Try again
              </button>
            )}
          </p>
        ))}
        {idleDenied ? (
          <div className="pr-controls">
            <button
              type="button"
              className="pr-b primary"
              onClick={openSettings}
            >
              Open Settings
            </button>
          </div>
        ) : (
          <>
            {view.controls.openSettings && (
              <div className="pr-controls" style={{ paddingBottom: 0 }}>
                <button
                  type="button"
                  className="pr-b primary"
                  onClick={openSettings}
                >
                  Open Settings
                </button>
              </div>
            )}
            <div className="pr-controls">
              <button
                ref={discardButton}
                type="button"
                className="pr-b"
                aria-label="Discard recording"
                disabled={!(view.controls.discard || discardUnknown)}
                onClick={() => setDiscardOpen(true)}
              >
                <CloseIcon />
              </button>
              {!denied && (
                <button
                  type="button"
                  className="pr-b"
                  aria-label={resume ? "Resume recording" : "Pause recording"}
                  disabled={!(resume || view.controls.pause)}
                  onClick={() => {
                    hapticLight();
                    control(resume ? "resume" : "pause");
                  }}
                >
                  {resume ? <PlayIcon /> : <PauseIcon />}
                </button>
              )}
              <button
                type="button"
                className="pr-b main"
                data-emphasis={mustSave}
                data-secondary={view.controls.openSettings}
                disabled={!(view.controls.stop || stopUnknown)}
                onClick={() => control("stop")}
              >
                <CheckIcon />
                Done
              </button>
            </div>
          </>
        )}
      </div>

      {discardOpen && (
        <SheetDialog
          role="alertdialog"
          titleId={`${ids}-dt`}
          descriptionId={`${ids}-dd`}
          title="Discard this recording?"
          description={`You'll lose ${view.timer.text} of audio. This can't be undone.`}
          onCancel={() => setDiscardOpen(false)}
          returnFocus={discardButton}
        >
          <button
            type="button"
            className="pr-keep"
            data-initial=""
            onClick={() => setDiscardOpen(false)}
          >
            Keep recording
          </button>
          <button
            type="button"
            className="pr-discard"
            onClick={() => {
              setDiscardOpen(false);
              control("discard");
            }}
          >
            Discard recording
          </button>
        </SheetDialog>
      )}
      {choice.asking && (
        <SheetDialog
          role="dialog"
          titleId={`${ids}-ct`}
          descriptionId={`${ids}-cd`}
          title="Use private cloud?"
          description={`After you stop, TinyCloud Private Transcription turns notes up to ${choice.maxMinutes} minutes into text.`}
          onCancel={choice.dismissConsent}
          returnFocus={consentOpener}
          fallbackFocus={scale}
        >
          <button
            type="button"
            className="pr-keep"
            data-initial=""
            onClick={choice.confirmConsent}
          >
            Use private cloud
          </button>
          <button
            type="button"
            className="pr-discard"
            style={{ color: "var(--dim)" }}
            onClick={choice.dismissConsent}
          >
            Not now
          </button>
          <HowItWorksLink section="transcription" />
        </SheetDialog>
      )}

      {toast && (
        <div key={toast.key} className="pr-toast" role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
