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
  platform?: string;
  metadata?: Record<string, unknown>;
}

/** Upstream answered with a non-2xx. `code` is the upstream error taxonomy code, when readable. */
export class TranscriptionApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionApiError";
  }
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
}

export interface TranscriptionApiConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  idempotencyKey?: () => string;
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
  return /socket|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|timed out|network|closed unexpectedly|fetch failed/i.test(
    text,
  );
}

export function createTranscriptionApiClient(config: TranscriptionApiConfig): TranscriptionApiClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const newIdempotencyKey = config.idempotencyKey ?? (() => crypto.randomUUID());

  async function request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
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
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, init);
    } catch (error) {
      if (!isTransientTransportError(error)) throw error;
      await sleep(TRANSIENT_RETRY_DELAY_MS);
      response = await fetchImpl(`${base}${path}`, init);
    }
    let json: unknown = null;
    const text = await response.text();
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
      );
    }
    return { status: response.status, json };
  }

  const encode = (id: string) => encodeURIComponent(id);

  return {
    async createMeeting(input) {
      const { json } = await request("POST", "/v1/meetings", input, {
        "Idempotency-Key": newIdempotencyKey(),
      });
      return json as TranscriptionMeeting;
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
