import type { SessionStore } from "@tinyboilerplate/client";

/**
 * Typed client for the TRANSCRIBER surface (`backend/src/routes/transcriber.ts`): send a bot
 * to a meeting link and read the speaker-attributed transcript back. The backend proxies the
 * TinyCloud Private Transcription API with a project key the browser never sees, so this
 * module holds no secret and touches no vault — a session token is the whole requirement.
 *
 *   list()          GET    /api/transcriber/meetings
 *   create()        POST   /api/transcriber/meetings
 *   get()           GET    /api/transcriber/meetings/:id
 *   stop()          POST   /api/transcriber/meetings/:id/stop
 *   transcript()    GET    /api/transcriber/meetings/:id/transcript   (202 = pending)
 *   remove()        DELETE /api/transcriber/meetings/:id
 *
 * A 404 on the LIST means the backend has no transcriber configured (`feature-dark`); a 404 on
 * one meeting means that meeting is gone (`not-found`). Same distinction meetingsApi.ts draws.
 */

export type TranscriberMeetingStatus =
  | "queued"
  | "joining"
  | "waiting_for_admission"
  | "in_progress"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export interface TranscriberMeeting {
  id: string;
  status: TranscriberMeetingStatus;
  platform: string;
  meeting_url: string;
  bot?: { name?: string; joined_at?: string | null };
  transcript?: { status?: string };
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  error?: { type: string; code: string; message: string } | null;
}

/** A row whose upstream read failed this time round. It keeps its id so it can still be deleted. */
export interface TranscriberUnavailableMeeting {
  id: string;
  unavailable: true;
}

export type TranscriberListRow = TranscriberMeeting | TranscriberUnavailableMeeting;

export interface TranscriberSegment {
  id: string;
  speaker_id: string;
  speaker_name: string;
  start: number;
  end: number;
  text: string;
}

export interface TranscriberTranscript {
  meeting_id: string;
  status: TranscriberMeetingStatus;
  language?: string;
  duration_seconds?: number;
  speakers?: { id: string; name: string }[];
  segments?: TranscriberSegment[];
  text?: string;
}

export type TranscriberResult<T> =
  | { status: "ok"; value: T }
  | { status: "unauthenticated" }
  | { status: "offline" }
  | { status: "feature-dark" }
  | { status: "not-found" }
  | { status: "retryable"; httpStatus: number; code: string | null }
  | { status: "rejected"; httpStatus: number; code: string | null; message: string | null };

export type TranscriptResult =
  | { status: "pending"; meetingStatus: TranscriberMeetingStatus }
  | { status: "ready"; transcript: TranscriberTranscript };

export const TRANSCRIBER_BASE_PATH = "/api/transcriber/meetings";

const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

export interface TranscriberClient {
  list(): Promise<TranscriberResult<{ meetings: TranscriberListRow[] }>>;
  create(input: {
    meeting_url: string;
    bot_name?: string;
    language?: string;
  }): Promise<TranscriberResult<TranscriberMeeting>>;
  get(id: string): Promise<TranscriberResult<TranscriberMeeting>>;
  stop(id: string): Promise<TranscriberResult<{ id: string; status: TranscriberMeetingStatus }>>;
  transcript(id: string): Promise<TranscriberResult<TranscriptResult>>;
  remove(id: string): Promise<TranscriberResult<null>>;
}

export function createTranscriberClient(
  backendUrl: string,
  config: { sessionStore: SessionStore; fetchImpl?: typeof fetch },
): TranscriberClient {
  const { sessionStore } = config;
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);

  async function request<T>(
    path: string,
    init: {
      method: "GET" | "POST" | "DELETE";
      body?: unknown;
      missing: "feature-dark" | "not-found";
      /** Map a 2xx response to the value. Default: parse JSON. */
      read?: (response: Response) => Promise<T>;
    },
  ): Promise<TranscriberResult<T>> {
    const token = sessionStore.getToken();
    if (!token) return { status: "unauthenticated" };
    if (sessionStore.isExpired()) {
      sessionStore.clear();
      return { status: "unauthenticated" };
    }

    let response: Response;
    try {
      response = await fetchImpl(`${backendUrl}${TRANSCRIBER_BASE_PATH}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch {
      return { status: "offline" };
    }

    if (response.status === 401) {
      sessionStore.clear();
      return { status: "unauthenticated" };
    }
    if (response.status === 404) {
      return init.missing === "feature-dark" ? { status: "feature-dark" } : { status: "not-found" };
    }
    if (!response.ok) {
      const { code, message } = await readError(response);
      if (response.status === 429 || response.status >= 500) {
        return { status: "retryable", httpStatus: response.status, code };
      }
      return { status: "rejected", httpStatus: response.status, code, message };
    }
    try {
      const value = init.read ? await init.read(response) : ((await response.json()) as T);
      return { status: "ok", value };
    } catch {
      return { status: "rejected", httpStatus: response.status, code: null, message: null };
    }
  }

  async function readError(response: Response): Promise<{ code: string | null; message: string | null }> {
    try {
      const body = (await response.json()) as { error?: unknown; message?: unknown };
      return {
        code: typeof body?.error === "string" ? body.error : null,
        message: typeof body?.message === "string" ? body.message : null,
      };
    } catch {
      return { code: null, message: null };
    }
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    list: () => request("", { method: "GET", missing: "feature-dark" }),
    create: (input) => request("", { method: "POST", body: input, missing: "feature-dark" }),
    get: (value) => request(`/${id(value)}`, { method: "GET", missing: "not-found" }),
    stop: (value) => request(`/${id(value)}/stop`, { method: "POST", missing: "not-found" }),
    transcript: (value) =>
      request<TranscriptResult>(`/${id(value)}/transcript`, {
        method: "GET",
        missing: "not-found",
        read: async (response) => {
          const body = (await response.json()) as TranscriberTranscript;
          // 202 = still being prepared; a 200 whose status is not `completed` (failed/cancelled)
          // carries no transcript either.
          if (response.status === 202 || body.status !== "completed") {
            return { status: "pending", meetingStatus: body.status ?? "processing" };
          }
          return { status: "ready", transcript: body };
        },
      }),
    remove: (value) =>
      request<null>(`/${id(value)}`, {
        method: "DELETE",
        missing: "not-found",
        read: async () => null,
      }),
  };
}
