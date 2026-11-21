// Granola REST client — talks to OUR stateless pass-through, never to Granola
// directly (its CORS preflight 404s, verified 2026-11-18). See
// docs/connectors-spec.md and backend/src/routes/granola-proxy.ts.
//
// Two credentials ride every request: our session JWT in `Authorization`
// (the proxy's authMiddleware requires it) and the user's own `grn_…` key in
// `x-granola-key`, which the backend forwards as Granola's Bearer token and
// never stores. Everything is Result-style; no throws cross the boundary.

import type { SessionStore } from "@tinyboilerplate/client";

export const GRANOLA_PROXY_PATH = "/api/connectors/granola";
export const GRANOLA_KEY_HEADER = "x-granola-key";
export const GRANOLA_LIST_PAGE_SIZE = 30; // Granola's own max for /v1/notes.
export const GRANOLA_TRANSCRIPT_PAGE_SIZE = 100; // Granola's own max for /transcript.
export const GRANOLA_DEFAULT_PAGE_BUDGET = 40; // 40 x 30 = 1,200 changed notes per run.
export const GRANOLA_DEFAULT_DELAY_MS = 250; // 4 req/s, under Granola's sustained 5 req/s.
export const GRANOLA_MAX_RATE_LIMIT_RETRIES = 3;
export const GRANOLA_MAX_RETRY_AFTER_MS = 60_000;
const MAX_TRANSCRIPT_PAGES = 1_000;

// `createApiClient`'s CSRF header, spelled here for the same reason the other
// connector clients spell it.
const REQUEST_HEADER_NAME = "X-Requested-With";
const REQUEST_HEADER_VALUE = "XMLHttpRequest";

/** Vite env keys the e2e lane sets to retarget the client at a mock proxy. */
export interface GranolaEnvOverrides {
  VITE_GRANOLA_PROXY_URL?: string;
  VITE_GRANOLA_DELAY_MS?: string;
}

export interface GranolaClientDefaults {
  /** Absolute or origin-relative base the three proxy paths hang off. */
  proxyUrl: string;
  delayMs: number;
}

/**
 * Pure env → defaults resolver. Blank, missing, or unparseable values fall back
 * to the production path, so a stray/partial .env can never silently point a
 * real user's key at a test proxy.
 */
export function resolveGranolaClientDefaults(env: GranolaEnvOverrides): GranolaClientDefaults {
  const rawUrl =
    typeof env.VITE_GRANOLA_PROXY_URL === "string" ? env.VITE_GRANOLA_PROXY_URL.trim() : "";
  const rawDelay =
    typeof env.VITE_GRANOLA_DELAY_MS === "string" ? env.VITE_GRANOLA_DELAY_MS.trim() : "";
  const delayMs = Number.parseInt(rawDelay, 10);
  return {
    proxyUrl: rawUrl.length > 0 ? rawUrl : "",
    delayMs:
      /^\d+$/.test(rawDelay) && Number.isFinite(delayMs) ? delayMs : GRANOLA_DEFAULT_DELAY_MS,
  };
}

export type GranolaErrorKind =
  /** 401 MISSING_API_KEY / INVALID_API_KEY — reconnect needed. */
  | "invalid-key"
  /** 403 — suspended, subscription inactive, scope denied. Terminal for the run. */
  | "forbidden"
  | "rate-limited"
  | "network-error"
  /** Any other upstream or parse failure, including 404. */
  | "api-error";

export interface GranolaError {
  kind: GranolaErrorKind;
  message: string;
  /** Granola's own `code` field when it sent one (e.g. SUBSCRIPTION_INACTIVE). */
  code?: string;
  httpStatus?: number;
  /** Only present when kind === "rate-limited". */
  retryAfterMs?: number;
  /** Granola's 404 NOTE_NOT_FOUND — a deleted or never-summarized note, never fatal. */
  notFound?: true;
}

export type GranolaResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: GranolaError };

export interface GranolaNoteSummary {
  id: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  owner: { name: string | null; email: string | null } | null;
}

export interface GranolaNotePage {
  notes: GranolaNoteSummary[];
  hasMore: boolean;
  cursor: string | null;
}

export interface GranolaCalendarEvent {
  event_title: string | null;
  invitees: { email: string | null }[];
  organiser: string | null;
  scheduled_start_time: string | null;
  scheduled_end_time: string | null;
}

