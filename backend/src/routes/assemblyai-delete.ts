import { Router } from "express";
import type { Request, Response } from "express";

/**
 * AssemblyAI delete proxy for Exo uploads (contract C9).
 *
 * Exo transcribes an uploaded recording with AssemblyAI straight from the client, using the
 * user's own key, then deletes the AssemblyAI copy once the meeting is saved. Browsers cannot send
 * that DELETE: AssemblyAI's CORS preflight allows only POST, PUT and GET. So every platform deletes
 * through here:
 *
 *   DELETE /api/transcriber/assemblyai/transcripts/:id    header X-AssemblyAI-Key: <user key>
 *
 * Mounted always (not behind any feature flag), behind `authMiddleware`; the global CSRF check
 * (`X-Requested-With`) and the `/api/transcriber` rate-limit bucket apply. The upstream host is
 * fixed: nothing the caller sends chooses where the request goes. The key is forwarded once and
 * is never logged, stored, cached or echoed; neither is the transcript id. Answers are
 * `Cache-Control: no-store` in the backend-wide `{ error, message }` shape, with our own fixed
 * messages; AssemblyAI's text is never relayed.
 *
 *   204                                AssemblyAI answered 2xx
 *   400 invalid_request                bad id, or missing/empty/malformed key (no upstream call)
 *   404 assemblyai_transcript_not_found  AssemblyAI answered 404, or its 400 "transcript id not
 *                                      found" (see NOT_FOUND_400)
 *   422 assemblyai_key_rejected        AssemblyAI answered 401/403 (never 401: that means
 *                                      "session expired" to the frontend)
 *   429 assemblyai_rate_limited        AssemblyAI answered 429 (numeric Retry-After relayed)
 *   502 assemblyai_unavailable         anything else: 5xx, 3xx, other 4xx, timeout, network error
 *                                      (never with Retry-After: an odd 4xx must not be looped on)
 */

export const ASSEMBLYAI_DELETE_MOUNT = "/api/transcriber/assemblyai";
const ASSEMBLYAI_ORIGIN = "https://api.assemblyai.com";
const TRANSCRIPT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Printable ASCII, no spaces: anything else cannot be a key and would not survive as a header. */
const KEY_RE = /^[\x21-\x7e]{1,256}$/;
const RETRY_AFTER_RE = /^\d{1,6}$/;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Most of an upstream body ever read; only a 400's is, and only to test for NOT_FOUND_400. */
const MAX_ERROR_BODY_BYTES = 4 * 1024;
/**
 * AssemblyAI does not answer 404 for a transcript that does not exist: DELETE (and GET) of an
 * unknown id is `400 {"error": "Transcript lookup error, transcript id not found"}` (observed
 * 2026-10-03). This stable fragment is how a missing transcript is told apart from other 400s.
 * Deleting an already-deleted transcript is a 200.
 */
const NOT_FOUND_400 = "transcript id not found";

export const ASSEMBLYAI_DELETE_ERRORS = {
  invalid_request: { status: 400, message: "The request is invalid." },
  assemblyai_transcript_not_found: { status: 404, message: "AssemblyAI has no such transcript." },
  assemblyai_key_rejected: { status: 422, message: "AssemblyAI rejected the API key." },
  assemblyai_rate_limited: { status: 429, message: "AssemblyAI is rate limiting requests. Try again later." },
  assemblyai_unavailable: { status: 502, message: "AssemblyAI could not be reached." },
} as const;

export type AssemblyAiDeleteErrorCode = keyof typeof ASSEMBLYAI_DELETE_ERRORS;

export interface AssemblyAiDeleteRouterOptions {
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable for tests. Receives route, status and code only. */
  log?: (line: string) => void;
}

/** The first `max` bytes of the body as text, or null when it is longer (then it is not read on). */
async function readCapped(response: globalThis.Response, max: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function classify(status: number, notFound400: boolean): AssemblyAiDeleteErrorCode | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404 || (status === 400 && notFound400)) return "assemblyai_transcript_not_found";
  if (status === 401 || status === 403) return "assemblyai_key_rejected";
  if (status === 429) return "assemblyai_rate_limited";
  return "assemblyai_unavailable";
}

export function createAssemblyAiDeleteRouter(options: AssemblyAiDeleteRouterOptions = {}): Router {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? ((line: string) => console.log(line));
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  function answer(res: Response, code: AssemblyAiDeleteErrorCode | null, retryAfter?: string) {
    if (code === null) {
      res.status(204).end();
      log("[assemblyai-delete] route=delete status=204");
      return;
    }
    const { status, message } = ASSEMBLYAI_DELETE_ERRORS[code];
    if (retryAfter !== undefined) res.setHeader("Retry-After", retryAfter);
    res.status(status).json({ error: code, message });
    log(`[assemblyai-delete] route=delete status=${status} code=${code}`);
  }

  router.delete("/transcripts/:id", async (req: Request, res: Response) => {
    const id = req.params.id;
    const key = req.get("x-assemblyai-key")?.trim() ?? "";
    if (typeof id !== "string" || !TRANSCRIPT_ID_RE.test(id) || !KEY_RE.test(key)) {
      answer(res, "invalid_request");
      return;
    }
    let response: globalThis.Response;
    let notFound400 = false;
    try {
      response = await fetchImpl(`${ASSEMBLYAI_ORIGIN}/v2/transcript/${id}`, {
        method: "DELETE",
        headers: { authorization: key },
        // A redirect is never expected; never follow one with the key attached.
        redirect: "manual",
        // Covers connecting and reading the (capped) body.
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The body is only ever inspected, never relayed; only a 400's is read at all.
      if (response.status === 400) {
        const body = await readCapped(response, MAX_ERROR_BODY_BYTES);
        notFound400 = body !== null && body.toLowerCase().includes(NOT_FOUND_400);
      } else {
        await response.body?.cancel().catch(() => {});
      }
    } catch {
      answer(res, "assemblyai_unavailable");
      return;
    }
    const code = classify(response.status, notFound400);
    const retryAfter = response.headers.get("retry-after")?.trim();
    answer(res, code, code === "assemblyai_rate_limited" && retryAfter && RETRY_AFTER_RE.test(retryAfter) ? retryAfter : undefined);
  });

  return router;
}
