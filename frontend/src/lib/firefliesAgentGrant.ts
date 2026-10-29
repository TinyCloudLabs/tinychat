import { CONNECTORS_KV_PREFIX, SESSION_EXPIRATION_MS, TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";
import { makePkhSpaceId, pkhDid, type PermissionEntry } from "@tinycloud/sdk-core";
import type { PortableDelegation, TinyCloudWeb } from "@tinycloud/web-sdk";

import { serializePortableDelegation, toPortableDelegation } from "./agentDelegation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const GRANT_EXPIRY_MS = SESSION_EXPIRATION_MS - DAY_MS;
const FIREFLIES_KV_PATH = `${CONNECTORS_KV_PREFIX}/credentials/fireflies`;
const FIREFLIES_KEY_PATH = `${TINYCHAT_KEY_PREFIX}connectors/fireflies`;
const AGENT_GRANT_KIND = "tinychat.fireflies.named-grant";

function principal(did: string): string {
  return did.split("#", 1)[0];
}

function sessionKeyDid(did: string): string {
  const trimmed = did.trim();
  const [keyDid, fragment, ...extra] = trimmed.split("#");
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(keyDid) || extra.length > 0 ||
    (fragment !== undefined && !/^[A-Za-z0-9._%-]+$/.test(fragment))) {
    throw new Error("Enter the agent session DID (did:key), not its account DID.");
  }
  return keyDid;
}
function requireLongLivedSession(tcw: TinyCloudWeb): void {
  const siwe = tcw.session()?.siwe;
  const expiryLines = siwe?.split(/\r?\n/).filter((line) => line.startsWith("Expiration Time: ")) ?? [];
  const expiresAt = expiryLines.length === 1 ? Date.parse(expiryLines[0]!.slice("Expiration Time: ".length)) : NaN;
  if (!Number.isFinite(expiresAt)) {
    throw new Error("The signed TinyCloud session expiry is unavailable. Sign out and back in before pairing.");
  }
  if (expiresAt - Date.now() < GRANT_EXPIRY_MS) {
    throw new Error("The signed TinyCloud session has less than 29 days left. Sign out and back in before pairing.");
  }
}


export function firefliesAgentGrantPermissions(ownerAddress: string, chainId: number): PermissionEntry[] {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("The signed-in account has no valid chain ID.");
  const ownerDid = pkhDid(ownerAddress, chainId);
  const spaceId = makePkhSpaceId(ownerAddress, chainId, "applications");
  const keyUri = `urn:tinycloud:encryption:${ownerDid}:default/${FIREFLIES_KEY_PATH}`;
  return [
    { service: "tinycloud.kv", space: spaceId, path: FIREFLIES_KV_PATH, actions: ["get"] },
    { service: "tinycloud.encryption", space: "encryption", path: keyUri, actions: ["decrypt"] },
  ];
}

function exactGrantResources(delegation: Partial<PortableDelegation>, permissions: PermissionEntry[]): boolean {
  if (!Array.isArray(delegation.resources) || delegation.resources.length !== 2 ||
    delegation.caveats !== undefined || delegation.publicDelegation !== undefined || delegation.siweProof !== undefined) return false;
  const kv = delegation.resources.find((resource) => resource.service === "kv");
  const key = delegation.resources.find((resource) => resource.service === "encryption");
  if (!kv || !key) return false;
  return kv.space === permissions[0]?.space && kv.path === FIREFLIES_KV_PATH &&
    kv.caveats === undefined && JSON.stringify(kv.actions) === '["tinycloud.kv/get"]' &&
    key.space === "encryption" && key.path === permissions[1]?.path && key.caveats === undefined &&
    JSON.stringify(key.actions) === '["tinycloud.encryption/decrypt"]';
}

/** Export the exact terminal session-key child allowed by the signed TinyCloud session. */
export async function pairFirefliesAgent(tcw: TinyCloudWeb, recipientDid: string): Promise<string> {
  const recipient = sessionKeyDid(recipientDid);
  const ownerAddress = tcw.address();
  const chainId = tcw.chainId();
  if (!ownerAddress || chainId === undefined) throw new Error("Sign in to TinyCloud before pairing agent-sync.");

  const permissions = firefliesAgentGrantPermissions(ownerAddress, chainId);
  requireLongLivedSession(tcw);
  const result = await tcw.delegateTo(recipient, permissions, {
    expiry: GRANT_EXPIRY_MS,
    disableSubDelegation: true,
    requireActivation: true,
  });

  const delegation = result.delegation;
  if (result.prompted || principal(delegation.delegateDID) !== recipient || !delegation.host ||
    delegation.disableSubDelegation !== true || !(delegation.expiry instanceof Date) ||
    !Number.isFinite(delegation.expiry.getTime()) || delegation.expiry.getTime() <= Date.now() ||
    !delegation.cid || !delegation.delegationHeader?.Authorization || !exactGrantResources(delegation, permissions)) {
    throw new Error("TinyCloud did not return the exact terminal Fireflies grant; nothing was exported.");
  }

  const portable = toPortableDelegation(delegation, ownerAddress, chainId, delegation.host);
  const serialized = JSON.parse(await serializePortableDelegation(portable)) as Record<string, unknown>;
  if (!exactGrantResources(serialized as Partial<PortableDelegation>, permissions) ||
    serialized.cid !== delegation.cid || serialized.delegateDID !== recipient ||
    serialized.disableSubDelegation !== true ||
    (serialized.delegationHeader as { Authorization?: unknown } | undefined)?.Authorization !== delegation.delegationHeader.Authorization) {
    throw new Error("The serialized Fireflies grant did not preserve its signed scope; nothing was exported.");
  }

  return JSON.stringify({
    kind: AGENT_GRANT_KIND,
    version: 1,
    ownerDid: pkhDid(ownerAddress, chainId),
    recipientDid: recipient,
    cid: delegation.cid,
    expiresAt: delegation.expiry.toISOString(),
    delegation: serialized,
  }, null, 2);
}
