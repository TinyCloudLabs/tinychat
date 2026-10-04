import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  PUBLIC_ERRORS,
  PtxResponseTooLargeError,
  PtxTransportError,
  RESPONSE_LIMITS,
  UUID_RE,
  classifyUpstreamError,
  tenantRefFor,
  type PrivateCloudRoute,
  type PtxClient,
  type PtxRequest,
  type PtxResponse,
  type PublicError,
} from "../services/private-cloud-transcription.js";
import {
  CHANNEL_MODES,
  CONTENT_TYPES,
  LANGUAGE_RE,
  MAX_RECORDING_BYTES,
  TRANSCRIPTION_ID_RE,
  parseCancelled,
  parseCapabilities,
  parseCreated,
  parseJob,
  parseJobList,
  parseResult,
  parseResultPending,
} from "../services/private-cloud-transcription-dto.js";

/**
 * Exo private cloud transcription (plan §4.4 P4). Mounted at `/api/transcriber/private-cloud`
 * behind `authMiddleware` ONLY when `PRIVATE_CLOUD_TRANSCRIPTION_ENABLED=true`; otherwise every
 * path 404s. Global CSRF (`X-Requested-With`) and the `/api/transcriber` rate-limit bucket apply.
 *
 *   GET    /capabilities                 PTX limits + admission mode
 *   POST   /transcriptions               { content_type, byte_size, sha256, language?, channel_mode?,
 *                                          channel_labels? } + Idempotency-Key (UUID)
 *                                         → { id, status, byte_size, upload?: { path, capability, expires_at } }
 *   GET    /transcriptions?limit=        the caller's jobs (resume after relaunch)
 *   GET    /transcriptions/:id           status
 *   GET    /transcriptions/:id/result    202 { id, status } | 200 result
 *   POST   /transcriptions/:id/cancel
 *   DELETE /transcriptions/:id           → 204
 *
 * No route accepts audio: create is JSON-only metadata, and the upload goes from Exo straight to
 * PTX. `upload.path` is relative and pinned to `/uploads/<id>`; the desktop joins it to its
 * compiled-in PTX origin. Every success body is rebuilt field by field (services/…-dto.ts) and
 * every response here is `Cache-Control: no-store`. Every error is
 * `{ error: { code, message, correlation_id } }` with our own fixed message; upstream text is never
 * relayed. Logs carry route, status, code, class and correlation id only — never the address,
 * tenant_ref, capability or transcript text.
 *
 * Documented exception to the error shape: 401 (session auth) and 403 `csrf_rejected` are answered
 * by the backend-wide middleware in front of this mount, before the caller is known, with the
 * backend-wide `{ error, message }` shape and no correlation id — the same answer every other
 * authenticated route gives, and the same whether this feature is armed or not.
 */

