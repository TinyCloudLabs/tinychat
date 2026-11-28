// TC-4354: a key root the backend's own session was not granted fails only at request time, as a 503 behind a bare
// catch. Every key-root constant must be exported, listed in BACKEND_KV_ROOTS and granted by the sign-in manifest, so
// the boot guard refuses such a release instead. Records written by 0.13.4 must still open with this code.
import { expect, test } from "bun:test";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BACKEND_KV_ROOTS } from "../backend-kv-roots.js";
import { BOT_HISTORY_GRANT_KEY_PREFIX, BotHistory, HISTORY_PREFIX, historyBotId, historyOwner } from "../bot-history.js";
import { assertBackendManifestCoversKvRoots, TINYCHAT_BACKEND_MANIFEST } from "../startup.js";
import { TRUSTBOT_READ_GRANT_KEY_PREFIX, TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant.js";

const SRC = join(import.meta.dir, "..");
const KEY_ROOT = /^(export\s+)?const\s+([A-Z0-9_]+_KEY_PREFIX)\b/gm;

/** Every `*_KEY_PREFIX` constant in backend/src, outside tests, with the module that declares it. */
function keyRootDeclarations() {
  const found: { file: string; name: string; exported: boolean }[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(SRC)) {
    if (file.startsWith("__tests__/") || file.endsWith(".d.ts")) continue;
    for (const match of readFileSync(join(SRC, file), "utf8").matchAll(KEY_ROOT)) {
      found.push({ file, name: match[2]!, exported: match[1] !== undefined });
    }
  }
  return found;
}

test("every key-root constant is exported, listed in BACKEND_KV_ROOTS and granted by the backend manifest", async () => {
  const declarations = keyRootDeclarations();
  expect(declarations.length).toBeGreaterThan(0);
  expect(declarations.filter(entry => !entry.exported).map(entry => `${entry.file}: ${entry.name}`)).toEqual([]);
  const roots: string[] = [];
  for (const { file, name } of declarations) {
    // The module is found by scanning, so a root added in a new file is checked without editing this test.
    const module: Record<string, unknown> = await import(join(SRC, file));
    const value = module[name];
    if (typeof value !== "string" || value === "") throw new Error(`${relative(SRC, join(SRC, file))}: ${name} is not a key root`);
    roots.push(value);
  }
  expect(roots.filter(root => !BACKEND_KV_ROOTS.includes(root))).toEqual([]);
  expect(() => assertBackendManifestCoversKvRoots(TINYCHAT_BACKEND_MANIFEST, roots)).not.toThrow();
});

/** AES-256-GCM sealing exactly as 0.13.4 (787b3319) wrote both records: nonce, ciphertext, tag; AAD is the key. */
function seal0134(secret: Uint8Array, purpose: string, key: string, value: unknown): string {
  const sealKey = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), purpose, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey, nonce);
  cipher.setAAD(Buffer.from(key));
  return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

test("a TrustBot read-grant record written by 0.13.4 opens with this code", async () => {
  const owner = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const sealSecret = new Uint8Array(randomBytes(32));
  const keyPrefix = `${TRUSTBOT_READ_GRANT_KEY_PREFIX}v1/reader/`;
  const now = Date.now();
  // 0.13.4's record: areas never empty, no deniedChatIds, replacedGrantCid left out when there was none.
  const record = { v: 1, areas: ["meetings"], cid: "bafy-0134", expiresAt: now + 86_400_000, mintedAt: now, serialized: "{}", siwe: "siwe", signature: "0x" };
  const stored = new Map([[`${keyPrefix}${owner}`, seal0134(sealSecret, "tinychat.trustbot-reads.grants/v1", `${keyPrefix}${owner}`, record)]]);
  const grants = new TrustBotReadGrants({
    reader: { did: "did:key:z6MkReader", useDelegation: async () => { throw new Error("not activated here"); }, computeDelegationCid },
    store: { get: async key => stored.get(key), put: async () => true, delete: async () => true },
    host: "http://127.0.0.1:9", sealSecret, keyPrefix, now: () => now,
  });
  expect(await grants.status(owner)).toEqual({ expiresAt: record.expiresAt, grantCid: "bafy-0134", areas: { meetings: "on", feed_chats: "off" } });
  expect(await grants.renewalStatus(owner)).toMatchObject({ grantCid: "bafy-0134", renewAfter: now + 43_200_000, replacedGrantCid: null });
  expect([...await grants.deniedChatIds(owner)]).toEqual([]);
});

test("a bot-history grant record written by 0.13.4 opens and is used with this code", async () => {
  const ownerKey = generatePrivateKey();
  const backendKey = generatePrivateKey();
  const address = privateKeyToAccount(ownerKey).address;
  const backendDid = historyOwner(privateKeyToAccount(backendKey).address);
  const host = "http://127.0.0.1:9";
  const directory = `${HISTORY_PREFIX}${historyBotId(address)}/`;
  const att = { [`${makePkhSpaceId(address, 1, "applications")}/kv/${directory}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } };
  const grant = await makeSignedTranscriptGrant({ privateKey: ownerKey, audience: backendDid, host, att });
  const key = `${BOT_HISTORY_GRANT_KEY_PREFIX}${address.toLowerCase()}`;
  const validUntil = grant.expiresAt.getTime();
  // 0.13.4's envelope: the request body plus expiresAt and revision, and no renewal.
  const envelope = { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature, expiresAt: validUntil, revision: 1 };
  const sealed = seal0134(Buffer.from(backendKey.slice(2), "hex"), "tinychat.bot-history.grants/v1", key, envelope);
  const node = {
    did: backendDid, computeDelegationCid,
    kv: {
      get: async (path: string) => path === key ? { ok: true, data: { data: sealed, headers: { etag: "\"1\"" } } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${path}`, service: "kv" } },
    },
    useDelegation: async () => ({ kv: {} }),
  } as unknown as TinyCloudNode;
  expect(await new BotHistory(node, backendKey, host).grantPermission(address)).toEqual({ cid: grant.cid, revision: 1, validUntil });
});
