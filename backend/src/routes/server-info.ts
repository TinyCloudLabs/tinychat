import { Router } from "express";
import type { DelegatingServerInfo } from "@tinyboilerplate/core";
import type { BackendBuildInfo } from "../build-info.js";
import { backendDelegationPolicyHash, backendManifestConfig } from "../manifest.js";

export { backendDelegationPolicyHash };

export interface ServerInfoCapabilities {
  firefliesServerImport?: boolean;
}

export interface ServerInfoOptions {
  capabilities?: ServerInfoCapabilities;
}

export function createServerInfoRouter(
  backendDid: string,
  build: BackendBuildInfo,
  options?: ServerInfoOptions,
) {
  const router = Router();
  router.get("/", (_req, res) => {
    const policy = backendManifestConfig(backendDid);
    const includeCapabilities = options?.capabilities?.firefliesServerImport === true;
    const info: DelegatingServerInfo & BackendBuildInfo & { capabilities?: ServerInfoCapabilities } = {
      did: backendDid,
      status: "ready",
      name: policy.name,
      expiry: policy.expiry,
      permissions: policy.permissions,
      policyHash: backendDelegationPolicyHash(backendDid),
      backendRevision: build.backendRevision,
      backendVersion: build.backendVersion,
      ...(includeCapabilities
        ? { capabilities: { firefliesServerImport: true } }
        : {}),
    };
    res.json(info);
  });
  return router;
}
