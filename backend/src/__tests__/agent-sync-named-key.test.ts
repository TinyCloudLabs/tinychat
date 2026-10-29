import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePkhSpaceId, pkhDid } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  hasNamedGrantFile, installNamedGrant, NamedGrantError, prepareFirefliesKeySource, readNamedFirefliesKey,
  readNamedGrantFile, verifyNamedGrant,
} from "../../../scripts/agent-sync/named-grant";
import { runFirefliesAgentSync } from "../../../scripts/agent-sync/fireflies";

const ADDRESS = "0x67b11c05Df4909Ed3372e27067C7e9225C11ff82";
const OWNER = pkhDid(ADDRESS, 1);
const SPACE = makePkhSpaceId(ADDRESS, 1, "applications");
const NETWORK = `urn:tinycloud:encryption:${OWNER}:default`;
const KEY_PATH = "apps/chat.tinycloud.tinychat/connectors/fireflies";
const KV_PATH = "xyz.tinycloud.tinychat/connectors/credentials/fireflies";
const KEY_URI = `${NETWORK}/${KEY_PATH}`;
const KV_URI = `${SPACE}/kv/${KV_PATH}`;
const HOST = "http://127.0.0.1:12345";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (value > 0n) { out = alphabet[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out;
}

const signerDid = `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]),
  publicKey.export({ format: "der", type: "spki" }).subarray(-32)]))}`;
const recipient = `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.alloc(32, 9)]))}`;
const expiry = Math.floor(Date.now() / 1000) + 3600;
const cidNode = { computeDelegationCid: () => "bafy-test-child" } as unknown as TinyCloudNode;
const originalEnv = Object.fromEntries(["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR"]
  .map((key) => [key, process.env[key]]));
const testHome = mkdtempSync("/var/tmp/tc2140-agent-home-");
if (!testHome.startsWith("/var/tmp/")) throw new Error("test home must be isolated");
process.env.HOME = testHome;
process.env.TC_HOME = join(testHome, "tinycloud");
process.env.COURIER_HOME = join(testHome, "courier");
process.env.BUN_INSTALL_CACHE_DIR = join(testHome, "bun-cache");

function artifact(editClaims?: (claims: Record<string, unknown>) => void) {
  const claims: Record<string, unknown> = {
    iss: signerDid, aud: recipient, exp: expiry, prf: ["bafy-parent"],
    fct: [{ "xyz.tinycloud.policy/delegationMode": "terminal" }],
    att: {
      [KV_URI]: { "tinycloud.kv/get": [{}] },
      [KEY_URI]: { "tinycloud.encryption/decrypt": [{}] },
    },
  };
  editClaims?.(claims);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const token = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
  return {
    kind: "tinychat.fireflies.named-grant", version: 1, ownerDid: OWNER, recipientDid: recipient,
    cid: "bafy-test-child", expiresAt: new Date(Number(claims.exp) * 1000).toISOString(),
    delegation: {
      cid: "bafy-test-child", delegationHeader: { Authorization: token }, spaceId: SPACE,
      path: KV_PATH, actions: ["tinycloud.kv/get"],
      resources: [
        { service: "kv", space: SPACE, path: KV_PATH, actions: ["tinycloud.kv/get"] },
        { service: "encryption", space: "encryption", path: KEY_URI, actions: ["tinycloud.encryption/decrypt"] },
      ],
      disableSubDelegation: true, expiry: new Date(Number(claims.exp) * 1000).toISOString(),
      delegateDID: recipient, ownerAddress: ADDRESS, chainId: 1, host: HOST,
    },
  };
}

const verify = (value: unknown, owner = OWNER, audience = recipient) =>
  verifyNamedGrant(value, cidNode, owner, audience, HOST);

let temp: string | null = null;
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = null; });
afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testHome, { recursive: true, force: true });
});

