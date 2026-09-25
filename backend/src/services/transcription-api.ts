import { createHash } from "node:crypto";

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
 *   GET    /v1/meetings/by-idempotency-key lookupMeetingByIdempotencyKey
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
}

export interface CreateMeetingInput {
  meeting_url: string;
  bot_name?: string;
  language?: string;
  webhook_url?: string;
  platform?: string;
  metadata?: Record<string, unknown>;
}

/** Upstream answered with a non-2xx. `code` is the upstream error taxonomy code, when readable. */
export class TranscriptionApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TranscriptionApiError";
  }
}

export interface TranscriptionApiClient {
  createMeeting(input: CreateMeetingInput, options?: CreateMeetingOptions): Promise<TranscriptionMeeting>;
  lookupMeetingByIdempotencyKey(key: string): Promise<IdempotencyLookup | null>;
  getMeeting(id: string): Promise<TranscriptionMeeting>;
  stopMeeting(id: string): Promise<{ id: string; status: TranscriptionMeetingStatus }>;
  /** `pending: true` mirrors upstream's 202 — the transcript is not ready yet. */
  getTranscript(
    id: string,
  ): Promise<{ pending: true; status: TranscriptionMeetingStatus } | { pending: false; transcript: TranscriptionTranscript }>;
  deleteMeeting(id: string): Promise<void>;
}

export interface CreateMeetingOptions {
  idempotencyKey?: string;
  /** The scheduler must recheck consent and eligibility before every create attempt. */
  retryTransport?: boolean;
}

export interface IdempotencyLookup {
  meeting: TranscriptionMeeting;
  requestHash: string;
}

export interface TranscriptionApiConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  idempotencyKey?: () => string;
  /** Bound each request, including reading its body. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

/** Match upstream's parsed JSON create hash, not defaults resolved after creation. */
export function computeCreateRequestHash(input: CreateMeetingInput): string {
  const wire = JSON.parse(JSON.stringify(input)) as CreateMeetingInput;
  let meetingUrl = wire.meeting_url;
  const url = new URL(meetingUrl);
  // The upstream never includes a Signal bearer capability in its persisted request hash.
  if (url.hostname === "signal.link" && url.pathname === "/call/") {
    url.hash = "";
    meetingUrl = url.toString();
  }
  const parsed = {
    meeting_url: meetingUrl,
    bot_name: wire.bot_name ?? undefined,
    language: wire.language ?? undefined,
    webhook_url: wire.webhook_url ?? undefined,
    platform: wire.platform ?? undefined,
    metadata: wire.metadata,
  };
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return createHash("sha256").update(canonical(parsed)).digest("hex");
}

function retryAfterMs(value: string | null): number | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
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
  const text = `${error.name} ${error.message} ${(error as { code?: string }).code ?? ""}`;
  return /socket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|TimeoutError|timed out|network|closed unexpectedly|fetch failed/i.test(
    text,
  );
}

export function createTranscriptionApiClient(config: TranscriptionApiConfig): TranscriptionApiClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newIdempotencyKey = config.idempotencyKey ?? (() => crypto.randomUUID());
  const requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("requestTimeoutMs must be positive");
  }

  async function request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    retryTransport = true,
  ): Promise<{ status: number; json: unknown }> {
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
    // Retried creates carry an Idempotency-Key, so they cannot send a second bot.
    // The only other POST is stop, whose upstream contract is explicitly idempotent.
    const attempt = async (): Promise<{ response: Response; text: string }> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new DOMException("Transcription request timed out", "TimeoutError");
          controller.abort(error);
          reject(error);
        }, requestTimeoutMs);
      });
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal });
            return { response, text: await response.text() };
          })(),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    let result: { response: Response; text: string };
    try {
      result = await attempt();
    } catch (error) {
      if (!retryTransport || !isTransientTransportError(error)) throw error;
      await sleep(TRANSIENT_RETRY_DELAY_MS);
      result = await attempt();
    }
    const { response, text } = result;
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok) {
      const err = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      throw new TranscriptionApiError(
        response.status,
        typeof err?.code === "string" ? err.code : null,
        typeof err?.message === "string" ? err.message : `upstream ${response.status}`,
        retryAfterMs(response.headers.get("retry-after")),
      );
    }
    return { status: response.status, json };
  }

  const encode = (id: string) => encodeURIComponent(id);

  return {
    async createMeeting(input, options = {}) {
      const { json } = await request("POST", "/v1/meetings", input, {
        "Idempotency-Key": options.idempotencyKey ?? newIdempotencyKey(),
      }, options.retryTransport ?? true);
      return json as TranscriptionMeeting;
    },
    async lookupMeetingByIdempotencyKey(key) {
      try {
        const { json } = await request("GET", "/v1/meetings/by-idempotency-key", undefined, {
          "Idempotency-Key": key,
        });
        const body = json as { meeting?: TranscriptionMeeting; request_hash?: unknown } | null;
        if (!body?.meeting?.id || typeof body.request_hash !== "string" || !/^[0-9a-f]{64}$/.test(body.request_hash)) {
          throw new TranscriptionApiError(502, "invalid_lookup_response", "Invalid idempotency lookup response");
        }
        return { meeting: body.meeting, requestHash: body.request_hash };
      } catch (error) {
        if (error instanceof TranscriptionApiError && error.status === 404 && error.code === "meeting_not_found") {
          return null;
        }
        throw error;
      }
    },
    async getMeeting(id) {
      const { json } = await request("GET", `/v1/meetings/${encode(id)}`);
      return json as TranscriptionMeeting;
    },
    async stopMeeting(id) {
      const { json } = await request("POST", `/v1/meetings/${encode(id)}/stop`);
      return json as { id: string; status: TranscriptionMeetingStatus };
    },
    async getTranscript(id) {
      const { status, json } = await request("GET", `/v1/meetings/${encode(id)}/transcript`);
      const body = json as TranscriptionTranscript | null;
      // 202 = still being prepared. Upstream also answers 200 with just `{meeting_id, status}`
      // (no segments) for a failed/cancelled meeting; that is not a transcript either.
      if (status === 202 || !body || body.status !== "completed") {
        return { pending: true, status: body?.status ?? "processing" };
      }
      return { pending: false, transcript: body };
    },
    async deleteMeeting(id) {
      await request("DELETE", `/v1/meetings/${encode(id)}`);
    },
  };
}
