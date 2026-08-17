// Google Meet REST v2 client (browser-direct, pure & fetch-injectable).
//
// See the connector plan §4.2. Every API constant below is spike-verified live
// (2026-08-17) against meet.googleapis.com — the filter field is snake_case
// while JSON responses are camelCase, entries cap at 100/page, and the list
// result keys are `conferenceRecords` / `participants` / `transcripts` /
// `transcriptEntries`.
//
// This module stores NOTHING: the access token is held by the caller and passed
// in; a 401 asks the injected `refreshAccessToken` callback for a new one and
// keeps it in memory for the life of the client instance only. No throws cross
// the module boundary — everything is Result-style, like firefliesClient.ts.
//
// Deliberately NOT reused from Listen's pull lane: its MAX_CONFERENCES = 500 /
// MAX_ENTRIES_PER_TRANSCRIPT = 1000 silent slice() caps. Pagination here runs to
// exhaustion — a long meeting must never lose its tail.

export const GMEET_API_BASE = "https://meet.googleapis.com/v2";

/** Pacing between record-level iterations (plan §4.2). */
export const GMEET_DEFAULT_DELAY_MS = 800;

export const GMEET_CONFERENCE_RECORDS_PAGE_SIZE = 100;
export const GMEET_PARTICIPANTS_PAGE_SIZE = 250;
export const GMEET_TRANSCRIPTS_PAGE_SIZE = 100;
/** API maximum for transcript entries. */
export const GMEET_TRANSCRIPT_ENTRIES_PAGE_SIZE = 100;

export const GMEET_MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_BACKOFF_MS = 1_000;

/** The updateMask + body value used to turn auto-transcription on for a space. */
export const GMEET_AUTO_TRANSCRIPTION_UPDATE_MASK =
  "config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration";

export type GmeetErrorKind =
  | "aborted"
  | "auth-expired"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "network-error"
  | "api-error";

/**
 * A failure with Google's structured error body preserved — never discarded,
 * never carrying token material (Google's error payloads contain none, and the
 * request's Authorization header is never copied into an error).
 */
export interface GmeetError {
  kind: GmeetErrorKind;
  /** HTTP status, or null for transport/abort failures. */
  status: number | null;
  message: string;
  /** Google's `error.status`, e.g. "PERMISSION_DENIED". */
  googleStatus?: string | null;
  /** Google's `error.details[].reason` / `error.errors[].reason` when present. */
  reason?: string | null;
  /** Raw (truncated) response body, for honest UX and debugging. */
  body?: string;
  /** Only present when kind === "rate-limited". */
  retryAfterMs?: number;
}

export type GmeetResult<T> = { ok: true; data: T } | { ok: false; error: GmeetError };

export interface GmeetConferenceRecord {
  name: string;
  startTime?: string | null;
  endTime?: string | null;
  expireTime?: string | null;
  space?: string | null;
}

export interface GmeetSignedinUser {
  user?: string | null;
  displayName?: string | null;
}

export interface GmeetAnonymousUser {
  displayName?: string | null;
}

export interface GmeetPhoneUser {
  displayName?: string | null;
}

/** Raw participant — the display-name join lives in gmeetNormalize, not here. */
export interface GmeetParticipant {
  name: string;
  earliestStartTime?: string | null;
  latestEndTime?: string | null;
  signedinUser?: GmeetSignedinUser | null;
  anonymousUser?: GmeetAnonymousUser | null;
  phoneUser?: GmeetPhoneUser | null;
}

export type GmeetTranscriptState = "STATE_UNSPECIFIED" | "STARTED" | "ENDED" | "FILE_GENERATED";

export interface GmeetTranscript {
  name: string;
  state?: GmeetTranscriptState | string | null;
  startTime?: string | null;
  endTime?: string | null;
  docsDestination?: { document?: string | null; exportUri?: string | null } | null;
}

