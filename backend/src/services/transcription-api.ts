/**
 * Client for the TinyCloud Private Transcription API
 * (`TinyCloudLabs/tinycloud-private-transcription`, SPEC.md V1).
 *
 * The public contract is OURS; Vexa is an internal, replaceable capture implementation behind
 * it, so nothing in this file (or anything that imports it) says "Vexa". The API key is a static
 * project key (`tc_live_…`) — it lives in the backend env only and never reaches a browser, which
 * is the whole reason `routes/transcriber.ts` proxies rather than letting the SPA call upstream.
 *
 *   POST   /v1/meetings                  createMeeting
 *   GET    /v1/meetings/{id}             getMeeting
 *   POST   /v1/meetings/{id}/stop        stopMeeting
 *   GET    /v1/meetings/{id}/transcript  getTranscript (202 while pending)
 *   DELETE /v1/meetings/{id}             deleteMeeting
 */

export type TranscriptionMeetingStatus =
  | "queued"
  | "joining"
  | "waiting_for_admission"
  | "in_progress"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_MEETING_STATUSES: ReadonlySet<TranscriptionMeetingStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export interface TranscriptionMeetingError {
  type: string;
  code: string;
  message: string;
}

export type TranscriptionRecoveryPhase =
  | "queued"
  | "preflighting"
  | "chunking"
  | "transcribing"
  | "delayed"
  | "publishing"
  | "completed"
  | "failed"
  | "disabled";

export interface TranscriptionMeetingRecovery {
  eligible: boolean;
  code: string | null;
  phase: TranscriptionRecoveryPhase | null;
  next_eligible_at: string | null;
  manual_remaining: number | null;
  automatic_enabled: false;
}

export interface TranscriptionMeeting {
  id: string;
  object?: "meeting";
  status: TranscriptionMeetingStatus;
  platform: string;
  meeting_url: string;
  bot?: { name?: string; joined_at?: string | null };
  transcript?: { status?: string };
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  metadata?: Record<string, unknown>;
  error?: TranscriptionMeetingError | null;
  recovery?: TranscriptionMeetingRecovery;
  transcript_revision?: number;
}

export interface TranscriptionSegment {
  id: string;
  speaker_id: string;
  speaker_name: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionTranscript {
  meeting_id: string;
  status: TranscriptionMeetingStatus;
  language?: string;
  duration_seconds?: number;
  speakers?: { id: string; name: string }[];
  segments?: TranscriptionSegment[];
  text?: string;
  created_at?: string;
  transcript_revision?: number;
}

export interface CreateMeetingInput {
  meeting_url: string;
  bot_name?: string;
  language?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

/** A bounded, TinyChat-authored failure. Upstream text and bodies are never retained here. */
export class TranscriptionApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super("Transcription API request failed");
    this.name = "TranscriptionApiError";
  }
}

export interface TranscriptionRecoveryCapabilities {
  available: boolean;
  contractVersion: string | null;
}

export interface RecoverMeetingResult {
  httpStatus: 200 | 202;
  status: "processing" | "completed" | "failed" | "cancelled";
  recovery: {
    disposition: "started" | "already_active" | "already_completed";
    phase: TranscriptionRecoveryPhase | null;
    next_eligible_at: string | null;
  };
}

export interface TranscriptionApiClient {
  createMeeting(input: CreateMeetingInput): Promise<TranscriptionMeeting>;
  getMeeting(id: string): Promise<TranscriptionMeeting>;
  stopMeeting(id: string): Promise<{ id: string; status: TranscriptionMeetingStatus }>;
  /** `pending: true` mirrors upstream's 202 — the transcript is not ready yet. */
  getTranscript(
    id: string,
  ): Promise<{ pending: true; status: TranscriptionMeetingStatus } | { pending: false; transcript: TranscriptionTranscript }>;
  deleteMeeting(id: string): Promise<void>;
  getCapabilities(): Promise<TranscriptionRecoveryCapabilities>;
  recoverMeeting(id: string, idempotencyKey: string): Promise<RecoverMeetingResult>;
}

