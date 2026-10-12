import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { APP_ID } from "@tinyboilerplate/core";
import { makePkhSpaceId, SiweMessage } from "@tinycloud/sdk-core";
import { computeCid, siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Keys are generated in memory and never included in a bundle or stored fixture.
const WALLET_A = generatePrivateKey();
const WALLET_B = generatePrivateKey();
const BACKEND_DID = "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810";
const HOST = "http://127.0.0.1:9137";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let number = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (number) {
    encoded = ALPHABET[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

export type TranscriptAtt = Record<string, Record<string, unknown[]>>;
export interface SignedGrantOverrides {
  wallet?: "A" | "B";
  privateKey?: `0x${string}`;
  now?: number;
  expirationTime?: string | null;
  expiresAt?: number;
  sessionUri?: string;
  audience?: string;
  issuer?: string;
  att?: TranscriptAtt;
  proof?: string[];
  host?: string | null;
  unsigned?: Record<string, unknown>;
  nbf?: number;
}
export interface SignedTranscriptGrant {
  serialized: string;
  siwe: string;
  signature: string;
  address: string;
  backendDid: string;
  configuredHost: string;
  spaceId: string;
  sessionDid: string;
  cid: string;
  authorization: string;
  expiresAt: Date;
  envelope: string;
  computeDelegationCid: (authorization: string) => string;
}

// The compact authorization CID uses the same raw codec (0x55) as TinyCloudNode.
export function computeDelegationCid(authorization: string): string {
  return computeCid(new TextEncoder().encode(authorization.replace(/^Bearer /i, "")), 0x55n);
}

/** An offline, cryptographically signed equivalent of the V1 browser-captured grant. */
export async function makeSignedTranscriptGrant(overrides: SignedGrantOverrides = {}): Promise<SignedTranscriptGrant> {
  const now = overrides.now ?? Date.now();
  const account = privateKeyToAccount(overrides.privateKey ?? (overrides.wallet === "B" ? WALLET_B : WALLET_A));
  const address = account.address;
  const spaceId = makePkhSpaceId(address, 1, "applications");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("Ed25519 public key export has no x coordinate");
  const rawPublicKey = Buffer.from(jwk.x, "base64url");
  const keyId = `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey]))}`;
  const sessionDid = `did:key:${keyId}`;
  const sessionUri = overrides.sessionUri ?? `${sessionDid}#${keyId}`;
  const expirationTime = overrides.expirationTime === null ? undefined :
    overrides.expirationTime ?? new Date(now + 30 * 86_400_000).toISOString();
  const siwe = new SiweMessage({
    domain: "localhost",
    address,
    statement: "Sign in to TinyCloud",
    uri: sessionUri,
    version: "1",
    chainId: 1,
    nonce: randomBytes(12).toString("hex"),
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime,
  }).prepareMessage();
  const signature = await account.signMessage({ message: siwe });
  const siweHeaders: unknown = siweToDelegationHeaders({ siwe, signature });
  if (!siweHeaders || typeof siweHeaders !== "object" || !("Authorization" in siweHeaders) || typeof siweHeaders.Authorization !== "string") {
    throw new Error("SIWE proof did not produce an authorization");
  }
  const proof = computeDelegationCid(siweHeaders.Authorization);
  const expiresAt = overrides.expiresAt ?? Math.floor((now + 29 * 86_400_000) / 1000);
  const att: TranscriptAtt = overrides.att ?? {
    [`${spaceId}/sql/${APP_ID}/connectors`]: { "tinycloud.sql/read": [{}], "tinycloud.sql/write": [{}] },
    [`${spaceId}/kv/${APP_ID}/connectors/tinycloud-transcriber/`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
  };
  const payload = {
    att,
    aud: overrides.audience ?? BACKEND_DID,
    exp: expiresAt,
    iss: overrides.issuer ?? `${sessionDid}#${keyId}`,
    nnc: randomBytes(12).toString("hex"),
    prf: overrides.proof ?? [proof],
    ...(overrides.nbf === undefined ? {} : { nbf: overrides.nbf }),
  };
  const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: rawPublicKey.toString("base64url") }, typ: "JWT", ucv: "0.10.0" };
  const signed = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const authorization = `Bearer ${signed}.${sign(null, Buffer.from(signed), privateKey).toString("base64url")}`;
  const cid = computeDelegationCid(authorization);
  const bundle: Record<string, unknown> = {
    cid,
    delegationHeader: { Authorization: authorization },
    host: HOST,
    spaceId,
    ownerAddress: address,
    chainId: 1,
    delegateDID: BACKEND_DID,
    resources: [
      { service: "sql", space: spaceId, path: `${APP_ID}/connectors`, actions: ["read", "write"] },
      { service: "kv", space: spaceId, path: `${APP_ID}/connectors/tinycloud-transcriber/`, actions: ["get", "put"] },
    ],
    actions: ["read", "write"],
    path: `${APP_ID}/connectors`,
    expiry: new Date(expiresAt * 1000).toISOString(),
    disableSubDelegation: true,
    ...overrides.unsigned,
  };
  if (overrides.host === null) delete bundle.host;
  else if (overrides.host !== undefined) bundle.host = overrides.host;
  const serialized = JSON.stringify(bundle);
  return {
    serialized, siwe, signature, address, backendDid: BACKEND_DID, configuredHost: HOST,
    spaceId, sessionDid, cid, authorization, expiresAt: new Date(expiresAt * 1000),
    envelope: JSON.stringify({ format: "tinychat.transcript-writer-grant", v: 1, delegation: serialized, siwe, signature }),
    computeDelegationCid,
  };
}
