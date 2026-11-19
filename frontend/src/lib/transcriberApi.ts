import { clearSessionAfterHandoff } from "./sessionSignedOut";
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
 *   remove()        DELETE /api/transcriber/meetings/:id (202 = still deleting)
 *   removeAll()     DELETE /api/transcriber/meetings
 *
 * A 404 on the LIST means the backend has no transcriber configured (`feature-dark`); a 404 on
 * one meeting means that meeting is gone (`not-found`). Same distinction meetingsApi.ts draws.
 */

export type TranscriberMeetingStatus =
  | "queued"
  | "joining"
  | "waiting_for_admission"
  | "needs_help"
  | "in_progress"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

/** Optional: older recordings predate capture diagnostics. */
export interface TranscriberCapture {
  completion_reason?: string | null;
  failure_reason?: "browser_crashed" | "browser_closed";
  provider_status?: string;
  exit_code?: number | null;
  observed_at?: string;
  started_at?: string | null;
  ended_at?: string | null;
  silence_timeout_ms?: number;
  stop_requested_at?: string;
  stop_requested_by?: "user" | "join_deadline";
  provider_record_missing_at?: string;
  audio_activity?: "not_reported";
}

export interface TranscriberMeeting {
  id: string;
  status: TranscriberMeetingStatus;
  platform: string;
  meeting_url: string;
  bot?: { name?: string; joined_at?: string | null };
  transcript?: { status?: string; version?: number };
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  completed_at?: string | null;
  error?: { type: string; code: string; message: string } | null;
  capture?: TranscriberCapture;
  transcript_provider?: string;
  fallback_from?: string;
  fallback_reason?: string | null;
  metadata?: {
    source?: string;
    calendar_title?: string;
    scheduled_start?: string;
    /** TC-581: another account's calendar bot captured this; this account can read and remove it, not end it. */
    shared?: boolean;
    [key: string]: unknown;
  };
}

/** A row whose upstream read failed this time round. It keeps its id so it can still be deleted. */
export interface TranscriberUnavailableMeeting {
  id: string;
  unavailable: true;
  /** TC-3136: the owner removed it and the provider's copy is not yet confirmed gone; the server is retrying. */
  deleting?: true;
  /** TC-3136: the owner removed it, but the notetaker service still holds the copy and it cannot be deleted from here. */
  kept?: true;
}

export type TranscriberListRow = TranscriberMeeting | TranscriberUnavailableMeeting;

export interface TranscriberSegment {
  source?: "recording" | "fallback";
  id: string;
  speaker_id: string;
  speaker_name: string | null;
  attribution?: "identified" | "unknown" | "overlap";
  start: number;
  end: number;
  text: string;
}

export interface TranscriberTranscript {
  partial?: boolean;
  gaps?: { start: number; end: number; speaker_name: string | null }[];
  version?: number;
  meeting_id: string;
  status: TranscriberMeetingStatus;
  language?: string;
  duration_seconds?: number;
  capture?: TranscriberCapture;
  provider?: string;
  fallback_from?: string;
  fallback_reason?: string | null;
  speakers?: { id: string; name: string | null }[];
  segments?: TranscriberSegment[];
  text?: string;
}

