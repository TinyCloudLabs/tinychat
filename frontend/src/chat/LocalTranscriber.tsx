// LOCAL recording panel — the desktop-only half of the Transcriber card.
//
// `LocalTranscriberView` is a pure function of its props (asserted with
// react-dom/server in tests); `LocalTranscriberPanel` owns the bridge instance,
// model download, and the record → transcribe → save lifecycle. Whisper at the
// pinned anarlog rev is batch-only, so the UI always says transcription happens
// after Stop.

import { useEffect, useMemo, useRef, useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { Loader2Icon, MicIcon, SquareIcon } from "lucide-react";

import { liveCapture } from "@/capture/recorder/liveCapture";
import { Button } from "@/components/ui/button";
import {
  createPrivateCloudApi,
  ENGINE_STORAGE_KEY,
  hasPrivateCloudConsent,
  PRIVATE_CLOUD_CONSENT_KEY,
  readStoredEngine,
  resolveEngine,
  type PrivateCloudAvailability,
  type TranscriptionEngine,
} from "@/lib/privateCloud";
import {
  CaptureStopUnconfirmedError,
  CloudConnectionLostError,
  createLocalTranscriber,
  createLocalTranscriptSaver,
  DEFAULT_LOCAL_MODEL,
  KeptRecordingError,
  LOCAL_MODEL_STORAGE_KEY,
  LOCAL_WHISPER_MODELS,
  PartialRecordingError,
  PreviousCaptureUnconfirmedError,
  prepareLocalTranscript,
  TranscriptionFailedError,
  type LocalTranscriptSaver,
  type CloudTranscriptResult,
  type LocalTranscriber,
  type LocalTranscriberStatus,
  type LocalTranscriptResult,
  type PreparedLocalTranscript,
  type WhisperModel,
} from "@/lib/localTranscriber";
import { PrivateCloudDisclosure } from "./PrivateCloudDisclosure";

export type LocalPanelState =
  | "checking-model"
  /** A closed view's capture, or a previous recording, is being stopped and confirmed. */
  | "stopping-previous"
  /** A capture no open view owns is not confirmed stopped; nothing starts until it is stopped. */
  | "previous-recording"
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
  /** Transcribing the stopped recording failed; Retry re-transcribes the same audio file. */
  | "transcribe-failed"
  /** Private cloud: polling failed for 10 minutes; "Keep waiting" resumes it. */
  | "connection-lost"
  /** Capture failed but kept a partial recording; it can be transcribed or discarded. */
  | "partial-recording"
  /** A previous launch or a closed view stopped this recording but never saved its transcript; it can be transcribed or discarded. */
  | "kept-recording"
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
    state === "stopping-previous" ||
    state === "previous-recording" ||
    state === "starting" ||
    state === "recording" ||
    state === "transcribing" ||
    state === "saving" ||
    state === "stop-failed" ||
    state === "transcribe-failed" ||
    state === "connection-lost" ||
    state === "partial-recording" ||
    state === "kept-recording" ||
    state === "save-failed"
  );
}

/** What the Retry button does in each failed state. */
export function localRetryAction(
  state: LocalPanelState,
): "stop" | "transcribe" | "save" | "stop-previous" | "readiness" {
  if (state === "stop-failed") return "stop";
  if (
    state === "transcribe-failed" ||
    state === "partial-recording" ||
    state === "kept-recording" ||
    state === "connection-lost"
  ) {
    return "transcribe";
  }
  if (state === "save-failed") return "save";
  if (state === "previous-recording") return "stop-previous";
  return "readiness";
}

