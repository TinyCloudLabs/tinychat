import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import express, { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  ASSEMBLYAI_API,
  ASSEMBLYAI_TRANSCRIPT_ID_RE,
  HOSTED_CONTENT_TYPES,
  HOSTED_PART_SIZE,
  MAX_HOSTED_BYTES,
  SPEECH_MODELS,
  isNotFound400,
  issueHandle,
  openHandle,
  parseJson,
  partLength,
  readCapped,
  rebuildSentences,
  rebuildTranscript,
  TRANSCRIPT_STATUSES,
  type AssemblyAiHostedConfig,
  type HostedUpload,
  type HostedUploadStore,
  type LookupResult,
  type SubmitOutcome,
} from "../services/assemblyai-hosted.js";

/**
 * AssemblyAI under TinyCloud's account ("hosted" mode, contract C10). Mounted always at
 * `/api/transcriber/assemblyai` behind `authMiddleware`; global CSRF applies; the part PUTs have
 * their own rate-limit bucket (rate-limits.ts), everything else is in the /api/transcriber bucket.
 *
 *   GET    /capabilities                                { hosted, max_bytes, part_size, content_types, daily_bytes_remaining }
 *   POST   /hosted/uploads                              { byte_size, content_type } → 201 { upload_id, part_size, expires_at }
 *   PUT    /hosted/uploads/:upload_id/parts/:index      raw ≤1 MiB part → 204
 *   GET    /hosted/uploads/:upload_id                   { status: receiving | submitting } |
 *                                                       { status: "submitted", id: <handle> } |
 *                                                       { status: "failed", error: { code, message } }
 *   DELETE /hosted/uploads/:upload_id                   abandon an unsent upload (refunded) → 204
 *   POST   /hosted/transcripts                          { upload_id, speaker_labels } → 202 { upload_id, status, … }
 *   GET    /hosted/transcripts/:handle                  rebuilt subset of the transcript
 *   GET    /hosted/transcripts/:handle/sentences        { sentences: [{ start, end, text, speaker }] }
 *   DELETE /hosted/transcripts/:handle                  → 204 (also when AssemblyAI no longer has it)
 *
 * Submitting is asynchronous: streaming a 121 MB spool to AssemblyAI can outlast any ingress read
 * timeout, so `POST /hosted/transcripts` only checks the upload is complete, starts the submit in
 * the background (its own 15-minute deadline; aborted by the sweep past it and at shutdown) and
 * answers 202. The client polls `GET /hosted/uploads/:id` for the handle; the outcome stays
 * readable for the upload's hour. The spool is deleted and the slot freed when the submit settles.
 *
 * The server key never leaves this process; the client only ever holds the HMAC handle, which
 * binds the AssemblyAI transcript to the session address (anything else about it → 404). Every
 * answer is `Cache-Control: no-store`, errors are `{ error, message }` with our fixed messages
 * (plus `retry_after_seconds` with a 429), and AssemblyAI's text is never relayed. Logs carry
 * route, status, code, correlation id and byte counts only: never the key, a handle, a transcript
 * id or the address. A key AssemblyAI refuses is OUR fault: 502 to the caller, `alert=true` here.
 */

export const ASSEMBLYAI_HOSTED_MOUNT = "/api/transcriber/assemblyai";
/** The part PUTs, which carry their own rate-limit bucket and skip the global JSON parser. */
export const ASSEMBLYAI_HOSTED_UPLOADS_PATH = `${ASSEMBLYAI_HOSTED_MOUNT}/hosted/uploads`;
const PART_PATH_RE = /^\/api\/transcriber\/assemblyai\/hosted\/uploads\/[^/]+\/parts\/[^/]+\/?$/;

/** The part upload route, whose raw body only its own parser may read. */
export function isHostedPartPath(path: string): boolean {
  return PART_PATH_RE.test(path);
}

export const ASSEMBLYAI_HOSTED_ERRORS = {
  invalid_request: { status: 400, message: "The request is invalid." },
  assemblyai_upload_not_found: { status: 404, message: "No such upload." },
  assemblyai_transcript_not_found: { status: 404, message: "No such transcript." },
  assemblyai_upload_incomplete: { status: 409, message: "Not every part of the recording has arrived." },
  assemblyai_upload_in_progress: { status: 409, message: "This recording has already been sent to AssemblyAI." },
  assemblyai_upload_expired: { status: 410, message: "The upload expired. Upload the recording again." },
  recording_too_large: { status: 413, message: "The recording is larger than the AssemblyAI upload limit." },
  unsupported_audio: { status: 415, message: "This audio format is not supported." },
  assemblyai_quota_exceeded: { status: 429, message: "Today's AssemblyAI allowance for this account is used up." },
  assemblyai_busy: { status: 429, message: "Another upload is in progress. Try again shortly." },
  assemblyai_rate_limited: { status: 429, message: "AssemblyAI is rate limiting requests. Try again later." },
  assemblyai_unavailable: { status: 502, message: "AssemblyAI could not be reached." },
  assemblyai_hosted_unavailable: { status: 503, message: "TinyCloud's AssemblyAI account is not available." },
} as const;

