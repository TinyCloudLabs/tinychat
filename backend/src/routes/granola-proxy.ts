/**
 * Stateless Granola REST pass-through.
 *
 * Why this exists: `https://public-api.granola.ai` answers GETs with
 * `access-control-allow-origin: *` but the CORS PREFLIGHT (`OPTIONS`) 404s with no CORS headers
 * (verified 2026-11-18), so a browser fetch carrying `Authorization` can never reach it. The web
 * app therefore relays its own API-key reads through this proxy — the same reason the Google
 * token mint and the NRAS POST are proxies.
 *
 * The custody contract is the Google `/refresh` one's: the user's `grn_…` key arrives on EVERY
 * call in `x-granola-key` (our session JWT already owns `Authorization`), is forwarded to Granola
 * verbatim as `Authorization: Bearer`, and is never stored, never logged and never returned.
 * Nothing here persists: no secret, no note, no cursor.
 *
 * Mounted at `/api/connectors/granola` BEHIND `authMiddleware` and its own `granolaProxy` rate
 * bucket, inside `granolaProxyEnabled()` — flag off ⇒ no mount ⇒ 404 (the dark-ship canary).
 *
 * It is a NARROW pass-through, not a generic one:
 *  - exactly three GETs are forwarded — `/v1/notes`, `/v1/notes/:id`, `/v1/notes/:id/transcript`;
 *  - the upstream host is pinned to `https://public-api.granola.ai` — the client names a path,
 *    never a URL, so no proxy-open-relay or SSRF surface exists;
 *  - `:id` must match the `not_` id shape and query params are allowlisted per route, so a
 *    caller cannot mint an upstream path or filter this router does not know.
 */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";

/** The only host this proxy will ever call. The client never supplies a URL. */
export const GRANOLA_API_BASE_URL = "https://public-api.granola.ai";

/** Arming flag: `=== "true"` only, the same exact-match contract the other *_ENABLED flags use. */
export const GRANOLA_PROXY_ENABLED_ENV = "GRANOLA_PROXY_ENABLED";

export function granolaProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GRANOLA_PROXY_ENABLED_ENV] === "true";
}

/** Header the caller's personal Granola key rides in (`Authorization` carries OUR session JWT). */
export const GRANOLA_KEY_HEADER = "x-granola-key";

/**
 * The key shape Granola documents (`grn_…`), token-characters only and bounded. Shape-checking is
 * the only validation possible without a network call; an invalid or revoked key is Granola's
 * 401, relayed verbatim. The bound also keeps an absurd header from becoming an upstream request.
 */
const GRANOLA_KEY_PATTERN = /^grn_[A-Za-z0-9._~+-]{8,256}$/;

/** Granola note ids are `not_` plus base36-ish characters; anchored, no slashes possible. */
const NOTE_ID_PATTERN = /^not_[A-Za-z0-9]{1,64}$/;

/** Bounded values; opaque cursors may use standard padded base64 as well as base64url. */
const QUERY_VALUE_PATTERN = /^[A-Za-z0-9._~:+-]{1,128}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9._~+/-]{1,1024}={0,2}$/;

/** Per-route query allowlists. Anything else is a 400, never a forwarded param. */
const LIST_QUERY_PARAMS: Record<string, true> = {
  created_before: true,
  created_after: true,
  updated_after: true,
  folder_id: true,
  space_id: true,
  page_size: true,
  cursor: true,
};
const GET_NOTE_QUERY_PARAMS: Record<string, true> = { include: true };
const TRANSCRIPT_QUERY_PARAMS: Record<string, true> = {
  page_size: true,
  cursor: true,
  from_time: true,
};

/** Longer than relay.ts's attestation timeout: a first transcript page can be slow upstream. */
const UPSTREAM_TIMEOUT_MS = 30_000;

export interface GranolaProxyOptions {
  /** Test seam for the upstream origin; production always uses {@link GRANOLA_API_BASE_URL}. */
  baseUrl?: string;
  /** Test seam; the real fetch stays bound to the global (browser-unreachable, but consistent). */
  fetchImpl?: typeof fetch;
  /** Test seam for the timeout. */
  timeoutMs?: number;
  /** Test seam for the response size limit. */
  maxResponseBytes?: number;
}

/** Log shapes and statuses only — never a key, an id, a path suffix or a query value. */
function logGranolaProxy(fields: string): void {
  console.log(`[granola-proxy] ${fields} t=${new Date().toISOString()}`);
}

/** Granola's documented error envelope — relayed or locally minted in the same shape. */
function respondError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message });
}

