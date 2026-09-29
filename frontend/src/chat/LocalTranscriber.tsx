// LOCAL recording panel — the desktop-only half of the Transcriber card.
//
// `LocalTranscriberView` is a pure function of its props (asserted with
// react-dom/server in tests); `LocalTranscriberPanel` owns the bridge instance,
// model download, and the record → transcribe → save lifecycle. Whisper at the
// pinned anarlog rev is batch-only, so the UI always says transcription happens
// after Stop.

import { useEffect, useRef, useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Loader2Icon, MicIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CaptureStopUnconfirmedError,
  createLocalTranscriber,
  DEFAULT_LOCAL_MODEL,
  LOCAL_MODEL_STORAGE_KEY,
  LOCAL_WHISPER_MODELS,
  prepareLocalTranscript,
  saveLocalTranscript,
  type LocalTranscriber,
  type LocalTranscriberStatus,
  type PreparedLocalTranscript,
  type WhisperModel,
} from "@/lib/localTranscriber";

export type LocalPanelState =
  | "checking-model"
  | "needs-download"
  | "downloading"
  | "ready"
  | "starting"
  | "recording"
  | "transcribing"
  | "saving"
  | "saved"
  /** Native capture did not confirm Stop; the recording may still be running. */
  | "stop-failed"
  /** The transcript is held in the panel; Retry re-runs the identical save. */
  | "save-failed"
  | "error";

/** "loaded" with no devices is a real answer; "failed" is an enumeration error. */
export type MicDeviceList =
  | { status: "loading" }
  | { status: "loaded"; devices: readonly string[] }
  | { status: "failed"; message: string };

/** States where a capture may be live or a transcript is not yet saved: the
 *  mode switch and pickers stay locked, and model checks never replace them. */
export function isLocalWorkflowActive(state: LocalPanelState): boolean {
  return (
    state === "starting" ||
    state === "recording" ||
    state === "transcribing" ||
    state === "saving" ||
    state === "stop-failed" ||
    state === "save-failed"
  );
}

/** What the Retry button does in each failed state. */
export function localRetryAction(state: LocalPanelState): "stop" | "save" | "readiness" {
  if (state === "stop-failed") return "stop";
  if (state === "save-failed") return "save";
  return "readiness";
}

