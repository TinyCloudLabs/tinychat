import type { CredentialSecret } from "./credential-store.js";
import {
  stripExpiringLinks,
  type FetchedMeeting,
  type MeetingFetchRequest,
  type MeetingFetchResult,
  type MeetingFetcher,
} from "./fetch-worker.js";

/**
 * W3's upstream half — the Fireflies side of the fetch worker (backend-ingest plan §8.1 W3;
 * §8.2 delta items 4, 7, 8).
 *
 * This module does ONE thing: `(meetingId, credential)` → content, or a short fixed error code.
 * It owns no schedule, no retry, no queue and no store — the worker owns those, and keeping them
 * out of here is what makes "the provider is slow/hostile" a value the worker can reason about
 * rather than a control-flow surprise.
 *
 * Two non-negotiables:
 *
 *  - **REFETCH BY ID (delta 7).** The request is a GraphQL query with an `id` variable. No stored
 *    URL, no provider-minted link, nothing that expires between the webhook and the fetch. The
 *    shipped browser client (`frontend/src/lib/connectors/firefliesClient.ts`) uses the same
 *    query for the same reason.
 *  - **The provider's words never escape (delta 4, §6.3).** A Fireflies error message can quote
 *    the query, the meeting title, or the credential that failed. Callers get a code from a
 *    CLOSED set; the message is not logged, not returned, and not stored.
 */

export const FIREFLIES_GRAPHQL_URL = "https://api.fireflies.ai/graphql";

/**
 * Verbatim from the shipped browser client, minus nothing: the backend copy of a meeting must be
 * the same meeting Option C would have written, or the two ingest paths diverge for one user.
 */
export const FIREFLIES_TRANSCRIPT_QUERY = `query GetTranscript($id: String!) {
  transcript(id: $id) {
    id title date duration organizer_email
    speakers { id name }
    meeting_attendees { displayName email }
    sentences { index speaker_name text start_time end_time }
    summary { keywords action_items overview meeting_type }
  }
}`;

/** Matches the browser client's fallback: a 429 with no header still pauses for a minute. */
export const FIREFLIES_RATE_LIMIT_FALLBACK_MS = 60_000;

const NOT_FOUND_RE = /not found|does not exist|no such transcript/i;
const RATE_LIMIT_RE = /rate limit|too many requests|retry after/i;
const UNAUTHORIZED_RE = /unauthori[sz]ed|forbidden|invalid api key|invalid token/i;

export interface FirefliesMeetingFetcherOptions {
  /** Injected so tests never touch the network and the e2e lane can retarget its mock. */
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  now?: () => number;
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). Anything else — and
 * any value that has already elapsed — is NOT a wait: the caller falls back to its own documented
 * pause rather than trusting a header it could not read.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return seconds * 1_000;
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