/** The panel state a rejected start(), stop() or retryTranscription() lands in. */
export function localFailureState(
  err: unknown,
):
  | "stop-failed"
  | "transcribe-failed"
  | "connection-lost"
  | "partial-recording"
  | "kept-recording"
  | "previous-recording"
  | "error" {
  if (err instanceof CaptureStopUnconfirmedError) return "stop-failed";
  if (err instanceof PartialRecordingError) return "partial-recording";
  if (err instanceof KeptRecordingError) return "kept-recording";
  if (err instanceof CloudConnectionLostError) return "connection-lost";
  if (err instanceof TranscriptionFailedError) return "transcribe-failed";
  if (err instanceof PreviousCaptureUnconfirmedError) return "previous-recording";
  return "error";
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
  /** Leaves `transcribe-failed`, `partial-recording` or `kept-recording` without transcribing; the audio file stays on disk. */
  onDiscardRecording: () => void;
  onStart: () => void;
  onStop: () => void;
  /** The engine new recordings use. The picker shows only when private cloud is available. */
  engine?: TranscriptionEngine;
  cloudAvailable?: boolean;
  /** The user chose private cloud, but this account or build does not offer it. */
  cloudUnavailable?: boolean;
  /** Checking whether private cloud is available (with private cloud selected). */
  cloudChecking?: boolean;
  /** The availability check itself failed (offline, server error): not a "no". */
  cloudCheckFailed?: boolean;
  onRecheckCloud?: () => void;
  /** The one-time "Use private cloud" confirmation was given. */
  cloudConsented?: boolean;
  onEngineChange?: (engine: TranscriptionEngine) => void;
  onConsentCloud?: () => void;
  /** Private cloud progress while a job runs (uploading, queued, transcribing). */
  progressText?: string | null;
  /** Private cloud failure reference (correlation id). */
  referenceId?: string | null;
  /** False when Retry cannot help: only Discard (and maybe Transcribe on this Mac). */
  retryable?: boolean;
  /** Offer transcribing the kept private cloud recording with on-device Whisper. */
  onDeviceOffer?: boolean;
  /** The kept recording (`kept-recording`) was made for private cloud: Transcribe uploads it. */
  keptCloud?: boolean;
  onTranscribeOnDevice?: () => void;
  /** That recording could be transcribed on this Mac once a Whisper model is downloaded. */
  onDeviceNeedsModel?: boolean;
  /** A model download for the kept recording is running (progress in downloadPct). */
  modelDownloading?: boolean;
  onDownloadForOnDevice?: () => void;
  /** An informational note (e.g. the private cloud copy's deletion schedule). */
  noteText?: string | null;
  /** A private cloud recording is nearing the 2 hour limit. */
  nearCloudLimit?: boolean;
}

