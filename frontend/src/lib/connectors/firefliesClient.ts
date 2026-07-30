// Fireflies.ai GraphQL client (browser-direct, pure & fetch-injectable).
// See docs/connectors-spec.md §5 — everything is Result-style; no throws
// cross the module boundary. Query strings are copied verbatim from the spec.

import type { SyncProgress } from "./types";

export const FIREFLIES_API_URL = "https://api.fireflies.ai/graphql";
export const FIREFLIES_DEFAULT_BATCH_SIZE = 25;
export const FIREFLIES_MAX_BATCH_SIZE = 50;
export const FIREFLIES_DEFAULT_DELAY_MS = 800;
export const FIREFLIES_MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_FALLBACK_MS = 60_000;

/** Vite env keys the browser-e2e lane sets to retarget the client at its mock. */
export interface FirefliesEnvOverrides {
  VITE_FIREFLIES_API_URL?: string;
  VITE_FIREFLIES_DELAY_MS?: string;
}

export interface FirefliesClientDefaults {
  apiUrl: string;
  delayMs: number;
}

/**
 * Pure env → defaults resolver. Blank, missing, or unparseable values fall back
 * to the production endpoint and pacing, so a stray/partial .env can never
 * silently point a real user's sync at a test upstream.
 */
export function resolveFirefliesClientDefaults(
  env: FirefliesEnvOverrides,
): FirefliesClientDefaults {
  const rawUrl =
    typeof env.VITE_FIREFLIES_API_URL === "string" ? env.VITE_FIREFLIES_API_URL.trim() : "";
  const rawDelay =
    typeof env.VITE_FIREFLIES_DELAY_MS === "string" ? env.VITE_FIREFLIES_DELAY_MS.trim() : "";
  const delayMs = Number.parseInt(rawDelay, 10);
  return {
    apiUrl: rawUrl.length > 0 ? rawUrl : FIREFLIES_API_URL,
    delayMs:
      /^\d+$/.test(rawDelay) && Number.isFinite(delayMs) ? delayMs : FIREFLIES_DEFAULT_DELAY_MS,
  };
}

/**
 * The `{ apiUrl, delayMs }` pair every UI construction site spreads into
 * `new FirefliesClient({ apiKey, ... })`. `import.meta.env` is read behind a
 * guard so non-Vite runtimes (bun unit tests) fall through to the defaults.
 */
export function defaultFirefliesClientOptions(): FirefliesClientDefaults {
  let env: FirefliesEnvOverrides = {};
  try {
    env = (import.meta.env ?? {}) as FirefliesEnvOverrides;
  } catch {
    // No Vite env injection in this runtime — production defaults.
  }
  return resolveFirefliesClientDefaults(env);
}

export const GET_USER_QUERY = `query GetUser { user { name email } }`;

export const LIST_TRANSCRIPTS_QUERY = `query ListTranscripts($limit: Int, $skip: Int) {
  transcripts(limit: $limit, skip: $skip) { id title date duration organizer_email }
}`;

export const GET_TRANSCRIPT_QUERY = `query GetTranscript($id: String!) {
  transcript(id: $id) {
    id title date duration organizer_email
    speakers { id name }
    meeting_attendees { displayName email }
    sentences { index speaker_name text start_time end_time }
    summary { keywords action_items overview meeting_type }
  }
}`;

export type FirefliesErrorKind =
  | "invalid-key"
  | "network-error"
  | "rate-limited"
  | "graphql-error";

export interface FirefliesError {
  kind: FirefliesErrorKind;
  message: string;
  /** Only present when kind === "rate-limited". */
  retryAfterMs?: number;
}

export type FirefliesResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: FirefliesError };

export interface FirefliesUser {
  name: string | null;
  email: string | null;
}

export interface FirefliesTranscriptSummary {
  id: string;
  title: string | null;
  date: number | string | null;
  duration: number | null;
  organizer_email: string | null;
}

export interface FirefliesSpeaker {
  id: string | number | null;
  name: string | null;
}

export interface FirefliesAttendee {
  displayName: string | null;
  email: string | null;
}

export interface FirefliesSentence {
  index: number;
  speaker_name: string | null;
  text: string;
  start_time: number;
  end_time: number;
}

export interface FirefliesSummary {
  keywords: string[] | null;
  action_items: string | null;
  overview: string | null;
  meeting_type: string | null;
}

