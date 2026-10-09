import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { hapticLight } from "@/lib/haptics";
import { PlatformContext } from "@/lib/platform";
import { useResolvedTheme } from "@/lib/theme";
import { useRecorder, type RecorderValue } from "../../RecorderProvider";
import type { RecorderState } from "../../recorderReducer";
import { useRecordedElapsed } from "../../useRecordedElapsed";
import { ModesCard } from "../ModesCard";
import { PrivacyScale } from "../PrivacyScale";
import { selectRecorderView } from "../recorderView";
import {
  recorderSizing,
  shellForPlatform,
  type RecorderLayout,
} from "../shellCapabilities";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  InfoChevronIcon,
  PauseIcon,
  PlayIcon,
} from "../softIcons";
import {
  modeShortLabel,
  identifySpeakersControl,
  MODE_STOPS,
} from "../transcriptionModes";
import { useAudioInputs, type AudioInputsSource } from "../useAudioInputs";
import { useSilencedSince } from "../useSilencedSince";
import {
  useOnDeviceModel,
  useTranscriptionChoice,
} from "../useTranscriptionChoice";
// TODO(#191): delete the local stub; read `transcriber`, `setTranscriber` and `setIdentifySpeakers` from `useRecorder()`.
import { useTranscriberApi, type TranscriberApi } from "../transcriberApiStub";
import { ViaMenu } from "../ViaMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { DesktopRing } from "./DesktopRing";
import { Toasts, showToast } from "./Toasts";
import "../soft.css";
import "../phone.css";
import "./desktop.css";

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

// TODO(TC-878): `useRecorder()` has no note yet; read it from the recorder once it does.
type RecorderWithNote = RecorderValue & { note?: { md: string } | null };

function PencilIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />
      <path d="M14.5 6.5l3 3" />
    </svg>
  );
}