export interface PrivateCloudTranscriptionRouterOptions {
  client: PtxClient;
  tenantKey: string;
  accountAllowed: (address: string) => boolean;
  /** Injectable for tests. `alert` = operator fault. */
  log?: (line: string, alert: boolean) => void;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_CHANNEL_LABEL_LENGTH = 64;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

interface Context {
  correlationId: string;
  tenantRef: string;
}

type Outcome = { status: number; body?: unknown } | { error: PublicError };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const fail = (code: PublicError["code"]): Outcome => ({ error: { code } });

type CreateBody = {
  content_type: string;
  byte_size: number;
  sha256: string;
  language?: string;
  channel_mode?: string;
  channel_labels?: string[];
};

/** Build the forwarded body field by field, so nothing but these reaches PTX. */
function parseCreateBody(raw: unknown): CreateBody | PublicError["code"] {
  if (!isObject(raw)) return "invalid_request";
  const { content_type, byte_size, sha256, language, channel_mode, channel_labels } = raw;
  if (typeof content_type !== "string" || !CONTENT_TYPES.includes(content_type)) return "invalid_request";
  if (typeof byte_size !== "number" || !Number.isSafeInteger(byte_size) || byte_size < 1) return "invalid_request";
  if (byte_size > MAX_RECORDING_BYTES) return "recording_too_large";
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return "invalid_request";
  const body: CreateBody = { content_type, byte_size, sha256 };
  if (language !== undefined) {
    if (typeof language !== "string" || !LANGUAGE_RE.test(language)) return "invalid_request";
    body.language = language;
  }
  if (channel_mode !== undefined) {
    if (typeof channel_mode !== "string" || !(CHANNEL_MODES as readonly string[]).includes(channel_mode)) return "invalid_request";
    body.channel_mode = channel_mode;
  }
  if (channel_labels !== undefined) {
    if (
      !Array.isArray(channel_labels) ||
      channel_labels.length < 1 ||
      channel_labels.length > 2 ||
      !channel_labels.every(
        (label) => typeof label === "string" && label.trim().length > 0 && label.length <= MAX_CHANNEL_LABEL_LENGTH,
      )
    ) {
      return "invalid_request";
    }
    body.channel_labels = channel_labels as string[];
  }
  return body;
}

export function createPrivateCloudTranscriptionRouter(options: PrivateCloudTranscriptionRouterOptions): Router {
  const { client, tenantKey, accountAllowed } = options;
  const log = options.log ?? ((line: string, alert: boolean) => (alert ? console.error(line) : console.log(line)));
  const router = Router();

  // Cohort gate. A non-member leaves this router and gets the app's ordinary 404: exactly what
  // every caller gets while the flag is off, so "dark" and "not in the cohort" look the same
  // (which is why nothing — not even Cache-Control — is set before this check).
  router.use((req: Request, res: Response, next: NextFunction) => {
    const address = req.user?.address;
    if (typeof address !== "string" || !accountAllowed(address)) {
      next("router");
      return;
    }
    const incoming = req.get("x-correlation-id");
    const correlationId = incoming !== undefined && UUID_RE.test(incoming) ? incoming.toLowerCase() : randomUUID();
    res.setHeader("X-Correlation-Id", correlationId);
    // Capabilities, job metadata and transcript text must not outlive upstream deletion in a cache.
    res.setHeader("Cache-Control", "no-store");
    res.locals.privateCloud = { correlationId, tenantRef: tenantRefFor(tenantKey, address) } satisfies Context;
    next();
  });

  /**
   * One route: `call` asks PTX (bounded read), then a non-success answer is classified against the
   * route's error contract and a success is rebuilt by its DTO (`rebuilt`; null = off-contract).
   */
  function handle(
    route: PrivateCloudRoute,
    fn: (req: Request, call: (request: Omit<PtxRequest, "correlationId" | "tenantRef" | "maxBytes">, tenantScoped?: boolean) => Promise<PtxResponse>) => Promise<Outcome>,
  ): RequestHandler {
    return async (req, res, next) => {
      const ctx = res.locals.privateCloud as Context;
      const call = (request: Omit<PtxRequest, "correlationId" | "tenantRef" | "maxBytes">, tenantScoped = true) =>
        client.request({
          ...request,
          correlationId: ctx.correlationId,
          maxBytes: RESPONSE_LIMITS[route],
          ...(tenantScoped ? { tenantRef: ctx.tenantRef } : {}),
        });
      let outcome: Outcome;
      try {
        outcome = await fn(req, call);
      } catch (error) {
        if (error instanceof PtxTransportError) outcome = fail("service_unavailable");
        else if (error instanceof PtxResponseTooLargeError) {
          outcome = { error: { code: "upstream_bad_response", upstreamStatus: error.status, reason: "body_too_large" } };
        } else {
          next(error);
          return;
        }
      }
      if ("error" in outcome) {
        const { code, retryAfterSeconds, id, upstreamStatus, reason } = outcome.error;
        const spec = PUBLIC_ERRORS[code];
        const alert = spec.class === "operator_fault";
        if (retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(spec.status).json({
          error: {
            code,
            message: spec.message,
            correlation_id: ctx.correlationId,
            ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
            ...(id !== undefined ? { id } : {}),
          },
        });
        log(
          `[private-cloud] route=${route} status=${spec.status} code=${code} class=${spec.class}` +
            `${upstreamStatus !== undefined ? ` upstream_status=${upstreamStatus}` : ""}` +
            `${reason !== undefined ? ` reason=${reason}` : ""}` +
            ` cid=${ctx.correlationId}${alert ? " alert=true" : ""}`,
          alert,
        );
        return;
      }
      if (outcome.body === undefined) res.status(outcome.status).end();
      else res.status(outcome.status).json(outcome.body);
      // Successful polls are not logged: the desktop polls every ~5 s per job.
      if (req.method !== "GET") log(`[private-cloud] route=${route} status=${outcome.status} cid=${ctx.correlationId}`, false);
    };
  }

  /** A success answer rebuilt by its DTO, or `upstream_bad_response` when off-contract. */
  function rebuilt(status: number, body: unknown, response: PtxResponse): Outcome {
    if (body === null) return { error: { code: "upstream_bad_response", upstreamStatus: response.status, reason: "off_contract" } };
    return { status, body };
  }

  function upstreamError(route: PrivateCloudRoute, response: PtxResponse): Outcome {
    return { error: classifyUpstreamError(route, response.status, response.body, response.retryAfter) };
  }

  /** The `:id` param, or null when it cannot be a transcription id (answered without asking PTX). */
  function jobId(req: Request): string | null {
    const id = req.params.id;
    return typeof id === "string" && TRANSCRIPTION_ID_RE.test(id) ? id : null;
  }

  router.get(
    "/capabilities",
    handle("capabilities", async (_req, call) => {
      const response = await call({ method: "GET", path: "/v1/transcriptions/capabilities" }, false);
      if (response.status !== 200) return upstreamError("capabilities", response);
      return rebuilt(200, parseCapabilities(response.body), response);
    }),
  );

  router.post(
    "/transcriptions",
    handle("create", async (req, call) => {
      if (!req.is("application/json")) return fail("unsupported_media_type");
      const idempotencyKey = req.get("idempotency-key");
      if (idempotencyKey === undefined || !UUID_RE.test(idempotencyKey)) return fail("invalid_idempotency_key");
      const parsed = parseCreateBody(req.body);
      if (typeof parsed === "string") return fail(parsed);
      const response = await call({
        method: "POST",
        path: "/v1/transcriptions",
        idempotencyKey: `tc:${idempotencyKey.toLowerCase()}`,
        body: parsed,
      });
      // 201 = new job, 200 = replay of the same Idempotency-Key (lost-response recovery).
      if (response.status !== 201 && response.status !== 200) return upstreamError("create", response);
      return rebuilt(response.status, parseCreated(response.body, parsed.byte_size), response);
    }),
  );

  router.get(
    "/transcriptions",
    handle("list", async (req, call) => {
      const raw = req.query.limit;
      let limit = DEFAULT_LIST_LIMIT;
      if (raw !== undefined) {
        if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) return fail("invalid_request");
        limit = Number(raw);
        if (limit < 1 || limit > MAX_LIST_LIMIT) return fail("invalid_request");
      }
      const response = await call({ method: "GET", path: `/v1/transcriptions?limit=${limit}` });
      if (response.status !== 200) return upstreamError("list", response);
      return rebuilt(200, parseJobList(response.body, limit), response);
    }),
  );

  router.get(
    "/transcriptions/:id",
    handle("get", async (req, call) => {
      const id = jobId(req);
      if (id === null) return fail("transcription_not_found");
      const response = await call({ method: "GET", path: `/v1/transcriptions/${id}` });
      if (response.status !== 200) return upstreamError("get", response);
      return rebuilt(200, parseJob(response.body, id), response);
    }),
  );

  router.get(
    "/transcriptions/:id/result",
    handle("result", async (req, call) => {
      const id = jobId(req);
      if (id === null) return fail("transcription_not_found");
      const response = await call({ method: "GET", path: `/v1/transcriptions/${id}/result` });
      if (response.status === 202) return rebuilt(202, parseResultPending(response.body, id), response);
      if (response.status !== 200) return upstreamError("result", response);
      return rebuilt(200, parseResult(response.body, id), response);
    }),
  );

  router.post(
    "/transcriptions/:id/cancel",
    handle("cancel", async (req, call) => {
      const id = jobId(req);
      if (id === null) return fail("transcription_not_found");
      const response = await call({ method: "POST", path: `/v1/transcriptions/${id}/cancel` });
      if (response.status !== 200) return upstreamError("cancel", response);
      return rebuilt(200, parseCancelled(response.body, id), response);
    }),
  );

  router.delete(
    "/transcriptions/:id",
    handle("delete", async (req, call) => {
      const id = jobId(req);
      if (id === null) return fail("transcription_not_found");
      const response = await call({ method: "DELETE", path: `/v1/transcriptions/${id}` });
      if (response.status !== 200 && response.status !== 204) return upstreamError("delete", response);
      return { status: 204 };
    }),
  );

  return router;
}
