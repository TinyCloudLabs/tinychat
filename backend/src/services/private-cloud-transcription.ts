import { createHmac } from "node:crypto";

import { assertStrongSecret } from "./webhook-tokens.js";

/**
 * Private cloud transcription for Exo desktop (plan: exo-private-cloud-transcription v2, §4.4 P4).
 *
 * TinyChat is a STATELESS authorizer in front of the TinyCloud Private Transcription batch CVM
 * (`ptx-batch`). It decides WHO may use it (dark flag + account allowlist), turns the session
 * address into an HMAC `tenant_ref`, and relays job metadata. It never sees audio: Exo uploads the
 * recording straight to PTX with the job-scoped capability PTX minted, to an origin compiled into
 * the desktop app. TinyChat returns only the RELATIVE upload path, so it cannot steer an upload.
 *
 * PTX is the single authority for tenant ownership, per-tenant admission (one active job, daily
 * byte budget: both enforced atomically in its create transaction) and deletion. TinyChat keeps no
 * index and no reservation, so there is nothing here to race or reconcile.
 *
 * The PTX key (`transcriptions:*` scope) stays in this process. The wallet address never leaves it.
 */

/** 2 h at 128 kbps stereo + 5% (plan D2). */
export const MAX_RECORDING_BYTES = 120_960_000;
export const PRIVATE_CLOUD_TRANSCRIPTION_MOUNT = "/api/transcriber/private-cloud";

export const TRANSCRIPTION_ID_RE = /^trn_[0-9A-HJKMNP-TV-Z]{26}$/;
export const UPLOAD_PATH_RE = /^\/uploads\/trn_[0-9A-HJKMNP-TV-Z]{26}$/;
export const CAPABILITY_RE = /^tcu_[A-Za-z0-9_-]{16,256}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export const TRANSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "awaiting_upload",
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

// ── Config ───────────────────────────────────────────────────────────

export type PrivateCloudTranscriptionConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** PTX origin, e.g. `https://<app_id>-8080.<gateway>`. */
      baseUrl: string;
      apiKey: string;
      tenantKey: string;
      accountAllowed: (address: string) => boolean;
    };

function fail(message: string): never {
  throw new Error(`[startup] FATAL: ${message}`);
}

function parseBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) fail("PRIVATE_CLOUD_TRANSCRIPTION_API_URL is required when PRIVATE_CLOUD_TRANSCRIPTION_ENABLED=true");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("PRIVATE_CLOUD_TRANSCRIPTION_API_URL is not a valid URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("PRIVATE_CLOUD_TRANSCRIPTION_API_URL must be https (http only for loopback)");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    fail("PRIVATE_CLOUD_TRANSCRIPTION_API_URL must be a bare origin (no credentials, path, query or fragment)");
  }
  return url.origin;
}

