import { loadRenewalReceipt, openKeyRenewalClient, saveRenewalReceipt, type ConnectWalletResult, type TinyCloudWebConfig } from "@tinyboilerplate/client";
import { SESSION_EXPIRATION_MS } from "@tinyboilerplate/core";
import { parseSignedSiweCacao, pkhDid, principalDidEquals } from "@tinycloud/sdk-core";
import { admitOwnerRenewalLease } from "@tinycloud/sdk-core/delegations/renewal";
import { parseApprovalRenewal, type ApprovalRenewal } from "@tinycloud/share-envelope/links";
import { BrowserSessionStorage, composeManifestRequest, type Manifest, type PersistedSessionData, type TinyCloudWeb } from "@tinycloud/web-sdk";
import { openKeyFailureOf } from "./authErrors";
import { withAbortTimeout } from "./abortTimeout";

/**
 * TC-2872: the renewal lease OpenKey signs when the owner leaves renewal on at sign-in. OpenKey records it, so the
 * owner's stops can revoke it, but doesn't send it to the node: right after sign-in this app checks it against the
 * just-saved session record, has the session's node admit it, and only then keeps it beside the record as the
 * session's receipt (packages/client session-persistence: cleared with the record). It is trusted for nothing until
 * it is checked here against that exact record. The node stays the authority on whether the lease still renews: the
 * SDK's renewal restore asks it before it restores anything.
 */

/** The 90-day renewal TinyCloud One asks OpenKey to offer at sign-in. */
export const SIGN_IN_RENEWAL_ASK = { version: 1, leaseLifetimeSeconds: 90 * 24 * 60 * 60, purpose: "standing" } as const;

const SENSITIVE_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** OpenKey limits each renewed window that can reach secrets to seven days. */
export function webSignInGrantWindow(manifest: Manifest): number {
  const { resources } = composeManifestRequest([manifest], { includeAccountRegistryPermissions: false });
  const reachesSecrets = resources.some(({ service, space, path, actions }) => {
    if (space === "secrets" || space?.endsWith(":secrets")) return true;
    if (service !== "tinycloud.encryption") return false;
    const keyPathStart = path.indexOf("/");
    return keyPathStart === -1
      ? actions.some((action) => action === "tinycloud.encryption/decrypt" || action === "tinycloud.encryption/*")
      : path.slice(keyPathStart + 1).startsWith("secrets/");
  });
  return reachesSecrets ? Math.min(SESSION_EXPIRATION_MS, SENSITIVE_RENEWAL_WINDOW_MS) : SESSION_EXPIRATION_MS;
}

/** Keep the draft and accepted expiry in the same window, and track when OpenKey's receipt arrived. */
export function webSignInRenewal(openkey: ConnectWalletResult["openkey"], manifest: Manifest) {
  const sessionExpirationMs = webSignInGrantWindow(manifest);
  let renewal: unknown;
  let arrivedAt: number | undefined;
  const config = {
    sessionExpirationMs,
    openkey: {
      client: openKeyRenewalClient(openkey, SIGN_IN_RENEWAL_ASK, (outcome) => {
        renewal = outcome.renewal;
        arrivedAt = performance.now();
      }),
      mode: "iframe",
      expiryChangeable: true,
      maxExpiresAt: () => Date.now() + sessionExpirationMs,
    },
  } satisfies TinyCloudWebConfig;
  return {
    config,
    admit: (tcw: Pick<TinyCloudWeb, "activeNodeIdentity">, address: string, storage?: Pick<BrowserSessionStorage, "load">) =>
      admitSignInRenewal({ tcw, address, renewal, arrivedAt, storage }),
  };
}

