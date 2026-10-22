import { Router, json, type ErrorRequestHandler, type RequestHandler } from "express";
import { EXO_UNAVAILABLE_BODY, handleWake, type ExoMailboxPorts } from "../exo/mailbox.js";

/**
 * `POST /api/exo/v1/requests`. Order: IP limiter, strict JSON (1 KB), owner limiter, handler.
 * Every pre-verification refusal, including a malformed body, is the uniform 409.
 */
export function createExoMailboxRouter(
  ports: ExoMailboxPorts,
  limiters: { ip: RequestHandler; owner: RequestHandler },
): Router {
  const router = Router();
  router.post(
    "/requests",
    limiters.ip,
    json({ limit: "1kb", strict: true }),
    limiters.owner,
    async (req, res, next) => {
      try {
        const result = await handleWake(ports, req.body);
        // Every 429 carries Retry-After in seconds: the same value as the body's retryAfterSec.
        if (result.status === 429) res.setHeader("Retry-After", String(result.body.retryAfterSec));
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    },
  );
  const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
    const type = (err as { type?: unknown } | undefined)?.type;
    if (typeof type === "string" && type.startsWith("entity.")) {
      res.status(409).json({ ...EXO_UNAVAILABLE_BODY });
      return;
    }
    next(err);
  };
  router.use(bodyErrors);
  return router;
}
