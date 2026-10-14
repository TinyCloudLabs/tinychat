// Private cloud transcription API shared by voice notes and audio uploads.
//
// Both callers create jobs in the webview with `createPrivateCloudJob` below
// and PUT audio to this build's PTX origin (`buildPtxUploadOrigin`).
//
// Every caller checks service capabilities, polls the job through the backend (bearer),
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
/** Each account's private cloud recording this Mac has not saved yet, so a
 *  relaunch can finish it. Suffixed with the account's DID (accountStorageKey);
 *  the bare key is the pre-TC-772 record shared by every account. */
export const PRIVATE_CLOUD_PENDING_KEY = "exo.transcriber.privateCloudPending";

export const PRIVATE_CLOUD_BASE_PATH = "/api/transcriber/private-cloud";

export type PrivateCloudJobStatus =
  | "awaiting_upload"
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface PrivateCloudTranscriptionStats {
  tinfoil_calls?: number;
  tinfoil_audio_seconds?: number;
  voiced_seconds?: number;
  dropped_above_floor_pct?: number | null;
  vad_fallback?: boolean | null;
}

export interface PrivateCloudJob {
  id: string;
  status: PrivateCloudJobStatus;
  /** The create request's choices, as PTX recorded them (null from a relay that predates them). */
  channel_mode?: "separate" | "mixed" | null;
  channel_labels?: string[] | null;
  duration_seconds?: number | null;
  stats?: PrivateCloudTranscriptionStats | null;
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
  stats?: PrivateCloudTranscriptionStats | null;
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
  readonly statusCode: number | null;
  readonly transcriptionId: string | null;
  constructor(
    code: string,
    message: string,
    extra: {
      correlationId?: string | null;
      retryAfterSeconds?: number | null;
      statusCode?: number | null;
      transcriptionId?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "PrivateCloudError";
    this.code = code;
    this.correlationId = extra.correlationId ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.statusCode = extra.statusCode ?? null;
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

/** User-facing sentence for a known private-cloud code, without the generic fallback. */
export function privateCloudCodeMessage(code: string): string | undefined {
  switch (code) {
    case "recording_too_long_for_cloud":
    case "recording_too_long":
    case "recording_too_large":
      return "Private cloud can't transcribe a recording this long or large.";
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
    case "offline":
    case "request_timeout":
    case "service_unavailable":
      return "Couldn't reach private cloud transcription. Check your connection and try again.";
    case "service_misconfigured":
      return "Private cloud transcription is misconfigured. The team has been alerted.";
    case "transcription_not_found":
      return "The private cloud job no longer exists.";
    case "cancelled":
      return "The upload was cancelled.";
    default:
      return undefined;
  }
}

/** User-facing sentence for a code; the backend's own message is fixed text too. */
export function privateCloudMessage(err: PrivateCloudError): string {
  return privateCloudCodeMessage(err.code) ?? "Private cloud transcription couldn't complete. Try again.";
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
  /** The service capabilities; a missing route is a retryable error. */
  capabilities(): Promise<PrivateCloudCapabilities>;
  /** This account's jobs (tenant-scoped by the backend). */
  list(): Promise<PrivateCloudJob[]>;
  get(id: string, signal?: AbortSignal): Promise<PrivateCloudJob>;
  result(id: string, signal?: AbortSignal): Promise<PrivateCloudResult>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

/** Parse `Retry-After` (seconds or HTTP date) and the draft-7 reset parameter. */
export function parseRateLimitWaitSeconds(headers: Headers, now = Date.now()): number | null {
  const waits: number[] = [];
  const retryAfter = headers.get("Retry-After");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) waits.push(seconds);
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) waits.push(Math.max(0, (date - now) / 1000));
    }
  }
  const rateLimit = headers.get("RateLimit");
  const reset = rateLimit?.match(/(?:^|[,;\s])(?:reset|t)\s*=\s*"?(\d+(?:\.\d+)?)"?/i);
  if (reset !== undefined && reset !== null) {
    const seconds = Number(reset[1]);
    if (Number.isFinite(seconds) && seconds >= 0) waits.push(seconds);
  }
  return waits.length === 0 ? null : Math.max(...waits);
}

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
  const waits = [parseRateLimitWaitSeconds(response.headers)];
  if (typeof e.retry_after_seconds === "number" && Number.isFinite(e.retry_after_seconds) && e.retry_after_seconds >= 0) {
    waits.push(e.retry_after_seconds);
  }
  const validWaits = waits.filter((wait): wait is number => wait !== null);
  return new PrivateCloudError(code, typeof e.message === "string" ? e.message : `HTTP ${response.status}`, {
    correlationId: typeof e.correlation_id === "string" ? e.correlation_id : response.headers.get("X-Correlation-Id"),
    retryAfterSeconds: validWaits.length === 0 ? null : Math.max(...validWaits),
    statusCode: response.status,
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

  async function request(path: string, method: "GET" | "POST" | "DELETE", callerSignal?: AbortSignal): Promise<Response> {
    const token = bearer();
    if (token === null) throw new PrivateCloudError("unauthenticated", "Not signed in");
    const timeout = AbortSignal.timeout(20_000);
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout]);
    let response: Response;
    try {
      response = await fetchImpl(`${backendUrl}${PRIVATE_CLOUD_BASE_PATH}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE },
        signal,
      });
    } catch {
      if (callerSignal?.aborted) throw new PrivateCloudError("cancelled", "The transcription poll was cancelled");
      throw new PrivateCloudError(timeout.aborted ? "request_timeout" : "offline", "Could not reach the backend");
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
      if (response.status === 404) throw new PrivateCloudError("service_unavailable", "Private transcription could not be reached. Try again.");
      if (!response.ok) throw await readError(response);
      return json<PrivateCloudCapabilities>(response);
    },

    async list() {
      const response = await request("/transcriptions?limit=20", "GET");
      if (response.status === 404) throw new PrivateCloudError("service_unavailable", "Private transcription could not be reached. Try again.");
      if (!response.ok) throw await readError(response);
      const body = await json<{ transcriptions?: unknown }>(response);
      if (!Array.isArray(body.transcriptions)) throw new PrivateCloudError("upstream_bad_response", "Unexpected job list");
      return body.transcriptions as PrivateCloudJob[];
    },

    async get(id, signal) {
      const response = await request(`/transcriptions/${encodeURIComponent(id)}`, "GET", signal);
      if (response.status === 404) throw new PrivateCloudError("transcription_not_found", "No such transcription");
      if (!response.ok) throw await readError(response);
      return json<PrivateCloudJob>(response);
    },

    async result(id, signal) {
      const response = await request(`/transcriptions/${encodeURIComponent(id)}/result`, "GET", signal);
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
//   - Earlier desktop jobs: separate, ["Speaker 1", "Speaker 2"];
//   - Voice notes on every platform (lib/voiceNotes): mixed, ["Exo voice note"];
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
  // A missing route is a service failure, never an account decision.
  if (response.status === 404) {
    throw new PrivateCloudError("service_unavailable", "Private transcription could not be reached. Try again.");
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
 * The PTX origin audio may be uploaded to, or null when this build is unconfigured.
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

/** This build's PTX upload origin (VITE_EXO_PTX_UPLOAD_ORIGIN), or null in an unconfigured dev build. */
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

/** Private-cloud status cadence and transient-failure limits. */
export interface CloudPolling {
  intervalMs: number;
  slowIntervalMs: number;
  slowAfterMs: number;
  giveUpAfterMs: number;
  fastPhaseMs: number;
  maxIntervalMs: number;
}

export const DEFAULT_CLOUD_POLLING: CloudPolling = {
  intervalMs: 5_000,
  slowIntervalMs: 30_000,
  slowAfterMs: 60_000,
  giveUpAfterMs: 10 * 60_000,
  fastPhaseMs: 30_000,
  maxIntervalMs: 60_000,
};

export const MAX_RATE_LIMIT_WAIT_MS = 900_000;

export function cloudStatusIntervalMs(durationSeconds: number | null | undefined, elapsedMs: number, polling: CloudPolling): number {
  if (elapsedMs < polling.fastPhaseMs) return polling.intervalMs;
  const expected = typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? (durationSeconds * 1000) / 70
    : polling.slowIntervalMs;
  return Math.min(polling.maxIntervalMs, Math.max(polling.slowIntervalMs, expected));
}

export function jitteredCloudIntervalMs(intervalMs: number, random: () => number): number {
  return Math.round(intervalMs * (1 + 0.2 * random()));
}

/** Explicit server deadlines are never shortened; unreadable or absent headers use the slow cadence. */
export function jitteredRateLimitWaitMs(
  retryAfterSeconds: number | null,
  fallbackMs: number,
  random: () => number,
): number {
  const requested = retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds * 1000
    : fallbackMs;
  const base = Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.max(0, requested));
  return Math.min(MAX_RATE_LIMIT_WAIT_MS, Math.round(base * (1 + 0.2 * random())));
}

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
   *  out for a bounded interval, then `connectionLost()` is thrown, not a failure.
   *  An aborted `signal` stops it with a `cancelled` error at the next step. */
  pollTranscript(id: string, onProgress: (p: CloudJobProgress) => void, signal?: AbortSignal): Promise<PrivateCloudTranscript>;
}

export function createCloudJobPoller(
  api: Pick<PrivateCloudApi, "get" | "result">,
  options: {
    clock?: CloudClock;
    polling?: Partial<CloudPolling>;
    connectionLost: () => Error;
    durationSeconds?: number | null;
  },
): CloudJobPoller {
  const clock = options.clock ?? REAL_CLOCK;
  const polling: CloudPolling = { ...DEFAULT_CLOUD_POLLING, ...options.polling };
  const sleep = (baseMs: number) => clock.sleep(Math.round(baseMs * (0.8 + 0.4 * clock.random())));

  const transientTolerance = (throttledTime: () => number = () => 0) => {
    let failingSince: number | null = null;
    let throttledAtFailure = 0;
    return {
      reset: () => { failingSince = null; throttledAtFailure = throttledTime(); },
      pause: async (wait: () => Promise<void>) => {
        const before = clock.now();
        try {
          await wait();
        } finally {
          if (failingSince !== null) failingSince += Math.max(0, clock.now() - before);
        }
      },
      rideOut: async (err: unknown) => {
        if (!isTransientCloudError(err)) throw err;
        const now = clock.now();
        if (failingSince === null) {
          failingSince = now;
          throttledAtFailure = throttledTime();
        }
        const failingFor = Math.max(0, now - failingSince - (throttledTime() - throttledAtFailure));
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
          const job = await api.get(id);
          tolerance.reset();
          return job;
        } catch (err) {
          if (err instanceof PrivateCloudError && err.statusCode === 429) {
            const delay = jitteredRateLimitWaitMs(err.retryAfterSeconds, polling.slowIntervalMs, clock.random);
            await tolerance.pause(() => clock.sleep(delay));
            continue;
          }
          await tolerance.rideOut(err);
        }
      }
    },

    async pollTranscript(id, onProgress, signal) {
      const cancelled = () => new PrivateCloudError("cancelled", "Stopped polling the transcription", { transcriptionId: id });
      const sleepWithSignal = async (ms: number): Promise<void> => {
        if (signal === undefined) {
          await clock.sleep(ms);
          return;
        }
        if (signal.aborted) throw cancelled();
        let removeAbort = (): void => {};
        try {
          await Promise.race([
            clock.sleep(ms),
            new Promise<never>((_, reject) => {
              const onAbort = (): void => reject(cancelled());
              signal.addEventListener("abort", onAbort, { once: true });
              removeAbort = () => signal.removeEventListener("abort", onAbort);
              if (signal.aborted) onAbort();
            }),
          ]);
        } finally {
          removeAbort();
        }
      };
      const startedAt = clock.now();
      let durationSeconds = options.durationSeconds ?? null;
      let throttledMs = 0;
      const throttledTime = () => throttledMs;
      const waitThrottled = async (ms: number): Promise<void> => {
        const before = clock.now();
        try {
          await sleepWithSignal(ms);
        } finally {
          throttledMs += Math.max(0, clock.now() - before);
        }
      };
      const statusTolerance = transientTolerance(throttledTime);
      const resultTolerance = transientTolerance(throttledTime);
      for (;;) {
        if (signal?.aborted) throw cancelled();
        let job: PrivateCloudJob;
        try {
          job = await api.get(id, signal);
          if (signal?.aborted) throw cancelled();
          statusTolerance.reset();
        } catch (err) {
          if (signal?.aborted) throw cancelled();
          if (err instanceof PrivateCloudError && err.statusCode === 429) {
            await waitThrottled(jitteredRateLimitWaitMs(err.retryAfterSeconds, polling.slowIntervalMs, clock.random));
            continue;
          }
          await statusTolerance.rideOut(err);
          continue;
        }
        if (typeof job.duration_seconds === "number" && Number.isFinite(job.duration_seconds) && job.duration_seconds > 0) {
          durationSeconds = job.duration_seconds;
        }
        if (job.status === "completed") {
          let result: PrivateCloudResult;
          try {
            result = await api.result(id, signal);
            if (signal?.aborted) throw cancelled();
            resultTolerance.reset();
          } catch (err) {
            if (signal?.aborted) throw cancelled();
            if (err instanceof PrivateCloudError && err.statusCode === 429) {
              await waitThrottled(jitteredRateLimitWaitMs(err.retryAfterSeconds, polling.slowIntervalMs, clock.random));
              continue;
            }
            await resultTolerance.rideOut(err);
            continue;
          }
          if (result.status === "completed") return result.transcript;
          if (result.status !== "pending") throw result.error;
        } else {
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
        const elapsed = clock.now() - startedAt;
        const interval = cloudStatusIntervalMs(durationSeconds, elapsed, polling);
        const delay = elapsed < polling.fastPhaseMs ? interval : jitteredCloudIntervalMs(interval, clock.random);
        await sleepWithSignal(delay);
      }
    },
  };
}

// ── Engine choice ──────────────────────────────────────────────────────

/**
 * Whether private cloud can be offered. A failed check can be retried.
 */
export type PrivateCloudAvailability = "available" | "failed";

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

/** A private cloud recording not yet saved: written at Stop (or when its view
 *  closes mid-recording), before any upload, and kept until its transcript is
 *  saved or it is discarded. */
export interface PendingCloudJob {
  /** The create call's Idempotency-Key, reused by every upload of this recording. */
  attemptId: string;
  /** Null until the backend names the job (no upload has been accepted yet). */
  transcriptionId: string | null;
  sessionId: string;
  startedAt: string;
  language: string;
  /** The recording's audio file, for "Transcribe on this Mac"; "" when unknown
   *  (a record from before TC-772). Uploads re-open it by session id instead. */
  audioPath: string;
  /** An upload was started with `attemptId`, so a job may exist even while
   *  `transcriptionId` is null (its create answer was lost). */
  submitted: boolean;
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

/** A pending record as stored, or null when malformed. */
export function parsePendingCloudJob(v: Record<string, unknown>): PendingCloudJob | null {
  if (typeof v.attemptId !== "string" || typeof v.sessionId !== "string" || typeof v.startedAt !== "string") return null;
  return {
    attemptId: v.attemptId,
    transcriptionId: typeof v.transcriptionId === "string" ? v.transcriptionId : null,
    sessionId: v.sessionId,
    startedAt: v.startedAt,
    language: typeof v.language === "string" ? v.language : "en",
    audioPath: typeof v.audioPath === "string" ? v.audioPath : "",
    // Before TC-772 a record was written only as its upload started.
    submitted: typeof v.submitted === "boolean" ? v.submitted : true,
  };
}

/** The record under the old key shared by every account (before TC-772). It
 *  names no account, so only the account whose backend can read its job
 *  adopts it (localTranscriber's legacy migration). */
export const legacyPendingCloudStore: PendingCloudStore = localStorageRecordStore(
  PRIVATE_CLOUD_PENDING_KEY,
  parsePendingCloudJob,
);
