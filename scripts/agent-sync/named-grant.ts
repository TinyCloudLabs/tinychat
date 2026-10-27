import { lstatSync, readFileSync } from "node:fs";
import { makePkhSpaceId, pkhDid } from "@tinycloud/node-sdk/core";
import { deserializeDelegation, type PortableDelegation, type TinyCloudNode } from "@tinycloud/node-sdk";
import { verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { CONNECTORS_KV_PREFIX, TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";

export const NAMED_GRANT_FILE = "fireflies-named-grant.json";
const KEY_PATH = `${TINYCHAT_KEY_PREFIX}connectors/fireflies`;
const KV_PATH = `${CONNECTORS_KV_PREFIX}/credentials/fireflies`;
const TERMINAL_FACT = "xyz.tinycloud.policy/delegationMode";

export class NamedGrantError extends Error {
  constructor(readonly result: "needs_renewal" | "needs_reconnect" | "error") {
    super(result);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const principal = (did: string) => did.split("#", 1)[0];
function invalid(): never { throw new NamedGrantError("needs_renewal"); }

function uncaveatedAbility(value: unknown, ability: string): boolean {
  if (!record(value) || Object.keys(value).length !== 1) return false;
  const clauses = value[ability];
  return Array.isArray(clauses) && (clauses.length === 0 ||
    (clauses.length === 1 && record(clauses[0]) && Object.keys(clauses[0]).length === 0));
}

export interface VerifiedNamedGrant {
  cid: string;
  expiresAt: string;
  delegation: PortableDelegation;
  spaceId: string;
  networkId: string;
}

/** The file is only transport. Every permission and binding comes from its signed UCAN. */
export function verifyNamedGrant(
  artifact: unknown,
  node: Pick<TinyCloudNode, "computeDelegationCid">,
  ownerDid: string,
  recipientDid: string,
  host: string,
  now = Date.now(),
): VerifiedNamedGrant {
  if (!record(artifact) || artifact.kind !== "tinychat.fireflies.named-grant" || artifact.version !== 1 ||
    !record(artifact.delegation) || typeof artifact.ownerDid !== "string" ||
    typeof artifact.recipientDid !== "string" || typeof artifact.cid !== "string" ||
    typeof artifact.expiresAt !== "string") invalid();
  const delegation = artifact.delegation;
  const header = delegation.delegationHeader;
  if (!record(header) || typeof header.Authorization !== "string") invalid();
  const authorization = header.Authorization;
  const parts = authorization.replace(/^Bearer /i, "").split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) invalid();
  let jwtHeader: unknown;
  let claims: unknown;
  try {
    jwtHeader = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { invalid(); }
  if (!record(jwtHeader) || jwtHeader.alg !== "EdDSA" || !record(claims) ||
    typeof claims.iss !== "string" || !claims.iss.startsWith("did:key:") ||
    typeof claims.aud !== "string" || principal(claims.aud) !== principal(recipientDid)) invalid();
  try {
    if (!verifyDidKeyEd25519Signature(principal(claims.iss),
      Buffer.from(`${parts[0]}.${parts[1]}`), Buffer.from(parts[2], "base64url"))) invalid();
  } catch { invalid(); }
  if (!Array.isArray(claims.prf) || claims.prf.length !== 1 || typeof claims.prf[0] !== "string" ||
    !record(claims.att) || Object.keys(claims.att).length !== 2 ||
    !Array.isArray(claims.fct) || claims.fct.length !== 1 || !record(claims.fct[0]) ||
    Object.keys(claims.fct[0]).length !== 1 || claims.fct[0][TERMINAL_FACT] !== "terminal" ||
    typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) ||
    claims.exp * 1000 <= now || claims.exp * 1000 > 8_640_000_000_000_000 ||
    (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf * 1000 > now))) invalid();
  const ownerParts = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/.exec(ownerDid);
  if (!ownerParts) invalid();
  const chainId = Number(ownerParts[1]);
  const address = ownerParts[2];
  const canonicalOwner = pkhDid(address, chainId);
  const spaceId = makePkhSpaceId(address, chainId, "applications");
  const networkId = `urn:tinycloud:encryption:${canonicalOwner}:default`;
  const kvUri = `${spaceId}/kv/${KV_PATH}`;
  const keyUri = `${networkId}/${KEY_PATH}`;
  if (!uncaveatedAbility(claims.att[kvUri], "tinycloud.kv/get") ||
    !uncaveatedAbility(claims.att[keyUri], "tinycloud.encryption/decrypt")) invalid();
  let cid: string;
  try { cid = node.computeDelegationCid(authorization); }
  catch { invalid(); }
  const expiresAt = new Date(claims.exp * 1000).toISOString();
  if (artifact.ownerDid !== canonicalOwner || artifact.recipientDid !== principal(recipientDid) ||
    artifact.cid !== cid || artifact.expiresAt !== expiresAt ||
    delegation.cid !== cid || delegation.delegateDID !== principal(recipientDid) ||
    typeof delegation.ownerAddress !== "string" || delegation.ownerAddress.toLowerCase() !== address.toLowerCase() || delegation.chainId !== chainId ||
    delegation.spaceId !== spaceId || delegation.disableSubDelegation !== true ||
    delegation.host !== host || delegation.publicDelegation !== undefined || delegation.siweProof !== undefined ||
    delegation.caveats !== undefined || !Array.isArray(delegation.resources) || delegation.resources.length !== 2 ||
    !delegation.resources.some((resource) => record(resource) && resource.service === "kv" && resource.space === spaceId &&
      resource.path === KV_PATH && resource.caveats === undefined && JSON.stringify(resource.actions) === '["tinycloud.kv/get"]') ||
    !delegation.resources.some((resource) => record(resource) && resource.service === "encryption" &&
      resource.space === "encryption" && resource.path === keyUri && resource.caveats === undefined &&
      JSON.stringify(resource.actions) === '["tinycloud.encryption/decrypt"]')) invalid();
  let parsed: PortableDelegation;
  try { parsed = deserializeDelegation(JSON.stringify(delegation)); }
  catch { invalid(); }
  if (!(parsed.expiry instanceof Date) || parsed.expiry.getTime() !== claims.exp * 1000) invalid();
  return { cid, expiresAt, delegation: parsed, spaceId, networkId };
}

/** An unreadable or malformed installed file must never select the legacy source. */
export function hasNamedGrantFile(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) {
    if (record(error) && error.code === "ENOENT") return false;
    return true;
  }
}

export function readNamedGrantFile(file: string): unknown {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.mode & 0o077) invalid();
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { invalid(); }
}

