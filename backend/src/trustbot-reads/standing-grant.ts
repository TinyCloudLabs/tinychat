import { randomBytes } from "node:crypto";
import { makePkhSpaceId, parseSignedSiweCacao, pkhDid, principalDidEquals, signCompactUcanAuthorization } from "@tinycloud/sdk-core";
import { assertRenewalNodeIdentity, verifyRenewalHistory, type RenewalStampHistoryEntry } from "@tinycloud/sdk-core/delegations/renewal";
import { checkApprovalResultBinding, type OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";
import { siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import { fetchDelegationStatus, fetchNodeIdentity, isOnlyCapability, type RenewalVerifyConfig } from "../renewal-verify.js";
import { areaResources } from "./areas.js";
import type { OwnerDid, StandingArea } from "./standing-types.js";

export const STANDING_READ_WINDOW_SECONDS = 7 * 86_400;
export const STANDING_READ_LEASE_SECONDS = 90 * 86_400;
const NODE_WINDOW_SLACK_SECONDS = 60;
const RENEW = "tinycloud.delegation/renew";
const STATUS = "tinycloud.delegation/status";

export interface StandingReadGrant {
  ownerDid: OwnerDid;
  holderDid: string;
  originalCid: string;
  originalEnd: number;
  leaseCid: string;
  leaseEnd: number;
  spaceId: string;
  areas: readonly StandingArea[];
}

export function standingReadPermissions(areas: readonly StandingArea[]): OpenKeyApprovalRequestV1["permissions"] {
  return areaResources(areas).map(({ service, path, actions }) => ({
    service: `tinycloud.${service}`, space: "applications", path, actions: [...actions],
  }));
}

const seconds = (date: string | undefined): number => Date.parse(date ?? "") / 1000;
const bare = (header: string): string => header.replace(/^Bearer\s+/i, "");

function onlyReadScope(grant: Awaited<ReturnType<typeof parseSignedSiweCacao>>, spaceId: string, areas: readonly StandingArea[]): boolean {
  const resources = areaResources(areas);
  return resources.length > 0 && Object.keys(grant.attenuation).length === resources.length && resources.every(resource => {
    const abilities = grant.attenuation[`${spaceId}/${resource.service}/${resource.path}`];
    return !!abilities && Object.keys(abilities).length === resource.actions.length && resource.actions.every(action => {
      const caveats = abilities[action];
      return caveats?.length === 1 && typeof caveats[0] === "object" && caveats[0] !== null &&
        !Array.isArray(caveats[0]) && Object.keys(caveats[0]).length === 0;
    });
  });
}

/** A decrypted reply must match the stored request as well as the authority in the signed bytes. */
export async function verifyStandingReadApproval(input: {
  opened: Record<string, unknown>;
  requestId: string;
  bodyCid: string;
  request: OpenKeyApprovalRequestV1;
  address: string;
  areas: readonly StandingArea[];
  config: RenewalVerifyConfig;
  now: number;
}): Promise<StandingReadGrant> {
  const { opened, requestId, bodyCid, request, address, areas, config, now } = input;
  const result = checkApprovalResultBinding(opened, { requestId, bodyCid, request, now: now * 1000 });
  const invalid = () => new Error("standing_read_approval_invalid");
  const ownerDid = pkhDid(address, 1).toLowerCase();
  const spaceId = makePkhSpaceId(address, 1, "applications");
  const { delegation, renewal } = result;
  const header = delegation.delegationHeader as { Authorization?: unknown } | undefined;
  const jwk = delegation.jwk as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown } | undefined;
  if (result.renewalChoice !== "leased" || !renewal || !request.renewal ||
    request.nodeOrigin !== config.nodeOrigin || !principalDidEquals(result.ownerDid, ownerDid) ||
    delegation.hostActivated !== true || typeof delegation.address !== "string" ||
    delegation.address.toLowerCase() !== address.toLowerCase() || delegation.chainId !== 1 ||
    delegation.spaceId !== spaceId || typeof delegation.verificationMethod !== "string" ||
    !principalDidEquals(delegation.verificationMethod, request.targetDid) ||
    jwk?.kty !== "OKP" || jwk.crv !== "Ed25519" || jwk.x !== request.targetPublicJwk.x || jwk.d !== undefined ||
    typeof header?.Authorization !== "string" || typeof delegation.delegationCid !== "string" ||
    typeof delegation.siwe !== "string" || typeof delegation.signature !== "string" ||
    JSON.stringify(request.permissions) !== JSON.stringify(standingReadPermissions(areas))) throw invalid();

  const { receipt } = renewal;
  assertRenewalNodeIdentity(receipt.nodeIdentity);
  const rebuilt = siweToDelegationHeaders({ siwe: delegation.siwe, signature: delegation.signature }) as { Authorization: string };
  if (bare(rebuilt.Authorization) !== bare(header.Authorization) || receipt.originalCid !== delegation.delegationCid ||
    receipt.nodeIdentity.nodeDid !== config.nodeDid || receipt.nodeIdentity.renewerDid !== config.renewerDid) throw invalid();

  const [grant, lease] = await Promise.all([
    parseSignedSiweCacao(bare(header.Authorization), receipt.originalCid),
    parseSignedSiweCacao(bare(receipt.leaseAuthorization), receipt.leaseCid),
  ]);
  const originalEnd = seconds(grant.expiresAt);
  const start = seconds(grant.notBefore ?? grant.issuedAt);
  const leaseEnd = seconds(lease.expiresAt);
  const leaseStart = seconds(lease.notBefore ?? lease.issuedAt);
  const approvedAt = seconds(renewal.approvedAt);
  if (!principalDidEquals(grant.issuer, ownerDid) || !principalDidEquals(grant.audience, request.targetDid) ||
    grant.proofs.length !== 0 || !onlyReadScope(grant, spaceId, areas) ||
    !Number.isSafeInteger(originalEnd) || !Number.isSafeInteger(start) || start > now ||
    originalEnd <= now || originalEnd <= start || originalEnd !== seconds(result.delegationExpiresAt) ||
    originalEnd - start > Math.min(request.grantLifetimeSeconds + 300, STANDING_READ_WINDOW_SECONDS) ||
    !principalDidEquals(lease.issuer, ownerDid) || lease.audience !== config.renewerDid ||
    lease.proofs.length !== 0 || !isOnlyCapability(lease.attenuation, `urn:cid:${grant.cid}`, RENEW) ||
    !Number.isSafeInteger(approvedAt) || leaseStart !== approvedAt || approvedAt >= originalEnd || approvedAt > now ||
    !Number.isSafeInteger(leaseEnd) || leaseEnd <= now || leaseEnd !== seconds(receipt.leaseExpiresAt) ||
    leaseEnd - approvedAt !== renewal.approvedLeaseLifetimeSeconds ||
    renewal.approvedLeaseLifetimeSeconds > Math.min(request.renewal.leaseLifetimeSeconds, STANDING_READ_LEASE_SECONDS)) throw invalid();

  return {
    ownerDid, holderDid: request.targetDid, originalCid: grant.cid, originalEnd,
    leaseCid: lease.cid, leaseEnd, spaceId, areas,
  };
}

/** The backend obtains an exact lease state through the credential holder. No key creation or custody here. */
export interface StandingReadHolder {
  did: string;
  signStatus(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** Asked on every read; never cached. */
  leaseState(grant: StandingReadGrant): Promise<"active" | "stopped" | "expired" | "unavailable">;
}

export type StandingReadAuthority =
  | { state: "active"; validUntil: number }
  | { state: "ended"; outcome: "expired" | "revoked" | "unavailable" }
  | { state: "unavailable"; outcome?: "not_owner" };

export type VerifyRenewalChain = typeof verifyRenewalHistory;

type StandingReadStatusDeps = {
  address: string;
  config: RenewalVerifyConfig;
  holder: StandingReadHolder;
  fetch?: typeof fetch;
  now?: () => number;
  verifyRenewalChain?: VerifyRenewalChain;
};

const unixNow = () => Math.floor(Date.now() / 1000);

function holderMatches(grant: StandingReadGrant, { address, holder }: StandingReadStatusDeps): boolean {
  return holder.did === grant.holderDid && grant.ownerDid === pkhDid(address, 1).toLowerCase();
}

async function signedOriginalStatus(grant: StandingReadGrant, deps: StandingReadStatusDeps, now: number) {
  const { holder, config } = deps;
  const invocation = await signCompactUcanAuthorization({
    issuerDid: holder.did,
    audienceDid: config.nodeDid,
    attenuation: { [`urn:cid:${grant.originalCid}`]: { [STATUS]: [{}] } },
    facts: [{}],
    proofs: [],
    notBefore: now,
    expiresAt: now + 60,
    nonce: randomBytes(16).toString("hex"),
    sign: async bytes => holder.signStatus(bytes),
  });
  return fetchDelegationStatus(deps.fetch ?? fetch, config, grant.originalCid, invocation.authorization);
}

/** The owner already revoked the grant. The holder checks that exact CID at its pinned node. */
export async function confirmedStandingReadRevocation(grant: StandingReadGrant, deps: StandingReadStatusDeps): Promise<boolean> {
  if (!holderMatches(grant, deps)) return false;
  const status = await signedOriginalStatus(grant, deps, (deps.now ?? unixNow)());
  return status.kind === "status" && status.value.cid === grant.originalCid && status.value.exists === true && status.value.revoked === true;
}

export async function standingReadAuthority(grant: StandingReadGrant, deps: StandingReadStatusDeps): Promise<StandingReadAuthority> {
  const { config, holder, verifyRenewalChain = verifyRenewalHistory } = deps;
  const now = deps.now ?? unixNow;
  const started = now();
  if (!holderMatches(grant, deps)) return { state: "unavailable", outcome: "not_owner" };
  if (grant.leaseEnd <= started) return { state: "ended", outcome: "expired" };
  try {
    const [identity, status] = await Promise.all([
      fetchNodeIdentity(deps.fetch ?? fetch, config),
      signedOriginalStatus(grant, deps, started),
    ]);
    if (status.kind === "refused") return { state: "unavailable" };
    const node = status.value;
    if (node.cid !== grant.originalCid || node.exists !== true) return { state: "unavailable" };
    if (node.revoked === true) return { state: "ended", outcome: "revoked" };
    if (node.expired === true) return { state: "ended", outcome: "expired" };
    if (node.active !== true || typeof node.effective_expiry !== "number" || !Number.isSafeInteger(node.effective_expiry) ||
      !Array.isArray(node.renewal_history)) return { state: "unavailable" };

    const nodeEnd = node.effective_expiry;
    if (nodeEnd > now() + STANDING_READ_WINDOW_SECONDS + NODE_WINDOW_SLACK_SECONDS) {
      return { state: "ended", outcome: "unavailable" };
    }
    const hasRenewedTime = nodeEnd > grant.originalEnd;
    const lease = await holder.leaseState(grant);
    // A stopped renewal is not a revocation: the time already granted runs out at the node's own end below.
    if (lease === "expired") return { state: "ended", outcome: "expired" };
    if (lease !== "active" && lease !== "stopped") return { state: "unavailable" };
    const checkedAt = now();
    if (Math.min(grant.leaseEnd, nodeEnd) <= checkedAt) return { state: "ended", outcome: "expired" };
    const signedEnd = hasRenewedTime ? verifyRenewalChain({
      originalCid: grant.originalCid,
      leaseCid: grant.leaseCid,
      leaseExpiresAt: grant.leaseEnd,
      nodeIdentity: identity,
      history: node.renewal_history as RenewalStampHistoryEntry[],
      now: checkedAt,
    }).effectiveExpiry : grant.originalEnd;
    // The live node can shorten the signed end. Clock slack applies only to the raw status check.
    const end = Math.min(signedEnd, nodeEnd, grant.leaseEnd, checkedAt + STANDING_READ_WINDOW_SECONDS);
    return end > checkedAt ? { state: "active", validUntil: end * 1000 } : { state: "ended", outcome: "expired" };
  } catch {
    return { state: "unavailable" };
  }
}