/** Empty = nobody. `*` (alone) = everyone. Otherwise 0x addresses, case-insensitive. */
function parseAccounts(raw: string | undefined): (address: string) => boolean {
  const entries = (raw ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (entries.includes("*")) {
    if (entries.length !== 1) fail("PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS: `*` must be the only entry");
    return () => true;
  }
  entries.forEach((entry, i) => {
    if (!ADDRESS_RE.test(entry)) fail(`PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS entry ${i + 1} is not an 0x address`);
  });
  const accounts = new Set(entries);
  return (address: string) => accounts.has(address.toLowerCase());
}

/**
 * Unset or `false` = dark: the routes are never mounted. `true` = every other var is validated
 * and a bad one refuses boot. Error messages name variables, never values (public CVM logs).
 */
export function privateCloudTranscriptionConfigFromEnv(
  env: Record<string, string | undefined>,
): PrivateCloudTranscriptionConfig {
  const flag = env.PRIVATE_CLOUD_TRANSCRIPTION_ENABLED?.trim() ?? "";
  if (flag === "" || flag === "false") return { enabled: false };
  if (flag !== "true") fail("PRIVATE_CLOUD_TRANSCRIPTION_ENABLED must be `true` or `false`");

  const baseUrl = parseBaseUrl(env.PRIVATE_CLOUD_TRANSCRIPTION_API_URL);
  const apiKey = env.PRIVATE_CLOUD_TRANSCRIPTION_API_KEY?.trim() ?? "";
  if (!apiKey || /\s/.test(apiKey)) {
    fail("PRIVATE_CLOUD_TRANSCRIPTION_API_KEY is required when PRIVATE_CLOUD_TRANSCRIPTION_ENABLED=true");
  }
  assertStrongSecret("PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY", env.PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY, {
    quiet: true,
  });
  const tenantKey = env.PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY!.trim();
  if (tenantKey === apiKey) fail("PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY must not reuse the API key");
  return { enabled: true, baseUrl, apiKey, tenantKey, accountAllowed: parseAccounts(env.PRIVATE_CLOUD_TRANSCRIPTION_ACCOUNTS) };
}

/** HMAC-SHA256(tenant key, lower(address)), hex. What PTX sees instead of the address. */
export function tenantRefFor(tenantKey: string, address: string): string {
  return createHmac("sha256", tenantKey).update(address.toLowerCase()).digest("hex");
}

// ── Public error codes (plan §4.6) ──────────────────────────────────

/**
 * - `client`: definite for this request; retrying the same request will not help.
 * - `transient`: retry later (polling tolerance, `retry_after_seconds` when known).
 * - `operator_fault`: our configuration is wrong; logged with `alert=true`, never auto-retried.
 */
export type PrivateCloudErrorClass = "client" | "transient" | "operator_fault";

export const PUBLIC_ERRORS = {
  invalid_request: { status: 400, class: "client", message: "The request is invalid." },
  invalid_idempotency_key: { status: 400, class: "client", message: "Idempotency-Key must be a UUID." },
  unsupported_media_type: { status: 415, class: "client", message: "Only application/json is accepted." },
  recording_too_large: { status: 413, class: "client", message: "The recording is larger than the private cloud limit." },
  recording_too_long: { status: 422, class: "client", message: "The recording is longer than the private cloud limit." },
  unsupported_recording: { status: 422, class: "client", message: "This recording format is not supported." },
  invalid_audio: { status: 422, class: "client", message: "The recording could not be read as audio." },
  transcription_not_found: { status: 404, class: "client", message: "No such transcription." },
  active_transcription_exists: { status: 409, class: "client", message: "A transcription is already in progress." },
  idempotency_conflict: { status: 409, class: "client", message: "This Idempotency-Key was used for a different request." },
  quota_exceeded: { status: 429, class: "transient", message: "Daily private cloud limit reached." },
  service_busy: { status: 429, class: "transient", message: "Private cloud transcription is busy." },
  service_paused: { status: 503, class: "transient", message: "Private cloud transcription is paused." },
  service_unavailable: { status: 503, class: "transient", message: "Private cloud transcription is unavailable." },
  upstream_bad_response: { status: 502, class: "transient", message: "Private cloud transcription returned an unexpected response." },
  service_misconfigured: { status: 503, class: "operator_fault", message: "Private cloud transcription is misconfigured." },
} as const satisfies Record<string, { status: number; class: PrivateCloudErrorClass; message: string }>;

export type PublicErrorCode = keyof typeof PUBLIC_ERRORS;

/** Upstream codes relayed as-is (everything else is classified by HTTP status). */
const RELAYED_UPSTREAM_CODES: ReadonlySet<PublicErrorCode> = new Set([
  "invalid_request",
  "unsupported_media_type",
  "recording_too_large",
  "recording_too_long",
  "unsupported_recording",
  "invalid_audio",
  "transcription_not_found",
  "active_transcription_exists",
  "idempotency_conflict",
  "quota_exceeded",
  "service_busy",
  "service_paused",
  "service_unavailable",
]);

export interface PublicError {
  code: PublicErrorCode;
  retryAfterSeconds?: number;
  /** The already-active job, for `active_transcription_exists`. */
  id?: string;
  upstreamStatus?: number;
}

function retryAfterSeconds(body: unknown, header: string | null): number | undefined {
  const fromBody = (body as { error?: { retry_after_seconds?: unknown } } | null)?.error?.retry_after_seconds;
  const seconds = typeof fromBody === "number" ? fromBody : header?.trim() ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(3600, Math.max(1, Math.ceil(seconds))) : undefined;
}

/** Map a non-2xx PTX response to one of our codes. Upstream message text is never relayed. */
export function classifyUpstreamError(status: number, body: unknown, retryAfterHeader: string | null): PublicError {
  const error = (body as { error?: { code?: unknown; id?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : null;
  const base = { upstreamStatus: status };
  // Our key was refused, or PTX answered from a route it does not have / a redirect: the
  // deployment is wrong, not the request. Retrying cannot fix it.
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) return { ...base, code: "service_misconfigured" };
  if (status === 404) {
    return { ...base, code: code === "transcription_not_found" ? "transcription_not_found" : "service_misconfigured" };
  }
  if (code !== null && RELAYED_UPSTREAM_CODES.has(code as PublicErrorCode)) {
    const relayed: PublicError = { ...base, code: code as PublicErrorCode };
    if (relayed.code === "active_transcription_exists" && typeof error?.id === "string" && TRANSCRIPTION_ID_RE.test(error.id)) {
      relayed.id = error.id;
    }
    if (status === 429 || status === 503) {
      const after = retryAfterSeconds(body, retryAfterHeader);
      if (after !== undefined) relayed.retryAfterSeconds = after;
    }
    return relayed;
  }
  if (status === 429) {
    const after = retryAfterSeconds(body, retryAfterHeader);
    return { ...base, code: "service_busy", ...(after !== undefined ? { retryAfterSeconds: after } : {}) };
  }
  if (status >= 500) return { ...base, code: "service_unavailable" };
  // A 4xx we did not expect after our own validation: contract drift between TinyChat and PTX.
  return { ...base, code: "upstream_bad_response" };
}

// ── PTX client ───────────────────────────────────────────────────────

export interface PtxResponse {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

/** The request never produced an HTTP response (DNS, refused, reset, timeout). */
export class PtxTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtxTransportError";
  }
}

export interface PtxRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  correlationId: string;
  tenantRef?: string;
  idempotencyKey?: string;
  body?: unknown;
}

export interface PtxClient {
  request(request: PtxRequest): Promise<PtxResponse>;
}

export function createPtxClient(config: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): PtxClient {
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = config.timeoutMs ?? 15_000;
  return {
    async request({ method, path, correlationId, tenantRef, idempotencyKey, body }) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        "X-Correlation-Id": correlationId,
      };
      if (tenantRef !== undefined) headers["X-Tenant-Ref"] = tenantRef;
      if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(`${config.baseUrl}${path}`, {
          method,
          headers,
          // A redirect is a misconfiguration; never follow it with the key attached.
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        text = await response.text();
      } catch (error) {
        throw new PtxTransportError(error instanceof Error ? error.name : "unknown");
      }
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      return { status: response.status, body: parsed, retryAfter: response.headers.get("retry-after") };
    },
  };
}