export class FirefliesMeetingFetcher implements MeetingFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly apiUrl: string;
  private readonly now: () => number;

  constructor(options: FirefliesMeetingFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiUrl = options.apiUrl ?? FIREFLIES_GRAPHQL_URL;
    this.now = options.now ?? (() => Date.now());
  }

  async fetchMeeting(request: MeetingFetchRequest): Promise<MeetingFetchResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearer(request.secret)}`,
        },
        body: JSON.stringify({
          query: FIREFLIES_TRANSCRIPT_QUERY,
          variables: { id: request.meetingId },
        }),
        // The worker's 30 s timeout aborts through this.
        signal: request.signal,
      });
    } catch {
      // Includes the abort: from here it is indistinguishable from any other transport failure,
      // and the worker has already recorded the timeout on its own side.
      return { ok: false, error: { code: "network_error" } };
    }

    if (!response.ok) {
      return { ok: false, error: this.classifyStatus(response) };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: { code: "invalid_response" } };
    }

    const envelope = body as {
      data?: { transcript?: unknown } | null;
      errors?: Array<{ message?: unknown }> | null;
    } | null;

    if (Array.isArray(envelope?.errors) && envelope.errors.length > 0) {
      return { ok: false, error: classifyGraphQlError(envelope.errors) };
    }
    const transcript = envelope?.data?.transcript;
    if (transcript === null || transcript === undefined) {
      // The provider announced this id and now does not have it: terminal on the first attempt
      // (§5.4/T5 — a 404 for an id we never wrote is a fabrication until proven otherwise).
      return { ok: false, error: { code: "not_found", terminal: true } };
    }
    if (typeof transcript !== "object" || Array.isArray(transcript)) {
      return { ok: false, error: { code: "invalid_response" } };
    }

    const row = transcript as Record<string, unknown>;
    if (row.id !== request.meetingId) {
      // An answer for a DIFFERENT meeting. Never stored under this user, never merged, never
      // retried into existence — the worker quarantines it.
      return { ok: false, error: { code: "invalid_response" } };
    }

    return { ok: true, content: toFetchedMeeting(row) };
  }

  private classifyStatus(response: Response): {
    code: string;
    retryAfterMs?: number;
    terminal?: boolean;
  } {
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
        this.now(),
      );
      return {
        code: "rate_limited",
        retryAfterMs: retryAfterMs ?? FIREFLIES_RATE_LIMIT_FALLBACK_MS,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return { code: "unauthorized" };
    }
    if (response.status === 404) return { code: "not_found", terminal: true };
    // Everything else — 5xx and any unexpected 4xx — is a retryable upstream failure. The body is
    // deliberately never read: it is the provider's prose, and it can quote the request.
    return { code: "upstream_error" };
  }
}

function bearer(secret: CredentialSecret): string {
  return secret.kind === "oauth" ? secret.accessToken : secret.apiKey;
}

/**
 * Classify by CLASS, never by quotation. The message is inspected here and discarded here; only
 * the resulting code leaves this function.
 */
function classifyGraphQlError(errors: Array<{ message?: unknown }>): {
  code: string;
  retryAfterMs?: number;
  terminal?: boolean;
} {
  const messages = errors
    .map((entry) => (typeof entry.message === "string" ? entry.message : ""))
    .join(" ");
  if (RATE_LIMIT_RE.test(messages)) return { code: "rate_limited" };
  if (UNAUTHORIZED_RE.test(messages)) return { code: "unauthorized" };
  if (NOT_FOUND_RE.test(messages)) return { code: "not_found", terminal: true };
  return { code: "upstream_error" };
}

function toFetchedMeeting(row: Record<string, unknown>): FetchedMeeting {
  const content: FetchedMeeting = {
    sourceId: row.id as string,
    // Stripped HERE as well as at the store boundary. The query asks for no URL field, so this
    // is defense against the provider adding one: an expiring link must not exist as a value
    // anywhere downstream, and the cheapest place to guarantee that is where the bytes arrive.
    payload: stripExpiringLinks(row),
  };
  if (typeof row.title === "string") content.title = row.title;
  const ts = normalizeTimestamp(row.date);
  if (ts !== undefined) content.ts = ts;
  const organizerEmail = boundedEmail(row.organizer_email);
  if (organizerEmail) content.organizerEmail = organizerEmail;
  const names: string[] = [];
  const emails: string[] = [];
  if (Array.isArray(row.meeting_attendees)) {
    for (const attendee of row.meeting_attendees.slice(0, 100)) {
      if (typeof attendee !== "object" || attendee === null || Array.isArray(attendee)) continue;
      const value = attendee as Record<string, unknown>;
      const name = boundedString(value.displayName);
      const email = boundedEmail(value.email);
      if (name && !names.some((existing) => existing.toLocaleLowerCase() === name.toLocaleLowerCase())) names.push(name);
      if (email && !emails.includes(email)) emails.push(email);
    }
  }
  if (names.length > 0) content.participantNames = names;
  if (emails.length > 0) content.participantEmails = emails;
  return content;
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 && normalized.length <= 256 ? normalized : undefined;
}

function boundedEmail(value: unknown): string | undefined {
  const normalized = boundedString(value)?.toLocaleLowerCase();
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : undefined;
}

/** Fireflies dates arrive as an ISO string or epoch millis; the store wants one shape. */
function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