export interface GranolaNote extends GranolaNoteSummary {
  web_url: string | null;
  calendar_event: GranolaCalendarEvent | null;
  attendees: { name: string | null; email: string | null }[];
  folder_membership: unknown;
  space_membership: unknown;
  summary_text: string | null;
  summary_markdown: string | null;
  /** Present only for the note owner's key — deliberately never read or stored. */
  attachment_count: number;
}

export interface GranolaTranscriptItem {
  speaker: {
    source: "microphone" | "speaker" | null;
    attribution: "me" | "them" | null;
    diarization_label: string | null;
    name: string | null;
  } | null;
  text: string;
  start_time: string | null;
  end_time: string | null;
}

export interface GranolaTranscriptPage {
  items: GranolaTranscriptItem[];
  hasMore: boolean;
  cursor: string | null;
}

export interface GranolaClientOptions {
  /** The caller's own key, read from the vault by the engine caller. Never logged. */
  apiKey: string;
  /** Backend origin (e.g. https://api.tinycloud.chat). REQUIRED — the proxy lives there. */
  backendUrl: string;
  sessionStore: SessionStore;
  /** Override the proxy base (e2e mock). Defaults to `${backendUrl}${GRANOLA_PROXY_PATH}`. */
  proxyUrl?: string;
  fetchImpl?: typeof fetch;
  /** Ms to sleep between upstream requests — 250 keeps us under 5 req/s. Tests pass 0. */
  delayMs?: number;
  /** Test seam for the 429 sleep. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class GranolaClient {
  private readonly apiKey: string;
  private readonly base: string;
  private readonly sessionStore: SessionStore;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  readonly delayMs: number;
  /** Requests sent this session — pacing and the page budgets are enforced against it. */
  private requests = 0;

  constructor(options: GranolaClientOptions) {
    if (!options.apiKey) throw new Error("GranolaClient: apiKey is required");
    if (!options.backendUrl && !options.proxyUrl) {
      throw new Error("GranolaClient: backendUrl is required (the sync proxies through our backend)");
    }
    this.apiKey = options.apiKey;
    this.base = (options.proxyUrl ?? `${options.backendUrl.replace(/\/+$/, "")}${GRANOLA_PROXY_PATH}`);
    this.sessionStore = options.sessionStore;
    // `fetch` MUST stay bound to the global — see firefliesClient.ts for why.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.delayMs = options.delayMs ?? GRANOLA_DEFAULT_DELAY_MS;
    this.sleep = options.sleepImpl ?? defaultSleep;
  }

  /** Cheap key check: one minimal list page. The UI layer's only auth probe. */
  async validateKey(signal?: AbortSignal): Promise<GranolaResult<GranolaNotePage>> {
    return this.listNotes({ pageSize: 1, signal });
  }