export interface TranscriptionApiConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  idempotencyKey?: () => string;
  recoveryContractVersion?: string;
  recoveryCapabilityCacheMs?: number;
  /** Injectable monotonic-enough wall clock for deterministic cache tests. */
  now?: () => number;
}

/** Both env vars set = the transcriber surface mounts. Either missing = the routes do not exist. */
export function transcriptionApiConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionApiConfig | null {
  const baseUrl = env.TRANSCRIPTION_API_URL?.trim();
  const apiKey = env.TRANSCRIPTION_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/** Retry once on a transport failure (socket closed, reset, timeout) — never on an HTTP status. */
const TRANSIENT_RETRY_DELAY_MS = 750;

export function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  const causeCode = isRecord(cause) && typeof cause.code === "string" ? cause.code : "";
  const text = `${error.name} ${error.message} ${(error as { code?: string }).code ?? ""} ${causeCode}`;
  return /socket|terminated|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|timed out|network|closed unexpectedly|fetch failed/i.test(
    text,
  );
}

const RECOVERY_SUPPORTED_CODES = [
  "provider_timeout",
  "provider_unavailable",
  "finalizer_interrupted",
  "recording_fetch_transient",
] as const;
const RECOVERY_PHASES = new Set<TranscriptionRecoveryPhase>([
  "queued",
  "preflighting",
  "chunking",
  "transcribing",
  "delayed",
  "publishing",
  "completed",
  "failed",
  "disabled",
]);
const RECOVERY_SAFE_CODES = new Set([
  ...RECOVERY_SUPPORTED_CODES,
  "operation_deadline_exceeded",
  "recording_absent",
  "recording_undecodable",
  "recording_silent",
  "provider_rejected",
  "attestation_failed",
  "coverage_incomplete",
  "budget_exhausted",
  "persistence_failed",
  "cancelled",
  "deleted",
  "validation_failed",
  "authentication_failed",
]);
const RECOVERY_DISPOSITIONS = new Set(["started", "already_active", "already_completed"] as const);
const RECOVERY_409_CODES = new Set([
  "idempotency_conflict",
  "recovery_ineligible",
  "provider_rejected",
  "recording_undecodable",
  "recording_silent",
  "attestation_failed",
  "coverage_incomplete",
  "cancelled",
]);
const RECOVERY_429_CODES = new Set(["recovery_cooldown", "budget_exhausted"]);
const MEETING_STATUSES = new Set<TranscriptionMeetingStatus>([
  "queued",
  "joining",
  "waiting_for_admission",
  "in_progress",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);
const RECOVERY_ACTION_KEY = /^[\x21-\x7e]{1,128}$/;
const CONTRACT_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSafeNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isBoundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length <= maximum;

function badUpstreamResponse(): TranscriptionApiError {
  return new TranscriptionApiError(503, null);
}

function decodeDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !ISO_DATE.test(value)) throw badUpstreamResponse();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw badUpstreamResponse();
  return value;
}

function decodeStatus(value: unknown): TranscriptionMeetingStatus {
  if (typeof value !== "string" || !MEETING_STATUSES.has(value as TranscriptionMeetingStatus)) {
    throw badUpstreamResponse();
  }
  return value as TranscriptionMeetingStatus;
}

function decodeRecoveryPhase(value: unknown): TranscriptionRecoveryPhase | null {
  if (value === null) return null;
  if (typeof value !== "string" || !RECOVERY_PHASES.has(value as TranscriptionRecoveryPhase)) {
    throw badUpstreamResponse();
  }
  return value as TranscriptionRecoveryPhase;
}

