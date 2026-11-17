import { beforeEach, describe, expect, test } from "bun:test";
import { clearPersistedSession, saveRenewalReceipt } from "@tinyboilerplate/client";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import type { PersistedSessionData } from "@tinycloud/web-sdk";
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
import { renewalRestoreFor, verifiedRenewalLease } from "./renewalReceipt";

// Real wallet-signed SIWE CACAOs, encoded as canonical DAG-CBOR, so the receipt is checked the way the SDK checks a grant.

const DAY = 86_400_000;
const RENEWER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_RENEWER = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const SESSION_KEY = "did:key:z6MknGc3ocHs3zdPiJbnaaqDi58NGb4pk1Sp9WxWufuXSdxf";
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
const iso = (ms: number) => new Date(ms).toISOString();
const originalEnd = now + 7 * DAY;
const approvedAt = iso(Math.floor(now / 1000) * 1000);
const leaseEnd = iso(Date.parse(approvedAt) + 90 * DAY);

async function fixture(options: {
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
      spaceId: "space", delegationHeader: { Authorization: `Bearer ${original.authorization}` }, delegationCid: original.cid,
      verificationMethod: SESSION_KEY,
    },
  } as PersistedSessionData;
  const receipt = {
    version: 1, approvedLeaseLifetimeSeconds: 90 * 86_400, approvedAt: options.approvedAt ?? approvedAt,
    receipt: {
      originalCid: original.cid, leaseCid: lease.cid, leaseAuthorization: lease.authorization, leaseExpiresAt: leaseEnd, leaseGeneration: 1,
      nodeIdentity: { nodeDid: OTHER_RENEWER, renewerDid: options.receiptRenewer ?? RENEWER, renewerPublicKey: "renewer-key", renewerEpoch: 0 },
    },
  };
  return { owner, record, receipt, lease };
}

describe("a stored renewal receipt", () => {
  test("for the saved grant, signed by its owner for that grant's renewal alone, yields the lease", async () => {
    const { record, receipt, lease } = await fixture();
    expect(await verifiedRenewalLease(receipt, record)).toBe(lease.authorization);
  });

  test("naming another grant is not used", async () => {
    const { record, receipt } = await fixture();
    const other = await fixture();
    expect(await verifiedRenewalLease(other.receipt, record)).toBeNull();
    expect(await verifiedRenewalLease({ ...receipt, receipt: { ...receipt.receipt, originalCid: other.record.tinycloudSession!.delegationCid } }, record)).toBeNull();
  });

  test("whose lease another wallet signed is not used", async () => {
    const { record, receipt } = await fixture({ leaseSigner: privateKeyToAccount(generatePrivateKey()) });
    expect(await verifiedRenewalLease(receipt, record)).toBeNull();
  });

  test("whose lease grants more than renewing that grant is not used", async () => {
    const { record, receipt } = await fixture({ extraAbility: true });
    expect(await verifiedRenewalLease(receipt, record)).toBeNull();
  });

  test("whose lease names a renewer other than the receipt's is not used", async () => {
    const { record, receipt } = await fixture({ leaseAudience: OTHER_RENEWER });
    expect(await verifiedRenewalLease(receipt, record)).toBeNull();
  });

  test("approved after the grant ended is not used", async () => {
    const late = iso(originalEnd + 1000);
    const { record, receipt } = await fixture({ approvedAt: late });
    expect(await verifiedRenewalLease({ ...receipt, approvedAt: late }, record)).toBeNull();
  });

  test("that is not a receipt at all is not used", async () => {
    const { record } = await fixture();
    expect(await verifiedRenewalLease({ version: 1 }, record)).toBeNull();
    expect(await verifiedRenewalLease(null, record)).toBeNull();
  });
});

describe("restoring through the lease", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      get length() { return values.size; },
    } as Storage;
  });

  function storage(status: "loaded" | "renewal-candidate" | "missing", record: PersistedSessionData, active?: string) {
    return {
      activeAddressForRenewal: () => active,
      loadRenewalCandidate: async () => status === "missing" ? { status, data: null } : { status, data: record },
    } as Parameters<typeof renewalRestoreFor>[1];
  }

  test("happens only once the saved session is past its end and its receipt checks out", async () => {
    const { owner, record, receipt, lease } = await fixture();
    saveRenewalReceipt(owner.address, receipt);
    expect(await renewalRestoreFor(owner.address, storage("renewal-candidate", record)))
      .toEqual({ address: owner.address, leaseAuthorization: lease.authorization });
    expect(await renewalRestoreFor(owner.address, storage("loaded", record))).toBeNull();
    expect(await renewalRestoreFor(owner.address, storage("missing", record))).toBeNull();
  });

  test("with the bearer gone, uses the account the SDK kept for renewal", async () => {
    const { owner, record, receipt, lease } = await fixture();
    saveRenewalReceipt(owner.address, receipt);
    expect(await renewalRestoreFor(null, storage("renewal-candidate", record, owner.address)))
      .toEqual({ address: owner.address, leaseAuthorization: lease.authorization });
    expect(await renewalRestoreFor(null, storage("renewal-candidate", record))).toBeNull();
  });

  test("never happens once the session was cleared, which takes the receipt with it", async () => {
    const { owner, record, receipt } = await fixture();
    saveRenewalReceipt(owner.address, receipt);
    clearPersistedSession(owner.address);
    expect(await renewalRestoreFor(owner.address, storage("renewal-candidate", record))).toBeNull();
  });
});