/** The desktop's opening paragraph and recording location for the shared disclosure. */
const DesktopPrivateCloudDisclosure: FC = () => (
  <PrivateCloudDisclosure
    intro={
      <>
        No download needed. After you stop, this recording (up to 2 hours) is uploaded over an encrypted
        connection to <strong>TinyCloud Private Transcription</strong>, a dedicated confidential virtual machine
        on Phala Cloud. It sends short speech segments to <strong>Tinfoil</strong> for speech-to-text.
      </>
    }
    originalStays="The original recording stays on this Mac."
  />
);

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
  onDiscardRecording,
  onStart,
  onStop,
  engine = "on-device",
  cloudAvailable = false,
  cloudUnavailable = false,
  cloudChecking = false,
  cloudCheckFailed = false,
  onRecheckCloud,
  cloudConsented = false,
  onEngineChange,
  onConsentCloud,
  progressText = null,
  referenceId = null,
  retryable = true,
  onDeviceOffer = false,
  keptCloud = false,
  onTranscribeOnDevice,
  onDeviceNeedsModel = false,
  modelDownloading = false,
  onDownloadForOnDevice,
  noteText = null,
  nearCloudLimit = false,
}) => {
  const cloud = engine === "private-cloud";
  const modelInfo = LOCAL_WHISPER_MODELS.find((m) => m.id === model);
  const recording = state === "recording";
  const micDevices = mics.status === "loaded" ? mics.devices : [];
  const locked = isLocalWorkflowActive(state);
  /** States that offer moving a private cloud recording to on-device Whisper. */
  const canMoveOnDevice = state === "transcribe-failed" || state === "kept-recording";
  const busy =
    state === "checking-model" ||
    state === "stopping-previous" ||
    state === "downloading" ||
    state === "starting" ||
    state === "transcribing" ||
    state === "saving";

  return (
    <div className="mt-3 flex flex-col gap-2">
      {(cloudAvailable || cloudCheckFailed) && (
        <div role="radiogroup" aria-label="Transcription engine" className="inline-flex w-fit rounded-md border p-0.5">
          {(["on-device", "private-cloud"] as const).map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={engine === e}
              disabled={locked || busy}
              onClick={() => onEngineChange?.(e)}
              className={`rounded px-3 py-1 text-xs disabled:opacity-60 ${
                engine === e ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {e === "on-device" ? "On this Mac" : "Private cloud"}
            </button>
          ))}
        </div>
      )}

      {cloud ? (
        <DesktopPrivateCloudDisclosure />
      ) : (
        <p className="text-xs text-muted-foreground">
          Record this Mac&apos;s microphone and meeting audio, then transcribe on-device with
          Whisper. Nothing leaves the machine until the transcript is saved to your space.
          Whisper runs after you stop, not live.
        </p>
      )}
      {cloud && cloudCheckFailed && (
        <p className="text-xs text-muted-foreground">
          Private cloud transcription is unavailable right now (Exo couldn&apos;t reach it). Check again, or choose
          On this Mac.
        </p>
      )}
      {cloudUnavailable && (
        <p className="text-xs text-muted-foreground">
          Private cloud transcription isn&apos;t available right now, so new recordings are transcribed on this
          Mac.
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        {!cloud && (
          <>
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
          </>
        )}

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
        {(state === "ready" || state === "saved") && !recording && cloud && cloudChecking && (
          <Button type="button" size="sm" disabled className="h-9 gap-1.5">
            <Loader2Icon className="size-4 animate-spin" />
            <span>Checking private cloud…</span>
          </Button>
        )}
        {(state === "ready" || state === "saved") && !recording && cloud && cloudCheckFailed && (
          <Button type="button" size="sm" variant="outline" onClick={onRecheckCloud} className="h-9">
            Check again
          </Button>
        )}
        {(state === "ready" || state === "saved") && !recording && cloud && cloudAvailable && !cloudConsented && (
          <Button type="button" size="sm" onClick={onConsentCloud} className="h-9">
            Use private cloud
          </Button>
        )}
        {(state === "ready" || state === "saved") && !recording && (!cloud || (cloudAvailable && cloudConsented)) && (
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
            <span>
              {state === "starting"
                ? "Starting recording…"
                : state === "transcribing"
                  ? (progressText ?? "Transcribing…")
                  : "Saving…"}
            </span>
          </Button>
        )}
        {state === "checking-model" && (
          <Button type="button" size="sm" disabled className="h-9 gap-1.5">
            <Loader2Icon className="size-4 animate-spin" />
            <span>Checking model…</span>
          </Button>
        )}
        {state === "stopping-previous" && (
          <Button type="button" size="sm" disabled className="h-9 gap-1.5">
            <Loader2Icon className="size-4 animate-spin" />
            <span>Stopping previous recording…</span>
          </Button>
        )}
        {state === "previous-recording" && (
          <Button type="button" size="sm" variant="destructive" onClick={onRetry} className="h-9">
            Stop previous recording
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
        {(state === "transcribe-failed" ||
          state === "partial-recording" ||
          state === "kept-recording" ||
          state === "connection-lost") && (
          <>
            {(retryable || state === "partial-recording" || state === "kept-recording") && (
              <Button type="button" size="sm" onClick={onRetry} className="h-9">
                {state === "partial-recording"
                  ? "Transcribe partial recording"
                  : state === "kept-recording"
                    ? keptCloud
                      ? "Transcribe in private cloud"
                      : "Transcribe recording"
                    : state === "connection-lost"
                      ? "Keep waiting"
                      : "Retry transcription"}
              </Button>
            )}
            {onDeviceOffer && canMoveOnDevice && (
              <Button type="button" size="sm" variant="outline" onClick={onTranscribeOnDevice} className="h-9">
                Transcribe on this Mac
              </Button>
            )}
            {onDeviceNeedsModel && canMoveOnDevice && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onDownloadForOnDevice}
                disabled={modelDownloading}
                className="h-9 gap-1.5"
              >
                {modelDownloading && <Loader2Icon className="size-4 animate-spin" />}
                <span>
                  {modelDownloading
                    ? `Downloading model${downloadPct !== null ? ` · ${downloadPct}%` : "…"}`
                    : `Download model${modelInfo ? ` (~${modelInfo.approxSizeMb} MB)` : ""}`}
                </span>
              </Button>
            )}
            <Button type="button" size="sm" variant="outline" onClick={onDiscardRecording} className="h-9">
              Discard recording
            </Button>
          </>
        )}
        {state === "save-failed" && (
          <Button type="button" size="sm" onClick={onRetry} className="h-9">
            Retry save
          </Button>
        )}
      </div>

      {state === "saved" && (
        <p className="text-xs text-muted-foreground">Saved to Library as Exo Local.</p>
      )}
      {state === "save-failed" && (
        <p className="text-xs text-muted-foreground">
          The transcript is kept here until it saves. If you leave this view first, Exo offers the
          recording again.
        </p>
      )}
      {state === "previous-recording" && (
        <p className="text-xs text-muted-foreground">
          A new recording can&apos;t start until the previous one is confirmed stopped. Stopping it does
          not transcribe it; any audio it recorded stays on this Mac.
        </p>
      )}
      {(state === "transcribe-failed" || state === "connection-lost") && (
        <p className="text-xs text-muted-foreground">
          The recording is kept until it transcribes or you discard it. Discarding leaves its audio
          file on this Mac.
        </p>
      )}
      {onDeviceNeedsModel && canMoveOnDevice && (
        <p className="text-xs text-muted-foreground">
          To transcribe this recording on this Mac instead, download a Whisper model first.
        </p>
      )}
      {recording && cloud && nearCloudLimit && (
        <p className="text-xs text-muted-foreground">
          Private cloud transcription takes recordings up to 2 hours. Stop soon, or transcribe this one on this Mac.
        </p>
      )}
      {state === "kept-recording" && (
        <p className="text-xs text-muted-foreground">
          Transcribe it now, or discard it; discarding leaves its audio file on this Mac.
        </p>
      )}
      {state === "partial-recording" && (
        <p className="text-xs text-muted-foreground">
          Capture stopped with an error, but the audio recorded until then was kept. Transcribe it, or
          discard it; discarding leaves its audio file on this Mac.
        </p>
      )}
      {(recording || state === "stop-failed") && (
        <p className="text-xs text-muted-foreground">
          Keep this window open while recording.
        </p>
      )}
      {statusText !== null && (
        <p role="alert" className="text-xs text-destructive">
          {statusText}
        </p>
      )}
      {referenceId !== null && <p className="text-xs text-muted-foreground">Reference: {referenceId}</p>}
      {noteText !== null && <p className="text-xs text-muted-foreground">{noteText}</p>}
    </div>
  );
};

export interface LocalTranscriberPanelProps {
  tcw: TinyCloudWeb;
  onWorkflowActiveChange?: (active: boolean) => void;
  /** Backend + session for the private cloud engine; without them it is never offered. */
  backendUrl?: string;
  sessionStore?: SessionStore;
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

/** What a mounted panel takes over, in order: a closed view's transcription
 *  (adoptTranscription), then this account's kept recording (on-device, or a
 *  private cloud one never uploaded, offered whether or not private cloud is
 *  available now), then, with private cloud available, a cloud job a previous
 *  launch or closed view left. A panel
 *  already running a recording of its own takes over none but the first. A
 *  kept recording a closed view is still saving is not taken over: `saving`
 *  settles with that save, after which the panel checks again. */
export function takeOverOnMount(
  t: LocalTranscriber,
  opts: { wasActive: boolean; cloudAvailable: boolean },
):
  | { from: "adopted" | "kept"; outcome: Promise<LocalTranscriptResult> }
  | { from: "cloud"; outcome: Promise<LocalTranscriptResult | null> }
  | { from: "saving"; settled: Promise<void> }
  | null {
  const adopted = t.adoptTranscription();
  if (adopted !== null) return { from: "adopted", outcome: adopted };
  if (opts.wasActive) return null;
  const kept = t.resumeKeptRecording();
  if (kept !== null) return { from: "kept", outcome: kept };
  const saving = t.keptRecordingSave();
  if (saving !== null) return { from: "saving", settled: saving };
  if (!opts.cloudAvailable) return null;
  const resumed = t.resumeCloudTranscription();
  return resumed === null ? null : { from: "cloud", outcome: resumed };
}

/** Normalizes a transcript to save. With no speech there is nothing to save,
 *  so its recording is finished (a relaunch would only find silence again):
 *  an on-device one's kept recording is forgotten, and a private cloud one is
 *  deleted from PTX along with its pending record. */
export function prepareTranscriptToSave(t: LocalTranscriber, result: LocalTranscriptResult): PreparedLocalTranscript {
  try {
    return prepareLocalTranscript(result);
  } catch (err) {
    if (result.engine !== "private-cloud") t.finishOnDeviceTranscript(result);
    else {
      t.finishCloudTranscript(result).catch((deleteErr: unknown) => {
        console.warn("Deleting a private cloud transcript with no speech failed; a relaunch retries", deleteErr);
      });
    }
    throw err;
  }
}

/** Saves a prepared transcript, then finishes its recording: an on-device one
 *  is not offered as kept while the save runs and is forgotten once saved; a
 *  private cloud one is deleted from PTX (`cloudDeletion`). Rejects, keeping
 *  the recording, when the save fails. */
export async function saveTranscriptAndFinish(
  t: LocalTranscriber,
  save: LocalTranscriptSaver,
  prepared: PreparedLocalTranscript,
  result: LocalTranscriptResult | null,
): Promise<{ cloudDeletion: Promise<void> | null }> {
  const saving = save(prepared).then((saved) => {
    if (!saved.ok) throw new Error(saved.error.message);
  });
  if (result !== null && result.engine !== "private-cloud") t.savingOnDeviceTranscript(result, saving);
  await saving;
  if (result?.engine === "private-cloud") {
    const cloudDeletion = t.finishCloudTranscript(result);
    cloudDeletion.catch(() => {}); // the caller handles it; never an unhandled rejection meanwhile
    return { cloudDeletion };
  }
  if (result !== null) t.finishOnDeviceTranscript(result);
  return { cloudDeletion: null };
}

/** Waits between availability checks after one fails (plus the first try). */
const CLOUD_CHECK_RETRY_MS = [2_000, 5_000];

/** Private cloud: 1 h 50 min into a recording, warn before the 2 hour limit. */
const CLOUD_LIMIT_WARNING_MS = 110 * 60_000;

/** Progress line for a private cloud status, or null for anything else. */
export function cloudProgressText(s: LocalTranscriberStatus): string | null {
  if (s.kind === "uploading") return s.pct === null ? "Uploading…" : `Uploading… ${s.pct}%`;
  if (s.kind === "cloud-processing") {
    if (s.stage === "queued") {
      return s.queuePosition !== null && s.queuePosition > 0 ? `Queued (position ${s.queuePosition})…` : "Queued…";
    }
    return s.regionsTotal !== null && s.regionsTotal > 0
      ? `Transcribing in private cloud… ${s.regionsCompleted ?? 0}/${s.regionsTotal}`
      : "Transcribing in private cloud…";
  }
  return null;
}

/** Stateful owner: bridge instance, model readiness, capture lifecycle, save. */
export const LocalTranscriberPanel: FC<LocalTranscriberPanelProps> = ({
  tcw,
  transcriber,
  onWorkflowActiveChange,
  backendUrl,
  sessionStore,
}) => {
  // Transcripts recovered from this account's other private cloud jobs are
  // saved one at a time, each as its own Exo Local meeting, then deleted.
  const tcwRef = useRef(tcw);
  tcwRef.current = tcw;
  const recoverySaver = useRef<LocalTranscriptSaver | null>(null);
  const recoveryQueue = useRef<Promise<unknown>>(Promise.resolve());
  const recoveredCount = useRef(0);
  const [recoveredNote, setRecoveredNote] = useState<string | null>(null);
  const transcriberRef = useRef<LocalTranscriber | null>(null);
  const saveRecovered = (result: CloudTranscriptResult): Promise<void> => {
    const run = recoveryQueue.current.then(async () => {
      const owner = transcriberRef.current;
      if (owner === null) return;
      let prepared: PreparedLocalTranscript;
      try {
        prepared = prepareLocalTranscript(result);
      } catch {
        await owner.finishCloudTranscript(result); // no speech: nothing to keep
        return;
      }
      recoverySaver.current ??= createLocalTranscriptSaver(tcwRef.current);
      const saved = await recoverySaver.current(prepared);
      if (!saved.ok) throw new Error(saved.error.message);
      recoveredCount.current += 1;
      setRecoveredNote(
        recoveredCount.current === 1
          ? "Saved an earlier private cloud transcript to Library."
          : `Saved ${recoveredCount.current} earlier private cloud transcripts to Library.`,
      );
      await owner.finishCloudTranscript(result);
    });
    recoveryQueue.current = run.catch(() => {});
    return run;
  };
  if (transcriberRef.current === null) {
    transcriberRef.current =
      transcriber ??
      createLocalTranscriber(undefined, {
        // Kept recordings belong to the signed-in account.
        account: () => tcwRef.current.did,
        ...(backendUrl !== undefined && sessionStore !== undefined
          ? { cloud: { api: createPrivateCloudApi(backendUrl, { sessionStore }), saveRecovered } }
          : {}),
      });
  }
  const t = transcriberRef.current;

  // A stop that is not confirmed here is left as the previous recording,
  // which the next mounted panel shows with "Stop previous recording"; a
  // running or failed transcription is handed to the next panel to adopt.
  useEffect(() => () => {
    void t.stopCaptureOnUnmount().catch((err) => {
      console.error("Failed to stop local recording when leaving the view", err);
    });
  }, [t]);

  // Saves are bounded and serialized: a timed-out save may still be writing.
  const saveToSpace = useMemo(() => createLocalTranscriptSaver(tcw), [tcw]);

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

  // Engine: resolved once availability is known; an explicit choice wins, and
  // a stored private cloud choice waits (visibly) for the check.
  const [engine, setEngine] = useState<TranscriptionEngine>(() =>
    readStoredEngine() === "private-cloud" ? "private-cloud" : "on-device",
  );
  const [cloudCheck, setCloudCheck] = useState<"checking" | PrivateCloudAvailability>("checking");
  const [cloudCheckRound, setCloudCheckRound] = useState(0);
  const [cloudUnavailable, setCloudUnavailable] = useState(false);
  const [modelDownloading, setModelDownloading] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** Tenant-list recovery runs once per panel. */
  const recoveryStarted = useRef(false);
  const [cloudConsented, setCloudConsented] = useState(hasPrivateCloudConsent);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [onDeviceOffer, setOnDeviceOffer] = useState(false);
  const [keptCloud, setKeptCloud] = useState(false);
  const [modelReady, setModelReady] = useState(false);

  // The Live Edge, held still (this recorder reports no level), while this Mac's microphone records.
  const capturing = state === "recording";
  useEffect(() => {
    if (!capturing) return;
    liveCapture.set({ source: "desktop-local", warning: false, startedAt: null });
    return () => {
      if (liveCapture.get()?.source === "desktop-local") liveCapture.set(null);
    };
  }, [capturing]);
  const [noteText, setNoteText] = useState<string | null>(null);
  const [nearCloudLimit, setNearCloudLimit] = useState(false);
  // The transcript being saved: once saved, a private cloud one is deleted
  // from PTX and an on-device one's kept recording is forgotten.
  const savingResult = useRef<LocalTranscriptResult | null>(null);

  useEffect(() => {
    onWorkflowActiveChange?.(isLocalWorkflowActive(state));
    return () => onWorkflowActiveChange?.(false);
  }, [onWorkflowActiveChange, state]);

  // Engine availability, on every mount and on "Check again": private cloud
  // needs this build's native upload (a compiled-in PTX origin) and the
  // backend's 200 for this account. A failed check (not a 404) is retried a
  // bounded number of times and then shown as "unavailable right now".
  useEffect(() => {
    let cancelled = false;
    setCloudCheck("checking");
    void (async () => {
      let availability = await t.privateCloudAvailability();
      for (const waitMs of CLOUD_CHECK_RETRY_MS) {
        if (availability !== "failed" || cancelled) break;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        if (cancelled) return;
        availability = await t.privateCloudAvailability();
      }
      const stored = readStoredEngine();
      const anyModel = availability === "available" && stored === null ? await t.anyModelDownloaded() : true;
      if (cancelled) return;
      setCloudCheck(availability);
      setCloudUnavailable(stored === "private-cloud" && availability === "hidden");
      // Never switch the engine under a recording in progress, and never
      // quietly drop a stored private cloud choice because a check failed.
      if (isLocalWorkflowActive(stateRef.current)) return;
      if (availability === "failed") {
        if (stored !== "private-cloud") setEngine("on-device");
        return;
      }
      setEngine(resolveEngine({ stored, cloudAvailable: availability === "available", anyModelDownloaded: anyModel }));
    })().catch((err) => {
      if (!cancelled) {
        console.warn("Choosing the transcription engine failed", err);
        setCloudCheck("failed");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [t, cloudCheckRound]);

  const fail = (err: unknown) => {
    setErrorText(err instanceof Error ? err.message : String(err));
    setState("error");
  };

  // Model readiness + mic list on mount and when the model or engine changes.
  // A previous recording that is not confirmed stopped comes first: nothing
  // starts over it.
  useEffect(() => {
    let cancelled = false;
    const wasActive = isLocalWorkflowActive(stateRef.current);
    setState((s) => (isLocalWorkflowActive(s) ? s : "checking-model"));
    void (async () => {
      const previous = await t.previousRecording(() => {
        if (!cancelled) setState((s) => (s === "checking-model" ? "stopping-previous" : s));
      });
      if (cancelled) return;
      if (previous !== null) {
        setErrorText(previous.message);
        setState("previous-recording");
        return;
      }
      setState((s) => (s === "stopping-previous" ? "checking-model" : s));
      // A transcription whose panel closed is shown and finished here: its
      // transcript is saved by this panel, once; a failure offers Retry/Discard.
      // A kept recording (Exo quit or crashed, or its view closed) is offered
      // for Transcribe or Discard; a private cloud job left by a previous
      // launch is finished the same way.
      const takeover = takeOverOnMount(t, { wasActive, cloudAvailable: cloudCheck === "available" });
      if (takeover?.from === "adopted") {
        setState("transcribing");
        void takeover.outcome.then(saveTranscript, failWithRecovery);
        return;
      }
      if (takeover?.from === "kept") {
        void takeover.outcome.then(saveTranscript, failWithRecovery);
        return;
      }
      if (takeover?.from === "cloud") {
        setState("transcribing");
        void takeover.outcome.then((result) => {
          if (result !== null) {
            saveTranscript(result);
            return;
          }
          // That job no longer exists: back to ready.
          setState("checking-model");
          setRetryCount((count) => count + 1);
        }, failWithRecovery);
        return;
      }
      if (takeover?.from === "saving") {
        // A closed view is still saving this account's kept recording: check
        // again once that save settles, so a failed save offers it here.
        void takeover.settled.then(() => {
          if (!cancelled) setRetryCount((count) => count + 1);
        });
      }
      if (cloudCheck === "available") {
        // Jobs of this account no recording here knows (a lost record, a
        // relaunch, another Mac): finish them so no transcript is lost.
        if (!recoveryStarted.current) {
          recoveryStarted.current = true;
          void t.recoverCloudTranscripts().catch((err) => {
            console.warn("Private cloud transcript recovery failed; the next launch retries", err);
          });
        }
      }
      const downloaded = await t.isModelDownloaded(model);
      if (cancelled) return;
      setModelReady(downloaded);
      const ready = engine === "private-cloud" || downloaded;
      setState((s) => (s === "checking-model" ? (ready ? "ready" : "needs-download") : s));
    })().catch((err) => {
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
  }, [t, model, engine, retryCount, cloudCheck]);

  useEffect(() => t.onStatus((s) => {
    lastStatus.current = s;
    if (s.kind === "error") setErrorText(s.message);
    const cloudText = cloudProgressText(s);
    if (cloudText !== null) setProgressText(cloudText);
    else if (s.kind !== "transcribing") setProgressText(null);
  }), [t]);

  // Private cloud: warn at 1 h 50 min into a recording.
  useEffect(() => {
    setNearCloudLimit(false);
    if (state !== "recording" || engine !== "private-cloud") return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started >= CLOUD_LIMIT_WARNING_MS) setNearCloudLimit(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [state, engine]);

  const clearFailure = () => {
    setErrorText(null);
    setReferenceId(null);
    setRetryable(true);
    setOnDeviceOffer(false);
    setKeptCloud(false);
  };

  const onDownload = () => {
    setDownloadPct(0);
    setErrorText(null);
    setState("downloading");
    void t
      .ensureModel(model, (pct) => setDownloadPct(pct))
      .then(() => {
        setModelReady(true);
        setState("ready");
      })
      .catch((err) => {
        setErrorText(err instanceof Error ? err.message : String(err));
        setState("needs-download");
      });
  };

  // A rejected start, stop or transcription lands in the state that offers its
  // recovery: a failed transcription keeps its recording in the transcriber for
  // Retry, and an unconfirmed previous capture offers "Stop previous recording".
  const failWithRecovery = (err: unknown) => {
    setErrorText(err instanceof Error ? err.message : String(err));
    setProgressText(null);
    if (err instanceof TranscriptionFailedError) {
      setReferenceId(err.correlationId);
      setRetryable(err.retryable);
      setOnDeviceOffer(err.offerOnDevice);
    }
    setKeptCloud(err instanceof KeptRecordingError && err.engine === "private-cloud");
    setState(localFailureState(err));
  };

  const onStart = () => {
    clearFailure();
    setNoteText(null);
    setState("starting");
    void t
      .start({ model, language: "en", micDevice: micDevice || undefined, engine })
      .then(() => setState("recording"), failWithRecovery);
  };

  const save = (prepared: PreparedLocalTranscript) => {
    setErrorText(null);
    setState("saving");
    void saveTranscriptAndFinish(t, saveToSpace, prepared, savingResult.current)
      .then(({ cloudDeletion }) => {
        setPendingSave(null);
        savingResult.current = null;
        setState("saved");
        if (cloudDeletion !== null) {
          // Saved to the space: the transcript is being deleted from PTX.
          cloudDeletion.catch((err) => {
            console.error("Deleting the private cloud transcript failed", err);
            setNoteText("The private cloud copy could not be deleted now; it is scheduled for deletion 24 hours after transcription.");
          });
        }
      })
      .catch((err) => {
        setErrorText(err instanceof Error ? err.message : String(err));
        setState("save-failed");
      });
  };

  const saveTranscript = (result: LocalTranscriptResult) => {
    setProgressText(null);
    let prepared: PreparedLocalTranscript;
    try {
      prepared = prepareTranscriptToSave(t, result);
    } catch (err) {
      fail(err);
      return;
    }
    savingResult.current = result;
    setPendingSave(prepared);
    save(prepared);
  };

  const onStop = () => {
    clearFailure();
    setState("transcribing");
    void t.stop().then(saveTranscript, failWithRecovery);
  };

  // Stops the previous recording, then re-runs readiness once native capture
  // is confirmed inactive; otherwise stays here with the new failure.
  const onStopPrevious = () => {
    setErrorText(null);
    setState("stopping-previous");
    void t.stopPreviousRecording().then(
      () => {
        setState("checking-model");
        setRetryCount((count) => count + 1);
      },
      (err) => {
        setErrorText(err instanceof Error ? err.message : String(err));
        setState("previous-recording");
      },
    );
  };

  const onDiscardRecording = () => {
    try {
      t.discardRecording();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
      return;
    }
    clearFailure();
    setState("ready");
    setRetryCount((count) => count + 1);
  };

  // The kept recording could be transcribed on this Mac once a model exists.
  const onDownloadForOnDevice = () => {
    setModelDownloading(true);
    setDownloadPct(0);
    void t
      .ensureModel(model, (pct) => setDownloadPct(pct))
      .then(() => setModelReady(true))
      .catch((err) => setErrorText(`Model download failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setModelDownloading(false));
  };

  const onTranscribeOnDevice = () => {
    clearFailure();
    setState("transcribing");
    void t.retryTranscription({ onDevice: { model } }).then(saveTranscript, failWithRecovery);
  };

  const onRetry = () => {
    switch (localRetryAction(state)) {
      case "stop":
        onStop();
        return;
      case "transcribe":
        clearFailure();
        setState("transcribing");
        void t.retryTranscription().then(saveTranscript, failWithRecovery);
        return;
      case "save":
        if (pendingSave === null) {
          fail(new Error("No transcript is waiting to be saved"));
          return;
        }
        save(pendingSave);
        return;
      case "stop-previous":
        onStopPrevious();
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
      engine={engine}
      cloudAvailable={cloudCheck === "available"}
      cloudUnavailable={cloudUnavailable}
      cloudChecking={cloudCheck === "checking"}
      cloudCheckFailed={cloudCheck === "failed"}
      onRecheckCloud={() => setCloudCheckRound((round) => round + 1)}
      cloudConsented={cloudConsented}
      progressText={progressText}
      referenceId={referenceId}
      retryable={retryable}
      onDeviceOffer={onDeviceOffer && modelReady}
      keptCloud={keptCloud}
      onDeviceNeedsModel={onDeviceOffer && !modelReady}
      modelDownloading={modelDownloading}
      onDownloadForOnDevice={onDownloadForOnDevice}
      noteText={noteText ?? recoveredNote}
      nearCloudLimit={nearCloudLimit}
      onModelChange={(m) => {
        setModel(m);
        try {
          localStorage.setItem(LOCAL_MODEL_STORAGE_KEY, m);
        } catch {
          // localStorage can throw in private contexts; the preference is best-effort.
        }
      }}
      onEngineChange={(e) => {
        setEngine(e);
        setCloudUnavailable(false);
        try {
          localStorage.setItem(ENGINE_STORAGE_KEY, e);
        } catch {
          // Best-effort, like the model preference.
        }
      }}
      onConsentCloud={() => {
        setCloudConsented(true);
        try {
          localStorage.setItem(PRIVATE_CLOUD_CONSENT_KEY, "1");
        } catch {
          // Best-effort: without it the confirmation is asked again next launch.
        }
      }}
      onMicChange={setMicDevice}
      onDownload={onDownload}
      onRetry={onRetry}
      onDiscardRecording={onDiscardRecording}
      onTranscribeOnDevice={onTranscribeOnDevice}
      onStart={onStart}
      onStop={onStop}
    />
  );
};