function decodeMeetingRecovery(value: unknown): TranscriptionMeetingRecovery {
  if (!isRecord(value)) throw badUpstreamResponse();
  const expected = [
    "eligible",
    "code",
    "phase",
    "next_eligible_at",
    "manual_remaining",
    "automatic_enabled",
  ];
  if (Object.keys(value).some((key) => !expected.includes(key)) || expected.some((key) => !(key in value))) {
    throw badUpstreamResponse();
  }
  if (typeof value.eligible !== "boolean" || value.automatic_enabled !== false) throw badUpstreamResponse();
  if (value.code !== null && (typeof value.code !== "string" || !RECOVERY_SAFE_CODES.has(value.code))) {
    throw badUpstreamResponse();
  }
  if (value.manual_remaining !== null && !isSafeNonnegativeInteger(value.manual_remaining)) {
    throw badUpstreamResponse();
  }
  return {
    eligible: value.eligible,
    code: value.code as string | null,
    phase: decodeRecoveryPhase(value.phase),
    next_eligible_at: decodeDate(value.next_eligible_at),
    manual_remaining: value.manual_remaining as number | null,
    automatic_enabled: false,
  };
}

function decodeMeeting(value: unknown): TranscriptionMeeting {
  if (!isRecord(value)) throw badUpstreamResponse();
  if (!isBoundedString(value.id, 128) || !SAFE_IDENTIFIER.test(value.id)
    || !isBoundedString(value.platform, 64) || !isBoundedString(value.meeting_url, 2_048)
    || !isBoundedString(value.created_at, 64)) {
    throw badUpstreamResponse();
  }
  const createdAt = decodeDate(value.created_at);
  if (createdAt === null) throw badUpstreamResponse();
  const result: TranscriptionMeeting = {
    id: value.id,
    status: decodeStatus(value.status),
    platform: value.platform,
    meeting_url: value.meeting_url,
    created_at: createdAt,
  };
  if (value.object !== undefined) {
    if (value.object !== "meeting") throw badUpstreamResponse();
    result.object = "meeting";
  }
  for (const field of ["started_at", "ended_at"] as const) {
    const fieldValue = value[field];
    if (fieldValue !== undefined) {
      result[field] = decodeDate(fieldValue);
    }
  }
  if (value.bot !== undefined) {
    if (!isRecord(value.bot)) throw badUpstreamResponse();
    const name = value.bot.name;
    const joinedAt = value.bot.joined_at;
    if (name !== undefined && !isBoundedString(name, 256)) throw badUpstreamResponse();
    const safeJoinedAt = joinedAt === undefined ? undefined : decodeDate(joinedAt);
    result.bot = {
      ...(name === undefined ? {} : { name }),
      ...(safeJoinedAt === undefined ? {} : { joined_at: safeJoinedAt }),
    };
  }
  if (value.transcript !== undefined) {
    if (!isRecord(value.transcript)) throw badUpstreamResponse();
    if (value.transcript.status !== undefined && !isBoundedString(value.transcript.status, 64)) {
      throw badUpstreamResponse();
    }
    result.transcript = value.transcript.status === undefined ? {} : { status: value.transcript.status };
  }
  if (value.error !== undefined) {
    if (value.error === null) {
      result.error = null;
    } else {
      if (!isRecord(value.error) || !isBoundedString(value.error.type, 64)
        || typeof value.error.code !== "string" || !SAFE_CODE.test(value.error.code)) {
        throw badUpstreamResponse();
      }
      result.error = {
        type: value.error.type,
        code: value.error.code,
        message: "Transcription could not be completed for this meeting.",
      };
    }
  }
  if (value.recovery !== undefined) result.recovery = decodeMeetingRecovery(value.recovery);
  if (value.transcript_revision !== undefined && value.transcript_revision !== null) {
    if (!isSafeNonnegativeInteger(value.transcript_revision)) throw badUpstreamResponse();
    result.transcript_revision = value.transcript_revision;
  }
  return result;
}

