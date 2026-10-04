// UPLOAD AUDIO panel — the Transcriber card's third surface, on every platform.
//
// `AudioUploadView` is a pure function of its props (asserted with
// react-dom/server in tests); `AudioUploadPanel` checks which engines are
// available, holds the picked file and the per-upload choices, and drives the
// app-wide upload runner (lib/audioUpload.ts), which outlives this view.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type FC } from "react";
import { useNavigate } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ASSEMBLYAI_TERMS_URL,
  AssemblyAiError,
  createAssemblyAiClient,
  createHostedAssemblyAiClient,
  readAssemblyAiKey,
  readAssemblyAiKeyHint,
  readAssemblyAiKeyMode,
  type AssemblyAiKeyMode,
  type AssemblyAiKeyStatus,
  type HostedAssemblyAiCapabilities,
} from "@/lib/assemblyai";
import {
  PRIVATE_CLOUD_ACCEPT,
  privateCloudContentType,
  readDefaultUploadEngine,
  UPLOAD_ACCEPT,
  UPLOAD_ENGINE_LABELS,
  uploadRunner,
  type UploadDeps,
  type UploadEngine,
  type UploadState,
} from "@/lib/audioUpload";
import { isSecretsUnlocked } from "@/lib/connectors/connectorSecrets";
import { createLocalTranscriptSaver } from "@/lib/localTranscriber";
import { buildPtxUploadOrigin, createPrivateCloudApi, createPrivateCloudJob, type PrivateCloudCapabilities } from "@/lib/privateCloud";
import { FilePicker } from "./FilePicker";
import { PrivateCloudDisclosure } from "./PrivateCloudDisclosure";

/** Whether an engine can take a new upload, and if not, why (one line). */
export type EngineStatus =
  | { state: "available" }
  | { state: "checking" }
  | { state: "unavailable"; reason: string; action?: "settings" | "recheck" };

/** Private cloud's and TinyCloud's AssemblyAI account's size limit (C1); capabilities may lower it. */
const PRIVATE_CLOUD_MAX_BYTES = 120_960_000;

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Whether files for this engine (and AssemblyAI account) go through TinyCloud's servers, which take only the C1 types. */
function c1Only(engine: UploadEngine, assemblyAiMode: AssemblyAiKeyMode): boolean {
  return engine === "private-cloud" || assemblyAiMode === "hosted";
}

/** Why the picked file can't go to `engine`, or null. */
export function fileProblem(
  file: { name: string; type: string; size: number } | null,
  engine: UploadEngine,
  maxBytes: number = PRIVATE_CLOUD_MAX_BYTES,
  assemblyAiMode: AssemblyAiKeyMode = "hosted",
): string | null {
  if (file === null || !c1Only(engine, assemblyAiMode)) return null;
  const who = engine === "private-cloud" ? "Private transcription" : "TinyCloud's AssemblyAI account";
  if (privateCloudContentType(file) === null) {
    return engine === "private-cloud"
      ? "Private transcription takes MP3, WAV, OGG, M4A/MP4, WebM or FLAC audio. Choose AssemblyAI, or convert the file."
      : "TinyCloud's AssemblyAI account takes MP3, WAV, OGG, M4A/MP4, WebM or FLAC audio. Use your own AssemblyAI key, or convert the file.";
  }
  if (file.size > maxBytes) return `${who} takes files up to ${formatBytes(maxBytes)} (and 2 hours).`;
  return null;
}

const PrivateUploadDisclosure: FC = () => (
  <PrivateCloudDisclosure
    intro={
      <>
        This file (up to 2 hours) is uploaded over an encrypted connection to{" "}
        <strong>TinyCloud Private Transcription</strong>, a dedicated confidential virtual machine on Phala Cloud. It
        sends short speech segments to <strong>Tinfoil</strong> for speech-to-text.
      </>
    }
    originalStays="A copy of the original file is kept in your TinyCloud space, next to its transcript."
  />
);

