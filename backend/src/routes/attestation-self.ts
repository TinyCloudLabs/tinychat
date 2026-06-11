import { Router } from "express";
import { createDstackClient } from "../attestation/dstackClient.js";
import {
  isDstackUnavailableError,
  selfAttest,
  type DstackClient,
} from "../attestation/selfAttest.js";

const NONCE_RE = /^[0-9a-fA-F]{64}$/;

export function createAttestationSelfRouter(config: {
  privateKey: string;
  did: string;
  dstack?: DstackClient;
}): Router {
  const router = Router();
  const dstack = config.dstack ?? createDstackClient();

  router.get("/", async (req, res) => {
    const nonce = typeof req.query.nonce === "string" ? req.query.nonce : "";
    if (!NONCE_RE.test(nonce)) {
      res.status(400).json({
        error: "invalid_nonce",
        message: "nonce must be 32 bytes encoded as 64 hex characters",
      });
      return;
    }

    try {
      const attestation = await selfAttest({
        privateKey: config.privateKey,
        did: config.did,
        nonce: nonce.toLowerCase(),
        dstack,
      });
      res.json(attestation);
    } catch (error) {
      if (isDstackUnavailableError(error)) {
        res.status(503).json({
          error: "attestation_unavailable",
          message: error.message,
        });
        return;
      }
      console.error("[attestation] self-attestation failed", error);
      res.status(500).json({
        error: "attestation_failed",
        message: "Backend attestation failed",
      });
    }
  });

  return router;
}
