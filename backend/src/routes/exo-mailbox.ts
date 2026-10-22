import { Router, json, type RequestHandler, type Response } from "express";
import { EXO_UNAVAILABLE_BODY, handleWake, type ExoMailboxPorts } from "../exo/mailbox.js";

/** Drops the limiters' draft-7 RateLimit headers so every non-429 wake response has one header set. */
function stripRateLimitHeaders(res: Response): void {
  for (const name of res.getHeaderNames()) {
    if (/^(x-)?ratelimit/i.test(name)) res.removeHeader(name);
  }
}

/**
 * `POST /api/exo/v1/requests`. Order: IP limiter, strict JSON (1 KB), owner limiter, handler.
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
  router.post("/requests", limiters.ip, strictBody, limiters.owner, async (req, res, next) => {
    try {
      const result = await handleWake(ports, req.body);
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
