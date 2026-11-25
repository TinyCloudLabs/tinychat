import { Router } from "express";
import type { Request, Response } from "express";
import { issueSessionToken, verifySIWE, type NonceStore } from "@tinyboilerplate/server";
import { isExpectedSiweOrigin } from "../cors-origins.js";
import { hasTinyChatNativeAudience } from "../native-siwe-audience.js";
import { createVerifyRenewalBudget } from "../rate-limits.js";
import { verifyRenewal, type RenewalVerifyConfig } from "../renewal-verify.js";

interface AuthRoutesConfig {
  nonceStore: NonceStore;
  privateKey: string;
  /** The allowed web origins (`frontendOriginsFromEnv`); each one's hostname is an accepted SIWE domain. */
  frontendOrigins: readonly string[];
  nativeSiweDomain?: string;
  /** Pinned node and renewer for `/verify-renewal`; absent, that route answers 503. */
  renewal?: RenewalVerifyConfig;
  /** Test seam for the node relay. */
  renewalFetch?: typeof fetch;
}

export function createAuthRouter(config: AuthRoutesConfig) {
  const router = Router();
  const webDomains = config.frontendOrigins.map((origin) => new URL(origin).host);
  const nativeDomain = config.nativeSiweDomain ?? "openkey.so";
  const spendRenewalBudget = createVerifyRenewalBudget();

  // Without `address` the nonce is unbound (native OpenKey sign-in binds it to
  // the recovered signer at /verify); it stays single-use and short-lived.
  router.get("/nonce", (req: Request, res: Response) => {
    const address = req.query.address;
    if (address !== undefined && (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address))) {
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
      const { address, nonce, domain, uri, chainId, resources, expirationTime } = await verifySIWE(message, signature);
      if (!isExpectedSiweOrigin(domain, uri, webDomains, nativeDomain)) {
        res.status(400).json({
          error: "invalid_origin", message: "SIWE domain or URI does not match this application",
        });
        return;
      }
      if (domain === nativeDomain && !hasTinyChatNativeAudience(message, address, chainId, resources)) {
        res.status(400).json({
          error: "invalid_native_audience", message: "Native SIWE grant does not match this application",
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

  /**
   * D2 (TC-2872): a fresh bearer for a TinyCloud session restored through its renewal lease after the
   * original grant's signed end. Checks run in D2's order; the nonce is consumed first, and the node is
   * asked only once everything the client signed has passed.
   */
  router.post("/verify-renewal", async (req: Request, res: Response) => {
    if (!config.renewal) {
      res.status(503).json({ error: "renewal_unavailable" });
      return;
    }
    const { address, nonce, delegation, leaseAuthorization, holderProof, statusInvocation } = req.body ?? {};
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || typeof nonce !== "string" ||
      typeof delegation !== "object" || delegation === null || typeof delegation.message !== "string" ||
      typeof delegation.signature !== "string" || typeof delegation.delegationCid !== "string" ||
      typeof leaseAuthorization !== "string" || typeof holderProof !== "string" || typeof statusInvocation !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    // 1. Nonce first: single-use and address-bound, consumed before any check that could leak state.
    if (!config.nonceStore.validate(address, nonce)) {
      res.status(401).json({ error: "invalid_nonce" });
      return;
    }
    try {
      const result = await verifyRenewal(
        {
          address,
          nonce,
          delegation: { message: delegation.message, signature: delegation.signature, delegationCid: delegation.delegationCid },
          leaseAuthorization,
          holderProof,
          statusInvocation,
        },
        { config: config.renewal, webDomains, nativeDomain, spendBudget: spendRenewalBudget, ...(config.renewalFetch ? { fetch: config.renewalFetch } : {}) },
      );
      if (!result.ok) {
        console.warn("[auth] verify-renewal refused:", result.code);
        res.status(result.status).json({ error: result.code });
        return;
      }
      const { token, expiresIn } = await issueSessionToken(address, config.privateKey, {
        notAfter: new Date(result.notAfter * 1000),
      });
      res.json({ token, expiresIn, address: address.toLowerCase(), renewal: { effectiveEnd: result.effectiveEnd } });
    } catch (error) {
      console.error("[auth] verify-renewal failed:", error);
      res.status(401).json({ error: "verification_failed" });
    }
  });

  return router;
}
