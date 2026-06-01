import { Router } from "express";
import type { DelegatingServerInfo } from "@tinyboilerplate/core";
import { backendDelegationPolicyHash, backendManifestConfig } from "../manifest.js";

export { backendDelegationPolicyHash };

export function createServerInfoRouter(backendDid: string) {
  const router = Router();
  router.get("/", (_req, res) => {
    const policy = backendManifestConfig(backendDid);
    const info: DelegatingServerInfo = {
      did: backendDid,
      status: "ready",
      name: policy.name,
      expiry: policy.expiry,
      permissions: policy.permissions,
      policyHash: backendDelegationPolicyHash(backendDid),
    };
    res.json(info);
  });
  return router;
}