export interface LocalTranscriberViewProps {
  state: LocalPanelState;
  model: WhisperModel;
  mics: MicDeviceList;
  micDevice: string;
  downloadPct: number | null;
  /** Status line; for `error` this is the message. */
  statusText: string | null;
  onModelChange: (model: WhisperModel) => void;
  onMicChange: (device: string) => void;
  onDownload: () => void;
  onRetry: () => void;
  onStart: () => void;
  onStop: () => void;
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

export const LocalTranscriberView: FC<LocalTranscriberViewProps> = ({
  state,
  model,
  mics,
  micDevice,
  downloadPct,
  statusText,
  onModelChange,
  onMicChange,
  onDownload,
  onRetry,
  onStart,
  onStop,
}) => {
  const modelInfo = LOCAL_WHISPER_MODELS.find((m) => m.id === model);
  const recording = state === "recording";
  const micDevices = mics.status === "loaded" ? mics.devices : [];
  const locked = isLocalWorkflowActive(state);
  const busy =
    state === "checking-model" ||
    state === "downloading" ||
    state === "starting" ||
    state === "transcribing" ||
    state === "saving";

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Record this Mac&apos;s microphone and meeting audio, then transcribe on-device with
        Whisper. Nothing leaves the machine until the transcript is saved to your space.
        Whisper runs after you stop, not live.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="local-transcriber-model" className="sr-only">
          Whisper model
        </label>
        <select
          id="local-transcriber-model"
          aria-label="Whisper model"
          className={`${selectClass} sm:max-w-[16rem]`}
          value={model}
          disabled={locked || busy}
          onChange={(e) => onModelChange(e.target.value as WhisperModel)}
        >
          {LOCAL_WHISPER_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · ~{m.approxSizeMb} MB
            </option>
          ))}
        </select>

        {micDevices.length > 0 && (
          <>
            <label htmlFor="local-transcriber-mic" className="sr-only">
              Microphone
            </label>
            <select
              id="local-transcriber-mic"
              aria-label="Microphone"
              className={`${selectClass} sm:max-w-[16rem]`}
              value={micDevice}
              disabled={locked || busy}
              onChange={(e) => onMicChange(e.target.value)}
            >
              <option value="">System default</option>
              {micDevices.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {mics.status === "failed" && (
        <p role="alert" className="text-xs text-destructive">
          Couldn&apos;t list microphones: {mics.message}
        </p>
      )}
      {mics.status === "loaded" && micDevices.length === 0 && (
        <p className="text-xs text-muted-foreground">No microphones were found on this Mac.</p>
      )}

      <div className="flex items-center gap-2">
        {state === "needs-download" && (
          <Button type="button" size="sm" onClick={onDownload} className="h-9 gap-1.5">
            Download model{modelInfo ? ` (~${modelInfo.approxSizeMb} MB)` : ""}
          </Button>
        )}
        {state === "downloading" && (
          <Button type="button" size="sm" disabled className="h-9 gap-1.5">
            <Loader2Icon className="size-4 animate-spin" />
            <span>Downloading model{downloadPct !== null ? ` · ${downloadPct}%` : "…"}</span>
          </Button>
        )}
        {(state === "ready" || state === "saved") && !recording && (
          <Button
            type="button"
            size="sm"
            onClick={onStart}
            disabled={busy}
            aria-label="Start local recording"
            className="h-9 gap-1.5"
          >
            <MicIcon className="size-4" />
            <span>Start recording</span>
          </Button>
        )}
        {recording && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={onStop}
            aria-label="Stop and transcribe"
            className="h-9 gap-1.5"
          >
            <SquareIcon className="size-4" />
            <span>Stop &amp; transcribe</span>
          </Button>
        )}
        {(state === "starting" || state === "transcribing" || state === "saving") && (
          <Button type="button" size="sm" disabled className="h-9 gap-1.5">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{state === "starting" ? "Starting recording…" : state === "transcribing" ? "Transcribing…" : "Saving…"}</span>
          </Button>
        )}
        {state === "checking-model" && (
          <Button type="button" size="sm" disabled className="h-9 gap-1.5">
            <Loader2Icon className="size-4 animate-spin" />
            <span>Checking model…</span>
          </Button>
        )}
        {state === "error" && (
          <Button type="button" size="sm" onClick={onRetry} className="h-9">
            Retry
          </Button>
        )}
        {state === "stop-failed" && (
          <Button type="button" size="sm" variant="destructive" onClick={onRetry} className="h-9">
            Retry stop
          </Button>
        )}
        {state === "save-failed" && (
          <Button type="button" size="sm" onClick={onRetry} className="h-9">
            Retry save
          </Button>
        )}
      </div>

      {state === "saved" && (
        <p className="text-xs text-muted-foreground">Saved to Meetings as Exo Local.</p>
      )}
      {state === "save-failed" && (
        <p className="text-xs text-muted-foreground">
          The transcript is kept here until it saves. Leaving this view discards it.
        </p>
      )}
      {(recording || state === "stop-failed") && (
        <p className="text-xs text-muted-foreground">
          Keep this view open while recording. Leaving it stops capture without saving a transcript.
        </p>
      )}
      {statusText !== null && (
        <p role="alert" className="text-xs text-destructive">
          {statusText}
        </p>
      )}
    </div>
  );
};

export interface LocalTranscriberPanelProps {
  tcw: TinyCloudWeb;
  onWorkflowActiveChange?: (active: boolean) => void;
  /** Injectable for tests; defaults to the real bridge-backed transcriber. */
  transcriber?: LocalTranscriber;
}

function readSavedModel(): WhisperModel {
  if (typeof localStorage === "undefined") return DEFAULT_LOCAL_MODEL;
  const stored = localStorage.getItem(LOCAL_MODEL_STORAGE_KEY);
  return LOCAL_WHISPER_MODELS.some((m) => m.id === stored)
    ? (stored as WhisperModel)
    : DEFAULT_LOCAL_MODEL;
}