export interface GmeetTranscriptEntry {
  name: string;
  /** Participant RESOURCE name — display names require the participants join. */
  participant?: string | null;
  text?: string | null;
  languageCode?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

export interface GmeetSpace {
  name: string;
  meetingUri?: string | null;
  meetingCode?: string | null;
  config?: Record<string, unknown> | null;
}

/**
 * Outcome of the auto-transcription toggle. A 403 PERMISSION_DENIED is
 * spike-verified host-only semantics ("you are not the meeting host"), NOT an
 * auth failure — it gets its own quiet, expected reason so callers never
 * conflate it with a dead token.
 */
export type GmeetPatchSpaceReason =
  | "not-host"
  | "auth-expired"
  | "rate-limited"
  | "network-error"
  | "aborted"
  | "not-found"
  | "api-error";

export type GmeetPatchSpaceResult =
  | { ok: true; data: GmeetSpace }
  | { ok: false; reason: GmeetPatchSpaceReason; error: GmeetError };

/** Sleep seam — `(ms, signal)`; tests inject a spy so no wall-clock time passes. */
export type GmeetDelay = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface GmeetClientOptions {
  /** Access token for this session. Held in memory only; never persisted here. */
  accessToken: string;
  /**
   * Called ONCE per request on a 401. Returns a fresh access token, or null if
   * the refresh itself failed (then the 401 is terminal).
   */
  refreshAccessToken?: () => Promise<string | null>;
  /** Override the API base (tests / harnesses). */
  apiBase?: string;
  /** Override fetch (unit tests inject a mock). */
  fetchImpl?: typeof fetch;
  /** Pacing between record-level iterations and between pages. */
  delayMs?: number;
  /** Override the sleep implementation (tests inject a spy). */
  delay?: GmeetDelay;
  /** Client-wide abort signal; per-call signals override it. */
  signal?: AbortSignal;
  /** 429 retry budget before giving up. */
  maxRateLimitRetries?: number;
}

export interface GmeetCallOptions {
  signal?: AbortSignal;
}

/** Sleep that resolves EARLY (not rejects) when the signal aborts. */
export function gmeetDefaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * The `conferenceRecords` list filter. The FIELD is snake_case (`start_time`)
 * even though responses are camelCase, and the ISO timestamp must be quoted —
 * both spike-verified.
 */
export function gmeetConferenceRecordsFilter(windowStartIso: string): string {
  return `start_time>="${windowStartIso}"`;
}

/** Parse a `Retry-After` header. Supports delta-seconds and HTTP-date. */
export function parseRetryAfterHeader(header: string | null | undefined): number | null {
  if (!header) return null;
  const s = header.trim();
  if (s.length === 0) return null;
  if (/^\d+$/.test(s)) {
    const asInt = Number.parseInt(s, 10);
    if (Number.isFinite(asInt)) return Math.max(0, asInt * 1000);
  }
  const asDate = Date.parse(s);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/** Strip a leading slash so resource names compose cleanly onto the base URL. */
function resourcePath(name: string): string {
  return name.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * The space id inside whatever the user pasted: a bare meeting code, a
 * `spaces/{id}` resource name, or the meeting LINK — `https://meet.google.com/
 * abc-defg-hij` is the string Google Calendar and the Meet UI both offer for
 * copying, and it is the one form the API cannot take. Anything that is not a
 * recognisable link is passed through untouched.
 */
export function gmeetSpaceIdFromInput(spaceNameOrMeetingCode: string): string {
  const value = resourcePath(spaceNameOrMeetingCode);
  const linked = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z-])/i.exec(value);
  if (linked) return linked[1]!;
  return value.replace(/^spaces\//, "");
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) return err.name === "AbortError" || err.name === "TimeoutError";
  return false;
}

function abortedError(): GmeetError {
  return { kind: "aborted", status: null, message: "Google Meet sync aborted" };
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ reason?: string } & Record<string, unknown>>;
    errors?: Array<{ reason?: string; message?: string } & Record<string, unknown>>;
  };
}

/**
 * Preserve Google's structured error body: HTTP status + `error.status` +
 * `error.details[].reason` + `error.message`, plus the raw text (truncated).
 */
async function readErrorDetail(
  response: Response,
): Promise<{ status: number; message: string; googleStatus: string | null; reason: string | null; body: string }> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    raw = "";
  }
  let parsed: GoogleErrorBody | null = null;
  try {
    parsed = raw ? (JSON.parse(raw) as GoogleErrorBody) : null;
  } catch {
    parsed = null;
  }
  const err = parsed?.error;
  const googleStatus = typeof err?.status === "string" ? err.status : null;
  const reason =
    (Array.isArray(err?.details) ? err?.details.find((d) => typeof d?.reason === "string")?.reason : null) ??
    (Array.isArray(err?.errors) ? err?.errors.find((e) => typeof e?.reason === "string")?.reason : null) ??
    null;
  const message =
    typeof err?.message === "string" && err.message.length > 0
      ? err.message
      : `Google Meet API HTTP ${response.status}`;
  return {
    status: response.status,
    message,
    googleStatus,
    reason: reason ?? null,
    body: raw.slice(0, 1000),
  };
}

