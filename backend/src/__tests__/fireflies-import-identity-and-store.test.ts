import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { makePkhSpaceId, SiweMessage } from "@tinycloud/sdk-core";
import { computeCid, siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DstackUnixClient } from "../attestation/dstackClient.js";
import { BACKEND_KV_ROOTS } from "../backend-kv-roots.js";
import {
  deriveFirefliesImportKeys,
  FIREFLIES_DELEGATE_KMS_PATH,
  FIREFLIES_GRANT_KEK_KMS_PATH,
  firefliesServerImportEnabled,
} from "../fireflies-import-identity.js";
import {
  FIREFLIES_APPLICATIONS_KV_PREFIX,
  FIREFLIES_DELEGATION_MODE_FACT_KEY,
  FIREFLIES_DELEGATION_MODE_TERMINAL,
  FIREFLIES_SECRET_ENCRYPTION_KEY_PATH,
  FIREFLIES_SECRET_KV_PATH,
} from "../fireflies-import-verify.js";
import {
  FIREFLIES_IMPORT_GRANT_KEY_PREFIX,
  FirefliesGrantStore,
  type FirefliesGrantKvPort,
} from "../services/fireflies-grant-store.js";
import { assertBackendManifestCoversKvRoots, TINYCHAT_BACKEND_MANIFEST } from "../startup.js";

const HOST = "https://tee.node.tinycloud.xyz";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

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

function computeDelegationCid(authorization: string): string {
  return computeCid(new TextEncoder().encode(authorization.replace(/^Bearer /i, "")), 0x55n);
}

async function mintGrantPair(delegateDid: string, options: { now?: number; ttlMs?: number; privateKey?: `0x${string}` } = {}) {
  const now = options.now ?? Date.now();
  const account = privateKeyToAccount(options.privateKey ?? generatePrivateKey());
  const address = account.address;
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const secretsSpaceId = makePkhSpaceId(address, 1, "secrets");
  const appsSpaceId = makePkhSpaceId(address, 1, "applications");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const rawPub = Buffer.from(jwk.x!, "base64url");
  const keyId = `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), rawPub]))}`;
  const sessionDid = `did:key:${keyId}`;

  const siwe = new SiweMessage({
    domain: "tinycloud.chat",
    address,
    statement: "Sign in to TinyCloud",
    uri: `${sessionDid}#${keyId}`,
    version: "1",
    chainId: 1,
    nonce: randomBytes(12).toString("hex"),
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + 30 * 86_400_000).toISOString(),
  }).prepareMessage();
  const signature = await account.signMessage({ message: siwe });
  const proof = computeDelegationCid((siweToDelegationHeaders({ siwe, signature }) as { Authorization: string }).Authorization);
  const expSecs = Math.floor((now + (options.ttlMs ?? 7 * 86_400_000)) / 1000);

  const signUcan = (spaceId: string, att: Record<string, Record<string, unknown[]>>) => {
    const header = { alg: "EdDSA", jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: rawPub.toString("base64url") }, typ: "JWT", ucv: "0.10.0" };
    const payload = {
      att,
      aud: delegateDid,
      exp: expSecs,
      iss: `${sessionDid}#${keyId}`,
      nnc: randomBytes(12).toString("hex"),
      prf: [proof],
      fct: [{ [FIREFLIES_DELEGATION_MODE_FACT_KEY]: FIREFLIES_DELEGATION_MODE_TERMINAL }],
    };
    const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const authorization = `Bearer ${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
    return JSON.stringify({
      cid: computeDelegationCid(authorization),
      delegationHeader: { Authorization: authorization },
      host: HOST,
      spaceId,
      ownerAddress: address,
      chainId: 1,
      delegateDID: delegateDid,
      expiry: new Date(expSecs * 1000).toISOString(),
    });
  };

  return {
    address,
    secretsGrant: signUcan(secretsSpaceId, {
      [`${secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
      [`urn:tinycloud:encryption:${ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`]: {
        "tinycloud.encryption/decrypt": [{}],
      },
    }),
    meetingsGrant: signUcan(appsSpaceId, {
      [`${appsSpaceId}/kv/${FIREFLIES_APPLICATIONS_KV_PREFIX}`]: { "tinycloud.kv/put": [{}] },
    }),
    siwe,
    signature,
    expiresAt: new Date(expSecs * 1000),
    now,
  };
}