export interface FirefliesTranscript extends FirefliesTranscriptSummary {
  speakers: FirefliesSpeaker[] | null;
  meeting_attendees: FirefliesAttendee[] | null;
  sentences: FirefliesSentence[] | null;
  summary: FirefliesSummary | null;
}

export interface FirefliesClientOptions {
  apiKey: string;
  /** Override the API URL (e2e mock upstream). */
  apiUrl?: string;
  /** Override fetch (unit tests inject a mock). */
  fetchImpl?: typeof fetch;
  /** Ms to sleep between pages / detail fetches. Tests pass 0. */
  delayMs?: number;
}

export interface ListNewTranscriptIdsOptions {
  knownIds: Iterable<string>;
  batchSize?: number;
  onProgress?: (progress: SyncProgress) => void;
}

type Json = Record<string, unknown>;

interface GraphQLErrorShape {
  message?: string;
  extensions?: { code?: string } & Record<string, unknown>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorShape[];
}

/** Sleep — replaceable in tests via delayMs: 0 (Promise.resolve()). */
function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse a `Retry-After` HTTP header. Supports delta-seconds and HTTP-date. */
function parseRetryAfterHeader(header: string | null): number | null {
  if (!header) return null;
  const s = header.trim();
  if (s.length === 0) return null;
  const asInt = Number.parseInt(s, 10);
  if (Number.isFinite(asInt) && /^\d+$/.test(s)) {
    return Math.max(0, asInt * 1000);
  }
  const asDate = Date.parse(s);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

/** Parse "retry after <date>" out of a GraphQL error message. */
function parseRetryAfterFromMessage(message: string): number | null {
  if (!message) return null;
  const m = message.match(/retry\s+after\s+([^;\s]+)/i);
  if (!m) return null;
  // Preserve the full token (millis + timezone) but strip trailing sentence
  // punctuation — Date.parse won't tolerate "…Z." otherwise.
  const candidate = m[1].trim().replace(/[.,;]+$/, "");
  const asDate = Date.parse(candidate);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  const asInt = Number.parseInt(candidate, 10);
  if (Number.isFinite(asInt) && /^\d+$/.test(candidate)) {
    return Math.max(0, asInt * 1000);
  }
  return null;
}

const RATE_LIMIT_MESSAGE_RE = /rate limit|too many requests|retry after/i;
const AUTH_MESSAGE_RE = /unauthorized|unauthenticated|invalid.*(api.*key|token|credentials)|forbidden/i;

function isRateLimitError(err: GraphQLErrorShape): boolean {
  const code = err.extensions?.code;
  if (typeof code === "string" && code.toLowerCase() === "too_many_requests") return true;
  if (typeof err.message === "string" && RATE_LIMIT_MESSAGE_RE.test(err.message)) return true;
  return false;
}

function isAuthError(err: GraphQLErrorShape): boolean {
  const code = err.extensions?.code;
  if (typeof code === "string") {
    const lc = code.toLowerCase();
    if (lc === "unauthenticated" || lc === "unauthorized" || lc === "forbidden") return true;
  }
  if (typeof err.message === "string" && AUTH_MESSAGE_RE.test(err.message)) return true;
  return false;
}

export class FirefliesClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly delayMs: number;

  constructor(options: FirefliesClientOptions) {
    if (!options.apiKey) {
      throw new Error("FirefliesClient: apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl ?? FIREFLIES_API_URL;
    // `fetch` MUST stay bound to the global. Storing the bare reference and
    // calling it as `this.fetchImpl(...)` rebinds `this` to the client, which
    // browsers reject with "Illegal invocation" — Bun and Node do not, so this
    // is invisible to the unit tests and bun e2e drivers and only the browser
    // lane (test/connectors/browser-lane.ts) catches a regression here.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.delayMs = options.delayMs ?? FIREFLIES_DEFAULT_DELAY_MS;
  }

  async validateKey(): Promise<FirefliesResult<FirefliesUser>> {
    const res = await this.request<{ user: FirefliesUser | null }>(GET_USER_QUERY);
    if (!res.ok) return res;
    if (!res.data.user) {
      return {
        ok: false,
        error: { kind: "invalid-key", message: "Fireflies returned no user for this key" },
      };
    }
    return { ok: true, data: res.data.user };
  }

  async getTranscript(id: string): Promise<FirefliesResult<FirefliesTranscript>> {
    const res = await this.request<{ transcript: FirefliesTranscript | null }>(
      GET_TRANSCRIPT_QUERY,
      { id },
    );
    if (!res.ok) return res;
    if (!res.data.transcript) {
      return {
        ok: false,
        error: { kind: "graphql-error", message: `Transcript ${id} not found` },
      };
    }
    return { ok: true, data: res.data.transcript };
  }

  async listNewTranscriptIds(
    opts: ListNewTranscriptIdsOptions,
  ): Promise<FirefliesResult<string[]>> {
    const batchSize = Math.min(
      Math.max(1, opts.batchSize ?? FIREFLIES_DEFAULT_BATCH_SIZE),
      FIREFLIES_MAX_BATCH_SIZE,
    );
    const known = opts.knownIds instanceof Set
      ? (opts.knownIds as Set<string>)
      : new Set<string>(opts.knownIds);

    const newIds: string[] = [];
    let skip = 0;
    let firstPage = true;

    while (true) {
      if (!firstPage) {
        await defaultSleep(this.delayMs);
      }
      firstPage = false;

      const res = await this.request<{ transcripts: FirefliesTranscriptSummary[] | null }>(
        LIST_TRANSCRIPTS_QUERY,
        { limit: batchSize, skip },
      );
      if (!res.ok) return res;

      const page = res.data.transcripts ?? [];
      if (page.length === 0) break;

      let hitKnown = false;
      for (const t of page) {
        if (typeof t.id !== "string") continue;
        if (known.has(t.id)) {
          hitKnown = true;
          break;
        }
        newIds.push(t.id);
      }

      opts.onProgress?.({ phase: "listing", done: newIds.length, total: null });

      if (hitKnown) break;
      if (page.length < batchSize) break;
      skip += batchSize;
    }

    return { ok: true, data: newIds };
  }

  private async request<T>(
    query: string,
    variables?: Json,
  ): Promise<FirefliesResult<T>> {
    const body = JSON.stringify(variables ? { query, variables } : { query });

    let attempt = 0;

    while (true) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
        });
      } catch (err) {
        return {
          ok: false,
          error: {
            kind: "network-error",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }

      if (response.status === 429) {
        const retryAfterMs =
          parseRetryAfterHeader(response.headers.get("retry-after")) ?? RATE_LIMIT_FALLBACK_MS;
        if (attempt >= FIREFLIES_MAX_RATE_LIMIT_RETRIES) {
          return {
            ok: false,
            error: { kind: "rate-limited", message: "Fireflies HTTP 429 rate limit", retryAfterMs },
          };
        }
        // In production wait the retry-after window; tests pass delayMs:0 so waits collapse.
        await defaultSleep(this.delayMs > 0 ? retryAfterMs : 0);
        attempt++;
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          error: {
            kind: "invalid-key",
            message: `Fireflies HTTP ${response.status}`,
          },
        };
      }

      if (!response.ok) {
        const text = await safeReadText(response);
        return {
          ok: false,
          error: {
            kind: "network-error",
            message: `Fireflies HTTP ${response.status}${text ? `: ${text}` : ""}`,
          },
        };
      }

      let payload: GraphQLResponse<T>;
      try {
        payload = (await response.json()) as GraphQLResponse<T>;
      } catch (err) {
        return {
          ok: false,
          error: {
            kind: "network-error",
            message: `Fireflies returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      const errors = Array.isArray(payload.errors) ? payload.errors : null;
      if (errors && errors.length > 0) {
        const rl = errors.find(isRateLimitError);
        if (rl) {
          const parsed = typeof rl.message === "string" ? parseRetryAfterFromMessage(rl.message) : null;
          const retryAfterMs = parsed ?? RATE_LIMIT_FALLBACK_MS;
          const message = rl.message ?? "Fireflies GraphQL rate limit";
          if (attempt >= FIREFLIES_MAX_RATE_LIMIT_RETRIES) {
            return {
              ok: false,
              error: { kind: "rate-limited", message, retryAfterMs },
            };
          }
          await defaultSleep(this.delayMs > 0 ? retryAfterMs : 0);
          attempt++;
          continue;
        }

        const auth = errors.find(isAuthError);
        if (auth) {
          return {
            ok: false,
            error: { kind: "invalid-key", message: auth.message ?? "Fireflies rejected the API key" },
          };
        }

        const first = errors[0];
        return {
          ok: false,
          error: {
            kind: "graphql-error",
            message: first?.message ?? "Fireflies returned an unknown GraphQL error",
          },
        };
      }

      if (!payload.data) {
        return {
          ok: false,
          error: { kind: "graphql-error", message: "Fireflies returned no data" },
        };
      }

      return { ok: true, data: payload.data };
    }
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}
