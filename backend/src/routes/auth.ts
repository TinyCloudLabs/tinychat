import { Router } from "express";
import type { Request, Response } from "express";
import { issueSessionToken, NonceStoreFullError, verifySIWE, type NonceStore } from "@tinyboilerplate/server";
import { isExpectedSiweOrigin } from "../cors-origins.js";
import { hasTinyChatNativeAudience } from "../native-siwe-audience.js";

interface AuthRoutesConfig {
  nonceStore: NonceStore;
  privateKey: string;
  frontendUrl: string;
  nativeSiweDomain?: string;
}

export function createAuthRouter(config: AuthRoutesConfig) {
  const router = Router();
  const webDomain = new URL(config.frontendUrl).hostname;
  const nativeDomain = config.nativeSiweDomain ?? "openkey.so";

  // Without `address` the nonce is unbound (native OpenKey sign-in binds it to
  // the recovered signer at /verify); it stays single-use and short-lived.
  router.get("/nonce", (req: Request, res: Response) => {
    const address = req.query.address;
    if (address !== undefined && (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address))) {
      res.status(400).json({ error: "invalid_address", message: "A valid address is required" });
      return;
    }
    try {
      res.json({ nonce: config.nonceStore.generate(address) });
    } catch (error) {
      if (!(error instanceof NonceStoreFullError)) throw error;
      res.status(429).json({ error: "nonce_capacity", message: "Too many pending sign-ins; try again shortly" });
    }
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
      const { address, nonce, domain, uri, chainId, resources, expirationTime } = await verifySIWE(message, signature);
      if (!isExpectedSiweOrigin(domain, uri, webDomain, nativeDomain) ||
        (uri.startsWith("did:key:") && !hasTinyChatNativeAudience(message, address, chainId, resources))) {
        res.status(400).json({
          error: "invalid_origin", message: "SIWE domain or URI does not match this application",
        });
        return;
      }
      if (!config.nonceStore.validate(address, nonce)) {
        res
          .status(401)
          .json({ error: "invalid_nonce", message: "Nonce is invalid, expired, or already used" });
        return;
      }
      const { token, expiresIn } = await issueSessionToken(address, config.privateKey, {
        notAfter: expirationTime ? new Date(expirationTime) : undefined,
      });
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
