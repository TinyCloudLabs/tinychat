import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { hapticLight } from "@/lib/haptics";
import { ModesCard } from "../ModesCard";
import { PrivacyScale } from "../PrivacyScale";
import { recorderSizing, type RecorderLayout } from "../shellCapabilities";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  InfoChevronIcon,
  PauseIcon,
  PlayIcon,
} from "../softIcons";
import { NOTES_COPY } from "../notesCopy";
import { modeShortLabel } from "../transcriptionModes";
import type { AudioInputsSource } from "../useAudioInputs";
import { useFinalRecorderControls } from "../useFinalRecorderControls";
import { MicDeniedAction } from "../shell/MicDeniedAction";
import type { TranscriberApi } from "../useTranscriptionChoice";
import { ViaMenu } from "../ViaMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { DesktopRing } from "./DesktopRing";
import { Toasts, showToast } from "./Toasts";
import "../soft.css";
import "../phone.css";
import "./desktop.css";

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
  /** The last write of the note failed: the notes button says so, and so does an alert. */
  noteSaveFailed?: boolean;
  /** Done: the owner saves the note first, then calls `stop`. Without it Done stops at once. */
  onDone?: (stop: () => void) => void;
}

/** What the screenshot harness sets in the view's place; the app never provides it. */
export interface DesktopRecorderSeed {
  /** Where the microphone list comes from; the native plugin unless a harness says otherwise. */
  inputs?: AudioInputsSource | null;
  /** Starts the silence timer earlier than now. */
  silencedSinceMs?: number | null;
  /** Replaces the provider's transcriber API (the harness passes a logging one). */
  transcriberApi?: TranscriberApi;
  /** Starts with one surface open. */
  defaultOpen?: "modes" | "via" | "discard";
}

export const DesktopRecorderSeedContext = createContext<DesktopRecorderSeed>({});

export function DesktopRecorder({
  layout,
  onOpenNotes,
  noteSaveFailed = false,
  onDone,
}: DesktopRecorderProps) {
  const {
    inputs: inputsSource,
    silencedSinceMs: silencedSeed = null,
    transcriberApi,
    defaultOpen,
  } = useContext(DesktopRecorderSeedContext);
  const {
    recorder,
    shell,
    theme,
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
      open: dialogOpen,
      opener,
      scale,
      discardButton,
      consentOpener,
      ids,
    },
  } = useFinalRecorderControls({
    inputs: inputsSource,
    silencedSinceMs: silencedSeed,
    transcriberApi,
    defaultOpen,
    notify: showToast,
  });
  const root = useRef<HTMLDivElement>(null);
  const { ringPx, timerPx } = useSizing(root);
  // The view replaces a dock, a ribbon or the loading surface, which held focus, so focus moves into it.
  useEffect(() => root.current?.focus({ preventScroll: true }), []);
  const hasNotes = (recorder.note?.md ?? "").length > 0;

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
          <button
            type="button"
            className="dr-notes"
            data-failed={noteSaveFailed || undefined}
            onClick={onOpenNotes}
          >
            <PencilIcon />
            {noteSaveFailed
              ? NOTES_COPY.noteNotSaved
              : hasNotes
                ? "View notes"
                : "Write notes"}
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

        {noteSaveFailed && (
          <p className="pr-alert" role="alert">
            {NOTES_COPY.noteNotSavedAlert}
          </p>
        )}
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
            <MicDeniedAction
              idle={idleDenied}
              onOpenSettings={openSettings}
              onTryAgain={recorder.record}
            />
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
              onClick={() =>
                onDone ? onDone(() => control("stop")) : control("stop")
              }
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
