import { createHash } from "node:crypto";
import { verifySiweSession, type VerifiedSiweSession } from "@tinyboilerplate/server";
import { makePkhSpaceId } from "@tinycloud/node-sdk/core";
import { verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { APP_ID } from "@tinyboilerplate/core";
import { backendDelegationPolicyHash } from "./manifest.js";

export interface VerifiedTranscriptWriter {
  cid: string;
  authorization: string;
  ownerAddress: string;
  chainId: number;
  spaceId: string;
  sessionDid: string;
  backendDid: string;
  resources: Array<{ service: string; space: string; path: string; actions: string[] }>;
  expiresAt: Date;
}
export type GrantResult = { ok: true; verified: VerifiedTranscriptWriter } | { ok: false; code: string };
export interface GrantInput {
  serialized: string;
  siwe: string;
  signature: string;
  address: string;
  backendDid: string;
  configuredHost: string;
  now?: number;
}
export interface GrantDependencies {
  computeDelegationCid: TinyCloudNode["computeDelegationCid"];
}
const failure = (code: string): GrantResult => ({ ok: false, code });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const stripFragment = (value: string) => value.split("#", 1)[0];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const expected = [
  { service: "sql", path: `${APP_ID}/connectors`, actions: ["tinycloud.sql/read", "tinycloud.sql/write"] },
  { service: "kv", path: `${APP_ID}/connectors/tinycloud-transcriber/`, actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
];
const verificationCache = new Map<string, { verified: VerifiedTranscriptWriter; until: number }>();
const productionHostOrigins: Record<string, true> = {
  "https://tee.node.tinycloud.xyz": true,
  "https://node.tinycloud.xyz": true,
};

function hostOrigin(host: unknown): string | undefined {
  if (typeof host !== "string") return undefined;
  try {
    const url = new URL(host);
    // Only origin URLs are routing metadata; userinfo, paths, queries and fragments are not.
    return url.href === `${url.origin}/` ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

export function verificationCacheKey(address: string, envelope: string, backendDid: string, configuredHost: string): string {
  return sha256(JSON.stringify({ address: address.toLowerCase(), envelopeSha256: sha256(envelope), backendDid, configuredHost, policyHash: backendDelegationPolicyHash(backendDid) }));
}
/** Invalidate a previously verified stored envelope when its grant is replaced or revoked. */
export function evictStoredGrantVerification(address: string, envelope: string, backendDid: string, configuredHost: string): void {
  verificationCache.delete(verificationCacheKey(address, envelope, backendDid, configuredHost));
}

export async function verifyTranscriptWriterGrant(input: GrantInput, deps: GrantDependencies): Promise<GrantResult> {
  const now = input.now ?? Date.now();
  let bundle: unknown;
  try { bundle = JSON.parse(input.serialized); } catch { return failure("unsupported_bundle_shape"); }
  if (!isRecord(bundle) || bundle.format === "tinycloud.delegation-bundle" || Array.isArray(bundle.delegations)) return failure("unsupported_bundle_shape");
  if (bundle.host !== undefined) {
    const origin = hostOrigin(bundle.host);
    const configuredOrigin = hostOrigin(input.configuredHost);
    if (!origin || !configuredOrigin ||
      (origin !== configuredOrigin && !(productionHostOrigins[origin] && productionHostOrigins[configuredOrigin]))) {
      return failure("untrusted_host");
    }
  }
  const header = bundle.delegationHeader;
  if (!isRecord(header) || typeof header.Authorization !== "string") return failure("unsupported_delegation_format");
  const authorization = header.Authorization;
  const token = authorization.replace(/^Bearer /i, "");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return failure("unsupported_delegation_format");
  if (typeof bundle.cid !== "string" || deps.computeDelegationCid(authorization) !== bundle.cid) return failure("cid_mismatch");
  let jwtHeader: unknown, payload: unknown;
  try { jwtHeader = decode(parts[0]); payload = decode(parts[1]); } catch { return failure("unsupported_delegation_format"); }
  if (!isRecord(jwtHeader) || !isRecord(payload) || jwtHeader.alg !== "EdDSA" || typeof payload.iss !== "string" || !payload.iss.startsWith("did:key:")) return failure("bad_signature");
  const sessionDid = stripFragment(payload.iss);
  try {
    if (!verifyDidKeyEd25519Signature(sessionDid, Buffer.from(`${parts[0]}.${parts[1]}`), Buffer.from(parts[2], "base64url"))) return failure("bad_signature");
  } catch { return failure("bad_signature"); }
  if (typeof payload.aud !== "string" || stripFragment(payload.aud).toLowerCase() !== input.backendDid.toLowerCase() || !payload.aud.startsWith("did:pkh:")) return failure("wrong_delegatee");
  let session: VerifiedSiweSession;
  try { session = await verifySiweSession(input.siwe, input.signature); } catch { return failure("bad_session_signature"); }
  if (session.address.toLowerCase() !== input.address.toLowerCase()) return failure("wrong_delegator");
  const sessionExpiry = Date.parse(session.expirationTime ?? "");
  if (!Number.isFinite(sessionExpiry) || sessionExpiry <= now) return failure("session_expired");
  if (stripFragment(session.uri) !== sessionDid) return failure("session_mismatch");
  let proof: string;
  try {
    const headers = siweToDelegationHeaders({ siwe: input.siwe, signature: input.signature }) as { Authorization: string };
    proof = deps.computeDelegationCid(headers.Authorization);
  } catch { return failure("proof_mismatch"); }
  if (!Array.isArray(payload.prf) || payload.prf.length !== 1 || payload.prf[0] !== proof) return failure("proof_mismatch");
  const spaceId = makePkhSpaceId(session.address, session.chainId, "applications");
  if (!isRecord(payload.att)) return failure("insufficient_delegation");
  const entries = Object.entries(payload.att);
  const resources: VerifiedTranscriptWriter["resources"] = [];
  for (const [uri, abilities] of entries) {
    // The URI's space is signed and must match the SIWE-derived user space exactly.
    if (!uri.startsWith(`${spaceId}/`)) return failure("foreign_space_delegation");
    const suffix = uri.slice(spaceId.length + 1);
    const target = expected.find((entry) => suffix === `${entry.service}/${entry.path}`);
    if (!target) return failure("overbroad_delegation");
    if (!isRecord(abilities)) return failure("overbroad_delegation");
    const granted = Object.keys(abilities);
    if (granted.some((action) => !target.actions.includes(action))) return failure("overbroad_delegation");
    if (granted.length !== target.actions.length) return failure("insufficient_delegation");
    // SDK 2.11 and 3.1 emit one empty nota-bene ({}) for an unrestricted action.
    // An absent list is also unrestricted; any populated condition is not.
    if (granted.some((action) => {
      const clauses = abilities[action];
      return !Array.isArray(clauses) || (clauses.length !== 0 &&
        (clauses.length !== 1 || !isRecord(clauses[0]) || Object.keys(clauses[0]).length !== 0));
    })) return failure("overbroad_delegation");
    resources.push({ service: target.service, space: spaceId, path: target.path, actions: [...target.actions] });
  }
  if (resources.length !== expected.length) return failure("insufficient_delegation");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now + 60_000) return failure("expired");
  if (payload.exp * 1000 > Math.min(sessionExpiry, now + 30 * 86_400_000 + 300_000)) return failure("expiry_too_long");
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf * 1000 > now + 60_000)) return failure("not_yet_valid");
  return { ok: true, verified: { cid: bundle.cid, authorization, ownerAddress: session.address.toLowerCase(), chainId: session.chainId, spaceId, sessionDid, backendDid: input.backendDid, resources, expiresAt: new Date(payload.exp * 1000) } };
}

export async function parseStoredGrant(address: string, envelope: string, options: { backendDid: string; configuredHost: string; now?: number }, deps: GrantDependencies): Promise<GrantResult> {
  let parsed: unknown;
  try { parsed = JSON.parse(envelope); } catch { return failure("unsupported_bundle_shape"); }
  if (!isRecord(parsed) || parsed.format !== "tinychat.transcript-writer-grant" || parsed.v !== 1 || typeof parsed.delegation !== "string" || typeof parsed.siwe !== "string" || typeof parsed.signature !== "string") return failure("unsupported_bundle_shape");
  const key = verificationCacheKey(address, envelope, options.backendDid, options.configuredHost);
  const now = options.now ?? Date.now();
  const cached = verificationCache.get(key);
  if (cached && cached.until > now) {
    const { verified } = cached;
    if (verified.ownerAddress !== address.toLowerCase() || verified.spaceId !== makePkhSpaceId(address, verified.chainId, "applications")) {
      verificationCache.delete(key);
      return failure("wrong_delegator");
    }
    if (verified.expiresAt.getTime() > now) return { ok: true, verified };
    verificationCache.delete(key);
  }
  const result = await verifyTranscriptWriterGrant({ serialized: parsed.delegation, siwe: parsed.siwe, signature: parsed.signature, address, backendDid: options.backendDid, configuredHost: options.configuredHost, now }, deps);
  if (result.ok) verificationCache.set(key, { verified: result.verified, until: Math.min(result.verified.expiresAt.getTime(), now + 600_000) });
  return result;
}