/** Retry a failed desktop authorization through the finite wallet sign-in. */
export async function desktopSignInWithRenewal<T>(
  config: ReturnType<typeof webSignInRenewal>["config"],
  signIn: (config?: TinyCloudWebConfig) => Promise<T>,
): Promise<T> {
  const client = config.openkey.client;
  let authorizationFailure: { error: unknown } | undefined;
  try {
    return await signIn({
      ...config,
      openkey: {
        ...config.openkey,
        client: {
          async authorizeTinyCloud(request, options) {
            try {
              return await client.authorizeTinyCloud(request, options);
            } catch (error) {
              authorizationFailure = { error };
              throw error;
            }
          },
        },
      },
    });
  } catch (error) {
    if (!authorizationFailure || authorizationFailure.error !== error) throw error;
    const failure = openKeyFailureOf(error);
    const walletCode = (error as { code?: unknown } | null)?.code;
    if (walletCode === 4001 || walletCode === "ACTION_REJECTED") throw error;
    if (failure.kind !== "failed" && failure.kind !== "popup-blocked") throw error;
    return signIn();
  }
}

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

/** How long the sign-in waits for the node to admit the lease before going on without renewal. */
const ADMIT_TIMEOUT_MS = 5_000;
/**
 * The latest a lease is sent to the node, after it arrived on this device. A stop at OpenKey leaves a sign-in lease
 * it can't find at the node on for ten minutes, in case the app is still admitting it; this keeps every admission
 * well inside that. Measured on this device's monotonic clock, never against OpenKey's `approvedAt`.
 */
const ADMIT_DEADLINE_MS = 60_000;

/**
 * Has the signed-in session's node admit the lease OpenKey returned, then keeps it as the session's receipt. The lease
 * must first check out against the session record the sign-in just saved, and is sent only within a minute of
 * `arrivedAt` (a `performance.now()` reading taken when OpenKey returned it). Without a lease, or when the check, the
 * deadline or the admission fails, nothing is kept: the session lasts until its signed end. Resolves whether renewal
 * is now on.
 */
export async function admitSignInRenewal(input: {
  tcw: Pick<TinyCloudWeb, "activeNodeIdentity">;
  address: string;
  renewal: unknown;
  arrivedAt: number | undefined;
  storage?: Pick<BrowserSessionStorage, "load">;
  persist?: (record: PersistedSessionData, renewal: ApprovalRenewal) => Promise<void>;
}): Promise<boolean> {
  const { tcw, address, renewal, arrivedAt } = input;
  if (renewal === undefined || renewal === null || arrivedAt === undefined) return false;
  try {
    const storage = input.storage ?? new BrowserSessionStorage();
    const record = await storage.load(address);
    const grant = record?.tinycloudSession;
    const leaseAuthorization = record ? await verifiedRenewalLease(renewal, record) : null;
    if (!record || !grant || !leaseAuthorization) return false;
    const approved = parseApprovalRenewal(renewal);
    const { receipt } = approved;
    const { origin } = await tcw.activeNodeIdentity();
    const remaining = arrivedAt + ADMIT_DEADLINE_MS - performance.now();
    if (!(remaining > 0)) return false;
    await withAbortTimeout(Math.min(ADMIT_TIMEOUT_MS, remaining), (signal) => admitOwnerRenewalLease({
      host: origin,
      originalAuthorization: grant.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""),
      originalCid: grant.delegationCid,
      ownerDid: pkhDid(record.address, record.chainId),
      agentDid: grant.verificationMethod,
      spaceId: grant.spaceId,
      nodeIdentity: receipt.nodeIdentity,
      leaseAuthorization,
      leaseCid: receipt.leaseCid,
      leaseExpiresAt: receipt.leaseExpiresAt,
      signal,
    }));
    // A sign-out during the admission cleared the record: keep no receipt beside a session that is gone.
    const current = await storage.load(address);
    if (current?.tinycloudSession?.delegationCid !== grant.delegationCid) return false;
    if (input.persist) await input.persist(current, approved);
    else saveRenewalReceipt(address, approved);
    return true;
  } catch {
    return false;
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
