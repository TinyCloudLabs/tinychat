import { Router, json, type RequestHandler, type Response } from "express";
import { EXO_UNAVAILABLE_BODY, startWake, verifyWake, type ExoMailboxPorts, type VerifiedWake } from "../exo/mailbox.js";

/** Drops the limiters' draft-7 RateLimit headers so every non-429 wake response has one header set. */
function stripRateLimitHeaders(res: Response): void {
  for (const name of res.getHeaderNames()) {
    if (/^(x-)?ratelimit/i.test(name)) res.removeHeader(name);
  }
}

/**
 * `POST /api/exo/v1/requests`. Order: IP limiter, strict JSON (1 KB), verification, owner limiter, start.
 * Every refusal before verification, including a body the parser rejects (size, charset,
 * encoding, syntax), is the same 409 with the same headers and body.
 */
export function createExoMailboxRouter(
  ports: ExoMailboxPorts,
  limiters: { ip: RequestHandler; owner: RequestHandler },
): Router {
  const router = Router();
  const parseBody = json({ limit: "1kb", strict: true });
  const strictBody: RequestHandler = (req, res, next) => {
    parseBody(req, res, (err?: unknown) => {
      if (err) {
        stripRateLimitHeaders(res);
        res.status(409).json({ ...EXO_UNAVAILABLE_BODY });
        return;
      }
      next();
    });
  };
  // Verification runs before the owner limiter, so only verified wakes spend an owner's budget.
  const verify: RequestHandler = async (req, res, next) => {
    try {
      const wake = await verifyWake(ports, req.body);
      if (!wake) {
        stripRateLimitHeaders(res);
        res.status(409).json({ ...EXO_UNAVAILABLE_BODY });
        return;
      }
      res.locals.exoWake = wake;
      next();
    } catch (error) {
      next(error);
    }
  };
  router.post("/requests", limiters.ip, strictBody, verify, limiters.owner, async (_req, res, next) => {
    try {
      const result = await startWake(ports, res.locals.exoWake as VerifiedWake);
      // Every 429 carries Retry-After in seconds: the same value as the body's retryAfterSec.
      if (result.status === 429) res.setHeader("Retry-After", String(result.body.retryAfterSec));
      else stripRateLimitHeaders(res);
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