export class GmeetClient {
  private accessToken: string;
  private readonly refreshAccessToken: (() => Promise<string | null>) | null;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly delayImpl: GmeetDelay;
  private readonly signal: AbortSignal | undefined;
  private readonly maxRateLimitRetries: number;
  readonly delayMs: number;

  constructor(options: GmeetClientOptions) {
    if (!options.accessToken) {
      throw new Error("GmeetClient: accessToken is required");
    }
    this.accessToken = options.accessToken;
    this.refreshAccessToken = options.refreshAccessToken ?? null;
    this.apiBase = (options.apiBase ?? GMEET_API_BASE).replace(/\/+$/, "");
    // `fetch` MUST stay bound to the global — calling a bare reference as
    // `this.fetchImpl(...)` rebinds `this` and browsers reject it with
    // "Illegal invocation" (see the same note in firefliesClient.ts).
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.delayMs = options.delayMs ?? GMEET_DEFAULT_DELAY_MS;
    this.delayImpl = options.delay ?? gmeetDefaultDelay;
    this.signal = options.signal;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? GMEET_MAX_RATE_LIMIT_RETRIES;
  }

  /**
   * Pacing seam the sync engine calls BETWEEN conference records (800ms by
   * default). Abort-aware: an aborted signal returns immediately.
   */
  async pace(opts: GmeetCallOptions = {}): Promise<void> {
    await this.delayImpl(this.delayMs, opts.signal ?? this.signal);
  }

  /**
   * Conference records started at/after `windowStartIso`, fully paginated.
   *
   * Order is Google's: NEWEST-FIRST (descending startTime) — spike-confirmed.
   * Callers must not assume otherwise, and this client does not re-sort.
   */
  async listConferenceRecords(
    windowStartIso: string,
    opts: GmeetCallOptions = {},
  ): Promise<GmeetResult<GmeetConferenceRecord[]>> {
    const url = this.url("conferenceRecords", {
      filter: gmeetConferenceRecordsFilter(windowStartIso),
      pageSize: String(GMEET_CONFERENCE_RECORDS_PAGE_SIZE),
    });
    return this.listAllPages<GmeetConferenceRecord>(url, "conferenceRecords", opts);
  }

  /**
   * Participants of a conference record, fully paginated. Returned RAW —
   * display names live under signedinUser / anonymousUser / phoneUser and the
   * join is gmeetNormalize's job.
   */
  async listParticipants(
    recordName: string,
    opts: GmeetCallOptions = {},
  ): Promise<GmeetResult<GmeetParticipant[]>> {
    const url = this.url(`${resourcePath(recordName)}/participants`, {
      pageSize: String(GMEET_PARTICIPANTS_PAGE_SIZE),
    });
    return this.listAllPages<GmeetParticipant>(url, "participants", opts);
  }

  /** Transcripts of a conference record, fully paginated. */
  async listTranscripts(
    recordName: string,
    opts: GmeetCallOptions = {},
  ): Promise<GmeetResult<GmeetTranscript[]>> {
    const url = this.url(`${resourcePath(recordName)}/transcripts`, {
      pageSize: String(GMEET_TRANSCRIPTS_PAGE_SIZE),
    });
    return this.listAllPages<GmeetTranscript>(url, "transcripts", opts);
  }

  /**
   * Transcript entries, fully paginated — result key `transcriptEntries`,
   * pageSize 100 (the API maximum). Google returns them oldest-first
   * (ascending startTime, natural transcript order) — spike-confirmed; no
   * re-sort here, and NO cap: every page is walked to exhaustion.
   */
  async listTranscriptEntries(
    transcriptName: string,
    opts: GmeetCallOptions = {},
  ): Promise<GmeetResult<GmeetTranscriptEntry[]>> {
    const url = this.url(`${resourcePath(transcriptName)}/entries`, {
      pageSize: String(GMEET_TRANSCRIPT_ENTRIES_PAGE_SIZE),
    });
    return this.listAllPages<GmeetTranscriptEntry>(url, "transcriptEntries", opts);
  }

