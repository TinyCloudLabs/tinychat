import { createHmac } from "node:crypto";

import { TRANSCRIPTION_ID_RE } from "./private-cloud-transcription-dto.js";
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

export const PRIVATE_CLOUD_TRANSCRIPTION_MOUNT = "/api/transcriber/private-cloud";
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

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
  // The plan's key separation (§1 #1): the batch key is a NEW `transcriptions:*` key on a different
  // CVM. Reusing the meeting transcriber's key would hand this surface meeting access, and vice versa.
  const meetingKey = env.TRANSCRIPTION_API_KEY?.trim();
  if (meetingKey && apiKey === meetingKey) {
    fail("PRIVATE_CLOUD_TRANSCRIPTION_API_KEY must be a distinct key from TRANSCRIPTION_API_KEY");
  }
  if (meetingKey && tenantKey === meetingKey) {
    fail("PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY must not reuse TRANSCRIPTION_API_KEY");
  }
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
  diarization_unavailable: { status: 400, class: "client", message: "Speaker detection is not available for private cloud transcription." },
  invalid_idempotency_key: { status: 400, class: "client", message: "Idempotency-Key must be a UUID." },
  unsupported_media_type: { status: 415, class: "client", message: "Only application/json is accepted." },
  recording_too_large: { status: 413, class: "client", message: "The recording is larger than the private cloud limit." },
  transcription_not_found: { status: 404, class: "client", message: "No such transcription." },
  transcript_expired: { status: 410, class: "client", message: "The transcript is no longer available." },
  active_transcription_exists: { status: 409, class: "client", message: "A transcription is already in progress." },
  idempotency_conflict: { status: 409, class: "client", message: "This Idempotency-Key was used for a different request." },
  quota_exceeded: { status: 429, class: "transient", message: "Daily private cloud limit reached." },
  service_busy: { status: 429, class: "transient", message: "Private cloud transcription is busy." },
  upload_capability_limit: { status: 429, class: "transient", message: "Too many uploads are open for this transcription." },
  service_paused: { status: 503, class: "transient", message: "Private cloud transcription is paused." },
  service_unavailable: { status: 503, class: "transient", message: "Private cloud transcription is unavailable." },
  upstream_bad_response: { status: 502, class: "transient", message: "Private cloud transcription returned an unexpected response." },
  service_misconfigured: { status: 503, class: "operator_fault", message: "Private cloud transcription is misconfigured." },
} as const satisfies Record<string, { status: number; class: PrivateCloudErrorClass; message: string }>;

export type PublicErrorCode = keyof typeof PUBLIC_ERRORS;

export type PrivateCloudRoute = "capabilities" | "create" | "list" | "get" | "result" | "cancel" | "delete";

/**
 * The ONLY upstream error answers relayed as themselves: exact (HTTP status, code) pairs per route
 * (PTX `SPEC.md` "Errors and correlation"). Anything else is classified by `classifyUpstreamError`,
 * never trusted by its code.
 */
const JOB_READ_ERRORS = [
  [404, "transcription_not_found"],
  [503, "service_unavailable"],
] as const;
export const UPSTREAM_ERROR_CONTRACT: Record<PrivateCloudRoute, readonly (readonly [number, PublicErrorCode])[]> = {
  capabilities: [[503, "service_unavailable"]],
  create: [
    [400, "invalid_request"],
    // `diarize: true` while PTX's diarization stage is not installed or disabled.
    [400, "diarization_unavailable"],
    [413, "recording_too_large"],
    // A replay of an Idempotency-Key whose job was deleted.
    [404, "transcription_not_found"],
    [409, "idempotency_conflict"],
    [409, "active_transcription_exists"],
    [429, "quota_exceeded"],
    [429, "service_busy"],
    // A replay while the job already has its maximum of live upload capabilities.
    [429, "upload_capability_limit"],
    [503, "service_paused"],
    [503, "service_unavailable"],
  ],
  list: [[503, "service_unavailable"]],
  get: JOB_READ_ERRORS,
  result: [...JOB_READ_ERRORS, [410, "transcript_expired"]],
  cancel: JOB_READ_ERRORS,
  delete: JOB_READ_ERRORS,
};

export interface PublicError {
  code: PublicErrorCode;
  retryAfterSeconds?: number;
  /** The already-active job, for `active_transcription_exists`. */
  id?: string;
  upstreamStatus?: number;
  /** Log-only detail for `upstream_bad_response`. */
  reason?: "off_contract" | "body_too_large";
}

function retryAfterSeconds(body: unknown, header: string | null): number | undefined {
  const fromBody = (body as { error?: { retry_after_seconds?: unknown } } | null)?.error?.retry_after_seconds;
  const seconds = typeof fromBody === "number" ? fromBody : header?.trim() ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(3600, Math.max(1, Math.ceil(seconds))) : undefined;
}

