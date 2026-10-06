// UPLOAD AUDIO: the body of Capture's Upload sheet, on every platform.
//
// `AudioUploadView` is a pure function of its props (asserted with
// react-dom/server in tests); `AudioUploadPanel` checks which engines are
// available, holds the picked file and the per-upload choices, and drives the
// app-wide upload runner (lib/audioUpload.ts), which outlives this view. An
// interrupted upload resumes at launch (capture/upload/UploadResumer), not
// here; this view shows it, or offers Continue when it waits for the user.
//
// The route control says where the file goes in one line, and How it works
// has the rest. The first private cloud upload on a device says, in one
// sentence, what Private cloud does before it sends anything.

import { useCallback, useEffect, useState, useSyncExternalStore, type FC, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Loader2Icon } from "lucide-react";

import { continuePausedUpload, pausedUpload } from "@/capture/upload/pausedUpload";
import { useUploadDeps } from "@/capture/upload/useUploadDeps";
import { RouteLine, uploadRoute } from "@/capture/sheetRoute";
import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { ResponsiveSheetBody, ResponsiveSheetFooter } from "@/components/ui/responsive-sheet";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
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
  uploadRunner,
  type UploadEngine,
  type UploadState,
} from "@/lib/audioUpload";
import { isSecretsUnlocked } from "@/lib/connectors/connectorSecrets";
import type { PrivateCloudCapabilities } from "@/lib/privateCloud";
import { PATHS } from "@/shell/routes";
import { FilePicker } from "./FilePicker";

/** Whether an engine can take a new upload, and if not, why (one line). */
export type EngineStatus =
  | { state: "available" }
  | { state: "checking" }
  | { state: "unavailable"; reason: string; action?: "settings" | "recheck" };

/** Private cloud's and TinyCloud's AssemblyAI account's size limit (C1); capabilities may lower it. */
const PRIVATE_CLOUD_MAX_BYTES = 120_960_000;

/** This device agreed to send uploads to private cloud (the one-sentence consent, asked once). */
export const UPLOAD_PRIVATE_CONSENT_KEY = "exo.upload.privateCloudConsent";

export const ROUTE_LABELS: Readonly<Record<UploadEngine, string>> = {
  "private-cloud": "Private cloud",
  assemblyai: "AssemblyAI",
};

const ROUTE_OPTIONS = [
  { value: "private-cloud", label: ROUTE_LABELS["private-cloud"] },
  { value: "assemblyai", label: ROUTE_LABELS.assemblyai },
] as const;

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

/** The route in one line; How it works has the rest. Never more than the mechanism (C10). */
export function routeText(engine: UploadEngine, assemblyAiMode: AssemblyAiKeyMode): string {
  if (engine === "private-cloud") return "Transcribed by TinyCloud Private Transcription. A copy of the file stays in your space.";
  return assemblyAiMode === "hosted"
    ? "Sent through Exo's server to AssemblyAI under TinyCloud's account, then deleted there."
    : "Sent from this device to AssemblyAI with your key, then deleted there.";
}

/** The one-sentence consent before a device's first private cloud upload. */
export const PRIVATE_CONSENT_TEXT =
  "Your file goes over an encrypted connection to TinyCloud Private Transcription, which sends short speech segments to Tinfoil for speech-to-text.";

function stageText(job: UploadState): string {
  const engine = ROUTE_LABELS[job.engine];
  switch (job.stage) {
    case "preparing":
      return "Preparing the file…";
    case "uploading":
      return job.uploadPct === null ? `Uploading to ${engine}…` : `Uploading to ${engine}… ${job.uploadPct}%`;
    case "queued":
    case "transcribing":
      return job.detail ?? "Transcribing…";
    case "saving":
      return job.detail ?? "Saving to your TinyCloud space…";
    default:
      return "";
  }
}

