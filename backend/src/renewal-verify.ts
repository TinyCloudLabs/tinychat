import { verifySiweSession, type VerifiedSiweSession } from "@tinyboilerplate/server";
import {
  decodeBase64Url,
  parseCompactUcanAuthorization,
  parseSignedSiweCacao,
  pkhDid,
  principalDidEquals,
  verifyDidKeyEd25519Signature,
  type CompactUcanAuthorizationV1,
  type SignedSiweCacao,
} from "@tinycloud/sdk-core";
import {
  assertRenewalNodeIdentity,
  verifyRenewalHistory,
  type RenewalNodeIdentity,
  type RenewalStampHistoryEntry,
} from "@tinycloud/sdk-core/delegations/renewal";
import { siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import { isExpectedSiweOrigin } from "./cors-origins.js";
import { hasTinyChatNativeAudience } from "./native-siwe-audience.js";

/**
 * D2 (TC-2872): a lease-renewed TinyCloud session gets a fresh backend bearer. The owner grant, the
 * holder's possession of its session key and the owner-signed lease are checked here; the node's live
 * status for the grant is fetched from the pinned node and its signed renewal history verified with
 * sdk-core. Nothing the client sends picks the node, its identity or the renewer.
 */
export interface RenewalVerifyConfig {
  /** This backend's public origin, bound into the holder proof. */
  backendOrigin: string;
  /** The TinyCloud node the status invocation is relayed to (`TINYCLOUD_HOST`). */
  nodeOrigin: string;
  nodeDid: string;
  /** The lease audience: the node's renewer DID (in production, OpenKey's `OPENKEY_RENEWAL_RENEWER_DID`). */
  renewerDid: string;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function canonicalOrigin(name: string, value: string, production: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an origin`); }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopbackHttp && !production)) || url.username || url.password ||
    (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error(`${name} must be an https origin${production ? "" : " (http only for loopback)"}`);
  }
  return url.origin;
}

/**
 * `RENEWAL_BACKEND_ORIGIN`, `RENEWAL_NODE_DID` and `RENEWAL_RENEWER_DID` turn the route on together;
 * none of them leaves it off. The node origin is `TINYCLOUD_HOST`. Loopback http only outside production.
 */
export function renewalVerifyConfigFromEnv(env: NodeJS.ProcessEnv, nodeHost: string): RenewalVerifyConfig | undefined {
  const backendOrigin = env.RENEWAL_BACKEND_ORIGIN?.trim();
  const nodeDid = env.RENEWAL_NODE_DID?.trim();
  const renewerDid = env.RENEWAL_RENEWER_DID?.trim();
  if (!backendOrigin && !nodeDid && !renewerDid) return undefined;
  if (!backendOrigin || !nodeDid || !renewerDid) {
    throw new Error("RENEWAL_BACKEND_ORIGIN, RENEWAL_NODE_DID and RENEWAL_RENEWER_DID must be set together");
  }
  if (!nodeDid.startsWith("did:key:z") || !renewerDid.startsWith("did:key:z")) {
    throw new Error("RENEWAL_NODE_DID and RENEWAL_RENEWER_DID must be did:key DIDs");
  }
  const production = env.NODE_ENV === "production";
  return {
    backendOrigin: canonicalOrigin("RENEWAL_BACKEND_ORIGIN", backendOrigin, production),
    nodeOrigin: canonicalOrigin("TINYCLOUD_HOST", nodeHost, production),
    nodeDid,
    renewerDid,
  };
}

/** The exact UTF-8 text the session key signs as `holderProof`. */
export function renewalHolderProofMessage(backendOrigin: string, address: string, delegationCid: string, nonce: string): string {
  return `tinychat-renewal-verify|${backendOrigin}|${address.toLowerCase()}|${delegationCid}|${nonce}`;
}

export interface RenewalVerifyInput {
  address: string;
  nonce: string;
  delegation: { message: string; signature: string; delegationCid: string };
  leaseAuthorization: string;
  holderProof: string;
  statusInvocation: string;
}

export type RenewalVerifyResult =
  | { ok: true; effectiveEnd: number; notAfter: number }
  | { ok: false; status: 401 | 429 | 503; code: string };

export interface RenewalVerifyDependencies {
  config: RenewalVerifyConfig;
  webDomains: readonly string[];
  nativeDomain: string;
  fetch?: typeof fetch;
  /** Charged once the holder proof passes, before anything else; false refuses with 429 and skips the node. */
  spendBudget?: (address: string) => Promise<boolean>;
  /** Unix seconds. */
  now?: () => number;
}

const NODE_TIMEOUT_MS = 5_000;
const NODE_KEYS_MAX_BYTES = 16 * 1024;
const STATUS_MAX_BYTES = 1024 * 1024;
const STATUS_INVOCATION_MAX_SECONDS = 60;
const TOKEN_MAX_SECONDS = 24 * 60 * 60;
const RENEW = "tinycloud.delegation/renew";
const STATUS = "tinycloud.delegation/status";

const refuse = (code: string): RenewalVerifyResult => ({ ok: false, status: 401, code });
const unavailable = (code: string): RenewalVerifyResult => ({ ok: false, status: 503, code });
const principal = (did: string) => did.split("#", 1)[0];

type Attenuation = Readonly<Record<string, Readonly<Record<string, readonly unknown[]>>>>;

/** Exactly `{ [resource]: { [ability]: [{}] } }`, the one-capability shape node-sdk checks for a lease. */
export function isOnlyCapability(attenuation: Attenuation, resource: string, ability: string): boolean {
  const abilities = attenuation[resource];
  const caveats = abilities?.[ability];
  const caveat = caveats?.[0];
  return Object.keys(attenuation).length === 1 && Object.keys(abilities ?? {}).length === 1 && caveats?.length === 1 &&
    typeof caveat === "object" && caveat !== null && !Array.isArray(caveat) && Object.keys(caveat).length === 0;
}

/** Untrusted node answers, before their fields are checked. */
interface NodeKeysAnswer { nodeDid?: unknown; renewerDid?: unknown; renewerPublicKey?: unknown; renewerEpoch?: unknown }
interface DelegationStatusAnswer {
  cid?: unknown;
  exists?: unknown;
  active?: unknown;
  revoked?: unknown;
  expired?: unknown;
  effective_expiry?: unknown;
  renewal_history?: unknown;
}

class NodeUnavailable extends Error {}

/** A JSON object from the node, read up to `maxBytes`. */
async function boundedJsonObject(response: Response, maxBytes: number): Promise<object> {
  const reader = response.body?.getReader();
  if (!reader) throw new NodeUnavailable("empty node response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new NodeUnavailable("node response too large");
    }
    chunks.push(value);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new NodeUnavailable("node response is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NodeUnavailable("node response is not an object");
  return value;
}

async function nodeRequest(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(NODE_TIMEOUT_MS) });
  } catch {
    throw new NodeUnavailable("node unreachable");
  }
}

export async function fetchNodeIdentity(fetchImpl: typeof fetch, config: RenewalVerifyConfig): Promise<RenewalNodeIdentity> {
  const response = await nodeRequest(fetchImpl, `${config.nodeOrigin}/.well-known/tinycloud/node-keys`, { method: "GET" });
  if (!response.ok) throw new NodeUnavailable(`node-keys answered ${response.status}`);
  const keys: NodeKeysAnswer = await boundedJsonObject(response, NODE_KEYS_MAX_BYTES);
  if (keys.nodeDid !== config.nodeDid || keys.renewerDid !== config.renewerDid || typeof keys.renewerPublicKey !== "string" ||
    typeof keys.renewerEpoch !== "number" || !Number.isSafeInteger(keys.renewerEpoch) || keys.renewerEpoch < 0) {
    throw new NodeUnavailable("node renewal identity does not match the pinned identity");
  }
  const identity: RenewalNodeIdentity = {
    nodeDid: config.nodeDid,
    renewerDid: config.renewerDid,
    renewerPublicKey: keys.renewerPublicKey,
    renewerEpoch: keys.renewerEpoch,
  };
  try { assertRenewalNodeIdentity(identity); } catch { throw new NodeUnavailable("node renewal identity is invalid"); }
  return identity;
}

type NodeStatus = { kind: "refused" } | { kind: "status"; value: DelegationStatusAnswer };

export async function fetchDelegationStatus(fetchImpl: typeof fetch, config: RenewalVerifyConfig, cid: string, authorization: string): Promise<NodeStatus> {
  const response = await nodeRequest(fetchImpl, `${config.nodeOrigin}/delegation/status`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ cid }),
  });
  // The node refuses an invocation it cannot verify or bind (401/403) and a delegation it does not hold (404).
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    return { kind: "refused" };
  }
  if (!response.ok) throw new NodeUnavailable(`status answered ${response.status}`);
  return { kind: "status", value: await boundedJsonObject(response, STATUS_MAX_BYTES) };
}

/** Live expiry can only shorten the node-signed extension of this exact owner lease. */
export function verifiedNodeRenewalEnd(input: {
  originalCid: string;
  leaseCid: string;
  leaseExpiresAt: number;
  nodeEffectiveExpiry: number;
  nodeIdentity: RenewalNodeIdentity;
  history: unknown;
  now: number;
}): number {
  if (!Array.isArray(input.history)) throw new Error("Invalid renewal history");
  return verifyRenewalHistory({
    originalCid: input.originalCid,
    leaseCid: input.leaseCid,
    leaseExpiresAt: input.leaseExpiresAt,
    ancestorEffectiveExpiry: input.nodeEffectiveExpiry,
    nodeIdentity: input.nodeIdentity,
    history: input.history as RenewalStampHistoryEntry[],
    now: input.now,
  }).effectiveExpiry;
}

/**
 * D2 checks 2 to 6, in order; the caller has already consumed the nonce (check 1). The node is asked
 * only after the grant, the holder proof, the lease and the status invocation have all passed.
 */
export async function verifyRenewal(input: RenewalVerifyInput, deps: RenewalVerifyDependencies): Promise<RenewalVerifyResult> {
  const { config } = deps;
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const { delegationCid } = input.delegation;

  // 2. Owner grant: the signed SIWE, checked at its last valid instant if it has expired.
  let session: VerifiedSiweSession;
  try { session = await verifySiweSession(input.delegation.message, input.delegation.signature); } catch { return refuse("invalid_grant"); }
  if (session.address.toLowerCase() !== input.address.toLowerCase()) return refuse("wrong_owner");
  if (!isExpectedSiweOrigin(session.domain, session.uri, deps.webDomains, deps.nativeDomain) ||
    (session.domain === deps.nativeDomain &&
      !hasTinyChatNativeAudience(input.delegation.message, session.address, session.chainId, session.resources))) {
    return refuse("invalid_origin");
  }
  if (!session.expirationTime || !session.uri.startsWith("did:key:")) return refuse("invalid_grant");
  const holderDid = principal(session.uri);
  const ownerDid = pkhDid(session.address, session.chainId);
  let original: SignedSiweCacao;
  try {
    const headers = siweToDelegationHeaders({ siwe: input.delegation.message, signature: input.delegation.signature }) as { Authorization: string };
    original = await parseSignedSiweCacao(headers.Authorization.replace(/^Bearer\s+/i, ""), delegationCid);
  } catch {
    return refuse("grant_cid_mismatch");
  }
  if (!principalDidEquals(original.issuer, ownerDid) || !principalDidEquals(original.audience, holderDid) || original.expiresAt === undefined) {
    return refuse("invalid_grant");
  }

  // 3. Possession: the grant's own session key signed this request.
  const proofMessage = renewalHolderProofMessage(config.backendOrigin, input.address, delegationCid, input.nonce);
  let possessed = false;
  try {
    possessed = verifyDidKeyEd25519Signature(holderDid, new TextEncoder().encode(proofMessage), decodeBase64Url(input.holderProof));
  } catch { /* refused below */ }
  if (!possessed) return refuse("invalid_holder_proof");
  // Only the key holder gets this far, so only they can spend the account's budget.
  if (deps.spendBudget && !await deps.spendBudget(session.address)) return { ok: false, status: 429, code: "rate_limited" };

  // 4. Lease: owner-signed, to the pinned renewer, renewing only this grant, no proofs, not yet ended.
  let lease: SignedSiweCacao;
  try { lease = await parseSignedSiweCacao(input.leaseAuthorization.replace(/^Bearer\s+/i, "")); } catch { return refuse("invalid_lease"); }
  if (!principalDidEquals(lease.issuer, original.issuer)) return refuse("lease_wrong_owner");
  if (lease.audience !== config.renewerDid) return refuse("lease_wrong_audience");
  if (!isOnlyCapability(lease.attenuation, `urn:cid:${delegationCid}`, RENEW) || lease.proofs.length !== 0) return refuse("lease_wrong_scope");
  const leaseExpiresAt = Math.floor(Date.parse(lease.expiresAt ?? "") / 1000);
  if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= now) return refuse("lease_expired");

  // 5. Live node check. The relayed invocation must be the holder's, for this grant's status only,
  // addressed to the pinned node, short-lived and carrying this request's nonce.
  let ucan: CompactUcanAuthorizationV1["payload"];
  try { ucan = parseCompactUcanAuthorization(input.statusInvocation).payload; } catch { return refuse("invalid_status_invocation"); }
  if (principal(ucan.iss) !== holderDid || ucan.aud !== config.nodeDid || ucan.prf.length !== 0 ||
    !isOnlyCapability(ucan.att, `urn:cid:${delegationCid}`, STATUS) || ucan.nnc !== input.nonce ||
    ucan.exp <= now || ucan.exp - ucan.nbf > STATUS_INVOCATION_MAX_SECONDS) {
    return refuse("invalid_status_invocation");
  }
  const fetchImpl = deps.fetch ?? fetch;
  let identity: RenewalNodeIdentity;
  let status: NodeStatus;
  try {
    [identity, status] = await Promise.all([
      fetchNodeIdentity(fetchImpl, config),
      fetchDelegationStatus(fetchImpl, config, delegationCid, input.statusInvocation),
    ]);
  } catch (error) {
    console.warn("[auth] verify-renewal node unavailable:", error instanceof Error ? error.message : "unknown");
    return unavailable("node_unavailable");
  }
  if (status.kind === "refused") return refuse("renewal_inactive");
  const value = status.value;
  const history = value.renewal_history ?? [];
  if ((value.cid !== undefined && value.cid !== delegationCid) || value.exists !== true || value.active !== true ||
    value.revoked === true || value.expired === true || typeof value.effective_expiry !== "number" || !Number.isSafeInteger(value.effective_expiry)) {
    return refuse("renewal_inactive");
  }
  let effectiveEnd: number;
  try {
    effectiveEnd = verifiedNodeRenewalEnd({
      originalCid: delegationCid,
      leaseCid: lease.cid,
      leaseExpiresAt,
      nodeEffectiveExpiry: value.effective_expiry,
      nodeIdentity: identity,
      history,
      now,
    });
  } catch {
    return refuse("renewal_history_invalid");
  }
  if (effectiveEnd <= now) return refuse("renewal_inactive");

  // 6. Token bound: the renewed end, the lease end, and one day.
  return { ok: true, effectiveEnd, notAfter: Math.min(effectiveEnd, leaseExpiresAt, now + TOKEN_MAX_SECONDS) };
}