export type TranscriberResult<T> =
  | { status: "ok"; value: T }
  | { status: "unauthenticated" }
  | { status: "offline" }
  | { status: "feature-dark" }
  | { status: "not-found" }
  | { status: "retryable"; httpStatus: number; code: string | null; message?: string }
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
  }, options?: { idempotencyKey?: string }): Promise<TranscriberResult<TranscriberMeeting>>;
  get(id: string): Promise<TranscriberResult<TranscriberMeeting>>;
  stop(id: string): Promise<TranscriberResult<{ id: string; status: TranscriberMeetingStatus }>>;
  transcript(id: string): Promise<TranscriberResult<TranscriptResult>>;
  /**
   * Resolves ok once the entry is gone (`deleting: false`) or accepted for retry (`deleting: true`).
   * `notDeleted`: dropped from the list but the notetaker service still holds the copy.
   */
  remove(id: string): Promise<TranscriberResult<{ deleting: boolean; notDeleted: boolean }>>;
  /**
   * Removes every recording this account holds, including the provider's copies, and (TC-3166) every private cloud
   * transcription job (voice notes and uploads). `deleting` counts meeting recordings still being retried; `listOnly`
   * (shared with this account) and `notDeleted` (own entries the provider did not attribute to it) were only dropped
   * from the list. Both are subsets of `removed`. `privateCloudDeleted` counts the jobs deleted and read back gone,
   * or is `null` when the deployment does not use that service (the step then says nothing about it).
   */
  removeAll(): Promise<TranscriberResult<{ removed: number; deleting: number; listOnly: number; notDeleted: number; privateCloudDeleted: number | null }>>;
  /**
   * TC-3166: whether the deployment keeps private cloud transcription jobs (voice notes and uploads), from config only.
   * `feature-dark` means neither the meeting transcriber nor private cloud transcription is on.
   */
  scope(): Promise<TranscriberResult<{ privateCloud: boolean }>>;
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
      headers?: Record<string, string>;
      missing: "feature-dark" | "not-found";
      /** Map a 2xx response to the value. Default: parse JSON. */
      read?: (response: Response) => Promise<T>;
    },
  ): Promise<TranscriberResult<T>> {
    const token = sessionStore.getToken();
    if (!token) return { status: "unauthenticated" };
    if (sessionStore.isExpired()) {
      await clearSessionAfterHandoff(sessionStore);
      return { status: "unauthenticated" };
    }

    // Read-only polling must settle during a storage outage. Mutations retain
    // their existing semantics: aborting a create does not prove no bot was sent.
    const signal = init.method === "GET" ? AbortSignal.timeout(20_000) : undefined;
    let response: Response;
    try {
      response = await fetchImpl(`${backendUrl}${TRANSCRIBER_BASE_PATH}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (signal?.aborted) return { status: "retryable", httpStatus: 504, code: "request_timeout" };
      return { status: "offline" };
    }

    if (response.status === 401) {
      await clearSessionAfterHandoff(sessionStore);
      return { status: "unauthenticated" };
    }
    if (response.status === 404) {
      return init.missing === "feature-dark" ? { status: "feature-dark" } : { status: "not-found" };
    }
    if (!response.ok) {
      const { code, message } = await readError(response);
      if (response.status === 429 || response.status >= 500) {
        return { status: "retryable", httpStatus: response.status, code, ...(message ? { message } : {}) };
      }
      return { status: "rejected", httpStatus: response.status, code, message };
    }
    try {
      const value = init.read ? await init.read(response) : ((await response.json()) as T);
      return { status: "ok", value };
    } catch {
      if (signal?.aborted) return { status: "retryable", httpStatus: 504, code: "request_timeout" };
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
    scope: () =>
      request<{ privateCloud: boolean }>("/scope", {
        method: "GET",
        missing: "feature-dark",
        read: async (response) => {
          const { privateCloud } = (await response.json()) as { privateCloud?: unknown };
          if (typeof privateCloud !== "boolean") throw new Error("incomplete_scope_response");
          return { privateCloud };
        },
      }),
    create: (input, options) => request("", {
      method: "POST",
      body: input,
      headers: options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
      missing: "feature-dark",
    }),
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
      request<{ deleting: boolean; notDeleted: boolean }>(`/${id(value)}`, {
        method: "DELETE",
        missing: "not-found",
        // 202 = the provider's copy is not yet confirmed gone; the server keeps retrying. A 200 with
        // `not_deleted` = dropped from the list but the provider's copy is not ours to delete.
        read: async (response) => {
          if (response.status === 202) return { deleting: true, notDeleted: false };
          if (response.status !== 200) return { deleting: false, notDeleted: false };
          const body = (await response.json()) as { status?: unknown };
          return { deleting: false, notDeleted: body.status === "not_deleted" };
        },
      }),
    removeAll: () =>
      request<{ removed: number; deleting: number; listOnly: number; notDeleted: number; privateCloudDeleted: number | null }>("", {
        method: "DELETE",
        missing: "feature-dark",
        // A backend that predates `listOnly`/`notDeleted`/`privateCloudDeleted` cannot say which removals were really
        // deleted, or whether voice notes and uploads were checked (`null` says it did not use that service), so a
        // missing field is a rejected response (the step shows "couldn't finish"), never a guess.
        read: async (response) => {
          const body = (await response.json()) as Record<"removed" | "deleting" | "listOnly" | "notDeleted" | "privateCloudDeleted", unknown>;
          const { removed, deleting, listOnly, notDeleted, privateCloudDeleted } = body;
          if (
            typeof removed !== "number" || typeof deleting !== "number" || typeof listOnly !== "number"
            || typeof notDeleted !== "number" || (typeof privateCloudDeleted !== "number" && privateCloudDeleted !== null)
          ) {
            throw new Error("incomplete_bulk_delete_response");
          }
          return { removed, deleting, listOnly, notDeleted, privateCloudDeleted };
        },
      }),
  };
}
