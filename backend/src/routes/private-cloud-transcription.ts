import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  CAPABILITY_RE,
  MAX_RECORDING_BYTES,
  PUBLIC_ERRORS,
  PtxTransportError,
  TRANSCRIPTION_ID_RE,
  TRANSCRIPTION_STATUSES,
  UPLOAD_PATH_RE,
  UUID_RE,
  classifyUpstreamError,
  tenantRefFor,
  type PtxClient,
  type PtxRequest,
  type PtxResponse,
  type PublicError,
} from "../services/private-cloud-transcription.js";

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
 * compiled-in PTX origin. Every error is `{ error: { code, message, correlation_id } }` with our
 * own fixed message; upstream text is never relayed. Logs carry route, status, code, class and
 * correlation id only — never the address, tenant_ref, capability or transcript text.
 */

export interface PrivateCloudTranscriptionRouterOptions {
  client: PtxClient;
  tenantKey: string;
  accountAllowed: (address: string) => boolean;
  /** Injectable for tests. `alert` = operator fault. */
  log?: (line: string, alert: boolean) => void;
}

const CONTENT_TYPES: ReadonlySet<string> = new Set(["audio/mpeg", "audio/wav", "audio/ogg"]);
const CHANNEL_MODES: ReadonlySet<string> = new Set(["separate", "mixed"]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const LANGUAGE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/;
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

function isJob(value: unknown, id?: string): value is JsonObject {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    TRANSCRIPTION_ID_RE.test(value.id) &&
    (id === undefined || value.id === id) &&
    typeof value.status === "string" &&
    TRANSCRIPTION_STATUSES.has(value.status)
  );
}