/** Read and validate `x-granola-key`, or answer and return null. Never logs the value. */
function keyFromRequest(req: Request, res: Response): string | null {
  const raw = req.headers[GRANOLA_KEY_HEADER];
  // Node normally comma-joins duplicate custom headers; neither that nor an array is accepted.
  const key = Array.isArray(raw) ? undefined : raw;
  if (typeof key !== "string" || !GRANOLA_KEY_PATTERN.test(key)) {
    respondError(
      res,
      401,
      "MISSING_API_KEY",
      "A Granola API key (grn_…) is required in the x-granola-key header",
    );
    return null;
  }
  return key;
}

/**
 * Copy only the allowlisted params. A param outside the allowlist, a repeated param, or a value
 * that is not a bounded opaque token is a 400 — the route never forwards what it did not check.
 */
function checkedQuery(
  req: Request,
  res: Response,
  allowed: Record<string, true>,
): URLSearchParams | null {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(req.query)) {
    if (allowed[name] !== true) {
      respondError(res, 400, "VALIDATION_ERROR", "Unsupported query parameter");
      return null;
    }
    if (typeof value !== "string" || !(name === "cursor" ? CURSOR_PATTERN : QUERY_VALUE_PATTERN).test(value)) {
      respondError(res, 400, "VALIDATION_ERROR", `Invalid value for query parameter: ${name}`);
      return null;
    }
    params.append(name, value);
  }
  return params;
}

/** Upstream responses larger than this are refused (a full transcript page is far smaller). */
export const GRANOLA_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Locally minted `{code, message}` for each upstream status the proxy replaces. */
function fixedErrorFor(status: number): { status: number; code: string; message: string } {
  switch (status) {
    case 400: return { status, code: "BAD_REQUEST", message: "Granola rejected the request" };
    case 401: return { status, code: "UNAUTHORIZED", message: "Granola did not accept the API key" };
    case 403: return { status, code: "FORBIDDEN", message: "Granola refused the request" };
    case 404: return { status, code: "NOT_FOUND", message: "Granola could not find that note" };
    case 429: return { status, code: "RATE_LIMITED", message: "Granola is rate limiting this key" };
    default:
      return status >= 400 && status < 500
        ? { status, code: "UPSTREAM_REJECTED", message: "Granola rejected the request" }
        : { status: 502, code: "UPSTREAM_ERROR", message: "Granola did not respond as expected" };
  }
}

/** `Retry-After` is passed on as delta-seconds or an HTTP date, and only in those shapes. */
function passRetryAfter(res: Response, upstream: globalThis.Response): void {
  const retryAfter = upstream.headers.get("retry-after");
  if (!retryAfter || retryAfter.length > 64) return;
  if (/^\d{1,6}$/.test(retryAfter)) {
    res.set("Retry-After", retryAfter);
    return;
  }
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) res.set("Retry-After", new Date(date).toUTCString());
}

/** The response body as text, or null when it exceeds `max` bytes (the rest is never read). */
async function readCappedText(upstream: globalThis.Response, max: number): Promise<string | null> {
  const declared = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await upstream.body?.cancel().catch(() => {});
    return null;
  }
  if (!upstream.body) return "";
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** A fetch or body-read failure: a timeout is a 504, anything else a 502; only the error class is logged. */
function answerUpstreamFailure(res: Response, op: string, result: string, message: string, error: unknown): void {
  // The error object is logged by class name only — its message can echo the URL, and a
  // URL built from a hostile query value would then carry that value into the log.
  const name = error instanceof Error ? error.name : "unknown";
  if (name === "TimeoutError" || name === "AbortError") {
    logGranolaProxy(`op=${op} result=upstream_timeout error=${name}`);
    respondError(res, 504, "UPSTREAM_TIMEOUT", "Granola took too long to respond");
    return;
  }
  logGranolaProxy(`op=${op} result=${result} error=${name}`);
  respondError(res, 502, "UPSTREAM_ERROR", message);
}

/**
 * Fetch the pinned upstream and answer with stable statuses:
 *  - 2xx: the JSON object body as-is; anything else is a 502;
 *  - 4xx: Granola's JSON error body as-is, or a fixed `{code, message}` when it is not a JSON object;
 *  - 429 and 5xx carry `Retry-After` when Granola sent one; 5xx and redirects answer 502;
 *  - a timeout is a 504, an unreachable upstream or an oversized body a 502;
 *  - a body that contains the caller's key is replaced by the fixed `{code, message}` for its status.
 * The Authorization header is set ONLY on the upstream request.
 */