/** One status line for an upload, for its In progress row. */
export function uploadStatusText(job: UploadState): string {
  switch (job.stage) {
    case "saved":
      return "Saved to your space";
    case "failed":
      return "Didn't finish";
    case "elsewhere":
      return "Running in another window";
    default:
      return stageText(job);
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
      return saved ? null : "Original audio stored in your TinyCloud space.";
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
  /**
   * An upload a reload interrupted that would unlock the vault to resume (it
   * uses the user's own AssemblyAI key): it waits for Continue instead.
   */
  paused?: { fileName: string } | null;
  onContinue?: () => void;
  file: { name: string; type: string; size: number } | null;
  engine: UploadEngine;
  engines: Readonly<Record<UploadEngine, EngineStatus>>;
  /** Whose AssemblyAI account uploads to AssemblyAI use (Settings → Transcription). */
  assemblyAiMode?: AssemblyAiKeyMode;
  /** This device has agreed to private cloud uploads; until then the consent sentence shows. */
  privateConsent?: boolean;
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
  onOpenLibrary?: () => void;
  /**
   * `inline` (default): one column. `sheet`: the Upload sheet's scrolling body,
   * with Transcribe pinned in its footer so it stays on screen.
   */
  layout?: "inline" | "sheet";
}

export const AudioUploadView: FC<AudioUploadViewProps> = ({
  job,
  paused = null,
  onContinue,
  file,
  engine,
  engines,
  assemblyAiMode = "hosted",
  privateConsent = true,
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
  onOpenLibrary,
  layout = "inline",
}) => {
  const inSheet = layout === "sheet";
  const body = (node: ReactNode) => (inSheet ? <ResponsiveSheetBody className="pb-5">{node}</ResponsiveSheetBody> : node);
  if (job === null && paused !== null) {
    return body(
      <div className="flex flex-col gap-3" data-testid="upload-paused">
        <p className="break-words text-headline" title={paused.fileName}>
          {paused.fileName}
        </p>
        <p className="text-callout text-muted-foreground" role="status">
          Upload paused. This upload uses your own AssemblyAI key. Continue to unlock it and finish.
        </p>
        <Button type="button" size="lg" onClick={onContinue} className="w-full">
          Continue
        </Button>
      </div>,
    );
  }
  if (job !== null && job.stage === "elsewhere") {
    return body(
      <div className="flex flex-col gap-3">
        <p className="text-callout text-muted-foreground" role="status">
          {job.fileName ? <>&ldquo;{job.fileName}&rdquo; is </> : "An upload is "}
          being transcribed in another Exo tab or window. It continues there.
        </p>
        <Button type="button" variant="outline" onClick={onRetry} className="w-full">
          Check again
        </Button>
      </div>,
    );
  }
  if (job !== null) {
    const busy = job.stage !== "saved" && job.stage !== "failed";
    const saved = job.stage === "saved";
    const audio = audioText(job);
    return body(
      <div className="flex flex-col gap-3" data-testid="upload-job" data-stage={job.stage}>
        {saved ? (
          <div className="flex flex-col gap-0.5">
            <h3 className="text-headline" role="status">
              Saved to your TinyCloud space
            </h3>
            <p className="break-words text-meta text-muted-foreground" title={job.fileName}>
              {job.savedTitle ?? "Uploaded audio"} · {ROUTE_LABELS[job.engine]}
            </p>
          </div>
        ) : (
          <p className="break-words text-headline" title={job.fileName}>
            {job.fileName}
          </p>
        )}
        {/* The job's own account, as stored with it: Settings may have changed since it started. */}
        <RouteLine nodes={uploadRoute(job.engine, job.assemblyAiMode ?? "own")} landed={saved} />
        {busy && (
          <p className="flex items-center gap-2 text-callout text-muted-foreground" role="status">
            <Loader2Icon className="size-4 shrink-0 animate-spin" />
            {stageText(job)}
          </p>
        )}
        {audio !== null && <p className="text-meta text-muted-foreground">{audio}</p>}
        {saved && job.cleanupPending && (
          <p className="text-meta text-muted-foreground">
            {job.engine === "assemblyai"
              ? "AssemblyAI still has a copy of this transcript and file: deleting it didn't work yet."
              : "Private transcription still has a copy of this transcript: deleting it didn't work yet."}
          </p>
        )}
        {saved && job.cleanupPending && job.error !== null && (
          <p role="alert" className="text-meta text-destructive">
            {job.error.message}
          </p>
        )}
        {job.stage === "failed" && job.error !== null && (
          <>
            <p role="alert" className="text-callout text-destructive">
              {job.error.message}
            </p>
            {job.error.reference !== null && <p className="text-meta text-muted-foreground">Reference: {job.error.reference}</p>}
          </>
        )}
        {!busy && (
          <div className="flex flex-wrap justify-end gap-2">
            {job.stage === "failed" && job.error?.retry === true && !job.cleanupPending && (
              <Button type="button" onClick={onRetry}>
                Retry
              </Button>
            )}
            {job.cleanupPending && (
              <Button type="button" onClick={onRetry}>
                Retry deleting
              </Button>
            )}
            {saved && onOpenLibrary && !job.cleanupPending && (
              <Button type="button" variant="outline" onClick={onOpenLibrary}>
                Open Library
              </Button>
            )}
            <Button type="button" variant={saved && !job.cleanupPending ? "default" : "outline"} onClick={onDismiss}>
              {saved ? "Upload another file" : "Discard"}
            </Button>
          </div>
        )}
      </div>,
    );
  }

  const status = engines[engine];
  const canTranscribe = file !== null && problem === null && status.state === "available";
  const asking = engine === "private-cloud" && status.state === "available" && !privateConsent;
  const transcribe = (
    <Button type="button" size="lg" disabled={!canTranscribe} onClick={onTranscribe} className="w-full" data-testid="upload-transcribe">
      Transcribe
    </Button>
  );
  const form = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <FilePicker
          accept={c1Only(engine, assemblyAiMode) ? PRIVATE_CLOUD_ACCEPT : UPLOAD_ACCEPT}
          label={file === null ? "Choose an audio file" : "Choose another file"}
          hint={c1Only(engine, assemblyAiMode) ? "MP3, WAV, OGG, M4A/MP4, WebM or FLAC · up to 2 hours" : "Most audio and video files"}
          onFile={onFile}
        />
        {file !== null && (
          <p className="text-callout [overflow-wrap:anywhere]" title={file.name}>
            {file.name} <span className="text-meta text-muted-foreground">· {formatBytes(file.size)}</span>
          </p>
        )}
      </div>

      <section aria-label="Transcription" className="flex flex-col gap-3">
        <h3 className="text-headline">Transcription</h3>
        <SegmentedControl<UploadEngine> aria-label="Transcription" value={engine} onValueChange={onEngineChange} options={ROUTE_OPTIONS} />
        <RouteLine nodes={uploadRoute(engine, assemblyAiMode)} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {status.state === "checking" && (
            <p className="flex items-center gap-2 text-callout text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              {engine === "private-cloud" ? "Checking private transcription…" : "Checking TinyCloud's AssemblyAI account…"}
            </p>
          )}
          {status.state === "unavailable" && (
            <p className="min-w-0 text-callout text-muted-foreground">
              {status.reason}
              {status.action === "settings" && (
                <>
                  {" "}
                  <button type="button" onClick={onOpenSettings} className="font-medium text-foreground underline underline-offset-4" data-inline-link>
                    Open Settings
                  </button>
                </>
              )}
              {status.action === "recheck" && (
                <>
                  {" "}
                  <button type="button" onClick={onRecheck} className="font-medium text-foreground underline underline-offset-4" data-inline-link>
                    Check again
                  </button>
                </>
              )}
            </p>
          )}
          {status.state === "available" && (
            <p className="min-w-0 text-callout text-muted-foreground" data-testid={asking ? "upload-private-consent" : "upload-route-line"}>
              {asking ? PRIVATE_CONSENT_TEXT : routeText(engine, assemblyAiMode)}
            </p>
          )}
          <HowItWorksLink section="uploads" />
        </div>
      </section>

      <div className="flex flex-col gap-1">
        <label className="flex min-h-11 items-center gap-3 text-callout">
          <input
            type="checkbox"
            checked={diarize && diarizeUnavailable === null}
            disabled={diarizeUnavailable !== null}
            onChange={(e) => onDiarizeChange(e.target.checked)}
            className="size-4 accent-primary"
          />
          Identify speakers (diarization)
        </label>
        {diarizeUnavailable !== null && <p className="text-meta text-muted-foreground">{diarizeUnavailable}</p>}
      </div>

      {problem !== null && (
        <p role="alert" className="text-callout text-destructive">
          {problem}
        </p>
      )}

      {!inSheet && transcribe}
    </div>
  );
  return inSheet ? (
    <>
      {body(form)}
      <ResponsiveSheetFooter>{transcribe}</ResponsiveSheetFooter>
    </>
  ) : (
    form
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

function readPrivateConsent(): boolean {
  try {
    return globalThis.localStorage?.getItem(UPLOAD_PRIVATE_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export interface AudioUploadPanelProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** The sheet closes (after Open Library). */
  onDone?: () => void;
  layout?: AudioUploadViewProps["layout"];
}

/** Stateful owner: engine availability, the picked file and choices, and the app-wide upload runner. */
export const AudioUploadPanel: FC<AudioUploadPanelProps> = ({ tcw, backendUrl, sessionStore, onDone, layout }) => {
  const navigate = useNavigate();
  const job = useSyncExternalStore(uploadRunner.subscribe, uploadRunner.snapshot, uploadRunner.snapshot);
  const paused = useSyncExternalStore(pausedUpload.subscribe, pausedUpload.snapshot, pausedUpload.snapshot);
  const { deps, origin, api, hosted } = useUploadDeps(tcw, backendUrl, sessionStore);
  const onContinue = useCallback(() => continuePausedUpload(deps), [deps]);

  const [file, setFile] = useState<File | null>(null);
  const [engine, setEngine] = useState<UploadEngine>(readDefaultUploadEngine);
  const [diarize, setDiarize] = useState(true);
  const [privateConsent, setPrivateConsent] = useState(readPrivateConsent);

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
    // Transcribe under the consent sentence is the agreement; it is asked once per device.
    if (engine === "private-cloud" && !privateConsent) {
      try {
        localStorage.setItem(UPLOAD_PRIVATE_CONSENT_KEY, "1");
      } catch {
        // best effort: the sentence shows again next time
      }
      setPrivateConsent(true);
    }
    uploadRunner.start(deps, { file, engine, diarize: diarize && diarizeUnavailable === null, assemblyAiMode });
    setFile(null);
  }, [deps, file, engine, diarize, diarizeUnavailable, assemblyAiMode, privateConsent]);

  return (
    <AudioUploadView
      job={job}
      paused={paused}
      onContinue={onContinue}
      file={file}
      engine={engine}
      engines={{ "private-cloud": privateStatus, assemblyai: assemblyStatus }}
      assemblyAiMode={assemblyAiMode}
      privateConsent={privateConsent}
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
      onOpenLibrary={() => {
        onDone?.();
        navigate(PATHS.library);
      }}
      layout={layout}
    />
  );
};
