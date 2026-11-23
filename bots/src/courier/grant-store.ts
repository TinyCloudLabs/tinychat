import { assertAgentGrant, DEFAULT_HOST, parseGrantPayload, siweTimes, type GrantPayload } from "@tinycloud/courier";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { isRecord } from "../guards";
import { botIdFor, OWNER_DID } from "../owner";
import { sealedGrantStore } from "../secret-store";
import { courierIdentity, type CourierIdentity } from "./identity";
export interface CourierGrant {
  raw: unknown;
  expiresAt: number;
}

export interface CourierGrantStore {
  get(owner: string): Promise<CourierGrant | undefined>;
  put(owner: string, grant: CourierGrant): Promise<void>;
  delete(owner: string): Promise<void>;
}

export class InvalidCourierGrant extends Error {}

export interface VerifiedCourierGrant {
  identity: CourierIdentity;
  payload: GrantPayload;
  node: TinyCloudNode;
  expiresAt: number;
}

/** Cryptographic session restore precedes every authority check; payload labels are not evidence. */
export async function verifyCourierGrant(owner: string, grant: CourierGrant): Promise<VerifiedCourierGrant> {
  owner = owner.toLowerCase();
  if (!OWNER_DID.test(owner) || !isRecord(grant) || !Number.isFinite(grant.expiresAt)) throw new Error("invalid Courier grant");
  const identity = await courierIdentity(owner);
  const payload = parseGrantPayload(grant.raw, { did: identity.did, jwk: { ...identity.publicJwk } });
  // This connection is finite. A renewal lease is additional authority, not an expiry extension from this UI.
  if (payload.renewal) throw new Error("Courier renewal leases are not accepted");
  if (payload.jwk && (payload.jwk.kty !== "OKP" || payload.jwk.crv !== "Ed25519"
    || Object.keys(payload.jwk).some(key => !["kty", "crv", "x", "kid"].includes(key)))) throw new Error("invalid Courier public key");
  const times = siweTimes(payload.siwe);
  const expiresAt = times.expiresAt?.getTime();
  if (!times.issuedAt || !expiresAt || expiresAt !== grant.expiresAt
    || expiresAt - times.issuedAt.getTime() > 30 * 86_400_000) throw new Error("invalid Courier expiry");
  const expectedSpace = `tinycloud:${owner.slice(4)}:agents`;
  if (`did:pkh:eip155:${payload.chainId}:${payload.address}`.toLowerCase() !== owner
    || payload.spaceId.toLowerCase() !== expectedSpace) throw new Error("Courier owner or space mismatch");
  const node = new TinyCloudNode({
    host: DEFAULT_HOST, tinycloudFallbackHosts: [DEFAULT_HOST], autoDiscoverLocalNode: false,
    enablePublicSpace: false, autoBootstrapAccount: false, includeAccountRegistryPermissions: false,
  });
  await identity.signer.restoreSession(node, {
    delegationHeader: payload.delegationHeader, delegationCid: payload.delegationCid,
    spaceId: payload.spaceId, verificationMethod: payload.verificationMethod,
    address: payload.address, chainId: payload.chainId, siwe: payload.siwe,
    signature: payload.signature, expiresAt: new Date(expiresAt).toISOString(), tinycloudHosts: [DEFAULT_HOST],
  });
  assertAgentGrant(node.getVerifiedSessionCapabilities(), times);
  const restored = node.restorableSession;
  if (node.credentialHolderDid !== identity.did || !restored
    || `did:pkh:eip155:${restored.chainId}:${restored.address}`.toLowerCase() !== owner
    || restored.spaceId.toLowerCase() !== expectedSpace) throw new Error("verified Courier binding mismatch");
  return { identity, payload, node, expiresAt };
}

/** Gateway-owned directory beside the budget file; key comes from sealKeyFromDstack. */
export function createCourierGrantStore(dir: string, sealKey: Uint8Array): CourierGrantStore {
  const sealed = sealedGrantStore(dir, sealKey);
  return {
    async get(owner) {
      owner = owner.toLowerCase();
      if (!OWNER_DID.test(owner)) return undefined;
      const id = botIdFor(owner);
      try {
        const entry = sealed.load().find(entry => entry.id === id && entry.botId === id);
        const record = entry?.record;
        if (!isRecord(record) || record.owner !== owner || !isRecord(record.grant)) return undefined;
        const grant = record.grant as unknown as CourierGrant;
        await verifyCourierGrant(owner, grant);
        return grant;
      } catch { return undefined; }
    },
    async put(owner, grant) {
      owner = owner.toLowerCase();
      let verified: VerifiedCourierGrant;
      try { verified = await verifyCourierGrant(owner, grant); }
      catch { throw new InvalidCourierGrant("invalid Courier grant"); }
      const p = verified.payload;
      const raw: GrantPayload = {
        delegationHeader: { Authorization: p.delegationHeader.Authorization }, delegationCid: p.delegationCid,
        spaceId: p.spaceId, address: p.address, chainId: p.chainId, siwe: p.siwe, signature: p.signature,
        verificationMethod: p.verificationMethod, jwk: { ...verified.identity.publicJwk },
      };
      const id = botIdFor(owner);
      sealed.save(id, id, { owner, grant: { raw, expiresAt: verified.expiresAt } });
    },
    async delete(owner) {
      owner = owner.toLowerCase();
      if (!OWNER_DID.test(owner)) throw new Error("invalid Courier owner");
      sealed.remove(botIdFor(owner));
    },
  };
}
