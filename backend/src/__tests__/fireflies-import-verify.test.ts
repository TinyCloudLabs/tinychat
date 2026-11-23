import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { APP_ID } from "@tinyboilerplate/core";
import { makePkhSpaceId, SiweMessage } from "@tinycloud/sdk-core";
import { computeCid, siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  FIREFLIES_APPLICATIONS_KV_PREFIX,
  FIREFLIES_DELEGATION_MODE_FACT_KEY,
  FIREFLIES_DELEGATION_MODE_TERMINAL,
  FIREFLIES_IMPORT_MAX_TTL_MS,
  FIREFLIES_IMPORT_CLOCK_SKEW_MS,
  FIREFLIES_IMPORT_POLICY,
  FIREFLIES_SECRET_ENCRYPTION_KEY_PATH,
  FIREFLIES_SECRET_KV_PATH,
  verifyFirefliesImportGrants,
  type FirefliesImportVerifyResult,
} from "../fireflies-import-verify.js";

const WALLET_A = generatePrivateKey();
const WALLET_B = generatePrivateKey();
const HOST = "https://tee.node.tinycloud.xyz";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let num = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function generateDidKey(): {
  did: string;
  keyId: string;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  rawPublicKey: Buffer;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const rawPublicKey = Buffer.from(jwk.x!, "base64url");
  const keyId = `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey]))}`;
  return { did: `did:key:${keyId}`, keyId, privateKey, rawPublicKey };
}

function computeDelegationCid(authorization: string): string {
  return computeCid(new TextEncoder().encode(authorization.replace(/^Bearer /i, "")), 0x55n);
}

type AttMap = Record<string, Record<string, unknown[]>>;

interface BuildPairOptions {
  wallet?: "A" | "B";
  now?: number;
  sessionExpirationMs?: number;
  g1ExpSecs?: number;
  g2ExpSecs?: number;
  g1Nbf?: number;
  g2Nbf?: number;
  g1Aud?: string;
  g2Aud?: string;
  g1Att?: AttMap;
  g2Att?: AttMap;
  g1Fct?: unknown;
  g2Fct?: unknown;
  g1Prf?: string[];
  g2Prf?: string[];
  g1Host?: string | null;
  g2Host?: string | null;
  tamperG1Sig?: boolean;
  tamperG2Sig?: boolean;
  tamperSiweSig?: boolean;
  tamperG1Cid?: boolean;
  sessionUriOverride?: string;
  delegateDid?: string;
  wrapG1AsBundle?: boolean;
}

