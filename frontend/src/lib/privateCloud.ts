// "Private cloud" transcription engine: the webview half.
//
// The desktop's native side (desktop/src-tauri/src/cloud) opens each stopped
// recording itself and gives this module only an opaque capture handle; it
// hashes and uploads the file straight to TinyCloud Private Transcription
// (PTX) with a job capability it gets from the TinyChat backend. Nothing here
// ever sees audio, a file path or the capability. This module:
//
//   - asks native whether this build can upload at all (a PTX origin is
//     compiled in) and the backend whether this account may (capabilities
//     200, not 404), which together decide whether the engine is shown;
//   - submits a capture handle, then polls the job through the backend
//     (bearer), fetches the transcript, and deletes it after it is saved.
//
// Backend routes (plan §4.4, TinyChat #99):
//   GET    /api/transcriber/private-cloud/capabilities
//   GET    /api/transcriber/private-cloud/transcriptions?limit=   (this account's jobs)
//   GET    /api/transcriber/private-cloud/transcriptions/:id
//   GET    /api/transcriber/private-cloud/transcriptions/:id/result   (202 = pending)
//   POST   /api/transcriber/private-cloud/transcriptions/:id/cancel
//   DELETE /api/transcriber/private-cloud/transcriptions/:id
// The create call (POST /transcriptions) is made by native code, not here.

import type { SessionStore } from "@tinyboilerplate/client";

export type TranscriptionEngine = "on-device" | "private-cloud";

export const ENGINE_STORAGE_KEY = "exo.transcriber.engine";
export const PRIVATE_CLOUD_CONSENT_KEY = "exo.transcriber.privateCloudConsent";
/** The one cloud job this Mac is waiting on, so a relaunch can finish it. */
export const PRIVATE_CLOUD_PENDING_KEY = "exo.transcriber.privateCloudPending";

export const PRIVATE_CLOUD_BASE_PATH = "/api/transcriber/private-cloud";

export type PrivateCloudJobStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface PrivateCloudJob {
  id: string;
  status: PrivateCloudJobStatus;
  duration_seconds?: number | null;
  created_at?: string;
  updated_at?: string;
  progress?: {
    stage?: string | null;
    queue_position?: number | null;
    regions_completed?: number | null;
    regions_total?: number | null;
  } | null;
  error?: { type?: string; code: string; message?: string } | null;
}

export interface PrivateCloudSegment {
  id?: string;
  speaker_id?: string;
  channel: number;
  start: number;
  end: number;
  text: string;
}

export interface PrivateCloudTranscript {
  language?: string;
  duration_seconds?: number | null;
  provider?: string;
  model?: string;
  channels?: number;
  segments: PrivateCloudSegment[];
  text: string;
}

export type PrivateCloudResult =
  | { status: "pending"; jobStatus: PrivateCloudJobStatus }
  | { status: "completed"; transcript: PrivateCloudTranscript }
  | { status: "failed" | "cancelled"; error: PrivateCloudError };

/**
 * A failure with a stable public code (plan §4.6), from native code or the
 * backend. `correlationId` is shown to the user as a reference.
 */
export class PrivateCloudError extends Error {
  readonly code: string;
  readonly correlationId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly transcriptionId: string | null;
  constructor(
    code: string,
    message: string,
    extra: { correlationId?: string | null; retryAfterSeconds?: number | null; transcriptionId?: string | null } = {},
  ) {
    super(message);
    this.name = "PrivateCloudError";
    this.code = code;
    this.correlationId = extra.correlationId ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.transcriptionId = extra.transcriptionId ?? null;
  }
}

/** Failures polling rides out (a backend redeploy, a network blip). */
const TRANSIENT_CODES = new Set([
  "offline",
  "request_timeout",
  "service_unavailable",
  "upstream_bad_response",
  "service_busy",
  "service_paused",
  "http_5xx",
]);

export function isTransientCloudError(err: unknown): boolean {
  return err instanceof PrivateCloudError && TRANSIENT_CODES.has(err.code);
}

