import { connectorMeetingId, type NormalizedMeeting, type TranscriptSentence } from "@tinyboilerplate/core";

export const FIREFLIES_GRAPHQL_URL = "https://api.fireflies.ai/graphql";
export const FIREFLIES_ALLOWED_HOST = "api.fireflies.ai";
export const DEFAULT_FIREFLIES_TIMEOUT_MS = 30_000;
export const MAX_FIREFLIES_RESPONSE_BYTES = 2 * 1024 * 1024;
export const FIREFLIES_RATE_LIMIT_FALLBACK_MS = 60_000;

export const FIREFLIES_TRANSCRIPT_QUERY = `query GetTranscript($id: String!) {
  transcript(id: $id) {
    id title date duration organizer_email
    speakers { id name }
    meeting_attendees { displayName email }
    sentences { index speaker_name text start_time end_time }
    summary { keywords action_items overview meeting_type }
  }
}`;

const NOT_FOUND_RE = /not found|does not exist|no such transcript/i;
const RATE_LIMIT_RE = /rate limit|too many requests|retry after/i;
const UNAUTHORIZED_RE = /unauthori[sz]ed|forbidden|invalid api key|invalid token/i;
const PURE_URL_RE = /^https?:\/\/\S+$/i;
const LINK_KEY_RE = /(?:url|link|audio|video|transcript_url)$/i;
const LINK_SENTINEL = "[link-removed]";

export type FirefliesFetchErrorCode =
  | "invalid_input"
  | "invalid_url"
  | "redirect_refused"
  | "response_too_large"
  | "timeout"
  | "network_error"
  | "unauthorized"
  | "rate_limited"
  | "not_found"
  | "upstream_error"
  | "invalid_response";

export interface RawFirefliesTranscript {
  id: string;
  title?: unknown;
  date?: unknown;
  duration?: unknown;
  organizer_email?: unknown;
  speakers?: unknown;
  meeting_attendees?: unknown;
  sentences?: unknown;
  summary?: unknown;
}

export interface FirefliesMeetingKvRecord extends NormalizedMeeting {
  hasTranscript: boolean;
  hasSummary: boolean;
  origin: "fireflies-delegation-import";
  importedAt: string;
}

export interface NormalizedFirefliesImport {
  meeting: NormalizedMeeting;
  meetingRecord: FirefliesMeetingKvRecord;
  sentences: TranscriptSentence[];
  transcriptBody: string;
  bytes: number;
}

export interface FirefliesFetchOptions {
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  /** Test-only escape hatch for local mock servers; production leaves this false. */
  allowCustomUrl?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
}

export interface FirefliesFetchRequest {
  meetingId: string;
  apiKey: string;
  signal?: AbortSignal;
}

export type FirefliesFetchResult =
  | { ok: true; data: NormalizedFirefliesImport }
  | { ok: false; code: FirefliesFetchErrorCode; retryAfterMs?: number };

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

function validateFirefliesUrl(rawUrl: string, allowCustomUrl: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (allowCustomUrl) {
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname.toLowerCase() !== FIREFLIES_ALLOWED_HOST) return null;
  if (parsed.port !== "" && parsed.port !== "443") return null;
  return parsed.toString();
}

export function stripExpiringLinks(value: unknown, keyHint = ""): unknown {
  if (typeof value === "string") {
    if (PURE_URL_RE.test(value) || (LINK_KEY_RE.test(keyHint) && PURE_URL_RE.test(value.trim()))) {
      return LINK_SENTINEL;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripExpiringLinks(entry, ""));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stripExpiringLinks(entry, key);
    }
    return out;
  }
  return value;
}

function durationMismatch(computed: number, sentenceEnd: number): boolean {
  if (!(sentenceEnd > 0)) return false;
  const tolerance = Math.max(120, 0.5 * sentenceEnd);
  return Math.abs(computed - sentenceEnd) > tolerance;
}

function coerceStartedAt(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return new Date(raw).toISOString();
  }
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString();
  }
  return null;
}

/**
 * Normalize a raw Fireflies `GetTranscript` payload into the TC-1192 `NormalizedMeeting` +
 * `TranscriptSentence[]` KV shapes. Expiring links are stripped first.
 */