/** The ring size and timer size for the room this view has: the main area's height, not the window's. */
function useSizing(root: React.RefObject<HTMLElement | null>) {
  // The layout effect below measures the real height before the first paint.
  const [sizing, setSizing] = useState(() => recorderSizing(1024, 700));
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const next = recorderSizing(window.innerWidth, element.clientHeight);
      setSizing((current) =>
        current.ringPx === next.ringPx && current.timerPx === next.timerPx
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  return sizing;
}

export interface DesktopRecorderProps {
  /** The rail (768–1023) or the desktop layout (1024 and up); both use these sizes. */
  layout: Exclude<RecorderLayout, "phone">;
  /** Opens the note view; without it there is no Write notes button. */
  onOpenNotes?: () => void;
}

/** What the screenshot harness sets in the view's place; the app never provides it. */
export interface DesktopRecorderSeed {
  /** Where the microphone list comes from; the native plugin unless a harness says otherwise. */
  inputs?: AudioInputsSource | null;
  /** Starts the silence timer earlier than now. */
  silencedSinceMs?: number | null;
  /** The provider's transcriber API; the stand-in until the provider has it. */
  transcriberApi?: TranscriberApi;
  /** Starts with one surface open. */
  defaultOpen?: "modes" | "via" | "discard";
}

export const DesktopRecorderSeedContext = createContext<DesktopRecorderSeed>({});

export function DesktopRecorder({ layout, onOpenNotes }: DesktopRecorderProps) {
  const {
    inputs: inputsSource,
    silencedSinceMs: silencedSeed = null,
    transcriberApi,
    defaultOpen,
  } = useContext(DesktopRecorderSeedContext);
  const recorder = useRecorder() as RecorderWithNote;
  const shell = shellForPlatform(useContext(PlatformContext));
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  const { phase, mic } = recorder;
  const root = useRef<HTMLDivElement>(null);
  const { ringPx, timerPx } = useSizing(root);
  // The view replaces a dock, a ribbon or the loading surface, which held focus, so focus moves into it.
  useEffect(() => root.current?.focus({ preventScroll: true }), []);

  const elapsedMs = useRecordedElapsed(recorder.elapsedMs, recorder);
  const silent =
    phase === "recording" &&
    (mic.state === "silenced" ||
      (mic.state === "recording" && mic.reason === "no_signal"));
  const silencedSinceMs = useSilencedSince(silent, silencedSeed);

  const audio = useAudioInputs(inputsSource);
  const input = mic.input ?? audio.current;
  const onDevice = useOnDeviceModel();
  // TODO(TC-781 transcriber API): read these from `recorder` once the provider has them.
  const stubbedApi = useTranscriberApi(recorder.transcription);
  const choice = useTranscriptionChoice({
    shell,
    transcription: recorder.transcription,
    model: onDevice.model,
    transcriber: transcriberApi ?? stubbedApi,
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
  // What opened the consent dialog: the scale, the caption link, or the modes card's button.
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
  const dialogOpen = discardOpen || choice.asking;
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
  const hasNotes = (recorder.note?.md ?? "").length > 0;

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
      ref={root}
      role="region"
      aria-label="Recorder"
      tabIndex={-1}
      className={`soft-skin soft-${theme} pr dr`}
      data-layout={layout}
      data-testid="desktop-recorder"
      data-ring={view.ring}
      data-compact={ringPx === 172}
      style={
        {
          "--dr-ring": `${ringPx}px`,
          "--dr-time": `${timerPx}px`,
        } as CSSProperties
      }
    >
      <div className="pr-blob a" aria-hidden="true" />
      <div className="pr-blob b" aria-hidden="true" />
      <p
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="desktop-recorder-announcer"
      >
        {said}
      </p>
      <Toasts />

      <div className="pr-main dr-main" inert={dialogOpen}>
        <div className="pr-top">
          <button
            type="button"
            className="pr-ibtn"
            aria-label="Minimise recorder"
            onClick={() => void recorder.minimiseSheet()}
          >
            <ChevronDownIcon size={19} />
          </button>
          <div className="pr-pill" data-testid="desktop-recorder-pill">
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
          </div>
          {view.timer.countdown && (
            <div className="pr-countdown">{view.timer.countdown.text}</div>
          )}
        </div>
        <div
          className="pr-extra"
          data-emphasis={mustSave}
          data-testid="desktop-recorder-status"
        >
          {view.statusLine}
        </div>
        {onOpenNotes && (
          <button type="button" className="dr-notes" onClick={onOpenNotes}>
            <PencilIcon />
            {hasNotes ? "View notes" : "Write notes"}
          </button>
        )}

        <div className="pr-stage">
          <DesktopRing
            ring={view.ring}
            flat={view.flat}
            theme={theme}
            size={ringPx}
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
            <span className="dr-anchor">
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
            </span>
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
        {denied ? (
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
            <button
              type="button"
              className="pr-b main"
              data-emphasis={mustSave}
              disabled={!(view.controls.stop || stopUnknown)}
              onClick={() => control("stop")}
            >
              <CheckIcon />
              Done
            </button>
          </div>
        )}
      </div>

      {discardOpen && (
        <ConfirmDialog
          titleId={`${ids}-dt`}
          descriptionId={`${ids}-dd`}
          title="Discard this recording?"
          description={`You'll lose ${view.timer.text} of audio. This can't be undone.`}
          keep={{
            label: "Keep recording",
            onPress: () => setDiscardOpen(false),
          }}
          other={{
            label: "Discard recording",
            tone: "danger",
            onPress: () => {
              setDiscardOpen(false);
              control("discard");
            },
          }}
          returnFocus={discardButton}
        />
      )}
      {choice.asking && (
        <ConfirmDialog
          role="dialog"
          titleId={`${ids}-ct`}
          descriptionId={`${ids}-cd`}
          title="Use private cloud?"
          description={`After you stop, TinyCloud Private Transcription turns notes up to ${choice.maxMinutes} minutes into text.`}
          keep={{
            label: "Use private cloud",
            onPress: choice.confirmConsent,
          }}
          other={{
            label: "Not now",
            tone: "dim",
            onPress: choice.dismissConsent,
          }}
          onCancel={choice.dismissConsent}
          returnFocus={consentOpener}
          fallbackFocus={scale}
        >
          <HowItWorksLink section="transcription" />
        </ConfirmDialog>
      )}
    </div>
  );
}
