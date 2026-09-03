import { Router } from "express";
import type { DelegatingServerInfo } from "@tinyboilerplate/core";
import { backendDelegationPolicyHash, backendManifestConfig } from "../manifest.js";
import { transcriberRecoveryConfigFromEnv } from "../services/transcriber-recovery-config.js";
import { transcriptionApiConfigFromEnv } from "../services/transcription-api.js";

export { backendDelegationPolicyHash };

export function createServerInfoRouter(
  backendDid: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const router = Router();
  router.get("/", (_req, res) => {
    const policy = backendManifestConfig(backendDid);
    const recovery = transcriberRecoveryConfigFromEnv(env);
    const info: DelegatingServerInfo & {
      provenance: { build_sha: string | null; backend_image_digest: string | null };
      transcriber_recovery: { proxy_enabled: boolean; contract_version: string | null };
    } = {
      did: backendDid,
      status: "ready",
      name: policy.name,
      expiry: policy.expiry,
      permissions: policy.permissions,
      policyHash: backendDelegationPolicyHash(backendDid),
      provenance: {
        build_sha: recovery.buildSha,
        backend_image_digest: recovery.imageDigest,
      },
      transcriber_recovery: {
        proxy_enabled: recovery.ready && transcriptionApiConfigFromEnv(env) !== null,
        contract_version: recovery.contractVersion,
      },
    };
    res.json(info);
  });
  return router;
}