export type AssemblyAiHostedErrorCode = keyof typeof ASSEMBLYAI_HOSTED_ERRORS;

export interface AssemblyAiHostedRouterOptions {
  config: AssemblyAiHostedConfig;
  /** Required when `config.hosted`. */
  store: HostedUploadStore | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** JSON calls to AssemblyAI made inside a client request. */
  timeoutMs?: number;
  now?: () => number;
  /** `alert` = operator fault. */
  log?: (line: string, alert: boolean) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INDEX_RE = /^\d{1,6}$/;
const RETRY_AFTER_RE = /^\d{1,6}$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const SMALL_BODY = 64 * 1024;
/** A two-hour transcript with word timings runs to several MB; sentences carry words too. */
const TRANSCRIPT_BODY = 64 * 1024 * 1024;

interface Failure {
  code: AssemblyAiHostedErrorCode;
  retryAfterSeconds?: number;
  upstreamStatus?: number;
  reason?: string;
  alert?: boolean;
}

/** The request never produced an HTTP response, or its body ran over the cap. */
class UpstreamFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code);
  }
}

interface Locals {
  cid: string;
  route: string;
  address: string;
}

export function createAssemblyAiHostedRouter(options: AssemblyAiHostedRouterOptions): Router {
  const { config, store } = options;
  /** Set exactly when hosted mode is on; every route that uses it sits behind the 503 gate. */
  const hosted = config.hosted ? config : null;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string, alert: boolean) => (alert ? console.error(line) : console.log(line)));
  if (config.hosted && !store) throw new Error("assemblyai hosted router: store is required when hosted");
  const router = Router();

  function locals(res: Response): Locals {
    return res.locals.assemblyAiHosted as Locals;
  }

  function line(res: Response, status: number, extra: string): string {
    const { route, cid } = locals(res);
    return `[assemblyai-hosted] route=${route} status=${status}${extra} cid=${cid}`;
  }

  function ok(res: Response, status: number, body?: unknown, logExtra = ""): void {
    if (body === undefined) res.status(status).end();
    else res.status(status).json(body);
    // Polls and part PUTs are not logged on success: a long upload is ~116 PUTs.
    if (res.req.method === "POST" || res.req.method === "DELETE") log(line(res, status, logExtra), false);
  }

  function fail(res: Response, failure: Failure): void {
    const { status, message } = ASSEMBLYAI_HOSTED_ERRORS[failure.code];
    if (failure.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(failure.retryAfterSeconds));
    res.status(status).json({
      error: failure.code,
      message,
      ...(failure.retryAfterSeconds !== undefined ? { retry_after_seconds: failure.retryAfterSeconds } : {}),
    });
    log(
      line(
        res,
        status,
        ` code=${failure.code}` +
          (failure.upstreamStatus !== undefined ? ` upstream_status=${failure.upstreamStatus}` : "") +
          (failure.reason !== undefined ? ` reason=${failure.reason}` : "") +
          (failure.alert ? " alert=true" : ""),
      ),
      failure.alert === true,
    );
  }

  /** Map an AssemblyAI non-2xx answer (C9 rules; a refused server key is our fault). */
  function upstreamFailure(response: globalThis.Response, body: Uint8Array | null, transcriptRead: boolean): Failure {
    const status = response.status;
    if (transcriptRead && (status === 404 || (status === 400 && isNotFound400(body)))) {
      return { code: "assemblyai_transcript_not_found", upstreamStatus: status };
    }
    if (status === 401 || status === 403) return { code: "assemblyai_unavailable", upstreamStatus: status, reason: "server_key_rejected", alert: true };
    if (status === 429) {
      const after = response.headers.get("retry-after")?.trim();
      return {
        code: "assemblyai_rate_limited",
        upstreamStatus: status,
        ...(after && RETRY_AFTER_RE.test(after) ? { retryAfterSeconds: Number(after) } : {}),
      };
    }
    return { code: "assemblyai_unavailable", upstreamStatus: status };
  }

  /** One AssemblyAI call with the server key; the body read under `maxBytes`. */
  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    maxBytes: number,
    init: { body?: BodyInit; contentType?: string; signal?: AbortSignal } = {},
  ): Promise<{ response: globalThis.Response; bytes: Uint8Array | null }> {
    let response: globalThis.Response;
    let bytes: Uint8Array | null;
    try {
      response = await fetchImpl(`${ASSEMBLYAI_API}${path}`, {
        method,
        headers: { authorization: hosted!.apiKey, ...(init.contentType ? { "content-type": init.contentType } : {}) },
        ...(init.body === undefined ? {} : { body: init.body }),
        // A redirect is never expected; never follow one with the key attached.
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
      bytes = await readCapped(response, maxBytes);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new UpstreamFailure({ code: "assemblyai_unavailable", reason: name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : "transport" });
    }
    if (bytes === null && response.status >= 200 && response.status < 300) {
      throw new UpstreamFailure({ code: "assemblyai_unavailable", upstreamStatus: response.status, reason: "body_too_large" });
    }
    return { response, bytes };
  }

  function handle(route: string, fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return async (req, res, next) => {
      locals(res).route = route;
      try {
        await fn(req, res);
      } catch (error) {
        if (error instanceof UpstreamFailure) fail(res, error.failure);
        else next(error);
      }
    };
  }

  router.use(["/capabilities", "/hosted"], (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get("x-correlation-id");
    const cid = incoming !== undefined && UUID_RE.test(incoming) ? incoming.toLowerCase() : randomUUID();
    res.setHeader("X-Correlation-Id", cid);
    res.setHeader("Cache-Control", "no-store");
    res.locals.assemblyAiHosted = { cid, route: "unknown", address: String(req.user?.address ?? "").toLowerCase() } satisfies Locals;
    next();
  });

  router.get(
    "/capabilities",
    handle("capabilities", async (_req, res) => {
      ok(res, 200, {
        hosted: config.hosted,
        max_bytes: MAX_HOSTED_BYTES,
        part_size: HOSTED_PART_SIZE,
        content_types: HOSTED_CONTENT_TYPES,
        daily_bytes_remaining: config.hosted ? store!.dailyBytesRemaining(locals(res).address, now()) : null,
      });
    }),
  );

  router.use("/hosted", (_req, res, next) => {
    if (!config.hosted) {
      locals(res).route = "hosted";
      fail(res, { code: "assemblyai_hosted_unavailable" });
      return;
    }
    next();
  });

  router.post(
    "/hosted/uploads",
    handle("create_upload", async (req, res) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (!req.is("application/json") || typeof body !== "object" || body === null || Array.isArray(body)) {
        return fail(res, { code: "invalid_request" });
      }
      const { byte_size, content_type } = body;
      if (typeof byte_size !== "number" || !Number.isSafeInteger(byte_size) || byte_size < 1) return fail(res, { code: "invalid_request" });
      if (byte_size > MAX_HOSTED_BYTES) return fail(res, { code: "recording_too_large" });
      if (typeof content_type !== "string" || !HOSTED_CONTENT_TYPES.includes(content_type)) return fail(res, { code: "unsupported_audio" });
      const created = await store!.create(locals(res).address, byte_size, content_type, now());
      if (!created.ok) return fail(res, { code: created.code, retryAfterSeconds: created.retryAfterSeconds });
      ok(
        res,
        201,
        { upload_id: created.upload.id, part_size: HOSTED_PART_SIZE, expires_at: new Date(created.upload.expiresAt).toISOString() },
        ` bytes=${byte_size}`,
      );
    }),
  );

  /** The caller's upload for `:upload_id` while it still takes parts, else answered (404 / 409 / 410). */
  function receivingUpload(res: Response, id: unknown): HostedUpload | null {
    const found = store!.lookup(typeof id === "string" ? id : "", locals(res).address, now());
    if (found.kind === "active" && found.upload.state === "receiving") return found.upload;
    fail(res, {
      code: found.kind === "missing" ? "assemblyai_upload_not_found" : found.kind === "expired" ? "assemblyai_upload_expired" : "assemblyai_upload_in_progress",
    });
    return null;
  }

  /** What the client polls: where its upload is, and the handle once it is submitted. */
  function uploadView(found: LookupResult) {
    if (found.kind === "active") return { status: found.upload.state };
    if (found.kind === "settled" && found.outcome.status === "submitted") return { status: "submitted", id: found.outcome.handle };
    if (found.kind === "settled" && found.outcome.status === "failed") {
      return { status: "failed", error: { code: found.outcome.code, message: ASSEMBLYAI_HOSTED_ERRORS[found.outcome.code].message } };
    }
    return null;
  }

  /** The background submit: stream the spool, create the transcript, mint the handle. */
  async function submit(upload: HostedUpload, speakerLabels: boolean, cid: string, signal: AbortSignal): Promise<SubmitOutcome> {
    const settle = (failure: Failure | null, outcome: SubmitOutcome): SubmitOutcome => {
      const status = failure ? ASSEMBLYAI_HOSTED_ERRORS[failure.code].status : 201;
      log(
        `[assemblyai-hosted] route=submit status=${status}` +
          (failure ? ` code=${failure.code}` : "") +
          (failure?.upstreamStatus !== undefined ? ` upstream_status=${failure.upstreamStatus}` : "") +
          (failure?.reason !== undefined ? ` reason=${failure.reason}` : "") +
          ` bytes=${upload.byteSize} cid=${cid}` +
          (failure?.alert ? " alert=true" : ""),
        failure?.alert === true,
      );
      return outcome;
    };
    const failed = (failure: Failure) =>
      settle(failure, { status: "failed", code: failure.code === "assemblyai_rate_limited" ? "assemblyai_rate_limited" : "assemblyai_unavailable" });
    try {
      // Streamed from disk: the file body is never held in memory.
      const sent = await call("POST", "/v2/upload", SMALL_BODY, {
        body: await openAsBlob(upload.path),
        contentType: "application/octet-stream",
        signal,
      });
      if (sent.response.status !== 200) return failed(upstreamFailure(sent.response, sent.bytes, false));
      const uploaded = parseJson(sent.bytes) as { upload_url?: unknown } | undefined;
      if (typeof uploaded?.upload_url !== "string" || !uploaded.upload_url.startsWith("https://")) {
        return failed({ code: "assemblyai_unavailable", upstreamStatus: 200, reason: "off_contract" });
      }
      const created = await call("POST", "/v2/transcript", SMALL_BODY, {
        body: JSON.stringify({ audio_url: uploaded.upload_url, speaker_labels: speakerLabels, language_detection: true, speech_models: SPEECH_MODELS }),
        contentType: "application/json",
        signal,
      });
      if (created.response.status !== 200 && created.response.status !== 201) {
        const failure = upstreamFailure(created.response, created.bytes, false);
        // A refused create body is a contract drift on our side: alert, like a refused key.
        return failed(created.response.status === 400 ? { ...failure, alert: true, reason: "create_rejected" } : failure);
      }
      const parsed = parseJson(created.bytes) as { id?: unknown; status?: unknown } | undefined;
      if (
        typeof parsed?.id !== "string" ||
        !ASSEMBLYAI_TRANSCRIPT_ID_RE.test(parsed.id) ||
        typeof parsed.status !== "string" ||
        !TRANSCRIPT_STATUSES.includes(parsed.status)
      ) {
        return failed({ code: "assemblyai_unavailable", upstreamStatus: created.response.status, reason: "off_contract" });
      }
      return settle(null, { status: "submitted", handle: issueHandle(hosted!.handleKey, parsed.id, upload.owner, now()) });
    } catch (error) {
      if (error instanceof UpstreamFailure) return failed(error.failure);
      return failed({ code: "assemblyai_unavailable", reason: "internal" });
    }
  }

  const rawPart = express.raw({ type: "application/octet-stream", limit: HOSTED_PART_SIZE });

  router.put(
    "/hosted/uploads/:upload_id/parts/:index",
    // Owner, upload and index are settled before a single body byte is read.
    (req, res, next) => {
      locals(res).route = "put_part";
      const upload = receivingUpload(res, req.params.upload_id);
      if (!upload) return;
      const raw = req.params.index;
      const index = typeof raw === "string" && INDEX_RE.test(raw) ? Number(raw) : -1;
      if (index < 0 || index >= upload.partCount) return fail(res, { code: "invalid_request" });
      res.locals.hostedPart = { upload, index };
      next();
    },
    rawPart,
    handle("put_part", async (req, res) => {
      const { upload, index } = res.locals.hostedPart as { upload: HostedUpload; index: number };
      const bytes = req.body;
      if (!Buffer.isBuffer(bytes) || bytes.byteLength !== partLength(upload.byteSize, index)) return fail(res, { code: "invalid_request" });
      // The upload may have expired or been submitted while its body was arriving.
      if (!receivingUpload(res, upload.id)) return;
      await store!.writePart(upload, index, bytes);
      ok(res, 204);
    }),
  );

  router.get(
    "/hosted/uploads/:upload_id",
    handle("get_upload", async (req, res) => {
      const view = uploadView(store!.lookup(String(req.params.upload_id), locals(res).address, now()));
      if (!view) return fail(res, { code: "assemblyai_upload_not_found" });
      ok(res, 200, view);
    }),
  );

  router.delete(
    "/hosted/uploads/:upload_id",
    handle("delete_upload", async (req, res) => {
      const id = String(req.params.upload_id);
      const found = store!.lookup(id, locals(res).address, now());
      // A settled outcome is the client's to drop; the transcript itself is deleted by handle.
      if (found.kind === "settled") {
        store!.forget(id);
        return ok(res, 204);
      }
      const upload = receivingUpload(res, id);
      if (!upload) return;
      await store!.abandon(upload);
      ok(res, 204);
    }),
  );

  router.post(
    "/hosted/transcripts",
    handle("create_transcript", async (req, res) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (!req.is("application/json") || typeof body !== "object" || body === null || Array.isArray(body) || typeof body.speaker_labels !== "boolean") {
        return fail(res, { code: "invalid_request" });
      }
      const id = typeof body.upload_id === "string" ? body.upload_id : "";
      const found = store!.lookup(id, locals(res).address, now());
      if (found.kind === "missing") return fail(res, { code: "assemblyai_upload_not_found" });
      if (found.kind === "expired") return fail(res, { code: "assemblyai_upload_expired" });
      // Idempotent: a repeat answers where the first one got to.
      if (found.kind === "active" && found.upload.state === "receiving") {
        const upload = found.upload;
        if (!(await store!.complete(upload))) return fail(res, { code: "assemblyai_upload_incomplete" });
        // complete() awaited: a concurrent repeat may have started it meanwhile.
        if (upload.state === "receiving") {
          const speakerLabels = body.speaker_labels;
          const cid = locals(res).cid;
          store!.startSubmit(upload, now, (signal) => submit(upload, speakerLabels, cid, signal));
        }
      }
      ok(res, 202, { upload_id: id, ...uploadView(store!.lookup(id, locals(res).address, now())) }, found.kind === "active" ? ` bytes=${found.upload.byteSize}` : "");
    }),
  );

  /** The transcript id behind `:handle`, or answered 404 without calling AssemblyAI. */
  function transcriptId(req: Request, res: Response): string | null {
    const raw = req.params.handle;
    const id = hosted && typeof raw === "string" ? openHandle(hosted.handleKey, raw, locals(res).address, now()) : null;
    if (id === null) fail(res, { code: "assemblyai_transcript_not_found", reason: "handle_rejected" });
    return id;
  }

  router.get(
    "/hosted/transcripts/:handle",
    handle("get_transcript", async (req, res) => {
      const id = transcriptId(req, res);
      if (id === null) return;
      const { response, bytes } = await call("GET", `/v2/transcript/${id}`, TRANSCRIPT_BODY);
      if (response.status !== 200) return fail(res, upstreamFailure(response, bytes, true));
      const view = rebuildTranscript(parseJson(bytes), req.params.handle as string);
      if (!view) return fail(res, { code: "assemblyai_unavailable", upstreamStatus: 200, reason: "off_contract" });
      ok(res, 200, view);
    }),
  );

  router.get(
    "/hosted/transcripts/:handle/sentences",
    handle("get_sentences", async (req, res) => {
      const id = transcriptId(req, res);
      if (id === null) return;
      const { response, bytes } = await call("GET", `/v2/transcript/${id}/sentences`, TRANSCRIPT_BODY);
      if (response.status !== 200) return fail(res, upstreamFailure(response, bytes, true));
      const view = rebuildSentences(parseJson(bytes));
      if (!view) return fail(res, { code: "assemblyai_unavailable", upstreamStatus: 200, reason: "off_contract" });
      ok(res, 200, view);
    }),
  );

  router.delete(
    "/hosted/transcripts/:handle",
    handle("delete_transcript", async (req, res) => {
      const id = transcriptId(req, res);
      if (id === null) return;
      const { response, bytes } = await call("DELETE", `/v2/transcript/${id}`, SMALL_BODY);
      const gone = response.status === 404 || (response.status === 400 && isNotFound400(bytes));
      if ((response.status >= 200 && response.status < 300) || gone) return ok(res, 204);
      fail(res, upstreamFailure(response, bytes, false));
    }),
  );

  // express.raw's own rejections (over 1 MiB, bad encoding) are a wrong-length part: 400.
  router.use("/hosted", (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const type = (error as { type?: unknown } | null)?.type;
    if ((typeof type === "string" && type.startsWith("entity.")) || (error as { status?: unknown } | null)?.status === 413) {
      locals(res).route = "put_part";
      fail(res, { code: "invalid_request", reason: "part_rejected" });
      return;
    }
    next(error);
  });

  return router;
}