describe("Fireflies agent named grant", () => {
  test("file absence selects the legacy source; an installed file selects named", () => {
    temp = mkdtempSync("/var/tmp/tc2140-agent-grant-");
    const file = join(temp, "fireflies-named-grant.json");
    expect(hasNamedGrantFile(file)).toBe(false);
    writeFileSync(file, JSON.stringify(artifact()), { mode: 0o600 });
    expect(hasNamedGrantFile(file)).toBe(true);
    expect(verify(readNamedGrantFile(file)).cid).toBe("bafy-test-child");
    chmodSync(file, 0o644);
    expect(() => readNamedGrantFile(file)).toThrow(NamedGrantError);
  });

  test("signed two-resource terminal child is installed and reads the v2 named envelope only", async () => {
    const grant = verify(artifact());
    let installs = 0, gets = 0, decrypts = 0;
    const node = {
      async useRuntimeDelegation(value: unknown) { installs++; expect(value).toEqual(grant.delegation); },
      kvForSpace(space: string) {
        expect(space).toBe(SPACE);
        return { async get(path: string, options: unknown) {
          gets++; expect(path).toBe(KV_PATH); expect(options).toEqual({ source: "network" });
          return { ok: true, data: { data: JSON.stringify({ v: 2, networkId: NETWORK, keyPath: KEY_PATH }) } };
        } };
      },
      keys: { async decrypt() { decrypts++; return new TextEncoder().encode("private-fireflies-token"); } },
    } as unknown as TinyCloudNode;
    await installNamedGrant(node, grant);
    expect(await readNamedFirefliesKey(node, grant)).toBe("private-fireflies-token");
    expect([installs, gets, decrypts]).toEqual([1, 1, 1]);
    expect(JSON.stringify({ key_source: "named", named_grant_cid: grant.cid, named_grant_expires_at: grant.expiresAt }))
      .not.toContain("private-fireflies-token");
  });

  test("source choice reads the legacy key only when no artifact is installed", async () => {
    temp = mkdtempSync("/var/tmp/tc2140-agent-source-");
    const file = join(temp, "fireflies-named-grant.json");
    let legacyReads = 0, namedReads = 0, installs = 0;
    const node = {
      computeDelegationCid: () => "bafy-test-child",
      async useRuntimeDelegation() { installs++; },
      kvForSpace: () => ({ get: async () => ({ ok: true, data: { data: { v: 2, networkId: NETWORK, keyPath: KEY_PATH } } }) }),
      keys: { async decrypt() { namedReads++; return new TextEncoder().encode("named-secret"); } },
    } as unknown as TinyCloudNode;
    const input = {
      file, node, ownerDid: OWNER, recipientDid: recipient, host: HOST,
      readLegacyKey: async () => { legacyReads++; return "legacy-secret"; },
    };
    const legacy = await prepareFirefliesKeySource(input);
    expect(legacy.keySource).toBe("legacy");
    expect(await legacy.readApiKey()).toBe("legacy-secret");
    writeFileSync(file, JSON.stringify(artifact()), { mode: 0o600 });
    const named = await prepareFirefliesKeySource(input);
    expect(named.keySource).toBe("named");
    expect(named.namedGrant).toMatchObject({ cid: "bafy-test-child" });
    expect(await named.readApiKey()).toBe("named-secret");
    expect([legacyReads, namedReads, installs]).toEqual([1, 1, 1]);
    writeFileSync(file, "{}", { mode: 0o600 });
    await expect(prepareFirefliesKeySource(input)).rejects.toMatchObject({ result: "needs_renewal" });
    expect(legacyReads).toBe(1);
  });

  test("signed scope and artifact metadata refusals", () => {
    const alterations: Array<[string, (value: ReturnType<typeof artifact>) => void]> = [
      ["wrong owner", (v) => { v.ownerDid = pkhDid("0x0000000000000000000000000000000000000001", 1); }],
      ["wrong audience metadata", (v) => { v.recipientDid = signerDid; }],
      ["wrong CID", (v) => { v.cid = "other"; }],
      ["wrong expiry metadata", (v) => { v.expiresAt = new Date((expiry - 1) * 1000).toISOString(); }],
      ["wrong resource metadata", (v) => { v.delegation.resources[1].path = `${NETWORK}/apps/other/`; }],
      ["resource caveat metadata", (v) => { (v.delegation.resources[1] as Record<string, unknown>).caveats = [{ limit: 1 }]; }],
      ["unprotected child metadata", (v) => { v.delegation.disableSubDelegation = false; }],
      ["wrong host", (v) => { v.delegation.host = "https://other.example"; }],
      ["changed signature", (v) => { v.delegation.delegationHeader.Authorization += "a"; }],
    ];
    for (const [name, change] of alterations) {
      const value = artifact(); change(value);
      expect(() => verify(value), name).toThrow(NamedGrantError);
    }
    expect(() => verify(artifact(), pkhDid("0x0000000000000000000000000000000000000001", 1))).toThrow(NamedGrantError);
  });

  test("every signed scope expansion or partial grant is refused", () => {
    const edits: Array<[string, (claims: Record<string, unknown>) => void]> = [
      ["extra ability", (c) => { (c.att as Record<string, unknown>)[KV_URI] = { "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}] }; }],
      ["missing KV", (c) => { delete (c.att as Record<string, unknown>)[KV_URI]; }],
      ["missing decrypt", (c) => { delete (c.att as Record<string, unknown>)[KEY_URI]; }],
      ["other folder", (c) => { const a = c.att as Record<string, unknown>; a[`${NETWORK}/apps/chat.tinycloud.tinychat/connectors/other`] = a[KEY_URI]; delete a[KEY_URI]; }],
      ["other network", (c) => { const a = c.att as Record<string, unknown>; a[`${NETWORK}-other/${KEY_PATH}`] = a[KEY_URI]; delete a[KEY_URI]; }],
      ["other KV path", (c) => { const a = c.att as Record<string, unknown>; a[`${SPACE}/kv/other`] = a[KV_URI]; delete a[KV_URI]; }],
      ["bare network", (c) => { const a = c.att as Record<string, unknown>; a[NETWORK] = a[KEY_URI]; delete a[KEY_URI]; }],
      ["extra row", (c) => { (c.att as Record<string, unknown>)[`${SPACE}/kv/other`] = { "tinycloud.kv/get": [{}] }; }],
      ["caveat", (c) => { (c.att as Record<string, unknown>)[KEY_URI] = { "tinycloud.encryption/decrypt": [{ limit: 1 }] }; }],
      ["not terminal", (c) => { c.fct = []; }],
      ["expired", (c) => { c.exp = Math.floor(Date.now() / 1000) - 1; }],
      ["future nbf", (c) => { c.nbf = Math.floor(Date.now() / 1000) + 60; }],
      ["other recipient", (c) => { c.aud = signerDid; }],
    ];
    for (const [name, edit] of edits) expect(() => verify(artifact(edit)), name).toThrow(NamedGrantError);
  });

  test("recipient mismatch at runtime reports renewal", async () => {
    const node = { async useRuntimeDelegation() { throw new Error("Runtime delegation targets another DID"); } } as unknown as TinyCloudNode;
    await expect(installNamedGrant(node, verify(artifact()))).rejects.toMatchObject({ result: "needs_renewal" });
  });

  test("v1 and wrong-target envelopes are refused without decrypting", async () => {
    const grant = verify(artifact());
    let decrypts = 0;
    for (const envelope of [
      { v: 1, networkId: NETWORK, keyPath: KEY_PATH },
      { v: 2, networkId: `${NETWORK}-other`, keyPath: KEY_PATH },
      { v: 2, networkId: NETWORK, keyPath: `${KEY_PATH}-other` },
    ]) {
      const node = {
        kvForSpace: () => ({ get: async () => ({ ok: true, data: { data: envelope } }) }),
        keys: { decrypt: async () => { decrypts++; return new Uint8Array(); } },
      } as unknown as TinyCloudNode;
      await expect(readNamedFirefliesKey(node, grant)).rejects.toMatchObject({ result: "needs_reconnect" });
    }
    expect(decrypts).toBe(0);
  });

  test("a node denial on named KV or decrypt remains a renewal result", async () => {
    const grant = verify(artifact());
    const deniedKv = {
      kvForSpace: () => ({ get: async () => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED" } }) }),
    } as unknown as TinyCloudNode;
    await expect(readNamedFirefliesKey(deniedKv, grant)).rejects.toMatchObject({ result: "needs_renewal" });
    const deniedDecrypt = {
      kvForSpace: () => ({ get: async () => ({ ok: true, data: { data: { v: 2, networkId: NETWORK, keyPath: KEY_PATH } } }) }),
      keys: { decrypt: async () => { throw new Error("denied"); } },
    } as unknown as TinyCloudNode;
    await expect(readNamedFirefliesKey(deniedDecrypt, grant)).rejects.toMatchObject({ result: "needs_renewal" });
  });

  test("JSON report names its key source and has no credential text", async () => {
    temp = mkdtempSync("/var/tmp/tc2140-agent-report-");
    const common = {
      tcw: {} as TinyCloudWeb, audit: { tables: async () => ({ counts: {}, schemaHash: "" }), siblingsOf: async () => [], deleteOwnRow: async () => {} },
      stateDir: temp, mode: "auto" as const,
    };
    const legacy = await runFirefliesAgentSync({ ...common, readApiKey: async () => "private-fireflies-token" });
    const named = await runFirefliesAgentSync({ ...common, keySource: "named", namedGrant: { cid: "bafy-test-child", expiresAt: "2026-11-27T00:00:00.000Z" }, readApiKey: async () => "private-fireflies-token" });
    expect(legacy.key_source).toBe("legacy");
    expect(named.key_source).toBe("named");
    expect(named.named_grant_cid).toBe("bafy-test-child");
    expect(JSON.stringify(named)).not.toContain("private-fireflies-token");
  });
});