function decodeTranscript(value: unknown): TranscriptionTranscript {
  if (!isRecord(value) || !isBoundedString(value.meeting_id, 128) || !SAFE_IDENTIFIER.test(value.meeting_id)) {
    throw badUpstreamResponse();
  }
  const result: TranscriptionTranscript = {
    meeting_id: value.meeting_id,
    status: decodeStatus(value.status),
  };
  if (value.language !== undefined) {
    if (!isBoundedString(value.language, 64)) throw badUpstreamResponse();
    result.language = value.language;
  }
  if (value.duration_seconds !== undefined) {
    if (typeof value.duration_seconds !== "number" || !Number.isFinite(value.duration_seconds)
      || value.duration_seconds < 0) throw badUpstreamResponse();
    result.duration_seconds = value.duration_seconds;
  }
  if (value.text !== undefined) {
    if (typeof value.text !== "string") throw badUpstreamResponse();
    result.text = value.text;
  }
  if (value.created_at !== undefined) {
    const createdAt = decodeDate(value.created_at);
    if (createdAt === null) throw badUpstreamResponse();
    result.created_at = createdAt;
  }
  if (value.transcript_revision !== undefined && value.transcript_revision !== null) {
    if (!isSafeNonnegativeInteger(value.transcript_revision)) throw badUpstreamResponse();
    result.transcript_revision = value.transcript_revision;
  }
  if (value.speakers !== undefined) {
    if (!Array.isArray(value.speakers)) throw badUpstreamResponse();
    result.speakers = value.speakers.map((speaker) => {
      if (!isRecord(speaker) || !isBoundedString(speaker.id, 128) || !isBoundedString(speaker.name, 256)) {
        throw badUpstreamResponse();
      }
      return { id: speaker.id, name: speaker.name };
    });
  }
  if (value.segments !== undefined) {
    if (!Array.isArray(value.segments)) throw badUpstreamResponse();
    result.segments = value.segments.map((segment) => {
      if (!isRecord(segment) || !isBoundedString(segment.id, 128)
        || !isBoundedString(segment.speaker_id, 128) || !isBoundedString(segment.speaker_name, 256)
        || typeof segment.start !== "number" || !Number.isFinite(segment.start)
        || typeof segment.end !== "number" || !Number.isFinite(segment.end)
        || typeof segment.text !== "string") {
        throw badUpstreamResponse();
      }
      return {
        id: segment.id,
        speaker_id: segment.speaker_id,
        speaker_name: segment.speaker_name,
        start: segment.start,
        end: segment.end,
        text: segment.text,
      };
    });
  }
  return result;
}

function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 86_400 ? value : null;
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  return typeof value.error.code === "string" && SAFE_CODE.test(value.error.code) ? value.error.code : null;
}

function mapRecoveryHttpFailure(status: number, json: unknown, headers: Headers): TranscriptionApiError {
  const code = errorCode(json);
  if (status === 400 || status === 422) return new TranscriptionApiError(400, "invalid_request");
  if (status === 404) return new TranscriptionApiError(404, "not_found");
  if (status === 409 && code !== null && RECOVERY_409_CODES.has(code)) {
    return new TranscriptionApiError(409, code);
  }
  if (status === 410 && code === "recording_absent") {
    return new TranscriptionApiError(410, code);
  }
  if (status === 429 && code !== null && RECOVERY_429_CODES.has(code)) {
    return new TranscriptionApiError(429, code, retryAfterSeconds(headers));
  }
  return badUpstreamResponse();
}

function mapGenericHttpFailure(status: number, json: unknown): TranscriptionApiError {
  const code = errorCode(json);
  if (status === 404) {
    return new TranscriptionApiError(404, code === "meeting_not_found" ? code : "not_found");
  }
  if (status === 400 || status === 422) {
    return new TranscriptionApiError(400, code === "invalid_meeting_url" || code === "unsupported_platform"
      ? code
      : "invalid_request");
  }
  if (status === 429) return new TranscriptionApiError(429, "upstream_rate_limited");
  if (status >= 500 && code !== null && RECOVERY_SAFE_CODES.has(code)) {
    return new TranscriptionApiError(503, code);
  }
  return badUpstreamResponse();
}