const fail = (code: PublicError["code"]): Outcome => ({ error: { code } });
const badResponse = (response: PtxResponse): Outcome => ({
  error: { code: "upstream_bad_response", upstreamStatus: response.status },
});
const upstreamError = (response: PtxResponse): Outcome => ({
  error: classifyUpstreamError(response.status, response.body, response.retryAfter),
});

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
  if (typeof content_type !== "string" || !CONTENT_TYPES.has(content_type)) return "invalid_request";
  if (typeof byte_size !== "number" || !Number.isSafeInteger(byte_size) || byte_size < 1) return "invalid_request";
  if (byte_size > MAX_RECORDING_BYTES) return "recording_too_large";
  if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) return "invalid_request";
  const body: CreateBody = { content_type, byte_size, sha256 };
  if (language !== undefined) {
    if (typeof language !== "string" || !LANGUAGE_RE.test(language)) return "invalid_request";
    body.language = language;
  }
  if (channel_mode !== undefined) {
    if (typeof channel_mode !== "string" || !CHANNEL_MODES.has(channel_mode)) return "invalid_request";
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

/** PTX create → our create response. Anything off-contract is `upstream_bad_response`. */
function createResponse(response: PtxResponse, requested: CreateBody): Outcome {
  const body = response.body;
  if (!isJob(body) || body.byte_size !== requested.byte_size) return badResponse(response);
  const out: JsonObject = { id: body.id, status: body.status, byte_size: body.byte_size };
  // The capability exists exactly while the job awaits its upload (plan §4.2).
  if ((body.status === "awaiting_upload") !== (body.upload !== undefined)) return badResponse(response);
  if (body.upload !== undefined) {
    const upload = body.upload;
    if (
      !isObject(upload) ||
      typeof upload.path !== "string" ||
      !UPLOAD_PATH_RE.test(upload.path) ||
      upload.path !== `/uploads/${body.id}` ||
      typeof upload.capability !== "string" ||
      !CAPABILITY_RE.test(upload.capability) ||
      typeof upload.expires_at !== "string" ||
      Number.isNaN(Date.parse(upload.expires_at))
    ) {
      return badResponse(response);
    }
    out.upload = { path: upload.path, capability: upload.capability, expires_at: upload.expires_at };
  }
  return { status: response.status, body: out };
}

export function createPrivateCloudTranscriptionRouter(options: PrivateCloudTranscriptionRouterOptions): Router {
  const { client, tenantKey, accountAllowed } = options;
  const log = options.log ?? ((line: string, alert: boolean) => (alert ? console.error(line) : console.log(line)));
  const router = Router();

  // Cohort gate. A non-member leaves this router and gets the app's ordinary 404: exactly what
  // every caller gets while the flag is off, so "dark" and "not in the cohort" look the same.
  router.use((req: Request, res: Response, next: NextFunction) => {
    const address = req.user?.address;
    if (typeof address !== "string" || !accountAllowed(address)) {
      next("router");
      return;
    }
    const incoming = req.get("x-correlation-id");
    const correlationId = incoming !== undefined && UUID_RE.test(incoming) ? incoming.toLowerCase() : randomUUID();
    res.setHeader("X-Correlation-Id", correlationId);
    res.locals.privateCloud = { correlationId, tenantRef: tenantRefFor(tenantKey, address) } satisfies Context;
    next();
  });

  function handle(route: string, fn: (req: Request, ctx: Context) => Promise<Outcome>): RequestHandler {
    return async (req, res, next) => {
      const ctx = res.locals.privateCloud as Context;
      let outcome: Outcome;
      try {
        outcome = await fn(req, ctx);
      } catch (error) {
        if (!(error instanceof PtxTransportError)) {
          next(error);
          return;
        }
        outcome = fail("service_unavailable");
      }
      if ("error" in outcome) {
        const { code, retryAfterSeconds, id, upstreamStatus } = outcome.error;
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

  function ptx(ctx: Context, request: Omit<PtxRequest, "correlationId" | "tenantRef">, tenantScoped = true) {
    return client.request({
      ...request,
      correlationId: ctx.correlationId,
      ...(tenantScoped ? { tenantRef: ctx.tenantRef } : {}),
    });
  }

  /** The `:id` param, or null when it cannot be a transcription id (answered without asking PTX). */
  function jobId(req: Request): string | null {
    const id = req.params.id;
    return typeof id === "string" && TRANSCRIPTION_ID_RE.test(id) ? id : null;
  }

  router.get(
    "/capabilities",
    handle("capabilities", async (_req, ctx) => {
      const response = await ptx(ctx, { method: "GET", path: "/v1/transcriptions/capabilities" }, false);
      if (response.status !== 200) return upstreamError(response);
      if (!isObject(response.body) || typeof response.body.max_bytes !== "number") return badResponse(response);
      return { status: 200, body: response.body };
    }),
  );

  router.post(
    "/transcriptions",
    handle("create", async (req, ctx) => {
      if (!req.is("application/json")) return fail("unsupported_media_type");
      const idempotencyKey = req.get("idempotency-key");
      if (idempotencyKey === undefined || !UUID_RE.test(idempotencyKey)) return fail("invalid_idempotency_key");
      const parsed = parseCreateBody(req.body);
      if (typeof parsed === "string") return fail(parsed);
      const response = await ptx(ctx, {
        method: "POST",
        path: "/v1/transcriptions",
        idempotencyKey: `tc:${idempotencyKey.toLowerCase()}`,
        body: parsed,
      });
      // 201 = new job, 200 = replay of the same Idempotency-Key (lost-response recovery).
      if (response.status !== 201 && response.status !== 200) return upstreamError(response);
      return createResponse(response, parsed);
    }),
  );

  router.get(
    "/transcriptions",
    handle("list", async (req, ctx) => {
      const raw = req.query.limit;
      let limit = DEFAULT_LIST_LIMIT;
      if (raw !== undefined) {
        if (typeof raw !== "string" || !/^\d{1,3}$/.test(raw)) return fail("invalid_request");
        limit = Number(raw);
        if (limit < 1 || limit > MAX_LIST_LIMIT) return fail("invalid_request");
      }
      const response = await ptx(ctx, { method: "GET", path: `/v1/transcriptions?limit=${limit}` });
      if (response.status !== 200) return upstreamError(response);
      const body = response.body;
      if (!isObject(body) || !Array.isArray(body.transcriptions) || !body.transcriptions.every((job) => isJob(job))) {
        return badResponse(response);
      }
      return { status: 200, body: { transcriptions: body.transcriptions } };
    }),
  );

  router.get(
    "/transcriptions/:id",
    handle("get", async (req, ctx) => {
      const id = jobId(req);
      if (id === null) return fail("transcription_not_found");
      const response = await ptx(ctx, { method: "GET", path: `/v1/transcriptions/${id}` });
      if (response.status !== 200) return upstreamError(response);
      if (!isJob(response.body, id)) return badResponse(response);
      return { status: 200, body: response.body };
    }),
  );

  router.get(
    "/transcriptions/:id/result",
    handle("result", async (req, ctx) => {
      const id = jobId(req);
      if (id === null) return fail("transcription_not_found");
      const response = await ptx(ctx, { method: "GET", path: `/v1/transcriptions/${id}/result` });
      const body = response.body;
      if (response.status === 202) {
        if (!isObject(body) || typeof body.status !== "string" || !TRANSCRIPTION_STATUSES.has(body.status)) {
          return badResponse(response);
        }
        return { status: 202, body: { id, status: body.status } };
      }
      if (response.status !== 200) return upstreamError(response);
      if (!isObject(body)) return badResponse(response);
      if (body.status === "failed" || body.status === "cancelled") return { status: 200, body };
      if ((body.status !== undefined && body.status !== "completed") || !Array.isArray(body.segments) || typeof body.text !== "string") {
        return badResponse(response);
      }
      return { status: 200, body };
    }),
  );

  router.post(
    "/transcriptions/:id/cancel",
    handle("cancel", async (req, ctx) => {
      const id = jobId(req);
      if (id === null) return fail("transcription_not_found");
      const response = await ptx(ctx, { method: "POST", path: `/v1/transcriptions/${id}/cancel` });
      if (response.status !== 200) return upstreamError(response);
      if (!isJob(response.body, id)) return badResponse(response);
      return { status: 200, body: { id, status: response.body.status } };
    }),
  );

  router.delete(
    "/transcriptions/:id",
    handle("delete", async (req, ctx) => {
      const id = jobId(req);
      if (id === null) return fail("transcription_not_found");
      const response = await ptx(ctx, { method: "DELETE", path: `/v1/transcriptions/${id}` });
      if (response.status !== 200 && response.status !== 204) return upstreamError(response);
      return { status: 204 };
    }),
  );

  return router;
}
