import { Router, json, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import {
  EXO_ACCEPTED_BODY,
  EXO_UNAVAILABLE_BODY,
  parseWakeBody,
  startWake,
  verifyWake,
  type ExoMailboxPorts,
  type ExoWakeRequest,
} from "../exo/mailbox.js";
import {
  EXO_WAKE_OWNER_LIMIT_PER_MIN,
  EXO_WAKE_OWNER_WINDOW_MS,
  FixedWindowBudget,
  WakeQueue,
} from "../exo/wake-intake.js";
import type { GrantHolderIndex } from "../exo/grant-holders.js";

/** Test seams. Production passes neither. */
export interface ExoWakeOptions {
  queue?: WakeQueue;
  ownerBudget?: FixedWindowBudget;
}

/** Sends one answer. A second send after headers are out is dropped. */
function answer(res: Response, status: number, body: object): void {
  if (res.headersSent) return;
  res.status(status).json(body);
}

/**
 * `POST /api/exo/v1/requests`. A body the strict parser rejects gets the uniform 409 before any lookup. Every other
 * request gets the same 202 `{"status":"accepted"}`, sent before any store read. An owner the holder index does not
 * hold is not queued, so a flood of unknown owners cannot evict a held owner's wake; the index refreshes in the
 * background. Verification, the owner budget, and the job write run afterwards in the wake queue, so the reply cannot
 * depend on store latency or on whether the owner has a grant. The outcome lives in the job record.
 */
export function createExoMailboxRouter(
  ports: ExoMailboxPorts,
  holders: Pick<GrantHolderIndex, "mayHold" | "refreshIfStale">,
  options: ExoWakeOptions = {},
): Router {
  const router = Router();
  const queue = options.queue ?? new WakeQueue();
  const ownerBudget = options.ownerBudget ?? new FixedWindowBudget(EXO_WAKE_OWNER_LIMIT_PER_MIN, EXO_WAKE_OWNER_WINDOW_MS);
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
  router.post("/requests", strictBody, (_req, res) => {
    const request: ExoWakeRequest = res.locals.exoRequest;
    answer(res, 202, EXO_ACCEPTED_BODY);
    if (!holders.mayHold(request.owner)) {
      holders.refreshIfStale();
      return;
    }
    // The parser lowercases the owner, so case variants share one lane. verifyWake and startWake are total.
    queue.offer(request.owner, request.requestId, async () => {
      const wake = await verifyWake(ports, request);
      if (wake) await startWake(ports, wake, ownerBudget);
    });
  });
  // A handler error gets the same 202; the failure is logged without detail.
  router.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[exo] wake route error");
    answer(res, 202, EXO_ACCEPTED_BODY);
  });
  return router;
}
