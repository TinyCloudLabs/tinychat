// Own schema for a signed bot-history UCAN. The node validates the full proof chain at activation;
// SDK 3.x may issue through a rooted child session rather than the transcript writer's direct SIWE chain.
import { verifySiweSession } from "@tinyboilerplate/server";
import { makePkhSpaceId, verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { historyBotId, HISTORY_PREFIX } from "./bot-history.js";
export interface HistoryGrant {
  cid: string; authorization: string; ownerAddress: string; chainId: number; spaceId: string;
  backendDid: string; expiresAt: Date; resources: [{ service: "kv"; space: string; path: string; actions: string[] }];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export async function projectBotHistoryGrant(
  node: TinyCloudNode, host: string, address: string,
  envelope: { serialized: string; siwe: string; signature: string },
): Promise<HistoryGrant> {
  const fail = () => { throw new Error("history_grant_rejected"); };
  const bundle: unknown = JSON.parse(envelope.serialized);
  if (!object(bundle) || bundle.host !== host || !object(bundle.delegationHeader) || typeof bundle.delegationHeader.Authorization !== "string") return fail();
  const authorization = bundle.delegationHeader.Authorization;
  const parts = authorization.replace(/^Bearer /i, "").split(".");
  if (parts.length !== 3 || node.computeDelegationCid(authorization) !== bundle.cid) return fail();
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  if (header.alg !== "EdDSA" || typeof payload.iss !== "string" || !payload.iss.startsWith("did:key:")
    || !verifyDidKeyEd25519Signature(payload.iss.split("#")[0], Buffer.from(`${parts[0]}.${parts[1]}`), Buffer.from(parts[2]!, "base64url"))) return fail();
  const session = await verifySiweSession(envelope.siwe, envelope.signature);
  const expires = Date.parse(session.expirationTime ?? "");
  if (session.address.toLowerCase() !== address.toLowerCase() || session.chainId !== 1 || !Number.isFinite(expires)
    || typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now() + 60_000 || payload.exp * 1000 > Math.min(expires, Date.now() + 30 * 86_400_000 + 300_000)
    || (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf * 1000 > Date.now()))
    || payload.aud?.split("#")[0]?.toLowerCase() !== node.did.toLowerCase() || !Array.isArray(payload.prf) || !payload.prf.length
    || payload.prf.some((proof: unknown) => typeof proof !== "string" || !proof)) return fail();
  const spaceId = makePkhSpaceId(session.address, 1, "applications");
  const path = `${HISTORY_PREFIX}${historyBotId(address)}/`;
  const uri = `${spaceId}/kv/${path}`;
  if (!object(payload.att) || Object.keys(payload.att).length !== 1 || !object(payload.att[uri])) return fail();
  const actions = ["tinycloud.kv/get", "tinycloud.kv/put"];
  const abilities = payload.att[uri];
  if (Object.keys(abilities).length !== 2 || !actions.every(action => {
    const clauses = abilities[action];
    return Array.isArray(clauses) && (clauses.length === 0 || (clauses.length === 1 && object(clauses[0]) && Object.keys(clauses[0]).length === 0));
  })) return fail();
  return { cid: bundle.cid as string, authorization, ownerAddress: address.toLowerCase(), chainId: 1, spaceId, backendDid: node.did,
    expiresAt: new Date(payload.exp * 1000), resources: [{ service: "kv", space: spaceId, path, actions }] };
}
