/**
 * Transparent NRAS proxy: NVIDIA's Remote Attestation Service (NRAS) blocks
 * browser CORS, so the browser routes its GPU-attestation call through here.
 *
 * This is a thin, forge-proof pass-through: we forward the request body to
 * `${NRAS_BASE_URL}/v3/attest/gpu` and return the upstream response bytes
 * verbatim (status + body). We compute NO verdict server-side — the browser
 * verifies NVIDIA's signature on the returned token itself, so the backend
 * cannot tamper with the result without detection. Auth-protected like the
 * other routes (mounted behind authMiddleware in index.ts).
 *
 * See docs/verifiable-inference-client-plan.md (Architecture: /api/nras-proxy).
 */

import { Router } from "express";
import type { Request, Response } from "express";

const NRAS_URL =
  process.env.NRAS_URL ?? "https://nras.attestation.nvidia.com/v3/attest/gpu";

// NVIDIA's public JWKS (signs the NRAS token). Browser-CORS-blocked just like
// the NRAS POST, so the browser fetches it through this same proxy to verify
// NVIDIA's ES384 signature itself. See docs/verifiable-inference-spike-results.md
// (LEG 2): the proxy must cover BOTH the NRAS POST and the JWKS GET.
const NRAS_JWKS_URL =
  process.env.NRAS_JWKS_URL ?? "https://nras.attestation.nvidia.com/.well-known/jwks.json";

export function createNrasProxyRouter() {
  const router = Router();

  /**
   * POST /
   * Forwards the JSON request body to NRAS and relays the upstream response
   * (status + bytes) verbatim. No server-side verdict.
   */
  router.post("/", async (req: Request, res: Response) => {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(NRAS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
      });
    } catch (error) {
      console.error("[nras-proxy] failed to reach NRAS:", error);
      res.status(502).json({ error: "upstream_error", message: "Failed to reach NRAS" });
      return;
    }

    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.type(contentType);
    res.status(upstream.status).send(body);
  });

  /**
   * GET /jwks
   * Relays NVIDIA's public JWKS verbatim so the browser can verify the NRAS
   * token's ES384 signature locally. Forge-proof: the key set is NVIDIA's
   * public material; the browser checks the signature against it itself.
   */
  router.get("/jwks", async (_req: Request, res: Response) => {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(NRAS_JWKS_URL, { method: "GET" });
    } catch (error) {
      console.error("[nras-proxy] failed to reach NRAS JWKS:", error);
      res.status(502).json({ error: "upstream_error", message: "Failed to reach NRAS JWKS" });
      return;
    }

    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.type(contentType);
    res.status(upstream.status).send(body);
  });

  return router;
}