/** User-facing sentence for a code; the backend's own message is fixed text too. */
export function privateCloudMessage(err: PrivateCloudError): string {
  switch (err.code) {
    case "recording_too_long_for_cloud":
    case "recording_too_long":
    case "recording_too_large":
      return "Private cloud transcription takes recordings up to 2 hours.";
    case "no_speech":
      return "No speech was found in the recording.";
    case "invalid_audio":
    case "unsupported_recording":
      return "Private cloud transcription could not read this recording.";
    case "quota_exceeded":
      return "You've reached today's private cloud transcription limit.";
    case "service_busy":
      return "Private cloud transcription is busy. Try again in a few minutes.";
    case "service_paused":
      return "Private cloud transcription is paused. Try again later.";
    case "active_transcription_exists":
      return "Another private cloud upload for your account hasn't finished (it expires within 2 hours). Try again later, or transcribe this recording on this Mac.";
    case "provider_unavailable":
    case "provider_outcome_unknown":
    case "processing_timeout":
    case "processing_failed":
    case "transcription_failed":
      return "Private cloud transcription failed while transcribing. Retrying uploads the recording again.";
    case "upload_outcome_unknown":
      return "The upload's result is unknown; Retry checks the job before uploading again.";
    case "upload_interrupted":
    case "upload_capability_expired":
    case "upload_expired":
    case "upload_integrity_failed":
      return "The upload did not complete. Retry uploads the recording again.";
    case "transcript_expired":
      return "The transcript expired before it was saved. Retry uploads the recording again.";
    case "file_changed":
      return "The recording changed on disk after it stopped, so it was not uploaded.";
    case "capture_not_available":
      return "This recording is no longer available to upload.";
    case "unauthenticated":
      return "Your session expired. Sign in again, then retry.";
    case "service_misconfigured":
      return "Private cloud transcription is misconfigured. The team has been alerted.";
    case "transcription_not_found":
      return "The private cloud job no longer exists.";
    case "cancelled":
      return "The upload was cancelled.";
    default:
      return err.message || "Private cloud transcription failed.";
  }
}

// ── Backend client ─────────────────────────────────────────────────────

export interface PrivateCloudCapabilities {
  max_bytes: number;
  max_duration_seconds?: number;
  admission?: string;
  [key: string]: unknown;
}

export interface PrivateCloudApi {
  readonly backendUrl: string;
  /** The session token native code sends with the create call, or null when signed out. */
  bearer(): string | null;
  /** Null when the feature is dark or this account is not in the cohort (404). */
  capabilities(): Promise<PrivateCloudCapabilities | null>;
  /** This account's jobs (tenant-scoped by the backend); empty when the feature is dark. */
  list(): Promise<PrivateCloudJob[]>;
  get(id: string): Promise<PrivateCloudJob>;
  result(id: string): Promise<PrivateCloudResult>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

async function readError(response: Response): Promise<PrivateCloudError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON: classified by status below.
  }
  const e =
    body && typeof body === "object" && "error" in body && body.error && typeof body.error === "object"
      ? (body.error as Record<string, unknown>)
      : {};
  const code =
    typeof e.code === "string"
      ? e.code
      : response.status >= 500
        ? "http_5xx"
        : response.status === 429
          ? "service_busy"
          : `http_${response.status}`;
  const headerRetry = Number(response.headers.get("Retry-After"));
  return new PrivateCloudError(code, typeof e.message === "string" ? e.message : `HTTP ${response.status}`, {
    correlationId: typeof e.correlation_id === "string" ? e.correlation_id : response.headers.get("X-Correlation-Id"),
    retryAfterSeconds:
      typeof e.retry_after_seconds === "number"
        ? e.retry_after_seconds
        : Number.isFinite(headerRetry) && headerRetry > 0
          ? headerRetry
          : null,
    transcriptionId: typeof e.id === "string" ? e.id : null,
  });
}