  /** ONE page of the newest-first notes listing. The engine drives the cursor. */
  async listNotes(opts: {
    pageSize?: number;
    cursor?: string | null;
    updatedAfter?: string | null;
    signal?: AbortSignal;
  } = {}): Promise<GranolaResult<GranolaNotePage>> {
    const params = new URLSearchParams();
    params.set("page_size", String(Math.min(GRANOLA_LIST_PAGE_SIZE, Math.max(1, opts.pageSize ?? GRANOLA_LIST_PAGE_SIZE))));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.updatedAfter) params.set("updated_after", opts.updatedAfter);
    const res = await this.request(`/v1/notes?${params}`, opts.signal);
    if (!res.ok) return res;
    const body = res.data as {
      notes?: unknown; hasMore?: unknown; has_more?: unknown; cursor?: unknown;
    };
    const notes = Array.isArray(body.notes)
      ? body.notes.filter((n): n is Record<string, unknown> => typeof n === "object" && n !== null)
        .map(normalizeNoteSummary)
      : [];
    return {
      ok: true,
      data: {
        notes,
        hasMore: body.hasMore === true || body.has_more === true,
        cursor: typeof body.cursor === "string" ? body.cursor : null,
      },
    };
  }

  /** One note's detail — summary, attendees, calendar event. Transcript is NOT included. */
  async getNote(id: string, signal?: AbortSignal): Promise<GranolaResult<GranolaNote>> {
    const res = await this.request(`/v1/notes/${encodeURIComponent(id)}`, signal);
    if (!res.ok) return res;
    return { ok: true, data: normalizeNote(res.data) };
  }

  /**
   * Follow the dedicated paginated route to completion; no inline transcript
   * or partial transcript is persisted. Missing and admin-disabled transcripts
   * leave the meeting summary available.
   */
  async getTranscript(
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GranolaResult<{ items: GranolaTranscriptItem[]; truncated: boolean; access?: "allowed" | "disabled" }>> {
    const items: GranolaTranscriptItem[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page++) {
      const params = new URLSearchParams();
      params.set("page_size", String(GRANOLA_TRANSCRIPT_PAGE_SIZE));
      if (cursor) params.set("cursor", cursor);
      const res = await this.request(
        `/v1/notes/${encodeURIComponent(id)}/transcript?${params}`,
        opts.signal,
      );
      if (!res.ok) {
        // Transcripts disabled by an admin (or auto-deleted) are not a sync
        // failure: the meeting still syncs with its summary.
        if (res.error.notFound) return { ok: true, data: { items: [], truncated: false } };
        if (res.error.kind === "forbidden" && res.error.code === "FORBIDDEN") {
          return { ok: true, data: { items: [], truncated: false, access: "disabled" } };
        }
        return res;
      }
      const body = res.data as {
        transcript?: unknown; items?: unknown; hasMore?: unknown; has_more?: unknown; cursor?: unknown;
      };
      const pageItems = Array.isArray(body.transcript) ? body.transcript
        : Array.isArray(body.items) ? body.items : [];
      for (const item of pageItems) {
        if (typeof item === "object" && item !== null) items.push(normalizeTranscriptItem(item));
      }
      const hasMore = body.hasMore === true || body.has_more === true;
      cursor = typeof body.cursor === "string" ? body.cursor : null;
      if (!hasMore) return { ok: true, data: { items, truncated: false, access: "allowed" } };
      if (!cursor || seenCursors.has(cursor)) {
        return { ok: false, error: { kind: "api-error", message: "Granola returned an unreadable response" } };
      }
      seenCursors.add(cursor);
    }
    // More data after the sanity cap: refuse the entire transcript, not a partial body.
    return { ok: false, error: { kind: "api-error", message: "Granola returned an unreadable response" } };
  }

  /**
   * One GET through the proxy, with 429 honouring Retry-After and pacing
   * between calls. The Granola key is scoped to this request and never logged.
   */
  private async request(path: string, signal?: AbortSignal): Promise<GranolaResult<unknown>> {
    const token = this.sessionStore.getToken();
    if (!token || this.sessionStore.isExpired()) {
      return { ok: false, error: { kind: "network-error", message: "You're signed out of TinyCloud One. Sign in, then try again." } };
    }
    const url = `${this.base}${path}`;
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) {
        return { ok: false, error: { kind: "network-error", message: "Aborted" } };
      }
      if (this.requests > 0 && !await this.sleep(this.delayMs, signal)) {
        return { ok: false, error: { kind: "network-error", message: "Aborted" } };
      }
      this.requests++;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${token}`,
            [GRANOLA_KEY_HEADER]: this.apiKey,
            [REQUEST_HEADER_NAME]: REQUEST_HEADER_VALUE,
            Accept: "application/json",
          },
          signal,
        });
      } catch {
        if (signal?.aborted) {
          return { ok: false, error: { kind: "network-error", message: "Aborted" } };
        }
        // Not narrated further: a transport error can echo the request URL,
        // and nothing client-supplied reaches a log from this module.
        return { ok: false, error: { kind: "network-error", message: "Could not reach the sync service" } };
      }

      const parsed = await readGranolaBody(response);
      if (response.status === 429) {
        const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
        if (attempt < GRANOLA_MAX_RATE_LIMIT_RETRIES
          && (retryAfterMs === null || retryAfterMs <= GRANOLA_MAX_RETRY_AFTER_MS)) {
          attempt++;
          if (!await this.sleep(retryAfterMs ?? 5_000, signal)) {
            return { ok: false, error: { kind: "network-error", message: "Aborted" } };
          }
          continue;
        }
        return {
          ok: false,
          error: {
            kind: "rate-limited",
            message: "Granola is rate limiting this key",
            code: parsed.code, httpStatus: 429,
            retryAfterMs: retryAfterMs ?? undefined,
          },
        };
      }
      if (response.status === 401) {
        // Only TinyCloud's auth middleware sets this header; the proxy does not relay it.
        if (response.headers.get("X-TinyCloud-Session-Rejected") === "1") {
          return { ok: false, error: { kind: "network-error", message: "You're signed out of TinyCloud One. Sign in, then try again." } };
        }
        return {
          ok: false,
          error: {
            kind: "invalid-key",
            message: "Granola did not accept this API key — it may have been revoked or expired",
            code: parsed.code, httpStatus: 401,
          },
        };
      }
      if (response.status === 403) {
        return {
          ok: false,
          error: {
            kind: "forbidden",
            message: "Granola refused this request. Check your API key, then try again.",
            code: parsed.code, httpStatus: 403,
          },
        };
      }
      if (response.status === 404) {
        return {
          ok: false,
          error: {
            kind: "api-error",
            message: "Granola couldn't find this note. It may have been deleted in Granola.",
            code: parsed.code, httpStatus: 404, notFound: true,
          },
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          error: {
            kind: "api-error",
            message: `Granola didn't respond as expected (error ${response.status}). Try again in a few minutes.`,
            code: parsed.code, httpStatus: response.status,
          },
        };
      }
      if (!parsed.ok) {
        return {
          ok: false,
          error: { kind: "api-error", message: "Granola returned an unreadable response", httpStatus: response.status },
        };
      }
      return { ok: true, data: parsed.body };
    }
  }
}

