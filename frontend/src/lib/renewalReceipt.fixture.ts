import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import type { PersistedSessionData } from "@tinycloud/web-sdk";
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";

// Real wallet-signed SIWE CACAOs, encoded as canonical DAG-CBOR, so the receipt is checked the way the SDK checks a grant.

const DAY = 86_400_000;
export const RENEWER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
export const OTHER_RENEWER = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
export const SESSION_KEY = "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf";
const STATEMENT = "I further authorize the stated URI to perform the following actions on my behalf:";

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

type Cbor = string | number | Uint8Array | Cbor[] | { [key: string]: Cbor };

function cbor(value: Cbor): number[] {
  if (typeof value === "number") return head(0, value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = Object.entries(value).map(([key, item]) => [cbor(key), cbor(item)] as const);
  // DAG-CBOR key order: shorter encoded key first, then bytewise.
  entries.sort(([a], [b]) => a.length - b.length || compare(a, b));
  return [...head(5, entries.length), ...entries.flatMap(([key, item]) => [...key, ...item])];
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function base64url(bytes: Uint8Array | number[]): string {
  return Buffer.from(bytes).toString("base64url");
}

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
    `tinycloud.chat wants you to sign in with your Ethereum account:`,
    signer.address,
    "",
    statement,
    "",
    `URI: ${input.aud}`,
    "Version: 1",
    "Chain ID: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${input.iat}`,
    `Expiration Time: ${input.exp}`,
    "Resources:",
    `- ${recap}`,
  ].join("\n");
  const signature = await signer.signMessage({ message });
  const authorization = base64url(cbor({
    h: { t: "eip4361" },
    p: {
      domain: "tinycloud.chat", iss: `did:pkh:eip155:1:${signer.address}`, aud: input.aud, version: 1, nonce,
      iat: input.iat, exp: input.exp, statement, resources: [recap],
    },
    s: { t: "eip191", s: Buffer.from(signature.slice(2), "hex") },
  }));
  const { cid } = await parseSignedSiweCacao(authorization);
  return { authorization, cid };
}

const now = Date.now();
/** The space the fixture grant's one resource sits in. */
export const SPACE_ID = "tinycloud:pkh:eip155:1:space";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The Ed25519 public key a `did:key:z6Mk…` names, base64url: what a node publishes as `renewerPublicKey`. */
function didKeyPublicKey(did: string): string {
  let value = 0n;
  for (const char of did.slice("did:key:z".length)) value = value * 58n + BigInt(BASE58.indexOf(char));
  const bytes: number[] = [];
  for (; value > 0n; value >>= 8n) bytes.unshift(Number(value & 0xffn));
  return base64url(bytes.slice(2));
}

export const iso = (ms: number) => new Date(ms).toISOString();
export const originalEnd = now + 7 * DAY;
const approvedAt = iso(Math.floor(now / 1000) * 1000);
const leaseEnd = iso(Date.parse(approvedAt) + 90 * DAY);

export async function fixture(options: {
  leaseSigner?: PrivateKeyAccount;
  leaseAudience?: string;
  extraAbility?: boolean;
  receiptRenewer?: string;
  approvedAt?: string;
} = {}) {
  const owner = privateKeyToAccount(generatePrivateKey());
  const original = await cacao(owner, {
    aud: SESSION_KEY,
    att: { "tinycloud:pkh:eip155:1:space/kv/xyz.tinycloud.tinychat/threads/": { "tinycloud.kv/get": [{}] } },
    iat: iso(now - DAY), exp: iso(originalEnd),
  });
  const target = `urn:cid:${original.cid}`;
  const lease = await cacao(options.leaseSigner ?? owner, {
    aud: options.leaseAudience ?? RENEWER,
    att: { [target]: { "tinycloud.delegation/renew": [{}], ...(options.extraAbility ? { "tinycloud.delegation/revoke": [{}] } : {}) } },
    iat: approvedAt, exp: leaseEnd,
  });
  const record = {
    address: owner.address, chainId: 1, sessionKey: "{}", siwe: "", signature: "0x", expiresAt: iso(originalEnd),
    createdAt: iso(now - DAY), version: "1",
    tinycloudSession: {
      spaceId: SPACE_ID, delegationHeader: { Authorization: `Bearer ${original.authorization}` }, delegationCid: original.cid,
      verificationMethod: SESSION_KEY,
    },
  } as PersistedSessionData;
  const receipt = {
    version: 1, approvedLeaseLifetimeSeconds: 90 * 86_400, approvedAt: options.approvedAt ?? approvedAt,
    receipt: {
      originalCid: original.cid, leaseCid: lease.cid, leaseAuthorization: lease.authorization, leaseExpiresAt: leaseEnd, leaseGeneration: 1,
      nodeIdentity: { nodeDid: OTHER_RENEWER, renewerDid: options.receiptRenewer ?? RENEWER, renewerPublicKey: didKeyPublicKey(options.receiptRenewer ?? RENEWER), renewerEpoch: 0 },
    },
  };
  return { owner, record, receipt, lease };
}
