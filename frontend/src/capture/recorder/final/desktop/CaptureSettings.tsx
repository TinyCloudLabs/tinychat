import {
  useCallback,
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  getDesktopCaptureExtras,
  type DesktopCaptureExtras,
  type WhisperModelId,
  type WhisperModelInfo,
} from "@/lib/voiceNotes/desktopCaptureExtras";
import { useAudioInputs, type AudioInputsSource } from "../useAudioInputs";
import {
  adjacentRadio,
  downloadedAnnouncement,
  downloadsReducer,
  focusAfterFail,
  focusAfterGet,
  focusAfterSync,
  formatModelSize,
  newlyDownloaded,
  partitionModels,
  progressPercent,
  progressText,
  type Downloads,
  type FocusTarget,
} from "./captureSettingsModel";
import "../soft.css";
import "./captureSettings.css";

export type CaptureSettingsVariant = "app" | "microphone-only";

type SwitchKey = "systemAudio" | "autoSave";

interface Loaded {
  models: WhisperModelInfo[];
  selected: WhisperModelId | null;
  systemAudio: boolean;
  autoSave: boolean;
}

type Load =
  | { status: "loading" }
  | { status: "ready"; data: Loaded }
  | { status: "error"; message: string };

const messageOf = (caught: unknown) =>
  caught instanceof Error ? caught.message : String(caught);

function GearIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.52 4.85L10.88 2.57L13.12 2.57L13.48 4.85A7.3 7.3 0 0 1 16.01 5.90L17.88 4.54L19.46 6.12L18.10 7.99A7.3 7.3 0 0 1 19.15 10.52L21.43 10.88L21.43 13.12L19.15 13.48A7.3 7.3 0 0 1 18.10 16.01L19.46 17.88L17.88 19.46L16.01 18.10A7.3 7.3 0 0 1 13.48 19.15L13.12 21.43L10.88 21.43L10.52 19.15A7.3 7.3 0 0 1 7.99 18.10L6.12 19.46L4.54 17.88L5.90 16.01A7.3 7.3 0 0 1 4.85 13.48L2.57 13.12L2.57 10.88L4.85 10.52A7.3 7.3 0 0 1 5.90 7.99L4.54 6.12L6.12 4.54L7.99 5.90A7.3 7.3 0 0 1 10.52 4.85Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

export interface MicrophoneRow {
  name: string | null;
  /** The shell has no list of inputs to show. */
  unavailable: boolean;
  error: string | null;
  retry: (() => void) | null;
}

export interface SettingsPanelProps {
  variant: CaptureSettingsVariant;
  /** Null: nothing registered a DesktopCaptureExtras, so the app variant has nothing to show. */
  extrasAvailable: boolean;
  load: Load;
  downloads: Downloads;
  microphone: MicrophoneRow;
  modelError: string | null;
  switches: Record<SwitchKey, { pending: boolean; error: string | null }>;
  onRetryLoad: () => void;
  onSelectModel: (id: WhisperModelId) => void;
  onGetModel: (id: WhisperModelId) => void;
  onToggle: (key: SwitchKey, on: boolean) => void;
}

function MicrophoneSection({ microphone }: { microphone: MicrophoneRow }) {
  return (
    <section aria-labelledby="cs-mic-h">
      <h3 id="cs-mic-h" className="cs-h">
        Microphone
      </h3>
      {microphone.name !== null ? (
        <div className="cs-row" data-testid="settings-mic">
          <span className="cs-rb" data-on="true" aria-hidden="true" />
          <span className="cs-name">{microphone.name}</span>
          <small>change with “via”</small>
        </div>
      ) : (
        <p className="cs-note" data-testid="settings-mic">
          {microphone.unavailable
            ? "Microphone choice isn’t available here."
            : "No microphone found."}
        </p>
      )}
      {microphone.error && (
        <p className="cs-error" role="alert">
          {microphone.error}
          {microphone.retry && (
            <button type="button" className="cs-link" onClick={microphone.retry}>
              Try again
            </button>
          )}
        </p>
      )}
    </section>
  );
}