/** Stateful owner: bridge instance, model readiness, capture lifecycle, save. */
export const LocalTranscriberPanel: FC<LocalTranscriberPanelProps> = ({ tcw, transcriber, onWorkflowActiveChange }) => {
  const transcriberRef = useRef<LocalTranscriber | null>(null);
  if (transcriberRef.current === null) {
    transcriberRef.current = transcriber ?? createLocalTranscriber();
  }
  const t = transcriberRef.current;

  useEffect(() => () => {
    void t.stopCaptureOnUnmount().catch((err) => {
      console.error("Failed to stop local recording when leaving the view", err);
    });
  }, [t]);

  const [model, setModel] = useState<WhisperModel>(readSavedModel);
  const [mics, setMics] = useState<MicDeviceList>({ status: "loading" });
  const [micDevice, setMicDevice] = useState("");
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [state, setState] = useState<LocalPanelState>("checking-model");
  const [retryCount, setRetryCount] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  // The transcript waiting to be saved; kept until a save succeeds so Retry
  // re-runs that exact save.
  const [pendingSave, setPendingSave] = useState<PreparedLocalTranscript | null>(null);
  // Recording/transcribing progress is driven by plugin events through onStatus;
  // panel state mirrors the last lifecycle-relevant status.
  const lastStatus = useRef<LocalTranscriberStatus>({ kind: "idle" });

  useEffect(() => {
    onWorkflowActiveChange?.(isLocalWorkflowActive(state));
    return () => onWorkflowActiveChange?.(false);
  }, [onWorkflowActiveChange, state]);

  const fail = (err: unknown) => {
    setErrorText(err instanceof Error ? err.message : String(err));
    setState("error");
  };

  // Model readiness + mic list on mount and when the model changes.
  useEffect(() => {
    let cancelled = false;
    setState((s) => (isLocalWorkflowActive(s) ? s : "checking-model"));
    void t
      .isModelDownloaded(model)
      .then((downloaded) => {
        if (cancelled) return;
        setState((s) => (s === "checking-model" ? (downloaded ? "ready" : "needs-download") : s));
      })
      .catch((err) => {
        if (!cancelled) fail(err);
      });
    setMics({ status: "loading" });
    void t
      .listMicrophoneDevices()
      .then((devices) => {
        if (!cancelled) setMics({ status: "loaded", devices });
      })
      .catch((err) => {
        if (!cancelled) setMics({ status: "failed", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [t, model, retryCount]);

  useEffect(() => t.onStatus((s) => {
    lastStatus.current = s;
    if (s.kind === "error") setErrorText(s.message);
  }), [t]);

  const onDownload = () => {
    setDownloadPct(0);
    setErrorText(null);
    setState("downloading");
    void t
      .ensureModel(model, (pct) => setDownloadPct(pct))
      .then(() => setState("ready"))
      .catch((err) => {
        setErrorText(err instanceof Error ? err.message : String(err));
        setState("needs-download");
      });
  };

  const onStart = () => {
    setErrorText(null);
    setState("starting");
    void t
      .start({ model, language: "en", micDevice: micDevice || undefined })
      .then(() => setState("recording"))
      .catch(fail);
  };

  const save = (prepared: PreparedLocalTranscript) => {
    setErrorText(null);
    setState("saving");
    void saveLocalTranscript(tcw, prepared)
      .then((saved) => {
        if (!saved.ok) throw new Error(saved.error.message);
        setPendingSave(null);
        setState("saved");
      })
      .catch((err) => {
        setErrorText(err instanceof Error ? err.message : String(err));
        setState("save-failed");
      });
  };

  const onStop = () => {
    setErrorText(null);
    setState("transcribing");
    void t.stop().then(
      (result) => {
        let prepared: PreparedLocalTranscript;
        try {
          prepared = prepareLocalTranscript(result);
        } catch (err) {
          fail(err);
          return;
        }
        setPendingSave(prepared);
        save(prepared);
      },
      (err) => {
        if (err instanceof CaptureStopUnconfirmedError) {
          setErrorText(err.message);
          setState("stop-failed");
          return;
        }
        fail(err);
      },
    );
  };

  const onRetry = () => {
    switch (localRetryAction(state)) {
      case "stop":
        onStop();
        return;
      case "save":
        if (pendingSave === null) {
          fail(new Error("No transcript is waiting to be saved"));
          return;
        }
        save(pendingSave);
        return;
      case "readiness":
        setErrorText(null);
        setRetryCount((count) => count + 1);
        return;
    }
  };

  return (
    <LocalTranscriberView
      state={state}
      model={model}
      mics={mics}
      micDevice={micDevice}
      downloadPct={downloadPct}
      statusText={errorText}
      onModelChange={(m) => {
        setModel(m);
        try {
          localStorage.setItem(LOCAL_MODEL_STORAGE_KEY, m);
        } catch {
          // localStorage can throw in private contexts; the preference is best-effort.
        }
      }}
      onMicChange={setMicDevice}
      onDownload={onDownload}
      onRetry={onRetry}
      onStart={onStart}
      onStop={onStop}
    />
  );
};
