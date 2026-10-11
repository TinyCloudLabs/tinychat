import { Router, raw } from "express";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { PTX_SIGNATURE_HEADER, verifyHmacSha256Signature } from "../services/webhook-verify.js";
import type { TranscriptDeliveryWorker } from "../services/transcript-delivery.js";

const MEETING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Mount ahead of JSON and CSRF middleware: signatures cover the exact received bytes. */
export function createTranscriberWebhookRouter(worker: Pick<TranscriptDeliveryWorker, "wake">, secret?: string): Router {
  const router = Router();
  router.use(rateLimit({ windowMs: 60_000, limit: 600, keyGenerator: () => "global", standardHeaders: "draft-7", legacyHeaders: false }));
  router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));
  router.post("/", (req: Request, res: Response, next: NextFunction) => {
    if (!req.is("application/json")) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    next();
  }, raw({ type: "application/json", limit: "16kb", inflate: false }), async (req: Request, res: Response) => {
    if (secret && !verifyHmacSha256Signature(req.body, req.headers[PTX_SIGNATURE_HEADER], secret)) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const data = event && typeof event === "object" && "data" in event ? event.data : undefined;
    const metadata = data && typeof data === "object" && "metadata" in data ? data.metadata : undefined;
    const type = event && typeof event === "object" && "type" in event ? event.type : undefined;
    const id = data && typeof data === "object" && "meeting_id" in data ? data.meeting_id : undefined;
    const address = metadata && typeof metadata === "object" && "tinychat_address" in metadata
      ? metadata.tinychat_address : undefined;
    if ((type !== "meeting.completed" && type !== "meeting.failed") || typeof id !== "string" || !MEETING_ID_RE.test(id)
      || typeof address !== "string" || !ADDRESS_RE.test(address)) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    if (type === "meeting.completed") {
      // ptx treats any 2xx as delivered and never retries it. A wake that was not recorded (a full
      // queue, a stopping worker, an unreadable index or state) answers retryably, so ptx's retry
      // schedule delivers it again; an ignored (unowned, shared, unknown) id still gets 202.
      const result = await worker.wake(address.toLowerCase(), id, "completed").catch(() => {
        console.warn("[transcript-delivery] op=wake result=error");
        return "dropped" as const;
      });
      if (result === "dropped") {
        console.warn("[transcript-delivery] op=wake result=not_recorded");
        res.setHeader("Retry-After", "60");
        res.status(503).json({ error: "wake_not_recorded" });
        return;
      }
    }
    res.status(202).end();
  }, ((error, _req, res, _next) => {
    const tooLarge = error !== null && typeof error === "object" && "type" in error && error.type === "entity.too.large";
    res.status(tooLarge ? 413 : 400).json({ error: "invalid_body" });
  }) satisfies ErrorRequestHandler);
  return router;
}