export function createPrivateCloudApi(
  backendUrl: string,
  config: { sessionStore: SessionStore; fetchImpl?: typeof fetch },
): PrivateCloudApi {
  const { sessionStore } = config;
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);

  const bearer = (): string | null => {
    const token = sessionStore.getToken();
    if (!token || sessionStore.isExpired()) return null;
    return token;
  };

  async function request(path: string, method: "GET" | "POST" | "DELETE"): Promise<Response> {
    const token = bearer();
    if (token === null) throw new PrivateCloudError("unauthenticated", "Not signed in");
    const signal = AbortSignal.timeout(20_000);
    let response: Response;
    try {
      response = await fetchImpl(`${backendUrl}${PRIVATE_CLOUD_BASE_PATH}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE },
        signal,
      });
    } catch {
      throw new PrivateCloudError(signal.aborted ? "request_timeout" : "offline", "Could not reach the backend");
    }
    if (response.status === 401) throw new PrivateCloudError("unauthenticated", "Session expired");
    return response;
  }

  async function json<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new PrivateCloudError("upstream_bad_response", "Unreadable backend response");
    }
  }

  return {
    backendUrl,
    bearer,

    async capabilities() {
      const response = await request("/capabilities", "GET");
      if (response.status === 404) return null;
      if (!response.ok) throw await readError(response);
      return json<PrivateCloudCapabilities>(response);
    },

    async list() {
      const response = await request("/transcriptions?limit=20", "GET");
      if (response.status === 404) return [];
      if (!response.ok) throw await readError(response);
      const body = await json<{ transcriptions?: unknown }>(response);
      if (!Array.isArray(body.transcriptions)) throw new PrivateCloudError("upstream_bad_response", "Unexpected job list");
      return body.transcriptions as PrivateCloudJob[];
    },

    async get(id) {
      const response = await request(`/transcriptions/${encodeURIComponent(id)}`, "GET");
      if (response.status === 404) throw new PrivateCloudError("transcription_not_found", "No such transcription");
      if (!response.ok) throw await readError(response);
      return json<PrivateCloudJob>(response);
    },

    async result(id) {
      const response = await request(`/transcriptions/${encodeURIComponent(id)}/result`, "GET");
      if (response.status === 404) throw new PrivateCloudError("transcription_not_found", "No such transcription");
      if (response.status === 202) {
        const body = await json<{ status: PrivateCloudJobStatus }>(response);
        return { status: "pending", jobStatus: body.status };
      }
      if (!response.ok) throw await readError(response);
      const body = await json<Record<string, unknown>>(response);
      if (body.status === "failed" || body.status === "cancelled") {
        const e = (body.error ?? {}) as { code?: string; message?: string };
        return {
          status: body.status,
          error: new PrivateCloudError(e.code ?? String(body.status), e.message ?? `Transcription ${String(body.status)}`, {
            transcriptionId: id,
          }),
        };
      }
      if (!Array.isArray(body.segments) || typeof body.text !== "string") {
        throw new PrivateCloudError("upstream_bad_response", "Unexpected transcript");
      }
      return { status: "completed", transcript: body as unknown as PrivateCloudTranscript };
    },

    async cancel(id) {
      const response = await request(`/transcriptions/${encodeURIComponent(id)}/cancel`, "POST");
      if (response.status === 404) return;
      if (!response.ok) throw await readError(response);
    },

    async remove(id) {
      const response = await request(`/transcriptions/${encodeURIComponent(id)}`, "DELETE");
      if (response.status === 404) return;
      if (!response.ok) throw await readError(response);
    },
  };
}

// ── Native bridge ──────────────────────────────────────────────────────

type Unlisten = () => void;

/** `exo://capture-ready`: a handle for the stopped session's recording, or why there is none. */
export interface CaptureReadyEvent {
  sessionId: string;
  captureHandle?: string;
  sizeBytes?: number;
  format?: string;
  partial: boolean;
  error?: { code: string; message: string };
}

export interface UploadProgressEvent {
  captureHandle: string;
  sentBytes: number;
  totalBytes: number;
}

export interface PrivateCloudSubmitArgs {
  captureHandle: string;
  /** The create call's Idempotency-Key (UUID); the same id re-joins the same job. */
  attemptId: string;
  backendUrl: string;
  bearer: string;
  language: string;
}

/** The Exo native commands (desktop/src-tauri/src/cloud/commands.rs). */
export interface PrivateCloudNative {
  status(): Promise<{ configured: boolean }>;
  submit(args: PrivateCloudSubmitArgs): Promise<{ transcriptionId: string; status: string | null }>;
  /** Abort an upload in flight and release the handle; the recording stays on disk. */
  cancel(captureHandle: string): Promise<void>;
  onCaptureReady(cb: (e: CaptureReadyEvent) => void): Promise<Unlisten>;
  onUploadProgress(cb: (e: UploadProgressEvent) => void): Promise<Unlisten>;
}

/** Native rejections are the serialized CloudError `{code, message, correlationId?, ...}`. */
export function toPrivateCloudError(err: unknown): PrivateCloudError {
  if (err instanceof PrivateCloudError) return err;
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    const e = err as { code: string; message?: string; correlationId?: string; retryAfterSeconds?: number; transcriptionId?: string };
    return new PrivateCloudError(e.code, e.message ?? e.code, {
      correlationId: e.correlationId ?? null,
      retryAfterSeconds: e.retryAfterSeconds ?? null,
      transcriptionId: e.transcriptionId ?? null,
    });
  }
  return new PrivateCloudError("native_error", err instanceof Error ? err.message : String(err));
}

/** Loaded lazily: `@tauri-apps/api` must never enter the web bundle's main chunk. */
export async function loadPrivateCloudNative(): Promise<PrivateCloudNative> {
  const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")]);
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(cmd, args);
    } catch (err) {
      throw toPrivateCloudError(err);
    }
  };
  return {
    status: () => call("cloud_transcription_status"),
    submit: (args) => call("cloud_transcription_submit", { ...args }),
    cancel: (captureHandle) => call("cloud_transcription_cancel", { captureHandle }),
    onCaptureReady: (cb) => listen<CaptureReadyEvent>("exo://capture-ready", (e) => cb(e.payload)),
    onUploadProgress: (cb) => listen<UploadProgressEvent>("exo://cloud-upload-progress", (e) => cb(e.payload)),
  };
}

