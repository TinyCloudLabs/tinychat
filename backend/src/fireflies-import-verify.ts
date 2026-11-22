import { verifySiweSession, type VerifiedSiweSession } from "@tinyboilerplate/server";
import { APP_ID, sameTinyCloudNode } from "@tinyboilerplate/core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/node-sdk/core";
import { siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import { verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { getAddress } from "viem";

export const FIREFLIES_IMPORT_POLICY = "fireflies-import" as const;
export const FIREFLIES_IMPORT_MAX_TTL_MS = 7 * 86_400_000;
export const FIREFLIES_IMPORT_CLOCK_SKEW_MS = 60_000;

export const FIREFLIES_SECRET_KV_PATH = "vault/secrets/FIREFLIES_API_KEY";
export const FIREFLIES_SECRET_ENCRYPTION_KEY_PATH = "secrets/fireflies_api_key";
export const FIREFLIES_APPLICATIONS_KV_PREFIX = `${APP_ID}/connectors/fireflies/`;

export const FIREFLIES_DELEGATION_MODE_FACT_KEY = "xyz.tinycloud.policy/delegationMode";
export const FIREFLIES_DELEGATION_MODE_TERMINAL = "terminal";

export interface FirefliesImportGrantInput {
  secretsGrant: string;
  meetingsGrant: string;
  siwe: string;
  signature: string;
  address: string;
  delegateDid: string;
  configuredHost: string;
  now?: number;
}

export interface FirefliesVerifyDependencies {
  computeDelegationCid: TinyCloudNode["computeDelegationCid"];
}

export interface VerifiedFirefliesResource {
  service: string;
  space: string;
  path: string;
  actions: string[];
}

export interface VerifiedFirefliesSingleGrant {
  cid: string;
  authorization: string;
  spaceId: string;
  expiresAt: Date;
  resources: VerifiedFirefliesResource[];
}

export interface VerifiedFirefliesImportGrants {
  ownerAddress: string;
  ownerDid: string;
  chainId: number;
  sessionDid: string;
  delegateDid: string;
  policy: typeof FIREFLIES_IMPORT_POLICY;
  secrets: VerifiedFirefliesSingleGrant;
  meetings: VerifiedFirefliesSingleGrant;
  expiresAt: Date;
}

export type FirefliesImportVerifyResult =
  | { ok: true; verified: VerifiedFirefliesImportGrants }
  | { ok: false; code: string };

const failure = (code: string): FirefliesImportVerifyResult => ({ ok: false, code });
const stripFragment = (value: string): string => value.split("#", 1)[0] ?? "";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const decodeBase64UrlJson = (part: string): unknown =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

function hasOnlyUnrestrictedAbilities(
  abilities: Record<string, unknown>,
  expectedActions: readonly string[],
): { ok: true } | { ok: false; code: string } {
  const granted = Object.keys(abilities);
  if (granted.some((action) => !expectedActions.includes(action))) {
    return { ok: false, code: "overbroad_delegation" };
  }
  if (granted.length !== expectedActions.length) {
    return { ok: false, code: "insufficient_delegation" };
  }
  for (const action of granted) {
    const clauses = abilities[action];
    const unrestricted =
      Array.isArray(clauses) &&
      (clauses.length === 0 ||
        (clauses.length === 1 && isRecord(clauses[0]) && Object.keys(clauses[0]).length === 0));
    if (!unrestricted) return { ok: false, code: "overbroad_delegation" };
  }
  return { ok: true };
}

function isTerminalFacts(fct: unknown): boolean {
  if (!Array.isArray(fct) || fct.length === 0) return false;
  let sawTerminalMode = false;
  for (const entry of fct) {
    if (!isRecord(entry)) return false;
    if (FIREFLIES_DELEGATION_MODE_FACT_KEY in entry) {
      if (entry[FIREFLIES_DELEGATION_MODE_FACT_KEY] !== FIREFLIES_DELEGATION_MODE_TERMINAL) {
        return false;
      }
      sawTerminalMode = true;
    }
    if ("remainingRedelegationDepth" in entry && entry.remainingRedelegationDepth !== 0) {
      return false;
    }
  }
  return sawTerminalMode;
}

interface ParsedSignedUcan {
  cid: string;
  authorization: string;
  sessionDid: string;
  att: Record<string, unknown>;
  expiresAt: Date;
}

function verifyCommonUcan(
  serialized: string,
  context: {
    session: VerifiedSiweSession;
    sessionExpiry: number;
    proof: string;
    expectedDelegateDid: string;
    configuredHost: string;
    now: number;
  },
  deps: FirefliesVerifyDependencies,
): { ok: true; ucan: ParsedSignedUcan } | { ok: false; code: string } {
  let bundle: unknown;
  try {
    bundle = JSON.parse(serialized);
  } catch {
    return { ok: false, code: "unsupported_bundle_shape" };
  }
  if (
    !isRecord(bundle) ||
    bundle.format === "tinycloud.delegation-bundle" ||
    Array.isArray(bundle.delegations)
  ) {
    return { ok: false, code: "unsupported_bundle_shape" };
  }
  if (
    bundle.host !== undefined &&
    (typeof bundle.host !== "string" || !sameTinyCloudNode(bundle.host, context.configuredHost))
  ) {
    return { ok: false, code: "untrusted_host" };
  }
  const header = bundle.delegationHeader;
  if (!isRecord(header) || typeof header.Authorization !== "string") {
    return { ok: false, code: "unsupported_delegation_format" };
  }
  const authorization = header.Authorization;
  const token = authorization.replace(/^Bearer /i, "");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return { ok: false, code: "unsupported_delegation_format" };
  }
  if (typeof bundle.cid !== "string" || deps.computeDelegationCid(authorization) !== bundle.cid) {
    return { ok: false, code: "cid_mismatch" };
  }
  let jwtHeader: unknown;
  let payload: unknown;
  try {
    jwtHeader = decodeBase64UrlJson(parts[0]!);
    payload = decodeBase64UrlJson(parts[1]!);
  } catch {
    return { ok: false, code: "unsupported_delegation_format" };
  }
  if (
    !isRecord(jwtHeader) ||
    !isRecord(payload) ||
    jwtHeader.alg !== "EdDSA" ||
    typeof payload.iss !== "string" ||
    !payload.iss.startsWith("did:key:")
  ) {
    return { ok: false, code: "bad_signature" };
  }
  const sessionDid = stripFragment(payload.iss);
  try {
    if (
      !verifyDidKeyEd25519Signature(
        sessionDid,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        Buffer.from(parts[2]!, "base64url"),
      )
    ) {
      return { ok: false, code: "bad_signature" };
    }
  } catch {
    return { ok: false, code: "bad_signature" };
  }
  // Audience MUST be the dedicated backend did:key delegate (case-sensitive base58btc).
  if (
    typeof payload.aud !== "string" ||
    !payload.aud.startsWith("did:key:") ||
    stripFragment(payload.aud) !== context.expectedDelegateDid
  ) {
    return { ok: false, code: "wrong_delegatee" };
  }
  if (stripFragment(context.session.uri) !== sessionDid) {
    return { ok: false, code: "session_mismatch" };
  }
  if (!Array.isArray(payload.prf) || payload.prf.length !== 1 || payload.prf[0] !== context.proof) {
    return { ok: false, code: "proof_mismatch" };
  }
  if (!isTerminalFacts(payload.fct)) {
    return { ok: false, code: "non_terminal_delegation" };
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return { ok: false, code: "expired" };
  }
  if (payload.exp * 1000 <= context.now + FIREFLIES_IMPORT_CLOCK_SKEW_MS) {
    return { ok: false, code: "expired" };
  }
  const maxExpiryMs = Math.min(
    context.sessionExpiry,
    context.now + FIREFLIES_IMPORT_MAX_TTL_MS + FIREFLIES_IMPORT_CLOCK_SKEW_MS,
  );
  if (payload.exp * 1000 > maxExpiryMs) {
    return { ok: false, code: "expiry_too_long" };
  }
  if (
    payload.nbf !== undefined &&
    (typeof payload.nbf !== "number" ||
      !Number.isFinite(payload.nbf) ||
      payload.nbf * 1000 > context.now + FIREFLIES_IMPORT_CLOCK_SKEW_MS)
  ) {
    return { ok: false, code: "not_yet_valid" };
  }
  if (!isRecord(payload.att)) {
    return { ok: false, code: "insufficient_delegation" };
  }
  return {
    ok: true,
    ucan: {
      cid: bundle.cid,
      authorization,
      sessionDid,
      att: payload.att,
      expiresAt: new Date(payload.exp * 1000),
    },
  };
}

function classifyEncryptionResource(
  uri: string,
  expectedOwnerDid: string,
  expectedEncryptionUri: string,
): "match" | "foreign_space_delegation" | "bare_network_decrypt_forbidden" | "overbroad_delegation" {
  const prefix = "urn:tinycloud:encryption:";
  if (!uri.startsWith(prefix)) return "overbroad_delegation";
  const rest = uri.slice(prefix.length);
  const slashIndex = rest.indexOf("/");
  const networkPart = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  const lastColon = networkPart.lastIndexOf(":");
  if (lastColon <= 0) return "overbroad_delegation";
  const ownerDid = networkPart.slice(0, lastColon);
  const networkName = networkPart.slice(lastColon + 1);
  if (ownerDid.toLowerCase() !== expectedOwnerDid.toLowerCase()) {
    return "foreign_space_delegation";
  }
  if (slashIndex === -1) {
    return "bare_network_decrypt_forbidden";
  }
  if (networkName !== "default") {
    return "overbroad_delegation";
  }
  if (uri !== expectedEncryptionUri) {
    // Catches uppercase key segment, secrets/ prefix, sibling key, wildcard or non-canonical owner DID.
    return "overbroad_delegation";
  }
  return "match";
}

/**
 * Strict allowlist verifier for the `fireflies-import` two-grant pair:
 *
 * - G1 (secrets space):
 *   1. `tinycloud.kv/get` on exact `vault/secrets/FIREFLIES_API_KEY` (no trailing slash, no put/del/list).
 *   2. `tinycloud.encryption/decrypt` on exact
 *      `urn:tinycloud:encryption:<ownerDid>:default/secrets/fireflies_api_key` (lowercase segment;
 *      no bare `:default` network, no `secrets/` prefix, no wildcard).
 * - G2 (applications space):
 *   1. `tinycloud.kv/put` ONLY on exact `xyz.tinycloud.tinychat/connectors/fireflies/`
 *      (no `kv/get`, no `kv/del`, no `kv/list`, no `tinycloud.sql/*`).
 * - Both grants:
 *   - Audience === backend's dedicated `did:key` delegate.
 *   - Owner matches authenticated SIWE session and signed proof chain.
 *   - `exp <= now + 7d + 60s` and `exp <= sessionExpiry`.
 *   - Terminal (`xyz.tinycloud.policy/delegationMode === "terminal"`).
 */
export async function verifyFirefliesImportGrants(
  input: FirefliesImportGrantInput,
  deps: FirefliesVerifyDependencies,
): Promise<FirefliesImportVerifyResult> {
  const now = input.now ?? Date.now();
  const expectedDelegateDid = stripFragment(input.delegateDid);
  if (!expectedDelegateDid.startsWith("did:key:")) {
    return failure("wrong_delegatee");
  }

  let session: VerifiedSiweSession;
  try {
    session = await verifySiweSession(input.siwe, input.signature);
  } catch {
    return failure("bad_session_signature");
  }
  if (session.address.toLowerCase() !== input.address.toLowerCase()) {
    return failure("wrong_delegator");
  }
  const sessionExpiry = Date.parse(session.expirationTime ?? "");
  if (!Number.isFinite(sessionExpiry) || sessionExpiry <= now) {
    return failure("session_expired");
  }

  let proof: string;
  try {
    const headers = siweToDelegationHeaders({
      siwe: input.siwe,
      signature: input.signature,
    }) as { Authorization: string };
    proof = deps.computeDelegationCid(headers.Authorization);
  } catch {
    return failure("proof_mismatch");
  }

  const commonContext = {
    session,
    sessionExpiry,
    proof,
    expectedDelegateDid,
    configuredHost: input.configuredHost,
    now,
  };

  const g1 = verifyCommonUcan(input.secretsGrant, commonContext, deps);
  if (!g1.ok) return failure(g1.code);

  const g2 = verifyCommonUcan(input.meetingsGrant, commonContext, deps);
  if (!g2.ok) return failure(g2.code);

  if (g1.ucan.cid === g2.ucan.cid) {
    return failure("duplicate_delegation");
  }

  const ownerAddress = session.address.toLowerCase();
  const checksummedAddress = getAddress(session.address);
  const ownerDid = `did:pkh:eip155:${session.chainId}:${checksummedAddress}`;

  // G1: secrets space KV get + exact lowercase named-key decrypt
  const secretsSpaceId = makePkhSpaceId(session.address, session.chainId, "secrets");
  const expectedSecretKvUri = `${secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`;
  const expectedEncryptionUri = `urn:tinycloud:encryption:${ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`;

  const g1Resources: VerifiedFirefliesResource[] = [];
  let matchedSecretKv = false;
  let matchedSecretDecrypt = false;
  for (const [uri, abilities] of Object.entries(g1.ucan.att)) {
    if (!isRecord(abilities)) return failure("overbroad_delegation");
    if (uri.startsWith("urn:tinycloud:encryption:")) {
      const verdict = classifyEncryptionResource(uri, ownerDid, expectedEncryptionUri);
      if (verdict !== "match") return failure(verdict);
      const abilityCheck = hasOnlyUnrestrictedAbilities(abilities, ["tinycloud.encryption/decrypt"]);
      if (!abilityCheck.ok) return failure(abilityCheck.code);
      matchedSecretDecrypt = true;
      g1Resources.push({
        service: "encryption",
        space: "encryption",
        path: expectedEncryptionUri,
        actions: ["tinycloud.encryption/decrypt"],
      });
      continue;
    }
    if (!uri.startsWith(`${secretsSpaceId}/`)) {
      return failure("foreign_space_delegation");
    }
    if (uri !== expectedSecretKvUri) {
      return failure("overbroad_delegation");
    }
    const abilityCheck = hasOnlyUnrestrictedAbilities(abilities, ["tinycloud.kv/get"]);
    if (!abilityCheck.ok) return failure(abilityCheck.code);
    matchedSecretKv = true;
    g1Resources.push({
      service: "kv",
      space: secretsSpaceId,
      path: FIREFLIES_SECRET_KV_PATH,
      actions: ["tinycloud.kv/get"],
    });
  }
  if (!matchedSecretKv || !matchedSecretDecrypt || g1Resources.length !== 2) {
    return failure("insufficient_delegation");
  }

  // G2: applications space KV put ONLY on exact Fireflies connector prefix (no kv/get, no kv/del, no sql)
  const appsSpaceId = makePkhSpaceId(session.address, session.chainId, "applications");
  const expectedAppsKvUri = `${appsSpaceId}/kv/${FIREFLIES_APPLICATIONS_KV_PREFIX}`;

  const g2Resources: VerifiedFirefliesResource[] = [];
  for (const [uri, abilities] of Object.entries(g2.ucan.att)) {
    if (!isRecord(abilities)) return failure("overbroad_delegation");
    if (!uri.startsWith(`${appsSpaceId}/`)) {
      return failure("foreign_space_delegation");
    }
    if (uri !== expectedAppsKvUri) {
      return failure("overbroad_delegation");
    }
    const abilityCheck = hasOnlyUnrestrictedAbilities(abilities, ["tinycloud.kv/put"]);
    if (!abilityCheck.ok) return failure(abilityCheck.code);
    g2Resources.push({
      service: "kv",
      space: appsSpaceId,
      path: FIREFLIES_APPLICATIONS_KV_PREFIX,
      actions: ["tinycloud.kv/put"],
    });
  }
  if (g2Resources.length !== 1) {
    return failure("insufficient_delegation");
  }

  const expiresAt = new Date(Math.min(g1.ucan.expiresAt.getTime(), g2.ucan.expiresAt.getTime()));
  return {
    ok: true,
    verified: {
      ownerAddress,
      ownerDid,
      chainId: session.chainId,
      sessionDid: g1.ucan.sessionDid,
      delegateDid: expectedDelegateDid,
      policy: FIREFLIES_IMPORT_POLICY,
      secrets: {
        cid: g1.ucan.cid,
        authorization: g1.ucan.authorization,
        spaceId: secretsSpaceId,
        expiresAt: g1.ucan.expiresAt,
        resources: g1Resources,
      },
      meetings: {
        cid: g2.ucan.cid,
        authorization: g2.ucan.authorization,
        spaceId: appsSpaceId,
        expiresAt: g2.ucan.expiresAt,
        resources: g2Resources,
      },
      expiresAt,
    },
  };
}