function createMemoryKv() {
  const rows = new Map<string, unknown>();
  let puts = 0;
  let deletes = 0;
  const kv: FirefliesGrantKvPort = {
    async get(key) {
      return (rows.get(key) as never) ?? null;
    },
    async put(key, value) {
      puts++;
      rows.set(key, structuredClone(value));
    },
    async delete(key) {
      deletes++;
      rows.delete(key);
    },
  };
  return {
    rows,
    kv,
    writeCounts: () => ({ puts, deletes }),
  };
}

describe("dstack KMS getKey and fireflies-import identity", () => {
  it("keeps the feature flag OFF by default unless literal 'true'", () => {
    expect(firefliesServerImportEnabled({})).toBe(false);
    expect(firefliesServerImportEnabled({ FIREFLIES_SERVER_IMPORT_ENABLED: "false" })).toBe(false);
    expect(firefliesServerImportEnabled({ FIREFLIES_SERVER_IMPORT_ENABLED: "1" })).toBe(false);
    expect(firefliesServerImportEnabled({ FIREFLIES_SERVER_IMPORT_ENABLED: "TRUE" })).toBe(false);
    expect(firefliesServerImportEnabled({ FIREFLIES_SERVER_IMPORT_ENABLED: "true" })).toBe(true);
  });

  it("reads /GetKey over a Unix domain socket and fails closed on short, non-hex or missing socket", async () => {
    const dir = mkdtempSync(join("/var/tmp", "tc3905-dstack-"));
    tmpDirs.push(dir);
    const sock = join(dir, "dstack.sock");
    const requestedPaths: string[] = [];
    const responses: Record<string, { status: number; body: string }> = {
      [FIREFLIES_DELEGATE_KMS_PATH]: { status: 200, body: JSON.stringify({ key: "11".repeat(32) }) },
      [FIREFLIES_GRANT_KEK_KMS_PATH]: { status: 200, body: JSON.stringify({ key: "22".repeat(32) }) },
      "short/key": { status: 200, body: JSON.stringify({ key: "aa".repeat(16) }) },
      "bad/hex": { status: 200, body: JSON.stringify({ key: "not-hex-at-all!" }) },
      "fail/http": { status: 500, body: JSON.stringify({ error: "boom" }) },
    };

    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(raw) as { path: string };
        requestedPaths.push(parsed.path);
        const match = responses[parsed.path] ?? { status: 404, body: "{}" };
        res.statusCode = match.status;
        res.setHeader("content-type", "application/json");
        res.end(match.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));

    try {
      const client = new DstackUnixClient(sock);
      const keys1 = await deriveFirefliesImportKeys(client, { host: HOST, env: {} });
      const keys2 = await deriveFirefliesImportKeys(client, { host: HOST, env: {} });

      expect(requestedPaths.slice(0, 2)).toEqual([FIREFLIES_DELEGATE_KMS_PATH, FIREFLIES_GRANT_KEK_KMS_PATH]);
      expect(keys1.delegate.did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
      expect(keys1.delegate.did).not.toContain("#");
      expect(keys1.delegate.node.isSessionOnly).toBe(true);
      expect(keys1.delegate.did).toBe(keys2.delegate.did);
      expect(keys1.grantKek.length).toBe(32);
      expect(keys1.grantKek.equals(keys2.grantKek)).toBe(true);

      await expect(client.getKey("short/key")).rejects.toThrow(/too few key bytes/);
      await expect(client.getKey("bad/hex")).rejects.toThrow(/invalid key encoding/);
      await expect(client.getKey("fail/http")).rejects.toThrow(/HTTP 500/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const missing = new DstackUnixClient(join(dir, "absent.sock"));
    await expect(deriveFirefliesImportKeys(missing, { host: HOST, env: {} })).rejects.toThrow(/not available/);
  });

  it("refuses boot when KMS returns colliding, weak, zero or reused env master bytes", async () => {
    const same = Buffer.alloc(32, 0x33);
    await expect(
      deriveFirefliesImportKeys({ getKey: async () => Buffer.from(same) }, { host: HOST, env: {} }),
    ).rejects.toThrow(/identical material/);

    await expect(
      deriveFirefliesImportKeys({ getKey: async () => Buffer.alloc(32, 0) }, { host: HOST, env: {} }),
    ).rejects.toThrow(/missing or weak/);

    const delegateBytes = Buffer.alloc(32, 0x44);
    const kekBytes = Buffer.alloc(32, 0x55);
    await expect(
      deriveFirefliesImportKeys(
        {
          getKey: async (path) =>
            Buffer.from(path === FIREFLIES_DELEGATE_KMS_PATH ? delegateBytes : kekBytes),
        },
        { host: HOST, env: { CONNECTOR_CREDENTIAL_MASTER: kekBytes.toString("base64") } },
      ),
    ).rejects.toThrow(/CONNECTOR_CREDENTIAL_MASTER/);

    await expect(
      deriveFirefliesImportKeys(
        {
          getKey: async (path) =>
            Buffer.from(path === FIREFLIES_DELEGATE_KMS_PATH ? delegateBytes : kekBytes),
        },
        { host: HOST, env: { WEBHOOK_HMAC_MASTER: kekBytes.toString("hex") } },
      ),
    ).rejects.toThrow(/WEBHOOK_HMAC_MASTER/);
  });
});

describe("encrypted FirefliesGrantStore", () => {
  it("registers delegations/fireflies-import/ in BACKEND_KV_ROOTS and is covered by the backend manifest", () => {
    expect(BACKEND_KV_ROOTS).toContain(FIREFLIES_IMPORT_GRANT_KEY_PREFIX);
    expect(() => assertBackendManifestCoversKvRoots(TINYCHAT_BACKEND_MANIFEST)).not.toThrow();
  });

  it("seals grants with AES-256-GCM + AAD (purpose, address, delegateDid) and never stores plaintext", async () => {
    const { delegate, grantKek } = await deriveFirefliesImportKeys(
      {
        getKey: async (path) =>
          Buffer.alloc(32, path === FIREFLIES_DELEGATE_KMS_PATH ? 0x61 : 0x62),
      },
      { host: HOST, env: {} },
    );
    const { rows, kv } = createMemoryKv();
    const store = new FirefliesGrantStore({ kv, kek: grantKek, delegateDid: delegate.did });
    const pair = await mintGrantPair(delegate.did);

    await store.store(pair.address, pair, pair.expiresAt);
    const key = `${FIREFLIES_IMPORT_GRANT_KEY_PREFIX}${pair.address.toLowerCase()}`;
    const storedJson = JSON.stringify(rows.get(key));
    expect(storedJson).toContain('"alg":"aes-256-gcm"');
    expect(storedJson).not.toContain(pair.siwe);
    expect(storedJson).not.toContain(pair.signature);
    expect(storedJson).not.toContain("FIREFLIES_API_KEY");
    expect(storedJson).not.toContain("Bearer ");

    const status = await store.status(pair.address, {
      configuredHost: HOST,
      deps: { computeDelegationCid },
      now: pair.now,
    });
    expect(status).toEqual({ state: "active", expiresAt: pair.expiresAt.toISOString() });

    // Writing again uses a fresh random 12-byte IV.
    const firstIv = (rows.get(key) as { iv: string }).iv;
    await store.store(pair.address, pair, pair.expiresAt);
    const secondIv = (rows.get(key) as { iv: string }).iv;
    expect(secondIv).not.toBe(firstIv);
  });

  it("fails closed on cross-tenant ciphertext relocation (AAD address binding)", async () => {
    const { delegate, grantKek } = await deriveFirefliesImportKeys(
      {
        getKey: async (path) =>
          Buffer.alloc(32, path === FIREFLIES_DELEGATE_KMS_PATH ? 0x71 : 0x72),
      },
      { host: HOST, env: {} },
    );
    const { rows, kv, writeCounts } = createMemoryKv();
    const store = new FirefliesGrantStore({ kv, kek: grantKek, delegateDid: delegate.did });
    const userA = await mintGrantPair(delegate.did);
    const userBAddress = privateKeyToAccount(generatePrivateKey()).address;

    await store.store(userA.address, userA, userA.expiresAt);
    // Attacker copies user A's ciphertext into user B's KV slot.
    const keyA = store.keyFor(userA.address);
    const keyB = store.keyFor(userBAddress);
    rows.set(keyB, structuredClone(rows.get(keyA)));

    const beforeWrites = writeCounts();
    const statusB = await store.status(userBAddress, {
      configuredHost: HOST,
      deps: { computeDelegationCid },
      now: userA.now,
    });
    expect(statusB).toEqual({ state: "needs_renewal", expiresAt: null });
    // GET status is strictly read-only and never overwrites KV.
    expect(writeCounts()).toEqual(beforeWrites);
  });

  it("invalidates stored grants when the backend delegate key or KEK rotates, while keeping status read-only", async () => {
    const keys1 = await deriveFirefliesImportKeys(
      {
        getKey: async (path) =>
          Buffer.alloc(32, path === FIREFLIES_DELEGATE_KMS_PATH ? 0x81 : 0x82),
      },
      { host: HOST, env: {} },
    );
    const keys2 = await deriveFirefliesImportKeys(
      {
        getKey: async (path) =>
          Buffer.alloc(32, path === FIREFLIES_DELEGATE_KMS_PATH ? 0x91 : 0x92),
      },
      { host: HOST, env: {} },
    );
    const { rows, kv, writeCounts } = createMemoryKv();
    const store1 = new FirefliesGrantStore({ kv, kek: keys1.grantKek, delegateDid: keys1.delegate.did });
    const pair = await mintGrantPair(keys1.delegate.did);
    await store1.store(pair.address, pair, pair.expiresAt);

    // Delegate DID rotated (same KEK, new delegate DID): status is read-only and reports needs_renewal.
    const storeRotatedDid = new FirefliesGrantStore({ kv, kek: keys1.grantKek, delegateDid: keys2.delegate.did });
    const writesBeforeStatus = writeCounts();
    expect(
      await storeRotatedDid.status(pair.address, {
        configuredHost: HOST,
        deps: { computeDelegationCid },
        now: pair.now,
      }),
    ).toEqual({ state: "needs_renewal", expiresAt: null });
    expect(writeCounts()).toEqual(writesBeforeStatus);

    // loadActive purges ciphertext on definitive delegate rotation.
    expect(
      await storeRotatedDid.loadActive(pair.address, {
        configuredHost: HOST,
        deps: { computeDelegationCid },
        now: pair.now,
      }),
    ).toEqual({ state: "needs_renewal", expiresAt: null });
    expect(JSON.stringify(rows.get(store1.keyFor(pair.address)))).not.toContain("ciphertext");

    // KEK rotated (same delegate DID, new KEK): fails GCM decryption cleanly without destroying ciphertext on read.
    await store1.store(pair.address, pair, pair.expiresAt);
    const storeRotatedKek = new FirefliesGrantStore({ kv, kek: keys2.grantKek, delegateDid: keys1.delegate.did });
    const beforeKekStatus = writeCounts();
    expect(
      await storeRotatedKek.status(pair.address, {
        configuredHost: HOST,
        deps: { computeDelegationCid },
        now: pair.now,
      }),
    ).toEqual({ state: "needs_renewal", expiresAt: null });
    expect(writeCounts()).toEqual(beforeKekStatus);
  });

  it("preserves stored ciphertext on transient CID/verify exceptions and corrupt reads", async () => {
    const { delegate, grantKek } = await deriveFirefliesImportKeys(
      {
        getKey: async (path) =>
          Buffer.alloc(32, path === FIREFLIES_DELEGATE_KMS_PATH ? 0x95 : 0x96),
      },
      { host: HOST, env: {} },
    );
    const { rows, kv, writeCounts } = createMemoryKv();
    const store = new FirefliesGrantStore({ kv, kek: grantKek, delegateDid: delegate.did });
    const pair = await mintGrantPair(delegate.did);
    await store.store(pair.address, pair, pair.expiresAt);
    const key = store.keyFor(pair.address);
    const originalRecord = structuredClone(rows.get(key));

    const throwingCid = () => {
      throw new Error("transient wasm cid failure");
    };
    const writesBefore = writeCounts();
    expect(
      await store.status(pair.address, {
        configuredHost: HOST,
        deps: { computeDelegationCid: throwingCid },
        now: pair.now,
      }),
    ).toEqual({ state: "needs_renewal", expiresAt: null });
    expect(
      await store.loadActive(pair.address, {
        configuredHost: HOST,
        deps: { computeDelegationCid: throwingCid },
        now: pair.now,
      }),
    ).toEqual({ state: "needs_renewal", expiresAt: null });
    // Stored ciphertext is completely untouched; subsequent valid read recovers active state.
    expect(writeCounts()).toEqual(writesBefore);
    expect(rows.get(key)).toEqual(originalRecord);
    expect(
      await store.status(pair.address, {
        configuredHost: HOST,
        deps: { computeDelegationCid },
        now: pair.now,
      }),
    ).toEqual({ state: "active", expiresAt: pair.expiresAt.toISOString() });
  });

  it("transitions expired grants to needs_renewal on loadActive, keeps status read-only, supports revoked markers and deletes cleanly", async () => {
    const { delegate, grantKek } = await deriveFirefliesImportKeys(
      {
        getKey: async (path) =>
          Buffer.alloc(32, path === FIREFLIES_DELEGATE_KMS_PATH ? 0xa1 : 0xa2),
      },
      { host: HOST, env: {} },
    );
    const { rows, kv, writeCounts } = createMemoryKv();
    const store = new FirefliesGrantStore({ kv, kek: grantKek, delegateDid: delegate.did });
    const pair = await mintGrantPair(delegate.did, { ttlMs: 2 * 86_400_000 });

    await store.store(pair.address, pair, pair.expiresAt);
    const beforeExpiredStatus = writeCounts();
    const afterExpiry = await store.status(pair.address, {
      configuredHost: HOST,
      deps: { computeDelegationCid },
      now: pair.expiresAt.getTime() + 1_000,
    });
    expect(afterExpiry).toEqual({ state: "needs_renewal", expiresAt: pair.expiresAt.toISOString() });
    expect(writeCounts()).toEqual(beforeExpiredStatus);

    // loadActive purges the definitively expired ciphertext.
    expect(
      await store.loadActive(pair.address, {
        configuredHost: HOST,
        deps: { computeDelegationCid },
        now: pair.expiresAt.getTime() + 1_000,
      }),
    ).toEqual({ state: "needs_renewal", expiresAt: pair.expiresAt.toISOString() });
    expect(JSON.stringify(rows.get(store.keyFor(pair.address)))).not.toContain("ciphertext");

    await store.markState(pair.address, "revoked", null);
    expect(
      await store.status(pair.address, { configuredHost: HOST, deps: { computeDelegationCid }, now: pair.now }),
    ).toEqual({ state: "revoked", expiresAt: null });

    await store.remove(pair.address);
    expect(
      await store.status(pair.address, { configuredHost: HOST, deps: { computeDelegationCid }, now: pair.now }),
    ).toEqual({ state: "none", expiresAt: null });

    expect(() => store.keyFor("../escape")).toThrow("fireflies_grant_owner_invalid");
  });
});
