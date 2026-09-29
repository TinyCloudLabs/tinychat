import { Router } from "express";
import type { DelegatingServerInfo } from "@tinyboilerplate/core";
import type { BackendBuildInfo } from "../build-info.js";
import { backendDelegationPolicyHash, backendManifestConfig } from "../manifest.js";

export { backendDelegationPolicyHash };

export function createServerInfoRouter(backendDid: string, build: BackendBuildInfo) {
  const router = Router();
  router.get("/", (_req, res) => {
    const policy = backendManifestConfig(backendDid);
    const info: DelegatingServerInfo & BackendBuildInfo = {
      did: backendDid,
      status: "ready",
      name: policy.name,
      expiry: policy.expiry,
      permissions: policy.permissions,
      policyHash: backendDelegationPolicyHash(backendDid),
      backendRevision: build.backendRevision,
      backendVersion: build.backendVersion,
    };
    res.json(info);
  });
  return router;
}