// ── Engine choice ──────────────────────────────────────────────────────

/**
 * Whether private cloud can be offered: `available`; `hidden` (this build has
 * no PTX origin, or the backend answers 404: dark or not in the cohort);
 * `failed` (the check itself failed — offline, 5xx, timeout — so try again).
 */
export type PrivateCloudAvailability = "available" | "hidden" | "failed";

/**
 * The engine a Local recording uses. An explicit choice wins; with none,
 * Private cloud is the default only when it is available and no Whisper model
 * has been downloaded. An explicit cloud choice while cloud is unavailable
 * shows On this Mac, and the panel says why (never a silent switch mid-job).
 */
export function resolveEngine(input: {
  stored: TranscriptionEngine | null;
  cloudAvailable: boolean;
  anyModelDownloaded: boolean;
}): TranscriptionEngine {
  if (input.stored === "on-device") return "on-device";
  if (input.stored === "private-cloud") return input.cloudAvailable ? "private-cloud" : "on-device";
  return input.cloudAvailable && !input.anyModelDownloaded ? "private-cloud" : "on-device";
}

export function readStoredEngine(): TranscriptionEngine | null {
  try {
    const v = globalThis.localStorage?.getItem(ENGINE_STORAGE_KEY);
    return v === "on-device" || v === "private-cloud" ? v : null;
  } catch {
    return null;
  }
}

export function hasPrivateCloudConsent(): boolean {
  try {
    return globalThis.localStorage?.getItem(PRIVATE_CLOUD_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

// ── Pending job (relaunch) ─────────────────────────────────────────────

export interface PendingCloudJob {
  attemptId: string;
  transcriptionId: string | null;
  sessionId: string;
  startedAt: string;
  language: string;
}

export interface PendingCloudStore {
  read(): PendingCloudJob | null;
  write(job: PendingCloudJob): void;
  clear(): void;
}

export const localStoragePendingCloudStore: PendingCloudStore = {
  read() {
    try {
      const raw = globalThis.localStorage?.getItem(PRIVATE_CLOUD_PENDING_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as Partial<PendingCloudJob>;
      if (typeof v.attemptId !== "string" || typeof v.sessionId !== "string" || typeof v.startedAt !== "string") return null;
      return {
        attemptId: v.attemptId,
        transcriptionId: typeof v.transcriptionId === "string" ? v.transcriptionId : null,
        sessionId: v.sessionId,
        startedAt: v.startedAt,
        language: typeof v.language === "string" ? v.language : "en",
      };
    } catch {
      return null;
    }
  },
  write(job) {
    try {
      globalThis.localStorage?.setItem(PRIVATE_CLOUD_PENDING_KEY, JSON.stringify(job));
    } catch {
      // Best-effort: without it a relaunch cannot resume this job.
    }
  },
  clear() {
    try {
      globalThis.localStorage?.removeItem(PRIVATE_CLOUD_PENDING_KEY);
    } catch {
      // Nothing to clear.
    }
  },
};