  /**
   * Turn auto-transcription ON for a space. Accepts a full `spaces/{id}`
   * resource name, a bare space id, a meeting code — the `spaces/{code}` alias
   * works for GET and PATCH (spike-verified) — or a pasted meeting link, whose
   * code `gmeetSpaceIdFromInput` extracts.
   *
   * A 403 is host-only semantics, surfaced as the quiet, expected
   * `{ ok: false, reason: "not-host" }` — never an auth failure.
   */
  async patchSpaceAutoTranscription(
    spaceNameOrMeetingCode: string,
    opts: GmeetCallOptions = {},
  ): Promise<GmeetPatchSpaceResult> {
    const id = gmeetSpaceIdFromInput(spaceNameOrMeetingCode);
    const url = this.url(`spaces/${id}`, { updateMask: GMEET_AUTO_TRANSCRIPTION_UPDATE_MASK });
    const res = await this.request<GmeetSpace>(
      url,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { artifactConfig: { transcriptionConfig: { autoTranscriptionGeneration: "ON" } } },
        }),
      },
      opts,
    );
    if (res.ok) return { ok: true, data: res.data };
    const reason: GmeetPatchSpaceReason =
      res.error.kind === "forbidden" ? "not-host" : (res.error.kind as GmeetPatchSpaceReason);
    return { ok: false, reason, error: res.error };
  }

  private url(path: string, params: Record<string, string>): string {
    const url = new URL(`${this.apiBase}/${resourcePath(path)}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  /**
   * Walk `nextPageToken` until it is exhausted. There is no page cap and no
   * item cap by design — silent truncation is the named anti-pattern.
   */
  private async listAllPages<T>(
    url: string,
    resultKey: string,
    opts: GmeetCallOptions,
  ): Promise<GmeetResult<T[]>> {
    const signal = opts.signal ?? this.signal;
    const items: T[] = [];
    let pageToken: string | null = null;

    while (true) {
      if (signal?.aborted) return { ok: false, error: abortedError() };
      if (pageToken !== null) {
        // Pace between pages, same seam as the record-level pacing.
        await this.delayImpl(this.delayMs, signal);
        if (signal?.aborted) return { ok: false, error: abortedError() };
      }

      const pageUrl = new URL(url);
      if (pageToken) pageUrl.searchParams.set("pageToken", pageToken);

      const res = await this.request<Record<string, unknown>>(pageUrl.toString(), { method: "GET" }, opts);
      if (!res.ok) return res;

      const raw = res.data[resultKey];
      if (Array.isArray(raw)) items.push(...(raw as T[]));

      const next = res.data.nextPageToken;
      pageToken = typeof next === "string" && next.length > 0 ? next : null;
      if (pageToken === null) break;
    }

    return { ok: true, data: items };
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    opts: GmeetCallOptions,
  ): Promise<GmeetResult<T>> {
    const signal = opts.signal ?? this.signal;
    let refreshAttempted = false;
    let rateLimitAttempts = 0;

    while (true) {
      if (signal?.aborted) return { ok: false, error: abortedError() };

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${this.accessToken}`,
          },
          signal,
        });
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return { ok: false, error: abortedError() };
        return {
          ok: false,
          error: {
            kind: "network-error",
            status: null,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }

      // 401 ⇒ refresh ONCE, retry; a second 401 is terminal.
      if (response.status === 401) {
        if (!refreshAttempted && this.refreshAccessToken) {
          refreshAttempted = true;
          let token: string | null = null;
          try {
            token = await this.refreshAccessToken();
          } catch {
            token = null;
          }
          if (signal?.aborted) return { ok: false, error: abortedError() };
          if (token) {
            this.accessToken = token;
            continue;
          }
        }
        const detail = await readErrorDetail(response);
        return { ok: false, error: { kind: "auth-expired", ...detail } };
      }

      if (response.status === 429) {
        const detail = await readErrorDetail(response);
        const retryAfterMs =
          parseRetryAfterHeader(response.headers.get("retry-after")) ??
          RATE_LIMIT_BASE_BACKOFF_MS * 2 ** rateLimitAttempts;
        if (rateLimitAttempts >= this.maxRateLimitRetries) {
          return { ok: false, error: { kind: "rate-limited", retryAfterMs, ...detail } };
        }
        rateLimitAttempts++;
        await this.delayImpl(retryAfterMs, signal);
        if (signal?.aborted) return { ok: false, error: abortedError() };
        continue;
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        const kind: GmeetErrorKind =
          response.status === 403 ? "forbidden" : response.status === 404 ? "not-found" : "api-error";
        return { ok: false, error: { kind, ...detail } };
      }

      let payload: T;
      try {
        payload = (await response.json()) as T;
      } catch (err) {
        return {
          ok: false,
          error: {
            kind: "network-error",
            status: response.status,
            message: `Google Meet returned malformed JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        };
      }

      return { ok: true, data: payload };
    }
  }
}
