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

/**
 * `POST /api/exo/v1/requests`. Order: IP limiter, strict JSON (1 KB) and wake shape, verification, owner limiter, start.
 * A malformed request (body the parser rejects, wrong shape, bad DID or request id) is the uniform 409 before any
 * lookup. Every outcome after that is the same 202 `{"status":"accepted"}`: found, started, replayed, coalesced,
 * refused, rate limited, unknown owner, or a failure at any step. The outcome lives in the job record.
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
  router.post("/requests", limiters.ip, strictBody, verify, limiters.owner, async (_req, res) => {
    try {
      await startWake(ports, res.locals.exoWake as VerifiedWake, res.locals.exoOwnerLimited === true);
    } catch {
      console.error("[exo] wake not recorded");
    }
    answer(res, 202, EXO_ACCEPTED_BODY);
  });
  // Any error not caught above keeps the same answers: 202 once the wake is verified, the uniform 409 before that.
  router.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[exo] wake route error");
    if (res.locals.exoWake) answer(res, 202, EXO_ACCEPTED_BODY);
    else answer(res, 409, EXO_UNAVAILABLE_BODY);
  });
  return router;
}
