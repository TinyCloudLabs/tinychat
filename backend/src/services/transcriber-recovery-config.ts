import { isStrongRecoveryPseudonymKey } from "../rate-limits.js";

export interface TranscriberRecoveryConfig {
  enabled: boolean;
  ready: boolean;
  contractVersion: string | null;
  capabilityCacheMs: number | null;
  upstreamLeaseMs: number | null;
  rateLimitMax: number | null;
  rateLimitWindowMs: number | null;
  pseudonymKey: string | null;
  buildSha: string | null;
  imageDigest: string | null;
}

const CONTRACT_VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const BUILD_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

function boundedInteger(raw: string | undefined, minimum: number, maximum: number): number | null {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function strictEnabled(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  return null;
}

export function transcriberRecoveryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TranscriberRecoveryConfig {
  const enabled = strictEnabled(env.TRANSCRIBER_RECOVERY_ENABLED);
  const contractVersion = env.TRANSCRIBER_RECOVERY_CONTRACT_VERSION;
  const capabilityCacheMs = boundedInteger(env.TRANSCRIBER_RECOVERY_CAPABILITY_CACHE_MS, 1, 300_000);
  const upstreamLeaseMs = boundedInteger(env.TRANSCRIBER_RECOVERY_UPSTREAM_LEASE_MS, 2, 600_000);
  const rateLimitMax = boundedInteger(env.TRANSCRIBER_RECOVERY_RATE_LIMIT_MAX, 1, 1_000);
  const rateLimitWindowMs = boundedInteger(env.TRANSCRIBER_RECOVERY_RATE_LIMIT_WINDOW_MS, 1_000, 86_400_000);
  const pseudonymKey = env.TRANSCRIBER_RECOVERY_PSEUDONYM_KEY;
  const transcriptionApiKey = env.TRANSCRIPTION_API_KEY?.trim();
  const buildSha = env.TINYCHAT_BUILD_SHA;
  const imageDigest = env.TINYCHAT_BACKEND_IMAGE_DIGEST;
  const contractValid = typeof contractVersion === "string" && CONTRACT_VERSION.test(contractVersion);
  const pseudonymValid = isStrongRecoveryPseudonymKey(pseudonymKey)
    && pseudonymKey !== transcriptionApiKey;
  const provenanceValid = typeof buildSha === "string" && BUILD_SHA.test(buildSha)
    && typeof imageDigest === "string" && IMAGE_DIGEST.test(imageDigest);
  const relationshipValid = capabilityCacheMs !== null && upstreamLeaseMs !== null
    && capabilityCacheMs < upstreamLeaseMs;
  const ready = enabled === true
    && contractValid
    && relationshipValid
    && rateLimitMax !== null
    && rateLimitWindowMs !== null
    && pseudonymValid
    && provenanceValid;

  return {
    enabled: enabled === true,
    ready,
    contractVersion: contractValid ? contractVersion : null,
    capabilityCacheMs,
    upstreamLeaseMs,
    rateLimitMax,
    rateLimitWindowMs,
    pseudonymKey: pseudonymValid ? pseudonymKey : null,
    buildSha: typeof buildSha === "string" && BUILD_SHA.test(buildSha) ? buildSha : null,
    imageDigest: typeof imageDigest === "string" && IMAGE_DIGEST.test(imageDigest) ? imageDigest : null,
  };
}
