// "Private cloud" transcription engine: the webview half.
//
// Three callers upload to TinyCloud Private Transcription (PTX):
//
//   - Local recording (desktop): native code (desktop/src-tauri/src/cloud)
//     opens each stopped recording itself and gives this module only an
//     opaque capture handle; it hashes, creates the job and uploads natively.
//   - Voice notes (Exo mobile, lib/voiceNotes) and Upload audio (every
//     platform, lib/audioUpload.ts) make the create call from the webview with
//     `createPrivateCloudJob` below and PUT the audio to this build's PTX
//     origin (`buildPtxUploadOrigin`).
//
// Every caller asks the backend whether this account may upload
// (capabilities 200, not 404), polls the job through the backend (bearer),
// fetches the transcript, and deletes it after it is saved. Each client's
// jobs carry its own channel labels (`privateCloudJobClient`).
//
// Backend routes (plan §4.4, TinyChat #99):
//   GET    /api/transcriber/private-cloud/capabilities
//   POST   /api/transcriber/private-cloud/transcriptions   (+ Idempotency-Key)
//   GET    /api/transcriber/private-cloud/transcriptions?limit=   (this account's jobs)
//   GET    /api/transcriber/private-cloud/transcriptions/:id
//   GET    /api/transcriber/private-cloud/transcriptions/:id/result   (202 = pending)
//   POST   /api/transcriber/private-cloud/transcriptions/:id/cancel
//   DELETE /api/transcriber/private-cloud/transcriptions/:id

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
  /** The create request's choices, as PTX recorded them (null from a relay that predates them). */
  channel_mode?: "separate" | "mixed" | null;
  channel_labels?: string[] | null;
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
  /** `channel_<n>`, or `speaker_<n>` when the job was diarized. */
  speaker_id?: string;
  channel: number;
  start: number;
  end: number;
  text: string;
}

export interface PrivateCloudSpeaker {
  id: string;
  name: string;
  channel: number;
}