/**
 * Map a PTX answer that is not the route's success to one of our codes:
 *  1. an exact (status, code) pair from the route's contract → that code (upstream text dropped);
 *  2. 401/403 (key or scope refused), 3xx, 404/405 outside the contract (route missing: wrong URL,
 *     P2 not deployed) → `service_misconfigured`, an operator fault;
 *  3. 5xx with no code or PTX's own `internal_error` (gateway/infra failure) → `service_unavailable`;
 *  4. everything else — an impossible pairing like `400 service_paused`, an unexpected 2xx or 4xx,
 *     `active_transcription_exists` without a valid job id — → `upstream_bad_response`.
 */
export function classifyUpstreamError(
  route: PrivateCloudRoute,
  status: number,
  body: unknown,
  retryAfterHeader: string | null,
): PublicError {
  const error = (body as { error?: { code?: unknown; id?: unknown } } | null | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : null;
  const base = { upstreamStatus: status };
  const listed = UPSTREAM_ERROR_CONTRACT[route].find(([s, c]) => s === status && c === code);
  if (listed) {
    const relayed: PublicError = { ...base, code: listed[1] };
    if (relayed.code === "active_transcription_exists") {
      if (typeof error?.id !== "string" || !TRANSCRIPTION_ID_RE.test(error.id)) {
        return { ...base, code: "upstream_bad_response", reason: "off_contract" };
      }
      relayed.id = error.id;
    }
    if (status === 429 || status === 503) {
      const after = retryAfterSeconds(body, retryAfterHeader);
      if (after !== undefined) relayed.retryAfterSeconds = after;
    }
    return relayed;
  }
  if (status === 401 || status === 403 || status === 404 || status === 405 || (status >= 300 && status < 400)) {
    return { ...base, code: "service_misconfigured" };
  }
  if (status >= 500 && (code === null || code === "internal_error")) return { ...base, code: "service_unavailable" };
  return { ...base, code: "upstream_bad_response", reason: "off_contract" };
}

// ── PTX client ───────────────────────────────────────────────────────

/** Most a response body may be, per route: metadata is small; a result is transcript-sized. */
export const RESPONSE_LIMITS: Record<PrivateCloudRoute, number> = {
  capabilities: 64 * 1024,
  create: 64 * 1024,
  list: 256 * 1024,
  get: 64 * 1024,
  result: 4 * 1024 * 1024,
  cancel: 64 * 1024,
  delete: 64 * 1024,
};

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

/** The response body was larger than the route allows; it was not read past the limit. */
export class PtxResponseTooLargeError extends Error {
  constructor(public readonly status: number) {
    super("PTX response body over the route limit");
    this.name = "PtxResponseTooLargeError";
  }
}

export interface PtxRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  correlationId: string;
  maxBytes: number;
  tenantRef?: string;
  idempotencyKey?: string;
  body?: unknown;
}

export interface PtxClient {
  request(request: PtxRequest): Promise<PtxResponse>;
}

/** Read at most `maxBytes` of the body: refuse on a larger Content-Length, else stop mid-stream. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel();
    throw new PtxResponseTooLargeError(response.status);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PtxResponseTooLargeError(response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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
    async request({ method, path, correlationId, maxBytes, tenantRef, idempotencyKey, body }) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        "X-Correlation-Id": correlationId,
      };
      if (tenantRef !== undefined) headers["X-Tenant-Ref"] = tenantRef;
      if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      let response: Response;
      let bytes: Uint8Array;
      try {
        response = await fetchImpl(`${config.baseUrl}${path}`, {
          method,
          headers,
          // A redirect is a misconfiguration; never follow it with the key attached.
          redirect: "manual",
          // Covers connecting AND reading the body.
          signal: AbortSignal.timeout(timeoutMs),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        bytes = await readCapped(response, maxBytes);
      } catch (error) {
        if (error instanceof PtxResponseTooLargeError) throw error;
        throw new PtxTransportError(error instanceof Error ? error.name : "unknown");
      }
      let parsed: unknown = undefined;
      if (bytes.byteLength > 0) {
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          parsed = undefined;
        }
      }
      return { status: response.status, body: parsed, retryAfter: response.headers.get("retry-after") };
    },
  };
}

// ── OpenAPI ──────────────────────────────────────────────────────────

/** The served spec while dark: no private-cloud path or `PrivateCloud*` component is advertised. */
export function withoutPrivateCloudOpenApi<T extends object>(spec: T): T {
  const copy = structuredClone(spec) as T & {
    paths?: Record<string, unknown>;
    components?: Record<string, Record<string, unknown> | undefined>;
  };
  for (const path of Object.keys(copy.paths ?? {})) {
    if (path === PRIVATE_CLOUD_TRANSCRIPTION_MOUNT || path.startsWith(`${PRIVATE_CLOUD_TRANSCRIPTION_MOUNT}/`)) {
      delete copy.paths![path];
    }
  }
  for (const section of Object.values(copy.components ?? {})) {
    for (const name of Object.keys(section ?? {})) {
      if (name.startsWith("PrivateCloud")) delete section![name];
    }
  }
  return copy;
}