export async function normalizeFirefliesTranscript(
  rawInput: RawFirefliesTranscript,
  options: { importedAt?: string } = {},
): Promise<NormalizedFirefliesImport> {
  const raw = stripExpiringLinks(rawInput) as RawFirefliesTranscript;
  const rawSentences = Array.isArray(raw.sentences) ? raw.sentences : [];
  const sentences: TranscriptSentence[] = [];
  for (let i = 0; i < rawSentences.length; i++) {
    const entry = rawSentences[i];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text : "";
    const index =
      typeof row.index === "number" && Number.isFinite(row.index) ? row.index : i;
    const speakerName =
      typeof row.speaker_name === "string" && row.speaker_name.trim().length > 0
        ? row.speaker_name.trim()
        : null;
    const startTime =
      typeof row.start_time === "number" && Number.isFinite(row.start_time) ? row.start_time : 0;
    const endTime =
      typeof row.end_time === "number" && Number.isFinite(row.end_time) ? row.end_time : 0;
    sentences.push({
      index,
      speaker_name: speakerName,
      text,
      start_time: startTime,
      end_time: endTime,
    });
  }

  const lastEnd = sentences.length > 0 ? sentences[sentences.length - 1]!.end_time : 0;
  const metadata: Record<string, unknown> = {};
  let durationSecs: number | null = null;
  if (typeof raw.duration === "number" && Number.isFinite(raw.duration)) {
    const computed = Math.round(raw.duration * 60);
    if (durationMismatch(computed, lastEnd)) {
      durationSecs = Math.round(lastEnd);
      metadata.duration_source = "sentences";
    } else {
      durationSecs = computed;
    }
  } else if (lastEnd > 0) {
    durationSecs = Math.round(lastEnd);
    metadata.duration_source = "sentences";
  }

  const participants: { name: string; email: string | null }[] = [];
  const seenNames = new Set<string>();
  const pushParticipant = (name: unknown, email: unknown) => {
    if (typeof name !== "string") return;
    const trimmed = name.trim();
    if (trimmed.length === 0 || seenNames.has(trimmed)) return;
    seenNames.add(trimmed);
    participants.push({
      name: trimmed,
      email: typeof email === "string" && email.length > 0 ? email : null,
    });
  };
  if (Array.isArray(raw.meeting_attendees)) {
    for (const att of raw.meeting_attendees) {
      if (typeof att === "object" && att !== null && !Array.isArray(att)) {
        const row = att as Record<string, unknown>;
        pushParticipant(row.displayName, row.email);
      }
    }
  }
  if (Array.isArray(raw.speakers)) {
    for (const sp of raw.speakers) {
      if (typeof sp === "object" && sp !== null && !Array.isArray(sp)) {
        const row = sp as Record<string, unknown>;
        pushParticipant(row.name, null);
      }
    }
  }

  const summary =
    typeof raw.summary === "object" && raw.summary !== null && !Array.isArray(raw.summary)
      ? (raw.summary as Record<string, unknown>)
      : null;
  const summaryOverview =
    summary && typeof summary.overview === "string" ? summary.overview : null;
  const summaryActionItems =
    summary && typeof summary.action_items === "string" ? summary.action_items : null;
  const keywords =
    summary && Array.isArray(summary.keywords)
      ? summary.keywords.filter((item): item is string => typeof item === "string")
      : null;
  const meetingType =
    summary && typeof summary.meeting_type === "string" ? summary.meeting_type : null;

  const id = await connectorMeetingId("fireflies", raw.id);
  const meeting: NormalizedMeeting = {
    id,
    source: "fireflies",
    sourceId: raw.id,
    title: typeof raw.title === "string" ? raw.title : null,
    startedAt: coerceStartedAt(raw.date),
    durationSecs,
    organizerEmail:
      typeof raw.organizer_email === "string" && raw.organizer_email.length > 0
        ? raw.organizer_email
        : null,
    participants,
    summaryOverview,
    summaryActionItems,
    keywords,
    meetingType,
    metadata,
  };

  const importedAt = options.importedAt ?? new Date().toISOString();
  const hasSummary =
    summaryOverview !== null ||
    summaryActionItems !== null ||
    (keywords !== null && keywords.length > 0) ||
    meetingType !== null;
  const meetingRecord: FirefliesMeetingKvRecord = {
    ...meeting,
    hasTranscript: sentences.length > 0,
    hasSummary,
    origin: "fireflies-delegation-import",
    importedAt,
  };
  const transcriptBody = JSON.stringify(sentences);
  const bytes =
    Buffer.byteLength(transcriptBody, "utf8") +
    Buffer.byteLength(JSON.stringify(meetingRecord), "utf8");

  return { meeting, meetingRecord, sentences, transcriptBody, bytes };
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; code: "response_too_large" | "network_error" }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cancel errors after refusing an oversize response.
      }
      return { ok: false, code: "response_too_large" };
    }
  }

  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return { ok: false, code: "response_too_large" };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, code: "network_error" };
    }
    return { ok: true, text: Buffer.concat(chunks, total).toString("utf8") };
  }

  try {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) return { ok: false, code: "response_too_large" };
    return { ok: true, text: buf.toString("utf8") };
  } catch {
    return { ok: false, code: "network_error" };
  }
}

