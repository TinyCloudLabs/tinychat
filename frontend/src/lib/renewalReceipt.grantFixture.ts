import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import type { PersistedSessionData } from "@tinycloud/web-sdk";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { RENEWER, SESSION_KEY, SPACE_ID, fixture, iso } from "./renewalReceipt.fixture";

// A leased session whose first grant has whatever resources a test names: a real wallet-signed SIWE CACAO with a recap
// of those resources (DAG-CBOR, as the SDK encodes it) and the owner's lease for it, so verifiedRenewalLease sees what
// a saved session really holds. renewalReceipt.fixture.ts builds the same shape for one fixed resource.

const DAY = 86_400_000;
const STATEMENT = "I further authorize the stated URI to perform the following actions on my behalf:";

type Cbor = string | number | Uint8Array | Cbor[] | { [key: string]: Cbor };

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function cbor(value: Cbor): number[] {
  if (typeof value === "number") return head(0, value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = Object.entries(value).map(([key, item]) => [cbor(key), cbor(item)] as const);
  entries.sort(([a], [b]) => a.length - b.length || compare(a, b));
  return [...head(5, entries.length), ...entries.flatMap(([key, item]) => [...key, ...item])];
}

const base64url = (bytes: Uint8Array | number[]) => Buffer.from(bytes).toString("base64url");

function recapLines(att: Record<string, Record<string, unknown[]>>): string {
  let index = 0;
  let lines = "";
  for (const resource of Object.keys(att).sort()) {
    const namespaces: Record<string, string[]> = {};
    for (const ability of Object.keys(att[resource]).sort()) {
      const [namespace, name] = ability.split("/");
      (namespaces[namespace] ??= []).push(name);
    }
    for (const namespace of Object.keys(namespaces).sort()) {
      lines += ` (${++index}) '${namespace}': ${namespaces[namespace].map((name) => `'${name}'`).join(", ")} for '${resource}'.`;
    }
  }
  return lines;
}

async function cacao(signer: PrivateKeyAccount, input: { aud: string; att: Record<string, Record<string, unknown[]>>; iat: string; exp: string }) {
  const statement = `${STATEMENT}${recapLines(input.att)}`;
  const recap = `urn:recap:${base64url(new TextEncoder().encode(JSON.stringify({ att: input.att, prf: [] })))}`;
  const nonce = "renewalnonce1234";
  const message = [
    "tinycloud.chat wants you to sign in with your Ethereum account:", signer.address, "", statement, "",
    `URI: ${input.aud}`, "Version: 1", "Chain ID: 1", `Nonce: ${nonce}`, `Issued At: ${input.iat}`, `Expiration Time: ${input.exp}`,
    "Resources:", `- ${recap}`,
  ].join("\n");
  const signature = await signer.signMessage({ message });
  const authorization = base64url(cbor({
    h: { t: "eip4361" },
    p: { domain: "tinycloud.chat", iss: `did:pkh:eip155:1:${signer.address}`, aud: input.aud, version: 1, nonce, iat: input.iat, exp: input.exp, statement, resources: [recap] },
    s: { t: "eip191", s: Buffer.from(signature.slice(2), "hex") },
  }));
  const { cid } = await parseSignedSiweCacao(authorization);
  return { authorization, cid };
}

/** The resources a saved session was signed for, as `{ resource: abilities }`. */
export type SignedResources = Record<string, string[]>;

/** A saved session signed for `resources` and the owner's 90-day lease receipt for it. */
export async function leasedSession(resources: SignedResources) {
  const now = Date.now();
  const owner = privateKeyToAccount(generatePrivateKey());
  const att = Object.fromEntries(Object.entries(resources).map(([resource, abilities]) => [resource, Object.fromEntries(abilities.map((ability) => [ability, [{}]]))]));
  const end = now + 7 * DAY;
  const original = await cacao(owner, { aud: SESSION_KEY, att, iat: iso(now - DAY), exp: iso(end) });
  const approvedAt = iso(Math.floor(now / 1000) * 1000);
  const leaseEnd = iso(Date.parse(approvedAt) + 90 * DAY);
  const lease = await cacao(owner, { aud: RENEWER, att: { [`urn:cid:${original.cid}`]: { "tinycloud.delegation/renew": [{}] } }, iat: approvedAt, exp: leaseEnd });
  const record = {
    address: owner.address, chainId: 1, sessionKey: "{}", siwe: "", signature: "0x", expiresAt: iso(end), createdAt: iso(now - DAY), version: "1",
    tinycloudSession: { spaceId: SPACE_ID, delegationHeader: { Authorization: `Bearer ${original.authorization}` }, delegationCid: original.cid, verificationMethod: SESSION_KEY },
  } as PersistedSessionData;
  const receipt = {
    version: 1, approvedLeaseLifetimeSeconds: 90 * 86_400, approvedAt,
    receipt: {
      originalCid: original.cid, leaseCid: lease.cid, leaseAuthorization: lease.authorization, leaseExpiresAt: leaseEnd, leaseGeneration: 1,
      nodeIdentity: (await fixture()).receipt.receipt.nodeIdentity,
    },
  };
  return { owner, record, receipt, lease };
}
