import { loadRenewalReceipt } from "@tinyboilerplate/client";
import { parseSignedSiweCacao, pkhDid, principalDidEquals } from "@tinycloud/sdk-core";
import { parseApprovalRenewal, type ApprovalRenewal } from "@tinycloud/share-envelope/links";
import { BrowserSessionStorage, type PersistedSessionData } from "@tinycloud/web-sdk";

/**
 * TC-2872: the renewal receipt OpenKey returns when the owner leaves renewal on at sign-in. It is kept beside the
 * session record (packages/client session-persistence: saved at sign-in, cleared with the record) and trusted for
 * nothing until it is checked here against that exact record. The node stays the authority on whether the lease
 * still renews: the SDK's renewal restore asks it before it restores anything.
 */

/** The 90-day renewal TinyCloud One asks OpenKey to offer at sign-in. */
export const SIGN_IN_RENEWAL_ASK = { version: 1, leaseLifetimeSeconds: 90 * 24 * 60 * 60, purpose: "standing" } as const;

const RENEW = "tinycloud.delegation/renew";

/**
 * The lease authorization in `value` when it is a well-formed receipt for `record`'s own grant, signed by the
 * grant's owner, for that grant only; otherwise null. Never throws.
 */
export async function verifiedRenewalLease(value: unknown, record: PersistedSessionData): Promise<string | null> {
  try {
    const renewal: ApprovalRenewal = parseApprovalRenewal(value);
    const { receipt } = renewal;
    const grant = record.tinycloudSession;
    if (!grant || receipt.originalCid !== grant.delegationCid) return null;
    const original = await parseSignedSiweCacao(grant.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), grant.delegationCid);
    const lease = await parseSignedSiweCacao(receipt.leaseAuthorization, receipt.leaseCid);
    const target = lease.attenuation[`urn:cid:${grant.delegationCid}`];
    const caveats = target?.[RENEW];
    const originalEnd = Date.parse(original.expiresAt ?? "");
    if (
      !principalDidEquals(original.issuer, pkhDid(record.address, record.chainId)) ||
      !principalDidEquals(lease.issuer, original.issuer) ||
      lease.audience !== receipt.nodeIdentity.renewerDid ||
      lease.proofs.length !== 0 ||
      Object.keys(lease.attenuation).length !== 1 ||
      !target || Object.keys(target).length !== 1 ||
      !Array.isArray(caveats) || caveats.length !== 1 ||
      typeof caveats[0] !== "object" || caveats[0] === null || Object.keys(caveats[0]).length !== 0 ||
      Date.parse(lease.expiresAt ?? "") !== Date.parse(receipt.leaseExpiresAt) ||
      !Number.isFinite(originalEnd) || Date.parse(renewal.approvedAt) >= originalEnd
    ) {
      return null;
    }
    return receipt.leaseAuthorization;
  } catch {
    return null;
  }
}

export interface RenewalRestore {
  address: string;
  leaseAuthorization: string;
}

/**
 * Restore through the lease only when the saved session is past its signed end and its own receipt checks out.
 * The account is the live bearer's, else the one the SDK kept a renewal candidate for (a lapsed bearer is gone).
 */
export async function renewalRestoreFor(
  bearerAddress: string | null,
  storage: Pick<BrowserSessionStorage, "activeAddressForRenewal" | "loadRenewalCandidate"> = new BrowserSessionStorage(),
): Promise<RenewalRestore | null> {
  const address = bearerAddress ?? storage.activeAddressForRenewal();
  if (!address) return null;
  // No receipt, no renewal: the saved session is then left for the plain restore to load.
  const receipt = loadRenewalReceipt(address);
  if (receipt === null) return null;
  const candidate = await storage.loadRenewalCandidate(address);
  if (candidate.status !== "renewal-candidate") return null;
  const leaseAuthorization = await verifiedRenewalLease(receipt, candidate.data);
  return leaseAuthorization ? { address, leaseAuthorization } : null;
}