function ModelSection({
  data,
  downloads,
  modelError,
  onSelectModel,
  onGetModel,
}: {
  data: Loaded;
  downloads: Downloads;
  modelError: string | null;
  onSelectModel: (id: WhisperModelId) => void;
  onGetModel: (id: WhisperModelId) => void;
}) {
  const radiosRef = useRef(new Map<WhisperModelId, HTMLElement>());
  const { radios, available, tabStop } = partitionModels(
    data.models,
    data.selected,
  );

  // WAI-ARIA radio group over the models on disk: arrows move focus and select, wrapping.
  const key = (event: KeyboardEvent) => {
    const direction =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (direction === 0) return;
    const next = adjacentRadio(
      radios,
      (event.target as HTMLElement)
        .closest<HTMLElement>("[data-model]")
        ?.getAttribute("data-model"),
      direction,
    );
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    radiosRef.current.get(next.id)?.focus();
    if (next.id !== data.selected) onSelectModel(next.id);
  };

  return (
    <section aria-labelledby="cs-model-h">
      <h3 id="cs-model-h" className="cs-h">
        Local model (Whisper on this Mac)
      </h3>
      {radios.length > 0 ? (
        <div role="radiogroup" aria-labelledby="cs-model-h" onKeyDown={key}>
          {radios.map((model) => {
            const checked = model.id === data.selected;
            return (
              <div
                key={model.id}
                className="cs-row cs-model"
                data-model={model.id}
                data-on={checked}
              >
                <button
                  ref={(el) => {
                    if (el) radiosRef.current.set(model.id, el);
                    else radiosRef.current.delete(model.id);
                  }}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={model.id === tabStop ? 0 : -1}
                  className="cs-radio"
                  onClick={() => {
                    if (!checked) onSelectModel(model.id);
                  }}
                >
                  <span className="cs-rb" data-on={checked} aria-hidden="true" />
                  <span className="cs-name">{model.label}</span>
                  <small>{formatModelSize(model.sizeBytes)}</small>
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="cs-note" data-testid="no-model">
          No model on this Mac yet. Get one below.
        </p>
      )}
      {available.length > 0 && (
        <div role="group" aria-label="Available to download">
          {available.map((model) => {
            const download = downloads[model.id];
            const percent =
              download?.status === "downloading"
                ? progressPercent(download.fraction)
                : 0;
            return (
              <div
                key={model.id}
                className="cs-row cs-model"
                data-model={model.id}
                data-on="false"
              >
                <div className="cs-radio cs-plain">
                  <span className="cs-rb" aria-hidden="true" />
                  <span className="cs-name">{model.label}</span>
                  <small>{formatModelSize(model.sizeBytes)}</small>
                </div>
                {download?.status === "downloading" ? (
                  <span
                    className="cs-progress"
                    role="progressbar"
                    tabIndex={0}
                    aria-label={`${model.label} download`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-valuetext={progressText(download.fraction)}
                  >
                    <span className="cs-bar" aria-hidden="true">
                      <i style={{ width: `${percent}%` }} />
                    </span>
                    <span className="cs-pct" aria-hidden="true">
                      {percent}%
                    </span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="cs-get"
                    aria-label={`${download?.status === "error" ? "Retry" : "Get"} ${model.label}`}
                    data-testid={`get-${model.id}`}
                    onClick={() => onGetModel(model.id)}
                  >
                    {download?.status === "error" ? "Retry" : "Get"}
                  </button>
                )}
                {download?.status === "error" && (
                  <p className="cs-error cs-rowerror" role="alert">
                    Could not download {model.label}: {download.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {modelError && (
        <p className="cs-error" role="alert">
          {modelError}
        </p>
      )}
    </section>
  );
}

function Switch({
  label,
  description,
  checked,
  pending,
  error,
  testId,
  onToggle,
}: {
  label: string;
  description: string;
  checked: boolean;
  pending: boolean;
  error: string | null;
  testId: string;
  onToggle: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="cs-tgl">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={`${id}-d`}
        aria-busy={pending}
        disabled={pending}
        className="cs-switch"
        data-testid={testId}
        onClick={() => onToggle(!checked)}
      >
        <span className="cs-sw" aria-hidden="true" />
      </button>
      <div>
        <b id={`${id}-l`}>{label}</b>
        <span id={`${id}-d`}>{description}</span>
        {error && (
          <p className="cs-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function SettingsPanel({
  variant,
  extrasAvailable,
  load,
  downloads,
  microphone,
  modelError,
  switches,
  onRetryLoad,
  onSelectModel,
  onGetModel,
  onToggle,
}: SettingsPanelProps) {
  if (variant === "microphone-only")
    return (
      <>
        <p className="cs-lede">
          Local transcription, meeting audio and auto-save need the Exo app.
        </p>
        <MicrophoneSection microphone={microphone} />
      </>
    );
  if (!extrasAvailable)
    return (
      <p className="cs-error" role="alert" data-testid="settings-unavailable">
        Capture settings aren’t available in this build.
      </p>
    );
  return (
    <>
      <p className="cs-lede">
        Desktop only. The scale picks where each recording is transcribed;
        these are the details behind it.
      </p>
      {load.status === "loading" && (
        <p className="cs-note" role="status">
          Loading…
        </p>
      )}
      {load.status === "error" && (
        <p className="cs-error" role="alert">
          {load.message}
          <button type="button" className="cs-link" onClick={onRetryLoad}>
            Try again
          </button>
        </p>
      )}
      {load.status === "ready" && (
        <ModelSection
          data={load.data}
          downloads={downloads}
          modelError={modelError}
          onSelectModel={onSelectModel}
          onGetModel={onGetModel}
        />
      )}
      <MicrophoneSection microphone={microphone} />
      {load.status === "ready" && (
        <section aria-labelledby="cs-meet-h">
          <h3 id="cs-meet-h" className="cs-h">
            Meetings
          </h3>
          <Switch
            label="Also record this Mac’s audio"
            description="Captures the other side of calls in Zoom, Meet or Teams. macOS asks for screen & system audio recording permission once."
            checked={load.data.systemAudio}
            pending={switches.systemAudio.pending}
            error={switches.systemAudio.error}
            testId="switch-system-audio"
            onToggle={(on) => onToggle("systemAudio", on)}
          />
          <Switch
            label="Save to your space automatically"
            description="Recordings and notes sync to TinyCloud when you stop."
            checked={load.data.autoSave}
            pending={switches.autoSave.pending}
            error={switches.autoSave.error}
            testId="switch-auto-save"
            onToggle={(on) => onToggle("autoSave", on)}
          />
        </section>
      )}
    </>
  );
}

export interface CaptureSettingsProps {
  variant: CaptureSettingsVariant;
  /** Where the microphones come from; null when the shell has none to list. */
  inputs: AudioInputsSource | null;
  /** Defaults to what the desktop app registered. Null renders the "not available in this build" state. */
  extras?: DesktopCaptureExtras | null;
  defaultOpen?: boolean;
  /** Download rows to show before anything is clicked: for the harness. */
  initialDownloads?: Downloads;
}

const NO_SWITCH = { pending: false, error: null };

export function CaptureSettings({
  variant,
  inputs,
  extras: extrasProp,
  defaultOpen = false,
  initialDownloads = {},
}: CaptureSettingsProps) {
  const extras =
    variant === "app"
      ? extrasProp === undefined
        ? getDesktopCaptureExtras()
        : extrasProp
      : null;
  const [open, setOpen] = useState(defaultOpen);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [downloads, dispatch] = useReducer(downloadsReducer, initialDownloads);
  const [modelError, setModelError] = useState<string | null>(null);
  const [switches, setSwitches] = useState<
    Record<SwitchKey, { pending: boolean; error: string | null }>
  >({ systemAudio: NO_SWITCH, autoSave: NO_SWITCH });
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const focusTarget = useRef<FocusTarget | null>(null);
  const loadedModels = useRef<WhisperModelInfo[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const titleId = useId();
  const panelId = useId();
  const audio = useAudioInputs(inputs);

  // The model whose progress element has focus, if one does: read before a row changes shape under it.
  const focusedProgress = useCallback((): WhisperModelId | null => {
    const active = document.activeElement;
    if (
      !active ||
      !panel.current?.contains(active) ||
      active.getAttribute("role") !== "progressbar"
    )
      return null;
    return active
      .closest<HTMLElement>("[data-model]")
      ?.getAttribute("data-model") as WhisperModelId | null;
  }, []);

  const fail = useCallback(
    (id: WhisperModelId, message: string) => {
      focusTarget.current =
        focusAfterFail(focusedProgress(), id) ?? focusTarget.current;
      dispatch({ type: "fail", id, message });
    },
    [focusedProgress],
  );

  const reload = useCallback(
    async (showLoading: boolean) => {
      if (!extras) return;
      const mine = ++request.current;
      if (showLoading) setLoad({ status: "loading" });
      try {
        const [models, selected, systemAudio, autoSave] = await Promise.all([
          extras.models.list(),
          extras.models.get(),
          extras.systemAudio.get(),
          extras.autoSaveToSpace.get(),
        ]);
        if (mine === request.current) {
          focusTarget.current =
            focusAfterSync(focusedProgress(), models) ?? focusTarget.current;
          const finished = newlyDownloaded(loadedModels.current, models);
          if (finished.length > 0)
            setAnnouncement(
              downloadedAnnouncement(finished.map((m) => m.label)),
            );
          loadedModels.current = models;
          dispatch({ type: "sync", models });
          setLoad({
            status: "ready",
            data: { models, selected, systemAudio, autoSave },
          });
        }
      } catch (caught) {
        console.error("[CaptureSettings] Could not load the settings", caught);
        if (mine === request.current)
          setLoad({
            status: "error",
            message: `Could not load the capture settings: ${messageOf(caught)}`,
          });
      }
    },
    [extras, focusedProgress],
  );

  useEffect(() => {
    if (!open || !extras) return;
    setModelError(null);
    loadedModels.current = null;
    setAnnouncement("");
    void reload(true);
    return () => {
      request.current++;
    };
  }, [open, extras, reload]);

  // Every model's events count, including downloads this popover did not start. A terminal event re-reads
  // list(): that, not the event, says whether the model is on disk and so selectable.
  useEffect(() => {
    if (!extras) return;
    return extras.models.onProgress(({ id, fraction, status, error }) => {
      if (status === "error") {
        fail(id, error ?? "The download did not finish.");
        void reload(false);
      } else {
        dispatch({ type: "progress", id, fraction });
        if (status === "done") void reload(false);
      }
    });
  }, [extras, reload, fail]);

  // Escape closes with focus returned to ⚙︎ at once. A click outside goes the same way, after the click has
  // finished moving focus: if it landed on another control, that control keeps it; if it landed nowhere,
  // focus comes back to ⚙︎.
  const close = useCallback((source: "key" | "pointer") => {
    setOpen(false);
    const restore = () => {
      const active = document.activeElement;
      if (!active || active === document.body || root.current?.contains(active))
        button.current?.focus();
    };
    if (source === "key") restore();
    else setTimeout(restore, 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    (
      panel.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ??
      panel.current
    )?.focus();
    const outside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close("pointer");
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open, close]);

  const radioReady = load.status === "ready";
  useEffect(() => {
    if (open && radioReady)
      panel.current
        ?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
        ?.focus();
  }, [open, radioReady]);

  // Runs after every commit: a target set alongside the state change that moves focus lands on the element
  // that state change just rendered, and is spent either way.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    const row = panel.current?.querySelector<HTMLElement>(
      `[data-model="${target.id}"]`,
    );
    const element =
      target.to === "progress"
        ? row?.querySelector<HTMLElement>('[role="progressbar"]')
        : target.to === "retry"
          ? row?.querySelector<HTMLElement>(".cs-get")
          : row?.querySelector<HTMLElement>('[role="radio"]');
    element?.focus();
  });

  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      close("key");
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const stops = [
      ...panel.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled):not([tabindex="-1"]), [role="progressbar"][tabindex="0"]',
      ),
    ];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onSelectModel = (id: WhisperModelId) => {
    if (!extras) return;
    setModelError(null);
    extras.models.select(id).then(
      () => reload(false),
      (caught: unknown) => {
        console.error("[CaptureSettings] Could not select the model", caught);
        setModelError(`Could not select the model: ${messageOf(caught)}`);
      },
    );
  };

  const onGetModel = (id: WhisperModelId) => {
    if (!extras) return;
    focusTarget.current = focusAfterGet(id);
    dispatch({ type: "start", id });
    extras.models.download(id).then(
      () => void reload(false),
      (caught: unknown) => {
        console.error("[CaptureSettings] Could not download the model", caught);
        fail(id, messageOf(caught));
      },
    );
  };

  const onToggle = (switchKey: SwitchKey, on: boolean) => {
    if (!extras) return;
    const target =
      switchKey === "systemAudio" ? extras.systemAudio : extras.autoSaveToSpace;
    setSwitches((s) => ({ ...s, [switchKey]: { pending: true, error: null } }));
    target.set(on).then(
      () => {
        setSwitches((s) => ({ ...s, [switchKey]: NO_SWITCH }));
        setLoad((current) =>
          current.status === "ready"
            ? { status: "ready", data: { ...current.data, [switchKey]: on } }
            : current,
        );
      },
      (caught: unknown) => {
        console.error("[CaptureSettings] Could not change the setting", caught);
        setSwitches((s) => ({
          ...s,
          [switchKey]: {
            pending: false,
            error: `Could not change this setting: ${messageOf(caught)}`,
          },
        }));
      },
    );
  };

  return (
    <div ref={root} className="cs" onKeyDown={key}>
      <button
        ref={button}
        type="button"
        className="cs-btn"
        aria-label="Capture settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid="capture-settings-button"
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          className="cs-pop"
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-variant={variant}
          data-testid="capture-settings"
        >
          <h2 id={titleId} className="cs-title">
            Capture settings
          </h2>
          <SettingsPanel
            variant={variant}
            extrasAvailable={extras !== null}
            load={load}
            downloads={downloads}
            microphone={{
              name: audio.current?.name ?? null,
              unavailable: inputs === null,
              error: audio.error,
              retry: audio.retry,
            }}
            modelError={modelError}
            switches={switches}
            onRetryLoad={() => void reload(true)}
            onSelectModel={onSelectModel}
            onGetModel={onGetModel}
            onToggle={onToggle}
          />
          <div className="cs-sr" role="status" aria-live="polite">
            {announcement}
          </div>
        </div>
      )}
    </div>
  );
}
