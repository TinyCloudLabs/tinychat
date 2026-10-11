import {
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
import { useRecorder, type RecorderValue } from "../RecorderProvider";
import type { RecorderState } from "../recorderReducer";
import { useRecordedElapsed } from "../useRecordedElapsed";
import { useKeyboardInset } from "./keyboardInset";
import { ModesCard } from "./ModesCard";
import { MomentField } from "./MomentField";
import { recordingKey, updateNotesUi, useNotesUi, warmRenderer } from "./notes";
import { NOTES_COPY } from "./notesCopy";
import { NotesListIcon, PlusIcon } from "./notesIcons";
import { NotesSheet } from "./NotesSheet";
import {
  readNotesView,
  rememberNotesView,
  type NotesView,
} from "./notesViewPreference";
import { hasNote } from "./momentLines";
import { finishRecording, type DoneGate } from "./doneGate";
import { useMomentFlow } from "./useMomentFlow";
import { useNoteSaver } from "./useNoteSaver";
import { PrivacyScale } from "./PrivacyScale";
import { RecorderRing } from "./RecorderRing";
import { TimerDigits } from "./TimerDigits";
import { selectRecorderView } from "./recorderView";
import { shellForPlatform } from "./shellCapabilities";
import { honestRecorderError } from "./honestRecorderError";
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
  type ModeId,
} from "./transcriptionModes";
import { FINAL_COPY } from "./finalCopy";
import { useAudioInputs, type AudioInputsSource } from "./useAudioInputs";
import { useSilencedSince } from "./useSilencedSince";
import { MicDeniedAction } from "./shell/MicDeniedAction";
import { openSettingsFailedLine } from "./shell/micDeniedCopy";
import type { OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import {
  useOnDeviceModel,
  useTranscriptionChoice,
  type TranscriberApi,
} from "./useTranscriptionChoice";
import { ViaMenu } from "./ViaMenu";
import "./soft.css";
import "./phone.css";

const TOAST_MS = 4200;
/** The notes renderer's WASM is fetched this long into a recording, never when the recorder opens. */
const WARM_RENDERER_MS = 4000;

/** What the selector reads of the recorder; the fields it does not use are inert. */
function recorderState(recorder: RecorderValue): RecorderState {
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

export interface PhoneRecorderProps {
  /** Where the microphone list comes from; the native plugin unless a harness says otherwise. */
  inputs?: AudioInputsSource | null;
  /** Starts the silence timer earlier than now (the harness). */
  silencedSinceMs?: number | null;
  /** Replaces the provider's transcriber API (the harness passes a logging one). */
  transcriberApi?: TranscriberApi;
  /** Starts with one surface open (the harness). */
  defaultOpen?: "modes" | "via" | "discard" | "moment" | "notes";
  /** The notes view remembered from an earlier session (the harness). */
  notesViewSeed?: NotesView;
}

export function PhoneRecorder({
  inputs: inputsSource,
  silencedSinceMs: silencedSeed = null,
  transcriberApi,
  defaultOpen,
  notesViewSeed,
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

  const [toast, setToast] = useState<{
    message: string;
    key: number;
    actions: Array<{ label: string; run: () => void }>;
  } | null>(null);
  const toastElement = useRef<HTMLDivElement | null>(null);
  const toastReturnFocus = useRef<HTMLElement | null>(null);
  const toastKey = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastStartedAt = useRef(0);
  const toastRemaining = useRef(TOAST_MS);
  const toastPauseReasons = useRef(new Set<"pointer" | "focus">());
  const toastActionUsed = useRef(false);
  const modelProgressToastKey = useRef<number | null>(null);
  const modelDownloadStartingFrom = useRef<OnDeviceSttStatus | null>(null);
  const [modelDownloadRequested, setModelDownloadRequested] = useState(false);
  const clearModelProgressToast = (key?: number) => {
    if (
      modelProgressToastKey.current === null ||
      (key !== undefined && modelProgressToastKey.current !== key)
    )
      return;
    modelProgressToastKey.current = null;
    modelDownloadStartingFrom.current = null;
    setModelDownloadRequested(false);
  };
  const showToast = (
    message: string,
    actions: Array<{ label: string; run: () => void }> = [],
  ) => {
    clearModelProgressToast();
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body)
      toastReturnFocus.current = active;
    toastActionUsed.current = false;
    toastPauseReasons.current.clear();
    const key = ++toastKey.current;
    setToast({ message, key, actions });
    return key;
  };
  const sizeToastForDock = useCallback(() => {
    const element = toastElement.current;
    if (!element) return;
    const dock = element.parentElement?.getBoundingClientRect();
    if (!dock) return;

    const toast = element.getBoundingClientRect();
    const protectedElements = document.querySelectorAll<HTMLElement>(
      ".pr-top, .pr-time-row, .pr-extra, .pr-notes, .pr-ring, .pr-stage button, .pr-mrow, .pr-scale",
    );
    const lastProtectedBottom = [...protectedElements].reduce((bottom, item) => {
      if (
        (item.matches(".pr-extra, .pr-notes") && !item.textContent?.trim()) ||
        item.hidden
      )
        return bottom;
      const bounds = item.getBoundingClientRect();
      const overlapsHorizontally =
        toast.left < bounds.right && toast.right > bounds.left;
      return overlapsHorizontally && bounds.top < dock.top
        ? Math.max(bottom, bounds.bottom)
        : bottom;
    }, 0);
    const available = Math.max(0, dock.top - 4 - lastProtectedBottom);
    const actions = element.querySelector<HTMLElement>(".pr-toast-actions");
    const actionsHeight = actions?.getBoundingClientRect().height ?? 0;
    const actionGap = actions ? 4 : 0;

    element.style.setProperty("--pr-toast-max-height", `${available}px`);
    element.style.setProperty(
      "--pr-toast-copy-max-height",
      `${Math.max(0, available - actionsHeight - actionGap)}px`,
    );
  }, []);
  useLayoutEffect(() => {
    const element = toastElement.current;
    if (!element) return;
    const main = element.closest<HTMLElement>(".pr-main");
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sizeToastForDock);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    for (const target of document.querySelectorAll<HTMLElement>(
      ".pr-top, .pr-time-row, .pr-extra, .pr-notes, .pr-ring, .pr-stage button, .pr-mrow, .pr-scale, .pr-dock",
    ))
      observer.observe(target);
    window.addEventListener("resize", schedule);
    main?.addEventListener("scroll", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      main?.removeEventListener("scroll", schedule);
    };
  }, [sizeToastForDock, toast?.key, toast?.message]);
  const showModelProgressToast = () => {
    modelDownloadStartingFrom.current = onDevice.model;
    const key = showToast("Starting the download…");
    modelProgressToastKey.current = key;
    setModelDownloadRequested(true);
  };
  const choiceForToast = useRef<{
    stops: ReturnType<typeof useTranscriptionChoice>["stops"];
    mode: ReturnType<typeof useTranscriptionChoice>["mode"];
  } | null>(null);
  const unavailable = (reason: string, modeId?: ModeId) => {
    const actions: Array<{ label: string; run: () => void }> = [];
    const rejected = choiceForToast.current?.stops.find(
      ({ stop }) => stop.id === modeId,
    );
    if (
      modeId === "local" &&
      rejected &&
      !rejected.available &&
      rejected.action
    ) {
      actions.push({
        label:
          rejected.action.label === FINAL_COPY.modelUnavailable
            ? "Get model"
            : rejected.action.label,
        run: () => {
          showModelProgressToast();
          rejected.action!.run();
        },
      });
    } else if (
      modeId !== undefined &&
      rejected &&
      !rejected.available &&
      rejected.action
    ) {
      actions.push({ label: rejected.action.label, run: rejected.action.run });
    }
    const privateAvailable = choiceForToast.current?.stops.some(
      ({ stop, available }) => stop.id === "private" && available,
    );
    if (
      modeId !== "private" &&
      privateAvailable &&
      choiceForToast.current?.mode !== "private"
    ) {
      actions.push({
        label: "Use Private",
        run: () => {
          consentOpener.current = toastReturnFocus.current?.isConnected
            ? toastReturnFocus.current
            : scale.current;
          choose("private");
        },
      });
    }
    showToast(reason, actions);
  };

  const audio = useAudioInputs(inputsSource);
  const input = mic.input ?? audio.current;
  const onDevice = useOnDeviceModel();
  const choice = useTranscriptionChoice({
    shell,
    transcription: recorder.transcription,
    model: onDevice.model,
    download: onDevice.download,
    transcriber: transcriberApi ?? recorder,
    signedIn: recorder.signedIn,
    notify: (reason) => showToast(reason),
  });
  choiceForToast.current = choice;

  const view = selectRecorderView(recorderState(recorder), {
    nowMs: Date.now(),
    elapsedMs,
    inputName: input?.name ?? null,
    silencedSinceMs,
  });

  const key = recordingKey(recorder);
  const ui = useNotesUi(key, {
    open: defaultOpen === "notes",
    view: notesViewSeed ?? "preview",
  });
  const saving = useNoteSaver(key, recorder);
  // What is typed and not yet saved is the note as far as the user is concerned.
  const noteText = ui.draft ?? recorder.note?.md ?? "";
  const { field: momentField, flow: moment } = useMomentFlow(
    {
      markMoment: () => recorder.markMoment(),
      text: noteText,
      write: (next) => {
        if (key !== null) updateNotesUi(key, () => ({ draft: next }));
        saving.change(next);
        saving.saveNow();
      },
    },
    (error) => {
      recorder.setMomentFieldFocused(false);
      console.error("[Recorder] Could not mark this moment", error);
      showToast(
        NOTES_COPY.momentFailed(
          error instanceof Error ? error.message : String(error),
        ),
      );
    },
  );
  const noteMd = noteText;
  const noteSyncFailed = recorder.noteSyncError !== null;
  const notesOpen = ui.open;
  const keyboardInset = useKeyboardInset();
  const markButton = useRef<HTMLButtonElement>(null);
  const viewNotesButton = useRef<HTMLButtonElement>(null);
  const recordingNow = phase === "recording";
  useEffect(() => {
    if (!recordingNow) return;
    const timer = setTimeout(warmRenderer, WARM_RENDERER_MS);
    return () => clearTimeout(timer);
  }, [recordingNow]);
  useEffect(() => {
    if (defaultOpen === "moment") moment.begin();
  }, []);

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
    if (
      !toast ||
      toast.actions.length > 0 ||
      toastPauseReasons.current.size > 0
    )
      return;
    toastRemaining.current = TOAST_MS;
    toastStartedAt.current = performance.now();
    const key = toast.key;
    toastTimer.current = setTimeout(() => {
      clearModelProgressToast(key);
      setToast((current) => (current?.key === key ? null : current));
    }, toastRemaining.current);
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = null;
    };
  }, [toast?.key, toast?.actions.length]);

  useEffect(() => {
    if (!modelDownloadRequested) return;
    const progressKey = modelProgressToastKey.current;
    if (progressKey === null) {
      setModelDownloadRequested(false);
      return;
    }
    if (!toast || toast.key !== progressKey) {
      clearModelProgressToast(progressKey);
      return;
    }
    const local = choice.stops.find(({ stop }) => stop.id === "local");
    if (local?.available) {
      modelProgressToastKey.current = null;
      modelDownloadStartingFrom.current = null;
      setModelDownloadRequested(false);
      setToast((current) =>
        current?.key === progressKey
          ? { ...current, message: "The on-device model is ready." }
          : current,
      );
      return;
    }
    const waitingForFirstStatus =
      modelDownloadStartingFrom.current === onDevice.model &&
      onDevice.download.error === null;
    if (!waitingForFirstStatus) modelDownloadStartingFrom.current = null;
    const next = waitingForFirstStatus
      ? "Starting the download…"
      : (local?.reason ?? "Checking Wi-Fi before downloading the model…");
    setToast((current) =>
      current?.key === progressKey && current.message !== next
        ? { ...current, message: next }
        : current,
    );
  }, [
    choice.stops,
    modelDownloadRequested,
    toast?.key,
    onDevice.model,
    onDevice.download,
  ]);

  const pauseToast = (reason: "pointer" | "focus") => {
    if (
      !toast ||
      toast.actions.length > 0 ||
      toastPauseReasons.current.has(reason)
    )
      return;
    const wasPaused = toastPauseReasons.current.size > 0;
    toastPauseReasons.current.add(reason);
    if (wasPaused) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastRemaining.current = Math.max(
      0,
      toastRemaining.current - (performance.now() - toastStartedAt.current),
    );
  };
  const resumeToast = (reason: "pointer" | "focus") => {
    if (
      !toastPauseReasons.current.delete(reason) ||
      toastPauseReasons.current.size > 0
    )
      return;
    if (!toast || toast.actions.length > 0) return;
    toastStartedAt.current = performance.now();
    const key = toast.key;
    toastTimer.current = setTimeout(() => {
      clearModelProgressToast(key);
      setToast((current) => (current?.key === key ? null : current));
    }, toastRemaining.current);
  };
  const runToastAction = (run: () => void) => {
    if (toastActionUsed.current) return;
    toastActionUsed.current = true;
    clearModelProgressToast(toast?.key);
    setToast(null);
    run();
    requestAnimationFrame(() => {
      if (!document.querySelector(".pr-sheet"))
        (toastReturnFocus.current?.isConnected
          ? toastReturnFocus.current
          : scale.current
        )?.focus({ preventScroll: true });
    });
  };
  const dismissToast = () => {
    clearModelProgressToast(toast?.key);
    setToast(null);
    requestAnimationFrame(() =>
      (toastReturnFocus.current?.isConnected
        ? toastReturnFocus.current
        : scale.current
      )?.focus({ preventScroll: true }),
    );
  };

  // The recorder provider announces every recording transition; this region only says what is new in this screen.
  const [said, setSaid] = useState("");
  const shownMode = useRef(choice.mode);
  useEffect(() => {
    if (shownMode.current === choice.mode) return;
    shownMode.current = choice.mode;
    setSaid(`${modeShortLabel(choice.mode, false)} selected`);
  }, [choice.mode]);

  const say = (message: string) =>
    setSaid((previous) =>
      previous === message ? `${message}\u200b` : message,
    );

  const closeModes = useCallback(() => {
    setModesOpen(false);
    opener.current?.focus();
  }, []);

  const choose = (id: Parameters<typeof choice.select>[0]) => {
    const changed = id !== choice.mode;
    const reason = choice.select(id);
    if (reason !== null) return reason;
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

  // Done never ends the recording over an unsaved note without the user knowing (doneGate.ts).
  const doneGate = useRef<DoneGate>({ acknowledged: null });
  const finish = () =>
    finishRecording(doneGate.current, key, {
      flush: saving.flush,
      stop: () => control("stop"),
    });

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
  const sheetOpen = discardOpen || choice.asking || notesOpen;
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
      setSettingsError(openSettingsFailedLine(error));
    });
  };
  const recorderError = honestRecorderError(recorder);
  const alerts = [
    recorderError ? { message: recorderError, retry: undefined } : null,
    ui.saveFailed && !notesOpen
      ? { message: NOTES_COPY.noteNotSavedAlert, retry: undefined }
      : null,
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
      data-mic-denied={idleDenied || undefined}
      style={{ "--kbh": `${keyboardInset}px` } as CSSProperties}
    >
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
        data-noting={momentField !== null}
        inert={sheetOpen}
      >
        <div className="pr-col pr-col-a">
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
            aria-label={view.timer.text}
            data-dim={view.ring === "paused"}
          >
            <TimerDigits text={view.timer.text} />
            <button
              ref={markButton}
              type="button"
              className="pr-time-slot pr-mark"
              aria-label={
                recorder.noteStatus === "ready"
                  ? NOTES_COPY.noteThisMoment
                  : recorder.noteStatus === "loading"
                    ? NOTES_COPY.noteLoading
                    : NOTES_COPY.noteLoadFailed
              }
              aria-hidden={idleDenied || undefined}
              aria-disabled={recorder.noteStatus !== "ready" || undefined}
              disabled={phase !== "recording" || idleDenied}
              onClick={() => {
                if (recorder.noteStatus !== "ready") return;
                hapticLight();
                moment.begin();
              }}
            >
              <PlusIcon />
            </button>
          </div>
          {view.timer.countdown && (
            <div className="pr-countdown">{view.timer.countdown.text}</div>
          )}
        </div>
        <div
          className="pr-extra"
          data-emphasis={mustSave}
          data-collapsed={
            !view.statusLine && (momentField !== null || hasNote(noteMd))
          }
          data-testid="phone-recorder-status"
        >
          {view.statusLine}
        </div>
        {phase !== "starting" && (momentField !== null || hasNote(noteMd)) && (
          <div className="pr-notes">
            {momentField ? (
              <MomentField
                field={momentField}
                flow={moment}
                onFocus={() => recorder.setMomentFieldFocused(true)}
                onClosed={(result, refocus) => {
                  recorder.setMomentFieldFocused(false);
                  if (result === "saved") say(NOTES_COPY.momentNoted);
                  if (refocus)
                    markButton.current?.focus({ preventScroll: true });
                }}
              />
            ) : (
              <button
                ref={viewNotesButton}
                type="button"
                className="pr-vnotes"
                data-failed={ui.saveFailed || undefined}
                onClick={() => {
                  ui.openNotes(readNotesView());
                }}
              >
                <NotesListIcon />
                {ui.saveFailed ? NOTES_COPY.noteNotSaved : NOTES_COPY.viewNotes}
              </button>
            )}
            {noteSyncFailed && !momentField && !ui.saveFailed && (
              <p className="pr-nsync" role="status">
                {NOTES_COPY.noteNotSynced}
              </p>
            )}
          </div>
        )}

        <div className="pr-stage">
          <RecorderRing
            ring={view.ring}
            flat={view.flat}
            theme={theme}
            quiet={idleDenied}
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

        </div>
        <div className="pr-col pr-col-b">
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
            onUnavailable={(reason, id) => unavailable(reason, id)}
          />
          <div className="pr-ends" aria-hidden="true">
            <span>more private</span>
            <span>more capable</span>
          </div>
          <div className="pr-capline">
            {choice.restingNote ?? stop.captions[shell]}
          </div>
          {!audio.unsupported &&
            (idleDenied ? (
              <div className="pr-via-placeholder" aria-hidden="true" />
            ) : (
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
            ))}
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
                  const reason = choose(id);
                  if (reason === null) closeModes();
                  else unavailable(reason, id);
                }}
                onToggleSpeakers={choice.setIdentifySpeakers}
              />
            </div>
          )}
        </div>

        <div className="pr-dock">
        {toast && (
          <div
            key={toast.key}
            ref={toastElement}
            className="pr-toast"
            role="status"
            onPointerEnter={() => pauseToast("pointer")}
            onPointerLeave={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node | null)
              )
                resumeToast("pointer");
            }}
            onFocusCapture={() => pauseToast("focus")}
            onBlurCapture={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node | null)
              )
                resumeToast("focus");
            }}
          >
            <div className="pr-toast-copy" tabIndex={0}>
              <span className="pr-toast-icon" aria-hidden="true">
                !
              </span>
              <span className="pr-toast-message">{toast.message}</span>
            </div>
            {toast.actions.length > 0 && (
              <div className="pr-toast-actions">
                {toast.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={() => runToastAction(action.run)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="pr-toast-dismiss"
              aria-label="Dismiss notification"
              onClick={dismissToast}
            >
              ×
            </button>
          </div>
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
        {idleDenied ? (
          <div className="pr-controls" data-mic-denied="true">
            <MicDeniedAction
              idle={phase === "idle"}
              onOpenSettings={openSettings}
              onTryAgain={recorder.record}
            />
          </div>
        ) : phase === "idle" ? (
          <div className="pr-controls">
            <button
              type="button"
              className="pr-b primary"
              disabled={!recorder.ready || recorder.outcome !== null}
              onClick={() => void recorder.record()}
            >
              Record
            </button>
          </div>
        ) : (
          <>
            {view.controls.openSettings && (
              <div className="pr-controls" style={{ paddingBottom: 0 }}>
                <MicDeniedAction
                  idle={false}
                  onOpenSettings={openSettings}
                  onTryAgain={recorder.record}
                />
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
                onClick={() => void finish()}
              >
                <CheckIcon />
                Done
              </button>
            </div>
          </>
        )}
        </div>
        </div>
      </div>

      {notesOpen && (
        <NotesSheet
          md={noteText}
          onChange={(md) => {
            if (key !== null) updateNotesUi(key, () => ({ draft: md }));
            saving.change(md);
          }}
          view={ui.view}
          onViewChange={(next) => {
            saving.saveNow();
            rememberNotesView(next);
            ui.setView(next);
          }}
          noteStatus={recorder.noteStatus}
          pending={saving.pending}
          saveFailed={ui.saveFailed}
          onClose={() => {
            saving.saveNow();
            ui.closeNotes();
          }}
          recording={{
            timerText: view.timer.text,
            paused: view.ring === "paused",
            canToggle: resume || view.controls.pause,
            onToggle: () => {
              hapticLight();
              control(resume ? "resume" : "pause");
            },
            subscribeLevel: recorder.subscribeLevel,
            theme,
          }}
          keyboardInset={keyboardInset}
          returnFocus={viewNotesButton}
          fallbackFocus={markButton}
        />
      )}
      {discardOpen && (
        <SheetDialog
          role="alertdialog"
          titleId={`${ids}-dt`}
          descriptionId={`${ids}-dd`}
          title="Discard this recording?"
          description={NOTES_COPY.discardLoss(view.timer.text, hasNote(noteMd))}
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

    </div>
  );
}
