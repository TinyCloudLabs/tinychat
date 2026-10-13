// Fireflies.ai GraphQL client (browser-direct, pure & fetch-injectable).
// See docs/connectors-spec.md §5 — everything is Result-style; no throws
// cross the module boundary. Query strings are copied verbatim from the spec.

import type { SyncProgress } from "./types";

export const FIREFLIES_API_URL = "https://api.fireflies.ai/graphql";
export const FIREFLIES_DEFAULT_BATCH_SIZE = 25;
export const FIREFLIES_MAX_BATCH_SIZE = 50;
export const FIREFLIES_DEFAULT_PAGE_BUDGET = 20;
export const FIREFLIES_MAX_DETAIL_CAP = 50;
export const FIREFLIES_DEFAULT_DELAY_MS = 800;
export const FIREFLIES_MAX_RATE_LIMIT_RETRIES = 3;
export const FIREFLIES_MAX_RETRY_AFTER_MS = 60_000;
const RATE_LIMIT_FALLBACK_MS = FIREFLIES_MAX_RETRY_AFTER_MS;

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

export interface FirefliesListing {
  ids: string[];
  /** True only after the date cutoff or the true end of history is reached. */
  complete: boolean;
}

export interface ListNewTranscriptIdsOptions {
  knownIds: Iterable<string>;
  batchSize?: number;
  /** Maximum detail IDs per run. */
  detailCap?: number;
  /** Maximum provider listing pages per run. */
  pageBudget?: number;
  /** Exclusive date cutoff; older summaries complete the listing. */
  stopBeforeDate?: string | null;
  /** A known SQL row without a stored body is not complete and must be repaired. */
  isKnownComplete?: (id: string) => boolean | Promise<boolean>;
  signal?: AbortSignal;
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

function firefliesDateMs(value: number | string | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
/** Resolve false when an AbortSignal cancels the wait. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

  async getTranscript(
    id: string,
    signal?: AbortSignal,
  ): Promise<FirefliesResult<FirefliesTranscript>> {
    const res = await this.request<{ transcript: FirefliesTranscript | null }>(
      GET_TRANSCRIPT_QUERY,
      { id },
      signal,
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
  ): Promise<FirefliesResult<FirefliesListing>> {
    const batchSize = Math.min(
      Math.max(1, opts.batchSize ?? FIREFLIES_DEFAULT_BATCH_SIZE),
      FIREFLIES_MAX_BATCH_SIZE,
    );
    const detailCap = Number.isFinite(opts.detailCap)
      ? Math.min(FIREFLIES_MAX_DETAIL_CAP, Math.max(0, Math.floor(opts.detailCap!)))
      : FIREFLIES_MAX_DETAIL_CAP;
    const pageBudget = Number.isFinite(opts.pageBudget)
      ? Math.max(0, Math.floor(opts.pageBudget!))
      : FIREFLIES_DEFAULT_PAGE_BUDGET;
    const known = opts.knownIds instanceof Set
      ? opts.knownIds as Set<string>
      : new Set<string>(opts.knownIds);
    const ids: string[] = [];
    const cutoff = opts.stopBeforeDate ? Date.parse(opts.stopBeforeDate) : Number.NaN;
    let skip = 0;
    let pages = 0;
    let complete = false;

    while (pages < pageBudget && ids.length < detailCap) {
      if (opts.signal?.aborted) break;
      if (pages > 0 && !await defaultSleep(this.delayMs, opts.signal)) break;

      const requestedLimit = Math.min(batchSize, detailCap - ids.length);
      const res = await this.request<{ transcripts: FirefliesTranscriptSummary[] | null }>(
        LIST_TRANSCRIPTS_QUERY,
        { limit: requestedLimit, skip },
        opts.signal,
      );
      if (!res.ok) {
        if (opts.signal?.aborted) break;
        return res;
      }

      pages++;
      const page = res.data.transcripts ?? [];
      if (page.length === 0) {
        complete = true;
        break;
      }

      let hitDateBoundary = false;
      for (const summary of page) {
        if (Number.isFinite(cutoff)) {
          const date = firefliesDateMs(summary.date);
          if (date !== null && date < cutoff) {
            hitDateBoundary = true;
            break;
          }
        }
        if (typeof summary.id !== "string") continue;
        if (known.has(summary.id) && (await opts.isKnownComplete?.(summary.id) ?? true)) continue;
        ids.push(summary.id);
        if (ids.length >= detailCap) break;
      }

      opts.onProgress?.({ phase: "listing", done: ids.length, total: null });
      if (hitDateBoundary) {
        complete = true;
        break;
      }
      if (page.length < requestedLimit) {
        complete = true;
        break;
      }
      skip += page.length;
    }

    return { ok: true, data: { ids, complete } };
  }

  private async request<T>(
    query: string,
    variables?: Json,
    signal?: AbortSignal,
  ): Promise<FirefliesResult<T>> {
    const body = JSON.stringify(variables ? { query, variables } : { query });

    let attempt = 0;

    while (true) {
      if (signal?.aborted) {
        return { ok: false, error: { kind: "network-error", message: "Fireflies request aborted" } };
      }
      let response: Response;
      try {
        response = await this.fetchImpl(this.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
          ...(signal ? { signal } : {}),
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
        if (retryAfterMs > FIREFLIES_MAX_RETRY_AFTER_MS
          || attempt >= FIREFLIES_MAX_RATE_LIMIT_RETRIES) {
          return {
            ok: false,
            error: { kind: "rate-limited", message: "Fireflies HTTP 429 rate limit", retryAfterMs },
          };
        }
        if (!await defaultSleep(this.delayMs > 0 ? retryAfterMs : 0, signal)) {
          return { ok: false, error: { kind: "network-error", message: "Fireflies request aborted" } };
        }
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
          if (retryAfterMs > FIREFLIES_MAX_RETRY_AFTER_MS
            || attempt >= FIREFLIES_MAX_RATE_LIMIT_RETRIES) {
            return {
              ok: false,
              error: { kind: "rate-limited", message, retryAfterMs },
            };
          }
          if (!await defaultSleep(this.delayMs > 0 ? retryAfterMs : 0, signal)) {
            return { ok: false, error: { kind: "network-error", message: "Fireflies request aborted" } };
          }
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