/** Inspect only status codes; the provider's message may contain private data. */
async function readGranolaBody(
  response: Response,
): Promise<{ ok: true; body: unknown; code?: string } | { ok: false; code?: undefined }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false };
  }
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  return {
    ok: true,
    body,
    code: typeof record.code === "string" ? record.code : undefined,
  };
}

function retryAfterMilliseconds(header: string | null): number | null {
  if (header === null) return null;
  if (/^\d{1,6}$/.test(header)) return Number.parseInt(header, 10) * 1000;
  const retryAt = Date.parse(header);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeNoteSummary(raw: Record<string, unknown>): GranolaNoteSummary {
  const owner = typeof raw.owner === "object" && raw.owner !== null
    ? raw.owner as Record<string, unknown>
    : null;
  return {
    id: str(raw.id) ?? "",
    title: strOrNull(raw.title),
    created_at: strOrNull(raw.created_at),
    updated_at: strOrNull(raw.updated_at),
    deleted_at: strOrNull(raw.deleted_at),
    owner: owner
      ? { name: strOrNull(owner.name), email: strOrNull(owner.email) }
      : null,
  };
}

function normalizeNote(raw: unknown): GranolaNote {
  const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const summary = normalizeNoteSummary(record);
  const event = typeof record.calendar_event === "object" && record.calendar_event !== null
    ? record.calendar_event as Record<string, unknown>
    : null;
  const invitees = event && Array.isArray(event.invitees)
    ? event.invitees
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
      .map((i) => ({ email: strOrNull(i.email) }))
    : [];
  const attendees = Array.isArray(record.attendees)
    ? record.attendees
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .map((a) => ({ name: strOrNull(a.name), email: strOrNull(a.email) }))
    : [];
  return {
    ...summary,
    web_url: strOrNull(record.web_url),
    calendar_event: event
      ? {
        event_title: strOrNull(event.event_title),
        invitees,
        organiser: strOrNull(event.organiser) ?? strOrNull(event.organizer),
        scheduled_start_time: strOrNull(event.scheduled_start_time),
        scheduled_end_time: strOrNull(event.scheduled_end_time),
      }
      : null,
    attendees,
    // Kept opaque: folders/spaces travel into meeting metadata untouched.
    folder_membership: record.folder_membership ?? null,
    space_membership: record.space_membership ?? null,
    summary_text: strOrNull(record.summary_text),
    summary_markdown: strOrNull(record.summary_markdown),
    // private_notes_* and attachments[] are deliberately NOT read — see the mapper.
    attachment_count: Array.isArray(record.attachments) ? record.attachments.length : 0,
  };
}

function normalizeTranscriptItem(raw: Record<string, unknown>): GranolaTranscriptItem {
  const speaker = typeof raw.speaker === "object" && raw.speaker !== null
    ? raw.speaker as Record<string, unknown>
    : null;
  const source = speaker?.source === "microphone" || speaker?.source === "speaker"
    ? speaker.source
    : null;
  const attribution = speaker?.attribution === "me" || speaker?.attribution === "them"
    ? speaker.attribution
    : null;
  return {
    speaker: speaker
      ? { source, attribution, diarization_label: strOrNull(speaker.diarization_label), name: strOrNull(speaker.name) }
      : null,
    text: typeof raw.text === "string" ? raw.text : "",
    start_time: strOrNull(raw.start_time),
    end_time: strOrNull(raw.end_time),
  };
}
