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
  createLocalTranscriber,
  DEFAULT_LOCAL_MODEL,
  LOCAL_MODEL_STORAGE_KEY,
  LOCAL_WHISPER_MODELS,
  saveLocalTranscript,
  type LocalTranscriber,
  type LocalTranscriberStatus,
  type WhisperModel,
} from "@/lib/localTranscriber";

export type LocalPanelState =
  | "checking-model"
  | "needs-download"
  | "downloading"
  | "ready"
  | "recording"
  | "transcribing"
  | "saving"
  | "saved"
  | "error";

export interface LocalTranscriberViewProps {
  state: LocalPanelState;
  model: WhisperModel;
  micDevices: readonly string[];
  micDevice: string;
  downloadPct: number | null;
  /** Status line; for `error` this is the message. */
  statusText: string | null;
  signedIn: boolean;
  onModelChange: (model: WhisperModel) => void;
  onMicChange: (device: string) => void;
  onDownload: () => void;
  onStart: () => void;
  onStop: () => void;
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

export const LocalTranscriberView: FC<LocalTranscriberViewProps> = ({
  state,
  model,
  micDevices,
  micDevice,
  downloadPct,
  statusText,
  signedIn,
  onModelChange,
  onMicChange,
  onDownload,
  onStart,
  onStop,
}) => {
  const modelInfo = LOCAL_WHISPER_MODELS.find((m) => m.id === model);
  const recording = state === "recording";
  const busy =
    state === "checking-model" ||
    state === "downloading" ||
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
          disabled={recording || busy}
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
              disabled={recording || busy}
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
        {(state === "ready" || state === "saved" || state === "error") && !recording && (
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
        {(state === "transcribing" || state === "saving") && (
          <Button type="button" size="sm" disabled className="h-9 gap-1.5">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{state === "transcribing" ? "Transcribing…" : "Saving…"}</span>
          </Button>
        )}
        {state === "checking-model" && (
          <Button type="button" size="sm" disabled className="h-9 gap-1.5">
            <Loader2Icon className="size-4 animate-spin" />
            <span>Checking model…</span>
          </Button>
        )}
      </div>

      {state === "saved" && (
        <p className="text-xs text-muted-foreground">Saved to Meetings as Exo Local.</p>
      )}
      {!signedIn && (
        <p className="text-xs text-muted-foreground">
          Sign in to save transcripts to your space — recording works signed out, saving waits.
        </p>
      )}
      {statusText !== null && state === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {statusText}
        </p>
      )}
    </div>
  );
};

export interface LocalTranscriberPanelProps {
  tcw?: TinyCloudWeb;
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
export const LocalTranscriberPanel: FC<LocalTranscriberPanelProps> = ({ tcw, transcriber }) => {
  const transcriberRef = useRef<LocalTranscriber | null>(null);
  if (transcriberRef.current === null) {
    transcriberRef.current = transcriber ?? createLocalTranscriber();
  }
  const t = transcriberRef.current;

  const [model, setModel] = useState<WhisperModel>(readSavedModel);
  const [micDevices, setMicDevices] = useState<string[]>([]);
  const [micDevice, setMicDevice] = useState("");
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [state, setState] = useState<LocalPanelState>("checking-model");
  const [errorText, setErrorText] = useState<string | null>(null);
  // Recording/transcribing progress is driven by plugin events through onStatus;
  // panel state mirrors the last lifecycle-relevant status.
  const lastStatus = useRef<LocalTranscriberStatus>({ kind: "idle" });

  const fail = (err: unknown) => {
    setErrorText(err instanceof Error ? err.message : String(err));
    setState("error");
  };

  // Model readiness + mic list on mount and when the model changes.
  useEffect(() => {
    let cancelled = false;
    setState((s) => (s === "recording" || s === "transcribing" || s === "saving" ? s : "checking-model"));
    void t
      .isModelDownloaded(model)
      .then((downloaded) => {
        if (cancelled) return;
        setState((s) => (s === "checking-model" ? (downloaded ? "ready" : "needs-download") : s));
      })
      .catch((err) => {
        if (!cancelled) fail(err);
      });
    void t
      .listMicrophoneDevices()
      .then((devices) => {
        if (!cancelled) setMicDevices(devices);
      })
      .catch(() => {
        // A mic list failure shouldn't block recording — the default device is used.
      });
    return () => {
      cancelled = true;
    };
  }, [t, model]);

  useEffect(() => t.onStatus((s) => {
    lastStatus.current = s;
    if (s.kind === "error") setErrorText(s.message);
  }), [t]);

  const onDownload = () => {
    setDownloadPct(0);
    setState("downloading");
    void t
      .ensureModel(model, (pct) => setDownloadPct(pct))
      .then(() => setState("ready"))
      .catch(fail);
  };

  const onStart = () => {
    setErrorText(null);
    void t
      .start({ model, language: "en", micDevice: micDevice || undefined })
      .then(() => setState("recording"))
      .catch(fail);
  };

  const onStop = () => {
    setState("transcribing");
    void t
      .stop()
      .then(async (result) => {
        if (!tcw) {
          // No signed-in session: keep the transcript unsaved rather than
          // pretending it persisted.
          setState("ready");
          setErrorText(null);
          return;
        }
        setState("saving");
        const saved = await saveLocalTranscript(tcw, result);
        if (saved.ok) setState("saved");
        else throw new Error(saved.error.message);
      })
      .catch(fail);
  };

  return (
    <LocalTranscriberView
      state={state}
      model={model}
      micDevices={micDevices}
      micDevice={micDevice}
      downloadPct={downloadPct}
      statusText={errorText}
      signedIn={tcw !== undefined}
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
      onStart={onStart}
      onStop={onStop}
    />
  );
};