export async function installNamedGrant(node: TinyCloudNode, grant: VerifiedNamedGrant): Promise<void> {
  try { await node.useRuntimeDelegation(grant.delegation); }
  catch { throw new NamedGrantError("needs_renewal"); }
}

export async function readNamedFirefliesKey(node: TinyCloudNode, grant: VerifiedNamedGrant): Promise<string> {
  const stored = await node.kvForSpace(grant.spaceId).get(KV_PATH, { source: "network" });
  if (!stored.ok) throw new NamedGrantError(stored.error.code === "KV_NOT_FOUND" ? "needs_reconnect" : "needs_renewal");
  let envelope: unknown = stored.data.data;
  if (typeof envelope === "string") {
    try { envelope = JSON.parse(envelope); } catch { throw new NamedGrantError("needs_reconnect"); }
  }
  if (!record(envelope) || envelope.v !== 2 || envelope.networkId !== grant.networkId ||
    envelope.keyPath !== KEY_PATH) throw new NamedGrantError("needs_reconnect");
  try {
    const bytes = await node.keys.decrypt(envelope as unknown as Parameters<typeof node.keys.decrypt>[0]);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!value) throw new NamedGrantError("needs_reconnect");
    return value;
  } catch (error) {
    if (error instanceof NamedGrantError) throw error;
    throw new NamedGrantError("needs_renewal");
  }
}

export async function prepareFirefliesKeySource(input: {
  file: string;
  node: TinyCloudNode;
  ownerDid: string;
  recipientDid: string;
  host: string;
  readLegacyKey: () => Promise<string>;
  now?: number;
}): Promise<{
  keySource: "named" | "legacy";
  namedGrant?: { cid: string; expiresAt: string };
  readApiKey: () => Promise<string>;
}> {
  if (!hasNamedGrantFile(input.file)) return { keySource: "legacy", readApiKey: input.readLegacyKey };
  const grant = verifyNamedGrant(readNamedGrantFile(input.file), input.node,
    input.ownerDid, input.recipientDid, input.host, input.now);
  await installNamedGrant(input.node, grant);
  return {
    keySource: "named",
    namedGrant: { cid: grant.cid, expiresAt: grant.expiresAt },
    readApiKey: () => readNamedFirefliesKey(input.node, grant),
  };
}