async function relayGranola(
  req: Request,
  res: Response,
  options: GranolaProxyOptions,
  op: "list" | "get" | "transcript",
  upstreamPath: string,
  params: URLSearchParams,
): Promise<void> {
  const key = keyFromRequest(req, res);
  if (key === null) return;
  const base = (options.baseUrl ?? GRANOLA_API_BASE_URL).replace(/\/+$/, "");
  const query = params.toString();
  const url = `${base}${upstreamPath}${query ? `?${query}` : ""}`;
  const fetchImpl = options.fetchImpl ?? fetch;

  let upstream: globalThis.Response;
  try {
    upstream = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    answerUpstreamFailure(res, op, "upstream_unreachable", "Failed to reach Granola", error);
    return;
  }

  try {
    const status = upstream.status;
    const failure = status < 200 || status >= 300;
    if (status < 200 || (status >= 300 && status < 400) || status >= 500) {
      await upstream.body?.cancel().catch(() => {});
      if (status >= 500) passRetryAfter(res, upstream);
      const fixed = fixedErrorFor(status);
      respondError(res, fixed.status, fixed.code, fixed.message);
      logGranolaProxy(`op=${op} result=upstream_status status=${status}`);
      return;
    }
    const body = await readCappedText(upstream, options.maxResponseBytes ?? GRANOLA_MAX_RESPONSE_BYTES);
    if (body === null) {
      respondError(res, 502, "UPSTREAM_TOO_LARGE", "The Granola response was too large");
      logGranolaProxy(`op=${op} result=too_large status=${status}`);
      return;
    }
    if (status === 429) passRetryAfter(res, upstream);
    if (body.includes(key) || !isJsonObject(body)) {
      const fixed = failure
        ? fixedErrorFor(status)
        : { status: 502, code: "UPSTREAM_INVALID_RESPONSE", message: "Granola returned an unreadable response" };
      respondError(res, fixed.status, fixed.code, fixed.message);
      logGranolaProxy(`op=${op} result=body_replaced status=${status}`);
      return;
    }
    res.status(status).type("application/json").send(body);
    logGranolaProxy(`op=${op} result=ok status=${status}`);
  } catch (error) {
    answerUpstreamFailure(res, op, "read_failed", "Failed to read the Granola response", error);
  }
}

export function createGranolaProxyRouter(options: GranolaProxyOptions = {}): Router {
  const router = Router();

  /** Only GET is served; HEAD, OPTIONS and every other method are 404. */
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET") return next();
    respondError(res, 404, "NOT_FOUND", "Not found");
  });

  /** `GET /v1/notes` — newest-first listing; the sync's incremental `updated_after` rides the query. */
  router.get("/v1/notes", async (req: Request, res: Response) => {
    const params = checkedQuery(req, res, LIST_QUERY_PARAMS);
    if (params === null) return;
    await relayGranola(req, res, options, "list", "/v1/notes", params);
  });

  /** `GET /v1/notes/:id` — the note detail (summary, attendees, calendar event, metadata). */
  router.get("/v1/notes/:id", async (req: Request, res: Response) => {
    if (!NOTE_ID_PATTERN.test(req.params.id)) {
      respondError(res, 404, "NOTE_NOT_FOUND", "Unknown note id");
      return;
    }
    const params = checkedQuery(req, res, GET_NOTE_QUERY_PARAMS);
    if (params === null) return;
    if (params.has("include") && params.get("include") !== "transcript") {
      respondError(res, 400, "VALIDATION_ERROR", "include must be 'transcript'");
      return;
    }
    await relayGranola(req, res, options, "get", `/v1/notes/${req.params.id}`, params);
  });

  /** `GET /v1/notes/:id/transcript` — cursor-paged transcript, page_size up to 100. */
  router.get("/v1/notes/:id/transcript", async (req: Request, res: Response) => {
    if (!NOTE_ID_PATTERN.test(req.params.id)) {
      respondError(res, 404, "NOTE_NOT_FOUND", "Unknown note id");
      return;
    }
    const params = checkedQuery(req, res, TRANSCRIPT_QUERY_PARAMS);
    if (params === null) return;
    const pageSize = params.get("page_size");
    if (pageSize !== null && !/^(?:[1-9]\d?|100)$/.test(pageSize)) {
      respondError(res, 400, "VALIDATION_ERROR", "Transcript page_size must be an integer from 1 to 100");
      return;
    }
    await relayGranola(req, res, options, "transcript", `/v1/notes/${req.params.id}/transcript`, params);
  });

  return router;
}