function classifyHttpStatus(
  status: number,
  retryAfterHeader: string | null,
  now: number,
): { code: FirefliesFetchErrorCode; retryAfterMs?: number } {
  if (status === 401 || status === 403) return { code: "unauthorized" };
  if (status === 404) return { code: "not_found" };
  if (status === 429) {
    return {
      code: "rate_limited",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader, now) ?? FIREFLIES_RATE_LIMIT_FALLBACK_MS,
    };
  }
  return { code: "upstream_error" };
}

function classifyGraphqlErrors(errors: unknown[]): FirefliesFetchErrorCode {
  const combined = errors
    .map((entry) =>
      typeof entry === "object" && entry !== null && "message" in entry && typeof entry.message === "string"
        ? entry.message
        : "",
    )
    .join(" ");
  if (UNAUTHORIZED_RE.test(combined)) return "unauthorized";
  if (RATE_LIMIT_RE.test(combined)) return "rate_limited";
  if (NOT_FOUND_RE.test(combined)) return "not_found";
  return "upstream_error";
}

/**
 * Stateless Fireflies meeting fetcher:
 * - HTTPS only on fixed host `api.fireflies.ai`
 * - `redirect: "manual"` (any 3xx / redirect refused immediately)
 * - Bounded time (`timeoutMs`, default 30 s) and response size (`maxBytes`, default 2 MiB)
 * - Closed error codes only (Fireflies words and the caller's API key never escape)
 */
export async function fetchFirefliesMeeting(
  request: FirefliesFetchRequest,
  options: FirefliesFetchOptions = {},
): Promise<FirefliesFetchResult> {
  const meetingId = request.meetingId.trim();
  const apiKey = request.apiKey.trim();
  if (!meetingId || !apiKey) return { ok: false, code: "invalid_input" };

  const targetUrl = validateFirefliesUrl(
    options.apiUrl ?? FIREFLIES_GRAPHQL_URL,
    options.allowCustomUrl === true,
  );
  if (!targetUrl) return { ok: false, code: "invalid_url" };

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FIREFLIES_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_FIREFLIES_RESPONSE_BYTES;
  const now = options.now ?? Date.now;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let response: Response;
  try {
    response = await fetchImpl(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: FIREFLIES_TRANSCRIPT_QUERY,
        variables: { id: meetingId },
      }),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    return { ok: false, code: timedOut ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCallerAbort);
  }

  // Never follow redirects (prevents off-host redirects or Bearer header leakage).
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore cancel errors on refused redirects.
    }
    return { ok: false, code: "redirect_refused" };
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore cancel errors on error responses.
    }
    const classified = classifyHttpStatus(response.status, response.headers.get("retry-after"), now());
    return { ok: false, ...classified };
  }

  const bodyRead = await readBoundedText(response, maxBytes);
  if (!bodyRead.ok) return { ok: false, code: bodyRead.code };

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRead.text);
  } catch {
    return { ok: false, code: "invalid_response" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "invalid_response" };
  }

  const envelope = parsed as { data?: unknown; errors?: unknown };
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    const code = classifyGraphqlErrors(envelope.errors);
    return {
      ok: false,
      code,
      ...(code === "rate_limited" ? { retryAfterMs: FIREFLIES_RATE_LIMIT_FALLBACK_MS } : {}),
    };
  }

  const data =
    typeof envelope.data === "object" && envelope.data !== null && !Array.isArray(envelope.data)
      ? (envelope.data as { transcript?: unknown })
      : null;
  if (!data) return { ok: false, code: "invalid_response" };
  if (data.transcript === null || data.transcript === undefined) {
    return { ok: false, code: "not_found" };
  }
  if (typeof data.transcript !== "object" || Array.isArray(data.transcript)) {
    return { ok: false, code: "invalid_response" };
  }
  const transcript = data.transcript as RawFirefliesTranscript;
  if (typeof transcript.id !== "string" || transcript.id !== meetingId) {
    return { ok: false, code: "invalid_response" };
  }

  const normalized = await normalizeFirefliesTranscript(transcript, {
    importedAt: new Date(now()).toISOString(),
  });
  return { ok: true, data: normalized };
}