async function makeSignedFirefliesPair(opts: BuildPairOptions = {}) {
  const now = opts.now ?? Date.now();
  const account = privateKeyToAccount(opts.wallet === "B" ? WALLET_B : WALLET_A);
  const address = account.address;
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const secretsSpaceId = makePkhSpaceId(address, 1, "secrets");
  const appsSpaceId = makePkhSpaceId(address, 1, "applications");
  const sessionKey = generateDidKey();
  const delegateKey = generateDidKey();
  const delegateDid = opts.delegateDid ?? delegateKey.did;

  const siwe = new SiweMessage({
    domain: "tinycloud.chat",
    address,
    statement: "Sign in to TinyCloud",
    uri: opts.sessionUriOverride ?? `${sessionKey.did}#${sessionKey.keyId}`,
    version: "1",
    chainId: 1,
    nonce: randomBytes(12).toString("hex"),
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + (opts.sessionExpirationMs ?? 30 * 86_400_000)).toISOString(),
  }).prepareMessage();
  let signature = await account.signMessage({ message: siwe });
  if (opts.tamperSiweSig) {
    const tail = signature.endsWith("0") ? "1" : "0";
    signature = `${signature.slice(0, -1)}${tail}` as `0x${string}`;
  }

  const siweHeaders = siweToDelegationHeaders({ siwe, signature }) as { Authorization: string };
  const proof = computeDelegationCid(siweHeaders.Authorization);
  const defaultExpSecs = Math.floor((now + 7 * 86_400_000) / 1000);

  const defaultG1Att: AttMap = {
    [`${secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
    [`urn:tinycloud:encryption:${ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`]: {
      "tinycloud.encryption/decrypt": [{}],
    },
  };
  const defaultG2Att: AttMap = {
    [`${appsSpaceId}/kv/${FIREFLIES_APPLICATIONS_KV_PREFIX}`]: { "tinycloud.kv/put": [{}] },
  };
  const defaultFct = [{ [FIREFLIES_DELEGATION_MODE_FACT_KEY]: FIREFLIES_DELEGATION_MODE_TERMINAL }];

  const buildGrant = (spec: {
    spaceId: string;
    att: AttMap;
    aud: string;
    exp: number;
    nbf?: number;
    fct: unknown;
    prf: string[];
    host?: string | null;
    tamperSig?: boolean;
    tamperCid?: boolean;
    wrapBundle?: boolean;
  }) => {
    const header = {
      alg: "EdDSA",
      jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: sessionKey.rawPublicKey.toString("base64url") },
      typ: "JWT",
      ucv: "0.10.0",
    };
    const payload: Record<string, unknown> = {
      att: spec.att,
      aud: spec.aud,
      exp: spec.exp,
      iss: `${sessionKey.did}#${sessionKey.keyId}`,
      nnc: randomBytes(12).toString("hex"),
      prf: spec.prf,
    };
    if (spec.fct !== undefined) payload.fct = spec.fct;
    if (spec.nbf !== undefined) payload.nbf = spec.nbf;

    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    let sig = sign(null, Buffer.from(signingInput), sessionKey.privateKey);
    if (spec.tamperSig) {
      sig = Buffer.from(sig);
      sig[0] ^= 0xff;
    }
    const authorization = `Bearer ${signingInput}.${sig.toString("base64url")}`;
    const cid = spec.tamperCid ? "bafkreiforgedcid00000000000000000000000000000000000000000000" : computeDelegationCid(authorization);
    const bundle: Record<string, unknown> = {
      cid,
      delegationHeader: { Authorization: authorization },
      spaceId: spec.spaceId,
      ownerAddress: address,
      chainId: 1,
      delegateDID: spec.aud,
      expiry: new Date(spec.exp * 1000).toISOString(),
    };
    if (spec.host === undefined) bundle.host = HOST;
    else if (spec.host !== null) bundle.host = spec.host;
    if (spec.wrapBundle) {
      return JSON.stringify({
        format: "tinycloud.delegation-bundle",
        version: 1,
        delegations: [JSON.stringify(bundle)],
      });
    }
    return JSON.stringify(bundle);
  };

  const secretsGrant = buildGrant({
    spaceId: secretsSpaceId,
    att: opts.g1Att ?? defaultG1Att,
    aud: opts.g1Aud ?? delegateDid,
    exp: opts.g1ExpSecs ?? defaultExpSecs,
    nbf: opts.g1Nbf,
    fct: "g1Fct" in opts ? opts.g1Fct : defaultFct,
    prf: opts.g1Prf ?? [proof],
    host: opts.g1Host,
    tamperSig: opts.tamperG1Sig,
    tamperCid: opts.tamperG1Cid,
    wrapBundle: opts.wrapG1AsBundle,
  });

  const meetingsGrant = buildGrant({
    spaceId: appsSpaceId,
    att: opts.g2Att ?? defaultG2Att,
    aud: opts.g2Aud ?? delegateDid,
    exp: opts.g2ExpSecs ?? defaultExpSecs,
    nbf: opts.g2Nbf,
    fct: "g2Fct" in opts ? opts.g2Fct : defaultFct,
    prf: opts.g2Prf ?? [proof],
    host: opts.g2Host,
    tamperSig: opts.tamperG2Sig,
  });

  return {
    secretsGrant,
    meetingsGrant,
    siwe,
    signature,
    address,
    ownerDid,
    secretsSpaceId,
    appsSpaceId,
    delegateDid,
    configuredHost: HOST,
    now,
    computeDelegationCid,
  };
}

function expectCode(result: FirefliesImportVerifyResult, code: string) {
  expect(result.ok ? "verified" : result.code).toBe(code);
}

