/**
 * Transparent signature passthrough: the browser verifies each reply itself by
 * ECDSA-recovering the per-message signature against the attested signing key,
 * but RedPill's `GET /v1/signature/{id}` requires the server-held API key (which
 * must never reach the browser). So the browser routes the call through here.
 *
 * This is a thin, forge-proof pass-through: we forward to
 * `${REDPILL_BASE_URL}/signature/{id}?model=...` with REDPILL_API_KEY and relay
 * the upstream response (status + bytes) verbatim. We compute NO verdict
 * server-side — the browser does the ECDSA recovery, so the backend cannot
 * tamper with the result without detection. Auth-protected like the other
 * routes (mounted behind authMiddleware in index.ts).
 *
 * See docs/verifiable-inference-client-plan.md (Architecture: /api/signature/:id).
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { relayUpstream } from "./relay.js";

const REDPILL_BASE_URL = process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1";

export function createSignatureRouter() {
  const router = Router();

  /**
   * GET /:id?model=...
   * Forwards to RedPill `GET /v1/signature/{id}` with the server-held API key
   * and relays the upstream response (status + bytes) verbatim. No server-side
   * verdict — the browser verifies the signature.
   */
  router.get("/:id", async (req: Request, res: Response) => {
    const apiKey = process.env.REDPILL_API_KEY;
    if (!apiKey) {
      res
        .status(500)
        .json({ error: "no_api_key", message: "REDPILL_API_KEY is not configured on this server." });
      return;
    }

    const id = req.params.id;
    const model = typeof req.query.model === "string" ? req.query.model : "";
    const url =
      `${REDPILL_BASE_URL}/signature/${encodeURIComponent(id)}` +
      `?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;

    await relayUpstream(
      res,
      url,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      "signature service",
    );
  });

  return router;
}