/** C10: the honest route for each AssemblyAI account; nothing "verified" or "end-to-end". */
const AssemblyAiDisclosure: FC<{ mode: AssemblyAiKeyMode }> = ({ mode }) =>
  mode === "hosted" ? (
    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <p>
        Your file goes to Exo&apos;s server (a confidential VM on Phala Cloud), which sends it to{" "}
        <strong>AssemblyAI</strong> under TinyCloud&apos;s account and{" "}
        <a href={ASSEMBLYAI_TERMS_URL} target="_blank" rel="noopener noreferrer" className="underline">
          AssemblyAI&apos;s terms
        </a>
        . AssemblyAI is not part of TinyCloud&apos;s private transcription.
      </p>
      <p>Exo deletes it at AssemblyAI after saving the transcript to your TinyCloud space.</p>
    </div>
  ) : (
    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <p>
        This file goes from this device to <strong>AssemblyAI</strong> under your own API key and{" "}
        <a href={ASSEMBLYAI_TERMS_URL} target="_blank" rel="noopener noreferrer" className="underline">
          AssemblyAI&apos;s terms
        </a>
        . The file does not pass through TinyChat&apos;s server, and AssemblyAI is not part of TinyCloud&apos;s
        private transcription.
      </p>
      <p>
        After the transcript is saved to your TinyCloud space, Exo deletes the copy at AssemblyAI, including the
        uploaded file. To do that, Exo&apos;s server forwards your key to AssemblyAI once; it never stores or logs it.
      </p>
    </div>
  );

function stageText(job: UploadState): string {
  const engine = UPLOAD_ENGINE_LABELS[job.engine];
  switch (job.stage) {
    case "preparing":
      return "Preparing the file…";
    case "uploading":
      return job.uploadPct === null ? `Uploading to ${engine}…` : `Uploading to ${engine}… ${job.uploadPct}%`;
    case "queued":
    case "transcribing":
      return job.detail ?? "Transcribing…";
    case "saving":
      return "Saving to your TinyCloud space…";
    default:
      return "";
  }
}

function audioText(job: UploadState): string | null {
  const saved = job.stage === "saved";
  switch (job.audio.stage) {
    case "storing":
      return job.audio.pct === null || job.audio.pct === 0
        ? "Storing the original audio in your space…"
        : `Storing the original audio in your space… ${job.audio.pct}%`;
    case "stored":
      return "Original audio stored in your TinyCloud space.";
    case "quota":
      return saved
        ? "The original audio wasn't stored: your TinyCloud storage is full. The transcript was saved without it."
        : "The original audio wasn't stored: your TinyCloud storage is full. The transcript will be saved without it.";
    case "failed":
      return saved
        ? "The original audio couldn't be stored. The transcript was saved without it."
        : "The original audio couldn't be stored. The transcript will be saved without it.";
    case "not-stored":
      return saved ? "The original audio wasn't stored: the page closed before it finished." : null;
  }
}

export interface AudioUploadViewProps {
  /** The running, failed or finished upload; null shows the form. */
  job: UploadState | null;
  file: { name: string; type: string; size: number } | null;
  engine: UploadEngine;
  engines: Readonly<Record<UploadEngine, EngineStatus>>;
  /** Whose AssemblyAI account uploads to AssemblyAI use (Settings → Transcription). */
  assemblyAiMode?: AssemblyAiKeyMode;
  /** The checkbox as the user left it. */
  diarize: boolean;
  /** Why speaker identification can't be used with this engine, or null. */
  diarizeUnavailable: string | null;
  /** Why the picked file can't go to this engine, or null. */
  fileProblem: string | null;
  onEngineChange: (engine: UploadEngine) => void;
  onDiarizeChange: (diarize: boolean) => void;
  onFile: (file: File) => void;
  onTranscribe: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
  onRecheck: () => void;
}

