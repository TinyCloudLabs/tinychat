import { Router } from "express";
import type { Request, Response } from "express";
import { issueSessionToken, verifySIWE, type NonceStore } from "@tinyboilerplate/server";

interface AuthRoutesConfig {
  nonceStore: NonceStore;
  privateKey: string;
}

export function createAuthRouter(config: AuthRoutesConfig) {
  const router = Router();

  router.get("/nonce", (req: Request, res: Response) => {
    const address = req.query.address;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      res.status(400).json({ error: "invalid_address", message: "A valid address is required" });
      return;
    }
    res.json({ nonce: config.nonceStore.generate(address) });
  });

  router.post("/verify", async (req: Request, res: Response) => {
    const { message, signature } = req.body;
    if (typeof message !== "string" || typeof signature !== "string") {
      res
        .status(400)
        .json({ error: "invalid_request", message: "Message and signature are required" });
      return;
    }

    try {
      const { address, nonce } = await verifySIWE(message, signature);
      if (!config.nonceStore.validate(address, nonce)) {
        res
          .status(401)
          .json({ error: "invalid_nonce", message: "Nonce is invalid, expired, or already used" });
        return;
      }
      const { token, expiresIn } = await issueSessionToken(address, config.privateKey);
      res.json({ token, expiresIn, address: address.toLowerCase() });
    } catch (error) {
      console.error("[auth] verification failed:", error);
      res
        .status(401)
        .json({ error: "verification_failed", message: "SIWE signature verification failed" });
    }
  });

  return router;
}
