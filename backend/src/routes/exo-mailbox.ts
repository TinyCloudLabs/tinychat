import { Router, json, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { EXO_ACCEPTED_BODY, EXO_UNAVAILABLE_BODY, parseWakeBody, startWake, verifyWake, type ExoMailboxPorts, type VerifiedWake } from "../exo/mailbox.js";

/** Drops the limiters' draft-7 RateLimit headers so every wake answer carries the same header set. */
function stripRateLimitHeaders(res: Response): void {
  for (const name of res.getHeaderNames()) {
    if (/^(x-)?ratelimit/i.test(name)) res.removeHeader(name);
  }
}

/** Sends one answer. A second send after headers are out is dropped. */
function answer(res: Response, status: number, body: object): void {
  if (res.headersSent) return;
  stripRateLimitHeaders(res);
  res.status(status).json(body);
}

/** Wake starts still running after their reply went out. `drainExoWakes` waits on these. */
const detachedWakes = new Set<Promise<void>>();

/** Resolves once every wake started so far has written its outcome, or has failed and been logged. */
export async function drainExoWakes(): Promise<void> {
  while (detachedWakes.size > 0) await Promise.all([...detachedWakes]);
}

/**
 * `POST /api/exo/v1/requests`. Order: IP limiter, strict JSON (1 KB) and wake shape, verification, owner limiter, start.
 * A malformed request (body the parser rejects, wrong shape, bad DID or request id) is the uniform 409 before any
 * lookup. Every other answer is the same 202 `{"status":"accepted"}`: found, started, replayed, coalesced, refused,
 * rate limited, unknown owner, or an internal error at any step, limiter errors included. The reply is sent before
 * the job record is written; the outcome lives in the job record.
 */
export function createExoMailboxRouter(
  ports: ExoMailboxPorts,
  limiters: { ip: RequestHandler; owner: RequestHandler },
): Router {
  const router = Router();
  const parseBody = json({ limit: "1kb", strict: true });
  const strictBody: RequestHandler = (req, res, next) => {
    parseBody(req, res, (err?: unknown) => {
      const request = err ? undefined : parseWakeBody(req.body);
      if (!request) {
        answer(res, 409, EXO_UNAVAILABLE_BODY);
        return;
      }
      res.locals.exoRequest = request;
      next();
    });
  };
  // Verification runs before the owner limiter, so only verified wakes spend an owner's budget. A refusal is accepted too.
  const verify: RequestHandler = async (_req, res, next) => {
    try {
      const wake = await verifyWake(ports, res.locals.exoRequest);
      if (!wake) {
        answer(res, 202, EXO_ACCEPTED_BODY);
        return;
      }
      res.locals.exoWake = wake;
      next();
    } catch {
      console.error("[exo] wake verification unavailable");
      answer(res, 202, EXO_ACCEPTED_BODY);
    }
  };
  router.post("/requests", limiters.ip, strictBody, verify, limiters.owner, (_req, res) => {
    answer(res, 202, EXO_ACCEPTED_BODY);
    const started = startWake(ports, res.locals.exoWake as VerifiedWake, res.locals.exoOwnerLimited === true).catch(() => {
      console.error("[exo] wake not recorded");
    });
    detachedWakes.add(started);
    void started.then(() => detachedWakes.delete(started));
  });
  // Errors reach here from a limiter or a handler. They get the same 202; the failure is logged without detail.
  router.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[exo] wake route error");
    answer(res, 202, EXO_ACCEPTED_BODY);
  });
  return router;
}