export interface PrivateCloudTranscript {
  language?: string | null;
  duration_seconds?: number | null;
  provider?: string;
  model?: string;
  channels?: number;
  /** True when segments are speaker turns from diarization. */
  diarized?: boolean;
  speakers?: PrivateCloudSpeaker[];
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
    case "unsupported_media_type":
      return "Private cloud transcription doesn't take this file type. Use MP3, WAV, OGG, M4A/MP4, WebM or FLAC audio.";
    case "diarization_unavailable":
      return "Speaker identification isn't available for private cloud transcription right now. Transcribe without it.";
    case "upload_capability_limit":
      return "Too many upload attempts for this file. Try again in a few minutes.";
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
  /** Accepted upload content types (contract C1). */
  content_types?: string[];
  /** True only when PTX can diarize (speaker turns) this deployment's jobs. */
  diarization?: boolean;
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

// ── Which client made a job ────────────────────────────────────────────
//
// One account can have jobs from Exo desktop and Exo mobile. PTX keeps no
// client field, but it records and echoes each job's `channel_mode` and
// `channel_labels`, which every client sets at create, so they tell the
// clients apart without new state anywhere:
//   - Exo desktop (native, desktop/src-tauri/src/cloud/client.rs): separate,
//     ["Speaker 1", "Speaker 2"];
//   - Exo mobile voice notes (lib/voiceNotes): mixed, ["Exo voice note"];
//   - Upload audio (lib/audioUpload.ts, every platform): mixed, ["Exo upload"],
//     with or without diarization (PTX records the labels either way).
// A job that matches neither (or a relay that does not relay them) is
// "unknown", and no client adopts it.

export const DESKTOP_CHANNEL_LABELS: readonly string[] = ["Speaker 1", "Speaker 2"];
export const VOICE_NOTE_CHANNEL_LABELS: readonly string[] = ["Exo voice note"];
export const UPLOAD_CHANNEL_LABELS: readonly string[] = ["Exo upload"];

export type PrivateCloudJobClient = "exo-desktop" | "exo-voice-note" | "exo-upload" | "unknown";

const sameLabels = (actual: readonly string[] | null | undefined, expected: readonly string[]) =>
  Array.isArray(actual) && actual.length === expected.length && actual.every((label, i) => label === expected[i]);

export function privateCloudJobClient(job: Pick<PrivateCloudJob, "channel_mode" | "channel_labels">): PrivateCloudJobClient {
  if (job.channel_mode === "separate" && sameLabels(job.channel_labels, DESKTOP_CHANNEL_LABELS)) return "exo-desktop";
  if (job.channel_mode === "mixed" && sameLabels(job.channel_labels, VOICE_NOTE_CHANNEL_LABELS)) return "exo-voice-note";
  if (job.channel_mode === "mixed" && sameLabels(job.channel_labels, UPLOAD_CHANNEL_LABELS)) return "exo-upload";
  return "unknown";
}

// ── Create (webview callers) ───────────────────────────────────────────

/** `trn_` + 26 Crockford base32 characters (PTX ULIDs). */
export const TRANSCRIPTION_ID_RE = /^trn_[0-9A-HJKMNP-TV-Z]{26}$/;
/** The only upload path the backend may hand out: relative, pinned to the job. */
export const UPLOAD_PATH_RE = /^\/uploads\/trn_[0-9A-HJKMNP-TV-Z]{26}$/;
const CAPABILITY_RE = /^tcu_[A-Za-z0-9_-]{16,256}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The create body (plan §4.4): metadata only, never audio. */
export interface PrivateCloudCreateBody {
  content_type: string;
  byte_size: number;
  sha256: string;
  /** Omitted: PTX detects the language. */
  language?: string;
  channel_mode?: "separate" | "mixed";
  channel_labels?: string[];
  /** Speaker turns (contract C2); only when capabilities report `diarization: true`. */
  diarize?: boolean;
}

export interface PrivateCloudCreated {
  id: string;
  status: PrivateCloudJobStatus;
  /** Present only while the job awaits its upload (a replay after the upload landed has none). */
  upload: { path: string; capability: string } | null;
}

const JOB_STATUSES: readonly PrivateCloudJobStatus[] = [
  "awaiting_upload",
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
];

/** The create answer, strictly (desktop parse_created): anything off-contract is `upstream_bad_response`. */
export function parseCreatedJob(body: unknown): PrivateCloudCreated {
  const bad = (why: string) => new PrivateCloudError("upstream_bad_response", `Unexpected create response: ${why}`);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("not an object");
  const o = body as Record<string, unknown>;
  if (typeof o.id !== "string" || !TRANSCRIPTION_ID_RE.test(o.id)) throw bad("id");
  if (typeof o.status !== "string" || !(JOB_STATUSES as readonly string[]).includes(o.status)) throw bad("status");
  let upload: PrivateCloudCreated["upload"] = null;
  if (o.upload !== undefined && o.upload !== null) {
    const u = o.upload as Record<string, unknown>;
    if (typeof u.path !== "string" || !UPLOAD_PATH_RE.test(u.path) || u.path !== `/uploads/${o.id}`) throw bad("upload path");
    if (typeof u.capability !== "string" || !CAPABILITY_RE.test(u.capability)) throw bad("upload capability");
    upload = { path: u.path, capability: u.capability };
  }
  if ((o.status === "awaiting_upload") !== (upload !== null)) throw bad("upload grant does not match status");
  return { id: o.id, status: o.status as PrivateCloudJobStatus, upload };
}

/**
 * POST the job to the backend (bearer, `Idempotency-Key`). Idempotent per
 * `attemptId`: a replay after a lost answer returns the same job, with a fresh
 * upload capability while it still awaits its upload. The desktop makes this
 * call natively; voice notes and Upload audio make it here.
 */
export async function createPrivateCloudJob(
  backendUrl: string,
  config: { sessionStore: SessionStore; fetchImpl?: typeof fetch },
  request: { attemptId: string; correlationId: string; body: PrivateCloudCreateBody },
): Promise<PrivateCloudCreated> {
  if (!UUID_RE.test(request.attemptId)) throw new PrivateCloudError("invalid_argument", "The attempt id must be a UUID");
  const token = config.sessionStore.getToken();
  if (!token || config.sessionStore.isExpired()) throw new PrivateCloudError("unauthenticated", "Not signed in");
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const signal = AbortSignal.timeout(60_000);
  let response: Response;
  try {
    response = await fetchImpl(`${backendUrl}${PRIVATE_CLOUD_BASE_PATH}/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
        "Content-Type": "application/json",
        "Idempotency-Key": request.attemptId,
        "X-Correlation-Id": request.correlationId,
      },
      body: JSON.stringify(request.body),
      redirect: "manual",
      signal,
    });
  } catch {
    throw new PrivateCloudError(signal.aborted ? "request_timeout" : "offline", "Could not reach the backend", {
      correlationId: request.correlationId,
    });
  }
  if (response.status === 401) throw new PrivateCloudError("unauthenticated", "Session expired");
  // Dark, or this account is not in the cohort: the same 404 every caller gets.
  if (response.status === 404) {
    throw new PrivateCloudError("feature_unavailable", "Private cloud transcription is not available for this account");
  }
  if (response.status === 200 || response.status === 201) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PrivateCloudError("upstream_bad_response", "Unreadable create response");
    }
    return parseCreatedJob(body);
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new PrivateCloudError("service_misconfigured", "The backend answered with a redirect; it was not followed");
  }
  const err = await readError(response);
  if (err.correlationId !== null) throw err;
  // The reference shown to the user: ours, when the answer carried none.
  throw new PrivateCloudError(err.code, err.message, {
    correlationId: request.correlationId,
    retryAfterSeconds: err.retryAfterSeconds,
    transcriptionId: err.transcriptionId,
  });
}

// ── PTX upload (webview callers) ───────────────────────────────────────

/**
 * The PTX origin audio may be uploaded to, or null (the engine is hidden).
 * A bare origin only: https, or http to a loopback port in dev builds.
 */
export function parsePtxUploadOrigin(raw: string | null | undefined, allowLoopbackHttp: boolean): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowLoopbackHttp && loopback && url.port !== "")) return null;
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  if (value.replace(/\/$/, "") !== url.origin) return null;
  return url.origin;
}

/** This build's PTX upload origin (VITE_EXO_PTX_UPLOAD_ORIGIN), or null: then no webview caller offers private cloud. */
export function buildPtxUploadOrigin(): string | null {
  return parsePtxUploadOrigin(import.meta.env.VITE_EXO_PTX_UPLOAD_ORIGIN, import.meta.env.DEV === true);
}

/** Joins a backend-issued upload path to the build's origin; anything but `/uploads/trn_…` is refused. */
export function ptxUploadUrl(origin: string, path: string): string {
  if (!UPLOAD_PATH_RE.test(path)) throw new PrivateCloudError("upstream_bad_response", "The upload path is not a PTX upload path");
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== path) {
    throw new PrivateCloudError("upstream_bad_response", "The upload path leaves the PTX origin");
  }
  return url.toString();
}

/** A PTX PUT answer: its status and parsed JSON body (or null). */
export interface PtxPutResponse {
  status: number;
  body: unknown;
}

/** Codes PTX's upload answers may carry as themselves (desktop client.rs RELAYED_CODES). */
const RELAYED_UPLOAD_CODES: ReadonlySet<string> = new Set([
  "recording_too_large",
  "recording_too_long",
  "unsupported_recording",
  "invalid_audio",
  "no_speech",
  "quota_exceeded",
  "service_busy",
  "service_paused",
  "service_unavailable",
  "upload_expired",
  "upload_integrity_failed",
]);

/**
 * A PUT answer (desktop `upload_result`): 201 is the only success. Every other
 * answer is a stable code; except for the decisive ones, the job's status
 * decides what happened (PTX answers a replayed PUT of an accepted upload 401).
 */
export function interpretUploadResponse(response: PtxPutResponse, correlationId: string): void {
  if (response.status === 201) return;
  const body = (response.body && typeof response.body === "object" ? response.body : {}) as { error?: Record<string, unknown> };
  const e = body.error && typeof body.error === "object" ? body.error : {};
  const code = typeof e.code === "string" ? e.code : null;
  const jobError = e.job_error as { code?: unknown } | undefined;
  const jobErrorCode = typeof jobError?.code === "string" ? jobError.code : null;
  const fail = (failure: string, message: string) =>
    new PrivateCloudError(failure, message, {
      correlationId: typeof e.correlation_id === "string" ? e.correlation_id : correlationId,
      retryAfterSeconds: typeof e.retry_after_seconds === "number" ? e.retry_after_seconds : null,
    });
  const status = response.status;
  if (status >= 300 && status < 400) throw fail("service_misconfigured", "PTX answered with a redirect; it was not followed");
  if (status === 401) throw fail("upload_outcome_unknown", "PTX no longer accepts this upload; its status decides");
  if (status === 409 && code === "upload_in_progress") throw fail("upload_outcome_unknown", "Another upload of this recording is in progress");
  if (status === 400 || status === 408) throw fail("upload_interrupted", "PTX did not receive the whole recording");
  if (status === 410) throw fail("upload_capability_expired", "The upload permission expired");
  if (status === 413) throw fail("recording_too_large", "The recording is larger than the private cloud limit");
  if (status === 415) throw fail("unsupported_recording", "This recording format is not supported");
  if (status === 422) {
    throw jobErrorCode !== null && RELAYED_UPLOAD_CODES.has(jobErrorCode)
      ? fail(jobErrorCode, "PTX rejected the recording")
      : fail("upstream_bad_response", "PTX rejected the recording");
  }
  if ((status === 429 || status === 503) && code !== null && RELAYED_UPLOAD_CODES.has(code)) {
    throw fail(code, "PTX cannot take the upload right now");
  }
  throw fail("upload_outcome_unknown", "PTX's answer to the upload was unclear");
}

/** Lowercase hex SHA-256 of the whole file, as the create call declares it. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PtxFileUpload {
  /** `ptxUploadUrl(origin, upload.path)`. */
  url: string;
  capability: string;
  file: Blob;
  /** Must equal the create call's `content_type` (C1). */
  contentType: string;
  /** The attempt's correlation id: the reference shown with a failure PTX gave none for. */
  correlationId: string;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Injected in tests. */
  createXhr?: () => XMLHttpRequest;
}

/**
 * One PUT of a picked file to PTX with the job capability, from any webview
 * (PTX answers CORS for the web, Tauri and Capacitor origins). XMLHttpRequest
 * because only it reports upload progress, and it streams the File as is;
 * voice notes' `capacitorPtxPut` sends base64 over the native bridge instead,
 * which suits short notes, not files up to 120 MB. Only Authorization and
 * Content-Type are sent: the headers PTX's CORS allows. Resolves on 201 only.
 */
export function putFileToPtx(input: PtxFileUpload): Promise<void> {
  // Executor form: the TS lib here (ES2022) has no Promise.withResolvers.
  return new Promise<void>((resolve, reject) => {
    const xhr = input.createXhr?.() ?? new XMLHttpRequest();
    let sent = 0;
    const onAbort = () => xhr.abort();
    const done = () => input.signal?.removeEventListener("abort", onAbort);
    const fail = (code: string, message: string) => new PrivateCloudError(code, message, { correlationId: input.correlationId });
    xhr.open("PUT", input.url);
    xhr.setRequestHeader("Authorization", `Bearer ${input.capability}`);
    xhr.setRequestHeader("Content-Type", input.contentType);
    xhr.upload.onprogress = (e) => {
      sent = e.loaded;
      input.onProgress?.(e.loaded, e.lengthComputable ? e.total : input.file.size);
    };
    xhr.onload = () => {
      done();
      let body: unknown = null;
      try {
        body = xhr.responseText ? (JSON.parse(xhr.responseText) as unknown) : null;
      } catch {
        // Not JSON: classified by status alone.
      }
      try {
        interpretUploadResponse({ status: xhr.status, body }, input.correlationId);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => {
      done();
      // Nothing sent: PTX was never reached (offline, CORS). Otherwise the bytes may have landed.
      reject(
        sent === 0
          ? fail("upload_interrupted", "Could not reach private cloud transcription")
          : fail("upload_outcome_unknown", "The upload connection failed"),
      );
    };
    xhr.onabort = () => {
      done();
      reject(fail("cancelled", "The upload was cancelled"));
    };
    if (input.signal?.aborted) {
      reject(fail("cancelled", "The upload was cancelled"));
      return;
    }
    input.signal?.addEventListener("abort", onAbort);
    xhr.send(input.file);
  });
}

// ── Polling ────────────────────────────────────────────────────────────

/** Private cloud polling (plan §4.7): 5 s ± 20 %, 30 s after a minute of
 *  transient failures, and "connection lost" (not failed) after 10 minutes. */
export interface CloudPolling {
  intervalMs: number;
  slowIntervalMs: number;
  slowAfterMs: number;
  giveUpAfterMs: number;
}

export const DEFAULT_CLOUD_POLLING: CloudPolling = {
  intervalMs: 5_000,
  slowIntervalMs: 30_000,
  slowAfterMs: 60_000,
  giveUpAfterMs: 10 * 60_000,
};

export interface CloudClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** [0, 1): polling jitter. */
  random(): number;
}

export const REAL_CLOCK: CloudClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/** A job that is not finished yet: waiting in PTX's queue or being transcribed. */
export interface CloudJobProgress {
  stage: "queued" | "processing";
  queuePosition: number | null;
  regionsCompleted: number | null;
  regionsTotal: number | null;
}

export interface CloudJobPoller {
  /** The job's status, riding out transient failures. */
  readJob(id: string): Promise<PrivateCloudJob>;
  /** Poll a job to its transcript (plan §4.7): transient failures are ridden
   *  out for 10 minutes, then `connectionLost()` is thrown, not a failure.
   *  An aborted `signal` stops it with a `cancelled` error at the next step. */
  pollTranscript(id: string, onProgress: (p: CloudJobProgress) => void, signal?: AbortSignal): Promise<PrivateCloudTranscript>;
}

export function createCloudJobPoller(
  api: Pick<PrivateCloudApi, "get" | "result">,
  options: { clock?: CloudClock; polling?: Partial<CloudPolling>; connectionLost: () => Error },
): CloudJobPoller {
  const clock = options.clock ?? REAL_CLOCK;
  const polling: CloudPolling = { ...DEFAULT_CLOUD_POLLING, ...options.polling };
  const sleep = (baseMs: number) => clock.sleep(Math.round(baseMs * (0.8 + 0.4 * clock.random())));

  /** Rides out transient failures: waits and returns while they last under
   *  10 minutes, backing off after one; then "connection lost". */
  const transientTolerance = () => {
    let failingSince: number | null = null;
    return {
      reset: () => {
        failingSince = null;
      },
      rideOut: async (err: unknown) => {
        if (!isTransientCloudError(err)) throw err;
        const now = clock.now();
        failingSince ??= now;
        const failingFor = now - failingSince;
        if (failingFor >= polling.giveUpAfterMs) throw options.connectionLost();
        await sleep(failingFor >= polling.slowAfterMs ? polling.slowIntervalMs : polling.intervalMs);
      },
    };
  };

  return {
    async readJob(id) {
      const tolerance = transientTolerance();
      for (;;) {
        try {
          return await api.get(id);
        } catch (err) {
          await tolerance.rideOut(err);
        }
      }
    },

    async pollTranscript(id, onProgress, signal) {
      const tolerance = transientTolerance();
      const rideOut = tolerance.rideOut;
      const cancelled = () => new PrivateCloudError("cancelled", "Stopped polling the transcription", { transcriptionId: id });
      for (;;) {
        if (signal?.aborted) throw cancelled();
        let job: PrivateCloudJob;
        try {
          job = await api.get(id);
        } catch (err) {
          await rideOut(err);
          continue;
        }
        if (signal?.aborted) throw cancelled();
        if (job.status === "completed") {
          let result: PrivateCloudResult;
          try {
            result = await api.result(id);
          } catch (err) {
            await rideOut(err);
            continue;
          }
          tolerance.reset();
          if (result.status === "completed") return result.transcript;
          if (result.status !== "pending") throw result.error;
        } else {
          tolerance.reset();
          if (job.status === "failed" || job.status === "cancelled") {
            throw new PrivateCloudError(job.error?.code ?? job.status, job.error?.message ?? `The transcription ${job.status}`, {
              transcriptionId: id,
            });
          }
          if (job.status === "awaiting_upload") {
            throw new PrivateCloudError("upload_interrupted", "PTX has not received the recording", { transcriptionId: id });
          }
          if (signal?.aborted) throw cancelled();
          onProgress({
            stage: job.status === "queued" ? "queued" : "processing",
            queuePosition: job.progress?.queue_position ?? null,
            regionsCompleted: job.progress?.regions_completed ?? null,
            regionsTotal: job.progress?.regions_total ?? null,
          });
        }
        await sleep(polling.intervalMs);
      }
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

/** One JSON record kept across relaunches (a job or recording Exo must not forget). */
export interface RecordStore<T> {
  read(): T | null;
  write(record: T): void;
  clear(): void;
}

export type PendingCloudStore = RecordStore<PendingCloudJob>;

/** A RecordStore in localStorage under `key`. Best-effort: `parse` returns null
 *  for a malformed record, and without storage nothing outlives a relaunch. */
export function localStorageRecordStore<T>(key: string, parse: (v: Record<string, unknown>) => T | null): RecordStore<T> {
  return {
    read() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (!raw) return null;
        const v: unknown = JSON.parse(raw);
        return v !== null && typeof v === "object" ? parse(v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    },
    write(record) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(record));
      } catch {
        // Best-effort: without it a relaunch cannot pick this record up.
      }
    },
    clear() {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

export const localStoragePendingCloudStore: PendingCloudStore = localStorageRecordStore(PRIVATE_CLOUD_PENDING_KEY, (v) => {
  if (typeof v.attemptId !== "string" || typeof v.sessionId !== "string" || typeof v.startedAt !== "string") return null;
  return {
    attemptId: v.attemptId,
    transcriptionId: typeof v.transcriptionId === "string" ? v.transcriptionId : null,
    sessionId: v.sessionId,
    startedAt: v.startedAt,
    language: typeof v.language === "string" ? v.language : "en",
  };
});