export const AudioUploadView: FC<AudioUploadViewProps> = ({
  job,
  file,
  engine,
  engines,
  assemblyAiMode = "hosted",
  diarize,
  diarizeUnavailable,
  fileProblem: problem,
  onEngineChange,
  onDiarizeChange,
  onFile,
  onTranscribe,
  onRetry,
  onDismiss,
  onOpenSettings,
  onRecheck,
}) => {
  if (job !== null && job.stage === "elsewhere") {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-xs text-muted-foreground" role="status">
          {job.fileName ? <>&ldquo;{job.fileName}&rdquo; is </> : "An upload is "}
          being transcribed in another Exo tab or window. It continues there; this one can check again once it is
          closed or finished.
        </p>
        <div>
          <Button type="button" size="sm" variant="outline" onClick={onRetry} className="h-9">
            Check again
          </Button>
        </div>
      </div>
    );
  }
  if (job !== null) {
    const busy = job.stage !== "saved" && job.stage !== "failed";
    const audio = audioText(job);
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p className="truncate text-sm font-medium" title={job.fileName}>
          {job.fileName}
          <span className="font-normal text-muted-foreground"> · {UPLOAD_ENGINE_LABELS[job.engine]}</span>
        </p>
        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2Icon className="size-4 animate-spin" />
            {stageText(job)}
          </p>
        )}
        {job.stage === "saved" && (
          <p className="text-xs text-muted-foreground" role="status">
            Saved to Library as {job.savedTitle !== null ? <>&ldquo;{job.savedTitle}&rdquo;</> : "Uploaded audio"}.
          </p>
        )}
        {audio !== null && <p className="text-xs text-muted-foreground">{audio}</p>}
        {job.stage === "saved" && job.cleanupPending && (
          <p className="text-xs text-muted-foreground">
            {job.engine === "assemblyai"
              ? "AssemblyAI still has a copy of this transcript and file: deleting it didn't work yet."
              : "Private transcription still has a copy of this transcript: deleting it didn't work yet."}
          </p>
        )}
        {job.stage === "saved" && job.cleanupPending && job.error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {job.error.message}
          </p>
        )}
        {job.stage === "failed" && job.error !== null && (
          <>
            <p role="alert" className="text-xs text-destructive">
              {job.error.message}
            </p>
            {job.error.reference !== null && (
              <p className="text-xs text-muted-foreground">Reference: {job.error.reference}</p>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {job.stage === "failed" && job.error?.retry === true && (
            <Button type="button" size="sm" onClick={onRetry} className="h-9">
              Retry
            </Button>
          )}
          {job.stage === "saved" && job.cleanupPending && (
            <Button type="button" size="sm" onClick={onRetry} className="h-9">
              Retry deleting
            </Button>
          )}
          {!busy && (
            <Button type="button" size="sm" variant="outline" onClick={onDismiss} className="h-9">
              {job.stage === "saved" ? "Upload another file" : "Discard"}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const status = engines[engine];
  const canTranscribe = file !== null && problem === null && status.state === "available";
  return (
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Transcribe a recording you already have. The transcript and a copy of the original file are saved to your
        TinyCloud space and show up in Library.
      </p>

      <FilePicker
        accept={c1Only(engine, assemblyAiMode) ? PRIVATE_CLOUD_ACCEPT : UPLOAD_ACCEPT}
        label={file === null ? "Click or drop an audio file" : "Click or drop another file"}
        hint={c1Only(engine, assemblyAiMode) ? "MP3, WAV, OGG, M4A/MP4, WebM or FLAC · up to 2 hours" : "Most audio and video files"}
        onFile={onFile}
      />
      {file !== null && (
        <p className="truncate text-sm" title={file.name}>
          {file.name} <span className="text-xs text-muted-foreground">· {formatBytes(file.size)}</span>
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div role="radiogroup" aria-label="Transcription engine" className="inline-flex w-fit rounded-md border p-0.5">
          {(["private-cloud", "assemblyai"] as const).map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={engine === e}
              onClick={() => onEngineChange(e)}
              className={`rounded px-3 py-1 text-xs ${engine === e ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            >
              {UPLOAD_ENGINE_LABELS[e]}
            </button>
          ))}
        </div>
        {status.state === "checking" && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            {engine === "private-cloud" ? "Checking private transcription…" : "Checking TinyCloud's AssemblyAI account…"}
          </p>
        )}
        {status.state === "unavailable" && (
          <p className="text-xs text-muted-foreground">
            {status.reason}
            {status.action === "settings" && (
              <>
                {" "}
                <button type="button" onClick={onOpenSettings} className="underline">
                  Open Settings
                </button>
              </>
            )}
            {status.action === "recheck" && (
              <>
                {" "}
                <button type="button" onClick={onRecheck} className="underline">
                  Check again
                </button>
              </>
            )}
          </p>
        )}
        {status.state === "available" && (engine === "private-cloud" ? <PrivateUploadDisclosure /> : <AssemblyAiDisclosure mode={assemblyAiMode} />)}
      </div>

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={diarize && diarizeUnavailable === null}
            disabled={diarizeUnavailable !== null}
            onChange={(e) => onDiarizeChange(e.target.checked)}
            className="size-4"
          />
          Identify speakers (diarization)
        </label>
        {diarizeUnavailable !== null && <p className="text-xs text-muted-foreground">{diarizeUnavailable}</p>}
      </div>

      {problem !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}

      <div>
        <Button type="button" size="sm" disabled={!canTranscribe} onClick={onTranscribe} className="h-9">
          Transcribe
        </Button>
      </div>
    </div>
  );
};

/** Whether AssemblyAI can take a new upload under the chosen account, and if not, why. */
export function assemblyAiStatus(
  mode: AssemblyAiKeyMode,
  hostedCaps: { state: "checking" } | { state: "ok"; caps: Pick<HostedAssemblyAiCapabilities, "hosted"> } | { state: "failed" },
  keyStatus: AssemblyAiKeyStatus,
): EngineStatus {
  if (mode === "own") {
    return keyStatus === "saved"
      ? { state: "available" }
      : { state: "unavailable", reason: "AssemblyAI with your own account needs your API key, saved in Settings → Transcription.", action: "settings" };
  }
  if (hostedCaps.state === "checking") return { state: "checking" };
  if (hostedCaps.state === "failed") return { state: "unavailable", reason: "Couldn't reach TinyCloud's AssemblyAI account.", action: "recheck" };
  return hostedCaps.caps.hosted
    ? { state: "available" }
    : {
        state: "unavailable",
        reason: "TinyCloud's AssemblyAI account isn't available on this server. You can use your own AssemblyAI key instead.",
        action: "settings",
      };
}

export interface AudioUploadPanelProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
}

/** Stateful owner: engine availability, the picked file and choices, and the app-wide upload runner. */
export const AudioUploadPanel: FC<AudioUploadPanelProps> = ({ tcw, backendUrl, sessionStore }) => {
  const navigate = useNavigate();
  const job = useSyncExternalStore(uploadRunner.subscribe, uploadRunner.snapshot);
  const origin = useMemo(() => buildPtxUploadOrigin(), []);
  const api = useMemo(() => createPrivateCloudApi(backendUrl, { sessionStore }), [backendUrl, sessionStore]);
  const hosted = useMemo(() => createHostedAssemblyAiClient({ backendUrl, sessionStore }), [backendUrl, sessionStore]);
  const save = useMemo(() => createLocalTranscriptSaver(tcw), [tcw]);

  const deps = useMemo<UploadDeps>(
    () => ({
      tcw,
      // Not gated on capabilities: a job started earlier must still resume; the relay itself refuses new ones.
      privateCloud:
        origin !== null
          ? { api, origin, create: (request) => createPrivateCloudJob(backendUrl, { sessionStore }, request) }
          : null,
      // Exactly the account the job was started with: a job never moves between TinyCloud's and the user's.
      assemblyAiClient: async (mode) => {
        if (mode === "hosted") return hosted;
        const read = await readAssemblyAiKey(tcw);
        if (!read.ok) throw new Error(read.message);
        if (read.data === null) throw new AssemblyAiError("invalid-key", "No AssemblyAI API key is saved. Add one in Settings → Transcription.");
        return createAssemblyAiClient(read.data, { backend: { url: backendUrl, sessionStore } });
      },
      save,
    }),
    [tcw, origin, api, hosted, save, backendUrl, sessionStore],
  );

  // A job a reload interrupted picks up where it was.
  useEffect(() => {
    uploadRunner.resume(deps);
  }, [deps]);

  const [file, setFile] = useState<File | null>(null);
  const [engine, setEngine] = useState<UploadEngine>(readDefaultUploadEngine);
  const [diarize, setDiarize] = useState(true);

  // Private: this build needs a PTX origin, and the backend must answer 200 for this account.
  const [caps, setCaps] = useState<{ state: "checking" } | { state: "ok"; caps: PrivateCloudCapabilities } | { state: "absent" | "failed" }>(
    { state: "checking" },
  );
  const [capsRound, setCapsRound] = useState(0);
  useEffect(() => {
    if (origin === null) return;
    let cancelled = false;
    setCaps({ state: "checking" });
    api.capabilities().then(
      (c) => !cancelled && setCaps(c === null ? { state: "absent" } : { state: "ok", caps: c }),
      () => !cancelled && setCaps({ state: "failed" }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, origin, capsRound]);

  // AssemblyAI: TinyCloud's account when the backend has it (capabilities), or the user's own saved key.
  const [assemblyAiMode] = useState<AssemblyAiKeyMode>(readAssemblyAiKeyMode);
  const [hostedCaps, setHostedCaps] = useState<{ state: "checking" } | { state: "ok"; caps: HostedAssemblyAiCapabilities } | { state: "failed" }>({
    state: "checking",
  });
  useEffect(() => {
    if (assemblyAiMode !== "hosted") return;
    let cancelled = false;
    setHostedCaps({ state: "checking" });
    hosted.capabilities().then(
      (c) => !cancelled && setHostedCaps({ state: "ok", caps: c }),
      () => !cancelled && setHostedCaps({ state: "failed" }),
    );
    return () => {
      cancelled = true;
    };
  }, [hosted, assemblyAiMode, capsRound]);

  // The own key: read without prompting only when the vault is already open.
  const [keyStatus, setKeyStatus] = useState<AssemblyAiKeyStatus>(readAssemblyAiKeyHint);
  useEffect(() => {
    if (!isSecretsUnlocked(tcw)) return;
    let cancelled = false;
    void readAssemblyAiKey(tcw).then((r) => {
      if (!cancelled && r.ok) setKeyStatus(r.data !== null ? "saved" : "none");
    });
    return () => {
      cancelled = true;
    };
  }, [tcw]);

  const privateStatus: EngineStatus =
    origin === null
      ? { state: "unavailable", reason: "Private transcription isn't set up in this version of Exo yet. Use AssemblyAI instead." }
      : caps.state === "checking"
        ? { state: "checking" }
        : caps.state === "absent"
          ? { state: "unavailable", reason: "Private transcription isn't available for your account yet." }
          : caps.state === "failed"
            ? { state: "unavailable", reason: "Couldn't reach private transcription.", action: "recheck" }
            : { state: "available" };
  const assemblyStatus = assemblyAiStatus(assemblyAiMode, hostedCaps, keyStatus);

  const privateDiarization = caps.state === "ok" && caps.caps.diarization === true;
  const diarizeUnavailable =
    engine === "private-cloud" && !privateDiarization ? "Speaker identification isn't available for private transcription yet." : null;
  const maxBytes =
    engine === "private-cloud"
      ? caps.state === "ok" && caps.caps.max_bytes > 0
        ? caps.caps.max_bytes
        : PRIVATE_CLOUD_MAX_BYTES
      : hostedCaps.state === "ok" && hostedCaps.caps.max_bytes > 0
        ? hostedCaps.caps.max_bytes
        : PRIVATE_CLOUD_MAX_BYTES;

  const onTranscribe = useCallback(() => {
    if (file === null) return;
    uploadRunner.start(deps, { file, engine, diarize: diarize && diarizeUnavailable === null, assemblyAiMode });
    setFile(null);
  }, [deps, file, engine, diarize, diarizeUnavailable, assemblyAiMode]);

  return (
    <AudioUploadView
      job={job}
      file={file}
      engine={engine}
      engines={{ "private-cloud": privateStatus, assemblyai: assemblyStatus }}
      assemblyAiMode={assemblyAiMode}
      diarize={diarize}
      diarizeUnavailable={diarizeUnavailable}
      fileProblem={fileProblem(file, engine, maxBytes, assemblyAiMode)}
      onEngineChange={setEngine}
      onDiarizeChange={setDiarize}
      onFile={setFile}
      onTranscribe={onTranscribe}
      onRetry={() => uploadRunner.retry(deps)}
      onDismiss={() => void uploadRunner.dismiss(deps)}
      onOpenSettings={() => navigate("/chat/settings")}
      onRecheck={() => setCapsRound((n) => n + 1)}
    />
  );
};