describe("fireflies-import strict verifier", () => {
  it("accepts the exact two-grant fireflies-import pair targeting the backend did:key delegate", async () => {
    const pair = await makeSignedFirefliesPair();
    const result = await verifyFirefliesImportGrants(
      {
        secretsGrant: pair.secretsGrant,
        meetingsGrant: pair.meetingsGrant,
        siwe: pair.siwe,
        signature: pair.signature,
        address: pair.address,
        delegateDid: pair.delegateDid,
        configuredHost: pair.configuredHost,
        now: pair.now,
      },
      { computeDelegationCid: pair.computeDelegationCid },
    );
    if (!result.ok) throw new Error(`Expected valid pair to verify; got ${result.code}`);
    expect(result.verified.policy).toBe(FIREFLIES_IMPORT_POLICY);
    expect(result.verified.ownerAddress).toBe(pair.address.toLowerCase());
    expect(result.verified.delegateDid).toBe(pair.delegateDid);
    expect(result.verified.secrets.resources).toEqual([
      {
        service: "kv",
        space: pair.secretsSpaceId,
        path: FIREFLIES_SECRET_KV_PATH,
        actions: ["tinycloud.kv/get"],
      },
      {
        service: "encryption",
        space: "encryption",
        path: `urn:tinycloud:encryption:${pair.ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`,
        actions: ["tinycloud.encryption/decrypt"],
      },
    ]);
    expect(result.verified.meetings.resources).toEqual([
      {
        service: "kv",
        space: pair.appsSpaceId,
        path: FIREFLIES_APPLICATIONS_KV_PREFIX,
        actions: ["tinycloud.kv/put"],
      },
    ]);
  });

  it("rejects bare :default encryption network decrypt", async () => {
    const base = await makeSignedFirefliesPair();
    const pair = await makeSignedFirefliesPair({
      g1Att: {
        [`${base.secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
        [`urn:tinycloud:encryption:${base.ownerDid}:default`]: { "tinycloud.encryption/decrypt": [{}] },
      },
    });
    expectCode(
      await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
      "bare_network_decrypt_forbidden",
    );
  });

  it("rejects uppercase secret key path segment in encryption URN", async () => {
    const base = await makeSignedFirefliesPair();
    const pair = await makeSignedFirefliesPair({
      g1Att: {
        [`${base.secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
        [`urn:tinycloud:encryption:${base.ownerDid}:default/secrets/FIREFLIES_API_KEY`]: {
          "tinycloud.encryption/decrypt": [{}],
        },
      },
    });
    expectCode(
      await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
      "overbroad_delegation",
    );
  });

  it("rejects secrets/ prefix or wildcard in encryption URN", async () => {
    const base = await makeSignedFirefliesPair();
    for (const badPath of ["secrets/", "secrets/*", "secrets/other_api_key", "other/fireflies_api_key"]) {
      const pair = await makeSignedFirefliesPair({
        g1Att: {
          [`${base.secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
          [`urn:tinycloud:encryption:${base.ownerDid}:default/${badPath}`]: {
            "tinycloud.encryption/decrypt": [{}],
          },
        },
      });
      expectCode(
        await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
        "overbroad_delegation",
      );
    }
  });

  it("rejects foreign owner DID in encryption URN", async () => {
    const a = await makeSignedFirefliesPair({ wallet: "A" });
    const b = await makeSignedFirefliesPair({ wallet: "B" });
    const pair = await makeSignedFirefliesPair({
      wallet: "A",
      g1Att: {
        [`${a.secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
        [`urn:tinycloud:encryption:${b.ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`]: {
          "tinycloud.encryption/decrypt": [{}],
        },
      },
    });
    expectCode(
      await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
      "foreign_space_delegation",
    );
  });

  it("rejects non-canonical lowercase owner DID in encryption URN", async () => {
    const base = await makeSignedFirefliesPair();
    const lowercaseOwnerDid = base.ownerDid.toLowerCase();
    // Only meaningful if checksum differs from lowercase (practically always true, guard just in case)
    if (lowercaseOwnerDid !== base.ownerDid) {
      const pair = await makeSignedFirefliesPair({
        g1Att: {
          [`${base.secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
          [`urn:tinycloud:encryption:${lowercaseOwnerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`]: {
            "tinycloud.encryption/decrypt": [{}],
          },
        },
      });
      expectCode(
        await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
        "overbroad_delegation",
      );
    }
  });

  it("rejects trailing slash, prefix or sibling secret on secrets KV path", async () => {
    const base = await makeSignedFirefliesPair();
    for (const badPath of [
      "vault/secrets/FIREFLIES_API_KEY/",
      "vault/secrets/",
      "vault/secrets/*",
      "vault/secrets/OTHER_API_KEY",
    ]) {
      const pair = await makeSignedFirefliesPair({
        g1Att: {
          [`${base.secretsSpaceId}/kv/${badPath}`]: { "tinycloud.kv/get": [{}] },
          [`urn:tinycloud:encryption:${base.ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`]: {
            "tinycloud.encryption/decrypt": [{}],
          },
        },
      });
      expectCode(
        await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
        "overbroad_delegation",
      );
    }
  });

  it("rejects kv/put, kv/del or kv/list on secrets KV grant", async () => {
    const base = await makeSignedFirefliesPair();
    for (const extra of ["tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list"]) {
      const pair = await makeSignedFirefliesPair({
        g1Att: {
          [`${base.secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: {
            "tinycloud.kv/get": [{}],
            [extra]: [{}],
          },
          [`urn:tinycloud:encryption:${base.ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`]: {
            "tinycloud.encryption/decrypt": [{}],
          },
        },
      });
      expectCode(
        await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
        "overbroad_delegation",
      );
    }
  });

  it("rejects kv/get, kv/del and kv/list on applications grant (put-only per Bobbie note #3)", async () => {
    const base = await makeSignedFirefliesPair();
    for (const forbidden of ["tinycloud.kv/get", "tinycloud.kv/del", "tinycloud.kv/list"]) {
      const pair = await makeSignedFirefliesPair({
        g2Att: {
          [`${base.appsSpaceId}/kv/${FIREFLIES_APPLICATIONS_KV_PREFIX}`]: {
            "tinycloud.kv/put": [{}],
            [forbidden]: [{}],
          },
        },
      });
      expectCode(
        await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
        "overbroad_delegation",
      );
    }
  });

  it("rejects any SQL resource in either grant", async () => {
    const base = await makeSignedFirefliesPair();
    const withSqlG2 = await makeSignedFirefliesPair({
      g2Att: {
        [`${base.appsSpaceId}/kv/${FIREFLIES_APPLICATIONS_KV_PREFIX}`]: { "tinycloud.kv/put": [{}] },
        [`${base.appsSpaceId}/sql/${APP_ID}/connectors`]: { "tinycloud.sql/write": [{}] },
      },
    });
    expectCode(
      await verifyFirefliesImportGrants(withSqlG2, { computeDelegationCid: withSqlG2.computeDelegationCid }),
      "overbroad_delegation",
    );

    const withSqlOnlyG2 = await makeSignedFirefliesPair({
      g2Att: {
        [`${base.appsSpaceId}/sql/${APP_ID}/connectors`]: { "tinycloud.sql/read": [{}] },
      },
    });
    expectCode(
      await verifyFirefliesImportGrants(withSqlOnlyG2, { computeDelegationCid: withSqlOnlyG2.computeDelegationCid }),
      "overbroad_delegation",
    );
  });

  it("rejects broader or malformed prefix on applications grant", async () => {
    const base = await makeSignedFirefliesPair();
    for (const badPath of [
      `${APP_ID}/connectors/`,
      `${APP_ID}/`,
      `${APP_ID}/connectors/fireflies`,
      `${APP_ID}/connectors/fireflies/meeting/`,
      "",
    ]) {
      const pair = await makeSignedFirefliesPair({
        g2Att: {
          [`${base.appsSpaceId}/kv/${badPath}`]: { "tinycloud.kv/put": [{}] },
        },
      });
      expectCode(
        await verifyFirefliesImportGrants(pair, { computeDelegationCid: pair.computeDelegationCid }),
        "overbroad_delegation",
      );
    }
  });

  it("rejects foreign space in G1 or G2", async () => {
    const b = await makeSignedFirefliesPair({ wallet: "B" });
    const foreignG1 = await makeSignedFirefliesPair({
      wallet: "A",
      g1Att: {
        [`${b.secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
      },
    });
    expectCode(
      await verifyFirefliesImportGrants(foreignG1, { computeDelegationCid: foreignG1.computeDelegationCid }),
      "foreign_space_delegation",
    );

    const foreignG2 = await makeSignedFirefliesPair({
      wallet: "A",
      g2Att: {
        [`${b.appsSpaceId}/kv/${FIREFLIES_APPLICATIONS_KV_PREFIX}`]: { "tinycloud.kv/put": [{}] },
      },
    });
    expectCode(
      await verifyFirefliesImportGrants(foreignG2, { computeDelegationCid: foreignG2.computeDelegationCid }),
      "foreign_space_delegation",
    );
  });

  it("rejects wrong audience (different did:key or did:pkh backend DID)", async () => {
    const otherDelegate = generateDidKey();
    const wrongKeyG1 = await makeSignedFirefliesPair({ g1Aud: otherDelegate.did });
    expectCode(
      await verifyFirefliesImportGrants(wrongKeyG1, { computeDelegationCid: wrongKeyG1.computeDelegationCid }),
      "wrong_delegatee",
    );

    const pkhAudience = await makeSignedFirefliesPair({
      g2Aud: "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810",
    });
    expectCode(
      await verifyFirefliesImportGrants(pkhAudience, { computeDelegationCid: pkhAudience.computeDelegationCid }),
      "wrong_delegatee",
    );
  });

  it("rejects owner mismatch", async () => {
    const pair = await makeSignedFirefliesPair({ wallet: "A" });
    const other = privateKeyToAccount(WALLET_B).address;
    expectCode(
      await verifyFirefliesImportGrants(
        { ...pair, address: other },
        { computeDelegationCid: pair.computeDelegationCid },
      ),
      "wrong_delegator",
    );
  });

  it("enforces the 7-day + 60s expiry cap and rejects expired grants", async () => {
    const now = Date.UTC(2026, 10, 22, 17, 0, 0);
    const maxAllowedSecs = Math.floor((now + FIREFLIES_IMPORT_MAX_TTL_MS + FIREFLIES_IMPORT_CLOCK_SKEW_MS) / 1000);

    const atBoundary = await makeSignedFirefliesPair({ now, g1ExpSecs: maxAllowedSecs, g2ExpSecs: maxAllowedSecs });
    expect(
      (await verifyFirefliesImportGrants(atBoundary, { computeDelegationCid: atBoundary.computeDelegationCid })).ok,
    ).toBe(true);

    const overCap = await makeSignedFirefliesPair({ now, g1ExpSecs: maxAllowedSecs + 1 });
    expectCode(
      await verifyFirefliesImportGrants(overCap, { computeDelegationCid: overCap.computeDelegationCid }),
      "expiry_too_long",
    );

    const thirtyDays = await makeSignedFirefliesPair({ now, g2ExpSecs: Math.floor((now + 30 * 86_400_000) / 1000) });
    expectCode(
      await verifyFirefliesImportGrants(thirtyDays, { computeDelegationCid: thirtyDays.computeDelegationCid }),
      "expiry_too_long",
    );

    const expired = await makeSignedFirefliesPair({ now, g1ExpSecs: Math.floor((now - 1_000) / 1000) });
    expectCode(
      await verifyFirefliesImportGrants(expired, { computeDelegationCid: expired.computeDelegationCid }),
      "expired",
    );

    const withinSkew = await makeSignedFirefliesPair({ now, g2ExpSecs: Math.floor((now + 30_000) / 1000) });
    expectCode(
      await verifyFirefliesImportGrants(withinSkew, { computeDelegationCid: withinSkew.computeDelegationCid }),
      "expired",
    );
  });

  it("requires terminal delegationMode fact on both grants", async () => {
    const missingG1 = await makeSignedFirefliesPair({ g1Fct: undefined });
    expectCode(
      await verifyFirefliesImportGrants(missingG1, { computeDelegationCid: missingG1.computeDelegationCid }),
      "non_terminal_delegation",
    );

    const missingG2 = await makeSignedFirefliesPair({ g2Fct: [] });
    expectCode(
      await verifyFirefliesImportGrants(missingG2, { computeDelegationCid: missingG2.computeDelegationCid }),
      "non_terminal_delegation",
    );

    const nonTerminalMode = await makeSignedFirefliesPair({
      g1Fct: [{ [FIREFLIES_DELEGATION_MODE_FACT_KEY]: "delegable" }],
    });
    expectCode(
      await verifyFirefliesImportGrants(nonTerminalMode, {
        computeDelegationCid: nonTerminalMode.computeDelegationCid,
      }),
      "non_terminal_delegation",
    );

    const positiveDepth = await makeSignedFirefliesPair({
      g2Fct: [
        { [FIREFLIES_DELEGATION_MODE_FACT_KEY]: FIREFLIES_DELEGATION_MODE_TERMINAL },
        { remainingRedelegationDepth: 1 },
      ],
    });
    expectCode(
      await verifyFirefliesImportGrants(positiveDepth, {
        computeDelegationCid: positiveDepth.computeDelegationCid,
      }),
      "non_terminal_delegation",
    );
  });

  it("rejects forged UCAN signature, forged SIWE signature, broken proof chain, CID mismatch, untrusted host and bundle shape", async () => {
    const badG1Sig = await makeSignedFirefliesPair({ tamperG1Sig: true });
    expectCode(
      await verifyFirefliesImportGrants(badG1Sig, { computeDelegationCid: badG1Sig.computeDelegationCid }),
      "bad_signature",
    );

    const badG2Sig = await makeSignedFirefliesPair({ tamperG2Sig: true });
    expectCode(
      await verifyFirefliesImportGrants(badG2Sig, { computeDelegationCid: badG2Sig.computeDelegationCid }),
      "bad_signature",
    );

    const badSiwe = await makeSignedFirefliesPair({ tamperSiweSig: true });
    expectCode(
      await verifyFirefliesImportGrants(badSiwe, { computeDelegationCid: badSiwe.computeDelegationCid }),
      "bad_session_signature",
    );

    const badPrf = await makeSignedFirefliesPair({ g1Prf: [] });
    expectCode(
      await verifyFirefliesImportGrants(badPrf, { computeDelegationCid: badPrf.computeDelegationCid }),
      "proof_mismatch",
    );

    const badCid = await makeSignedFirefliesPair({ tamperG1Cid: true });
    expectCode(
      await verifyFirefliesImportGrants(badCid, { computeDelegationCid: badCid.computeDelegationCid }),
      "cid_mismatch",
    );

    const badHost = await makeSignedFirefliesPair({ g2Host: "https://evil.example.com" });
    expectCode(
      await verifyFirefliesImportGrants(badHost, { computeDelegationCid: badHost.computeDelegationCid }),
      "untrusted_host",
    );

    const wrappedBundle = await makeSignedFirefliesPair({ wrapG1AsBundle: true });
    expectCode(
      await verifyFirefliesImportGrants(wrappedBundle, {
        computeDelegationCid: wrappedBundle.computeDelegationCid,
      }),
      "unsupported_bundle_shape",
    );
  });

  it("rejects missing required resource in G1 and swapped G1/G2", async () => {
    const base = await makeSignedFirefliesPair();
    const missingDecrypt = await makeSignedFirefliesPair({
      g1Att: {
        [`${base.secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
      },
    });
    expectCode(
      await verifyFirefliesImportGrants(missingDecrypt, {
        computeDelegationCid: missingDecrypt.computeDelegationCid,
      }),
      "insufficient_delegation",
    );

    const swapped = {
      ...base,
      secretsGrant: base.meetingsGrant,
      meetingsGrant: base.secretsGrant,
    };
    expectCode(
      await verifyFirefliesImportGrants(swapped, { computeDelegationCid: swapped.computeDelegationCid }),
      "foreign_space_delegation",
    );
  });
});