export function createTranscriptionApiClient(config: TranscriptionApiConfig): TranscriptionApiClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newIdempotencyKey = config.idempotencyKey ?? (() => crypto.randomUUID());
  const now = config.now ?? Date.now;
  let capabilityCache: { value: TranscriptionRecoveryCapabilities; expiresAt: number } | null = null;

  async function request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    failureMode: "generic" | "capability" | "recovery" = "generic",
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    // A CVM redeploy on the other side shows up here as a closed socket mid-request. One
    // retry after a short pause covers the blip without turning an outage into a hammer.
    // Retried creates and recoveries carry stable Idempotency-Key values; stop is idempotent.
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${base}${path}`, init);
      text = await response.text();
    } catch (error) {
      if (!isTransientTransportError(error)) {
        if (failureMode === "generic") throw error;
        throw badUpstreamResponse();
      }
      await sleep(TRANSIENT_RETRY_DELAY_MS);
      try {
        response = await fetchImpl(`${base}${path}`, init);
        text = await response.text();
      } catch (retryError) {
        if (failureMode === "generic") throw retryError;
        throw badUpstreamResponse();
      }
    }
    let json: unknown = null;
    if (text.length > 0 && text.length <= 1_048_576) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok) {
      if (failureMode === "recovery") {
        if (response.status === 401 || response.status === 403) {
          console.warn("[transcriber-recovery] op=upstream-auth result=error status_class=credential");
        }
        throw mapRecoveryHttpFailure(response.status, json, response.headers);
      }
      if (failureMode === "capability") throw badUpstreamResponse();
      throw mapGenericHttpFailure(response.status, json);
    }
    return { status: response.status, json, headers: response.headers };
  }

  const encode = (id: string) => encodeURIComponent(id);

  return {
    async createMeeting(input) {
      const { json } = await request("POST", "/v1/meetings", input, {
        "Idempotency-Key": newIdempotencyKey(),
      });
      return decodeMeeting(json);
    },
    async getMeeting(id) {
      const { status, json } = await request("GET", `/v1/meetings/${encode(id)}`);
      if (status !== 200) throw badUpstreamResponse();
      const meeting = decodeMeeting(json);
      if (meeting.id !== id) throw badUpstreamResponse();
      return meeting;
    },
    async stopMeeting(id) {
      const { json } = await request("POST", `/v1/meetings/${encode(id)}/stop`);
      if (!isRecord(json) || json.id !== id) throw badUpstreamResponse();
      return { id, status: decodeStatus(json.status) };
    },
    async getTranscript(id) {
      const { status, json } = await request("GET", `/v1/meetings/${encode(id)}/transcript`);
      if (status !== 200 && status !== 202) throw badUpstreamResponse();
      if (!isRecord(json) || json.meeting_id !== id) throw badUpstreamResponse();
      const bodyStatus = decodeStatus(json.status);
      // 202 = still being prepared. Upstream also answers 200 with just `{meeting_id, status}`
      // (no segments) for a failed/cancelled meeting; that is not a transcript either.
      if (status === 202 || bodyStatus !== "completed") {
        return { pending: true, status: bodyStatus };
      }
      return { pending: false, transcript: decodeTranscript(json) };
    },
    async deleteMeeting(id) {
      await request("DELETE", `/v1/meetings/${encode(id)}`);
    },
    async getCapabilities() {
      const currentTime = now();
      if (capabilityCache !== null && currentTime < capabilityCache.expiresAt) {
        return capabilityCache.value;
      }
      capabilityCache = null;
      const { status, json } = await request("GET", "/v1/capabilities", undefined, {}, "capability");
      if (status !== 200) throw badUpstreamResponse();
      let value: TranscriptionRecoveryCapabilities;
      if (isRecord(json) && !("recovery" in json)) {
        value = { available: false, contractVersion: null };
      } else {
        if (!isRecord(json) || !isRecord(json.recovery)) throw badUpstreamResponse();
        const recovery = json.recovery;
        const keys = [
          "contract_version",
          "manual_available",
          "automatic_available",
          "supported_error_codes",
        ];
        if (Object.keys(recovery).some((key) => !keys.includes(key)) || keys.some((key) => !(key in recovery))) {
          throw badUpstreamResponse();
        }
        if (recovery.contract_version !== null
          && (typeof recovery.contract_version !== "string" || !CONTRACT_VERSION.test(recovery.contract_version))) {
          throw badUpstreamResponse();
        }
        if (typeof recovery.manual_available !== "boolean" || typeof recovery.automatic_available !== "boolean"
          || !Array.isArray(recovery.supported_error_codes)
          || recovery.supported_error_codes.some((code) => typeof code !== "string")) {
          throw badUpstreamResponse();
        }
        const exactCodes = recovery.supported_error_codes.length === RECOVERY_SUPPORTED_CODES.length
          && recovery.supported_error_codes.every((code, index) => code === RECOVERY_SUPPORTED_CODES[index]);
        const expectedVersion = config.recoveryContractVersion;
        value = {
          available: typeof expectedVersion === "string"
            && CONTRACT_VERSION.test(expectedVersion)
            && recovery.contract_version === expectedVersion
            && recovery.manual_available
            && recovery.automatic_available === false
            && exactCodes,
          contractVersion: recovery.contract_version,
        };
      }
      const ttl = config.recoveryCapabilityCacheMs;
      if (typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl > 0) {
        capabilityCache = { value, expiresAt: currentTime + ttl };
      }
      return value;
    },
    async recoverMeeting(id, idempotencyKey) {
      if (!RECOVERY_ACTION_KEY.test(idempotencyKey)) {
        throw new TranscriptionApiError(400, "invalid_request");
      }
      const { status, json } = await request(
        "POST",
        `/v1/meetings/${encode(id)}/recover`,
        { kind: "manual" },
        { "Idempotency-Key": idempotencyKey },
        "recovery",
      );
      if ((status !== 200 && status !== 202) || !isRecord(json)) throw badUpstreamResponse();
      const responseKeys = ["id", "status", "recovery"];
      if (Object.keys(json).some((key) => !responseKeys.includes(key))
        || responseKeys.some((key) => !(key in json))
        || json.id !== id
        || !isRecord(json.recovery)) throw badUpstreamResponse();
      const recovery = json.recovery;
      const recoveryKeys = [
        "operation_id",
        "disposition",
        "kind",
        "phase",
        "attempt",
        "max_attempts",
        "next_eligible_at",
      ];
      const hasOperation = typeof recovery.operation_id === "string";
      if (Object.keys(recovery).some((key) => !recoveryKeys.includes(key))
        || recoveryKeys.some((key) => !(key in recovery))
        || recovery.kind !== "manual"
        || !RECOVERY_DISPOSITIONS.has(recovery.disposition as never)
        || (recovery.operation_id !== null
          && (typeof recovery.operation_id !== "string" || !SAFE_IDENTIFIER.test(recovery.operation_id)))
        || (hasOperation
          ? (decodeRecoveryPhase(recovery.phase) === null
            || !isSafeNonnegativeInteger(recovery.attempt) || recovery.attempt < 1
            || !isSafeNonnegativeInteger(recovery.max_attempts) || recovery.max_attempts < recovery.attempt
            || recovery.next_eligible_at !== null)
          : recovery.phase !== null || recovery.attempt !== null || recovery.max_attempts !== null)) {
        throw badUpstreamResponse();
      }
      const meetingStatus = decodeStatus(json.status);
      if (!["processing", "completed", "failed", "cancelled"].includes(meetingStatus)) {
        throw badUpstreamResponse();
      }
      const disposition = recovery.disposition as RecoverMeetingResult["recovery"]["disposition"];
      if ((status === 202 && (disposition !== "started"
        || meetingStatus !== "processing" || recovery.phase !== "queued"))
        || (disposition === "started" && !hasOperation)
        || (disposition === "already_completed" && (meetingStatus !== "completed" || hasOperation))
        || (disposition === "already_active" && meetingStatus !== "processing")) {
        throw badUpstreamResponse();
      }
      return {
        httpStatus: status,
        status: meetingStatus as RecoverMeetingResult["status"],
        recovery: {
          disposition,
          phase: decodeRecoveryPhase(recovery.phase),
          next_eligible_at: decodeDate(recovery.next_eligible_at),
        },
      };
    },
  };
}
