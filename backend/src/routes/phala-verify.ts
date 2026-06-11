/**
 * Transparent Phala TDX-verify proxy: Phala's attestation verifier
 * (`cloud-api.phala.network/.../verify`) blocks browser CORS, so the browser
 * routes its TDX-quote verification call through here.
 *
 * This is a thin, verdict-free pass-through: we forward the request body to
 * `${PHALA_TDX_VERIFIER_URL}` and return the upstream response bytes verbatim
 * (status + body). We compute NO verdict server-side — Phala's verifier (and
 * the browser, which reads its response) does the verification, so the backend
 * cannot fabricate a result. Auth-protected like the other routes (mounted
 * behind authMiddleware in index.ts).
 *
 * See docs/phala-parity-plan.md (Backend: POST /api/phala-verify).
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { relayUpstream } from "./relay.js";

const PHALA_TDX_VERIFIER_URL =
  process.env.PHALA_TDX_VERIFIER_URL ??
  "https://cloud-api.phala.network/api/v1/attestations/verify";

export function createPhalaVerifyRouter() {
  const router = Router();

  /**
   * POST /
   * Forwards the JSON request body to Phala's TDX verifier and relays the
   * upstream response (status + bytes) verbatim. No server-side verdict.
   */
  router.post("/", async (req: Request, res: Response) => {
    await relayUpstream(
      res,
      PHALA_TDX_VERIFIER_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
      },
      "Phala verifier",
    );
  });

  return router;
}
