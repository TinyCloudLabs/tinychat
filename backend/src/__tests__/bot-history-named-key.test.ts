import { expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { KeyDescriptor } from "@tinycloud/sdk-services/encryption/named-keys";
import { HistoryJournal } from "../../../bots/src/history";
import { botLayout } from "../../../bots/src/layout";
import { BotHistory, HISTORY_PREFIX, historyBotId, historyHash, historyOwner } from "../bot-history";
import {
  BOT_HISTORY_KEY_MAX_MS, BOT_HISTORY_KEY_PATH, botHistoryNetworkId, verifyBotHistoryKeyDescriptor,
} from "../bot-history-key";
import { createBotHistoryRouter } from "../routes/bot-history";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const ownerKey = generatePrivateKey();
const backendKey = generatePrivateKey();
const address = privateKeyToAccount(ownerKey).address;
const backendDid = historyOwner(privateKeyToAccount(backendKey).address);
const host = "http://127.0.0.1:9137";
const networkId = botHistoryNetworkId(address);
const directory = `${HISTORY_PREFIX}${historyBotId(address)}/`;
const spaceId = makePkhSpaceId(address, 1, "applications");
const signedGrant = (now = Date.now()) => makeSignedTranscriptGrant({
  privateKey: ownerKey, audience: backendDid, host, now, att: {
    [`${spaceId}/kv/${directory}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
  },
});

function storage() {
  const entries = new Map<string, { body: unknown; etag: string }>();
  let writes = 0;
  const reads = {
    get: async (key: string) => {
      const entry = entries.get(key);
      return entry ? { ok: true, data: { data: entry.body, headers: { etag: entry.etag } } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } };
    },
    put: async (key: string, body: unknown, options?: { ifMatch?: string; ifNoneMatch?: string }) => {
      const entry = entries.get(key);
      if ((options?.ifNoneMatch === "*" && entry) || (options?.ifMatch && options.ifMatch !== entry?.etag)) {
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
      }
      entries.set(key, { body, etag: `"${++writes}"` });
      return { ok: true, data: {} };
    },
  };
  return { ...reads, entries, writes: () => writes };
}

async function fixture() {
  const owned = storage();
  const service = storage();
  const encrypted: { path: string; descriptor: KeyDescriptor }[] = [];
  let failSeal = false;
  let networkEncryptions = 0;
  const node = {
    did: backendDid, computeDelegationCid, kv: service,
    useDelegation: async () => ({ kv: owned }),
    keys: {
      encrypt: async (path: string, _plaintext: Uint8Array, options: { aad: Uint8Array; descriptor: KeyDescriptor }) => {
        encrypted.push({ path, descriptor: options.descriptor });
        if (failSeal) throw new Error("key seal refused");
        return {
          v: 2, networkId, keyPath: path, keyVersion: options.descriptor.keyVersion,
          aad: Buffer.from(options.aad).toString("base64"), ciphertext: "named ciphertext",
        };
      },
    },
    encryption: { encryptToNetwork: async () => { networkEncryptions++; throw new Error("network fallback"); } },
  } as unknown as TinyCloudNode;
  const history = new BotHistory(node, backendKey, host);
  const grant = await signedGrant();
  await history.accept(address, grant);
  return { history, owned, service, grant, encrypted, failSeal: () => { failSeal = true; }, networkEncryptions: () => networkEncryptions };
}

const batch = {
  v: 1, generation: "ab".repeat(16), seq: 1, challenge: "cd".repeat(32),
  record: { type: "assistant", text: "named history" },
};

test("the authenticated descriptor route refuses another owner, network, key or session signature", async () => {
  const f = await fixture();
  const another = await makeSignedTranscriptGrant({ privateKey: generatePrivateKey() });
  let authenticatedOwner = address;
  const app = express();
  app.use("/history", createBotHistoryRouter(f.history, {
    serviceUrl: host, serviceSecret: "fixture", accountAllowed: () => true, postTimeoutMs: 1000,
  }, (req, _res, next) => { req.user = { address: authenticatedOwner } as typeof req.user; next(); }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const post = async (body: unknown) => fetch(`http://127.0.0.1:${port}/history/key`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const valid = f.grant.signKeyDescriptor();
    for (const rejected of [
      another.signKeyDescriptor(),
      another.signKeyDescriptor({ owner: valid.descriptor.owner, networkId }),
      f.grant.signKeyDescriptor({ networkId: networkId.replace(":default", ":other") }),
      f.grant.signKeyDescriptor({ keyPath: `${BOT_HISTORY_KEY_PATH}-other` }),
      { ...valid, descriptor: { ...valid.descriptor, keyVersion: 2 } },
      { ...valid, signerDid: another.sessionDid },
    ]) {
      expect((await post(rejected)).status).toBe(400);
    }
    authenticatedOwner = another.address;
    expect((await post(valid)).status).toBe(400);
    authenticatedOwner = address;
    expect((await post(valid)).status).toBe(200);
    await f.history.archive(address, batch, async () => {});
    expect(f.encrypted).toEqual([{ path: BOT_HISTORY_KEY_PATH, descriptor: expect.objectContaining({
      networkId, keyPath: BOT_HISTORY_KEY_PATH, kind: "deletable", state: "active",
      alg: valid.descriptor.alg, keyVersion: valid.descriptor.keyVersion, publicEncryptionKey: valid.descriptor.publicEncryptionKey,
    }) }]);
    expect(f.networkEncryptions()).toBe(0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("signed descriptors must be active, deletable, well formed and within the session and seven-day bounds", async () => {
  const now = Date.now();
  const grant = await signedGrant(now);
  const sec = Math.floor(now / 1000);
  for (const override of [
    { state: "deleted" }, { kind: "deterministic" }, { alg: "unknown" }, { keyVersion: 0 },
    { publicEncryptionKey: "bad==" }, { exp: sec }, { exp: sec + BOT_HISTORY_KEY_MAX_MS / 1000 + 1 },
    { iat: sec + 301, exp: sec + 3600 },
  ]) {
    const signed = grant.signKeyDescriptor(override as Parameters<typeof grant.signKeyDescriptor>[0]);
    await expect(verifyBotHistoryKeyDescriptor(address, signed, now)).rejects.toThrow();
  }
  const shorter = await makeSignedTranscriptGrant({
    privateKey: ownerKey, now, expirationTime: new Date(now + 90_000).toISOString(),
  });
  await expect(verifyBotHistoryKeyDescriptor(address, shorter.signKeyDescriptor({ exp: sec + 120 }), now)).rejects.toThrow("lifetime_exceeded");
});

test("pinned keys reject a different same-version public key and a version rollback", async () => {
  const f = await fixture();
  const original = f.grant.signKeyDescriptor({ keyVersion: 2 });
  await f.history.acceptKeyDescriptor(address, original);
  const publicEncryptionKey = Buffer.alloc(32, 9).toString("base64");
  await expect(f.history.acceptKeyDescriptor(address, f.grant.signKeyDescriptor({ keyVersion: 2, publicEncryptionKey })))
    .rejects.toThrow("history_key_mismatch");
  await expect(f.history.acceptKeyDescriptor(address, f.grant.signKeyDescriptor({ keyVersion: 1 })))
    .rejects.toThrow("history_key_version_downgrade");
  await f.history.acceptKeyDescriptor(address, f.grant.signKeyDescriptor({ keyVersion: 3, publicEncryptionKey }));
  await f.history.archive(address, batch, async () => {});
  expect(f.encrypted[0]?.descriptor).toMatchObject({ keyVersion: 3, publicEncryptionKey });
});

test("an older signed attestation cannot replace a newer pin for the same key", async () => {
  const f = await fixture();
  const older = await signedGrant(Date.now() - 2000);
  await f.history.acceptKeyDescriptor(address, f.grant.signKeyDescriptor());
  await expect(f.history.acceptKeyDescriptor(address, older.signKeyDescriptor()))
    .rejects.toThrow("history_key_descriptor_stale");
});

test("archive checks expiry again and never seals with the network key on any failure", async () => {
  const f = await fixture();
  await expect(f.history.archive(address, batch, async () => {})).rejects.toThrow("history_recipient_unavailable");
  const originalNow = Date.now;
  const now = originalNow();
  const grant = await signedGrant(now);
  const exp = Math.floor(now / 1000) + 2;
  await f.history.acceptKeyDescriptor(address, grant.signKeyDescriptor({ exp }));
  try {
    Date.now = () => exp * 1000;
    await expect(f.history.archive(address, batch, async () => {})).rejects.toThrow("history_key_descriptor_expired");
  } finally { Date.now = originalNow; }
  expect(f.encrypted).toEqual([]);
  await f.history.acceptKeyDescriptor(address, grant.signKeyDescriptor());
  f.failSeal();
  await expect(f.history.archive(address, batch, async () => {})).rejects.toThrow("history_encryption_failed");
  expect(f.owned.writes()).toBe(0);
  expect(f.networkEncryptions()).toBe(0);
});

for (const alreadyStored of [false, true]) {
  test(`journal rollout preserves a ${alreadyStored ? "committed" : "pending"} v1 stage across restart`, async () => {
    const f = await fixture();
    await f.history.acceptKeyDescriptor(address, f.grant.signKeyDescriptor());
    const tmp = mkdtempSync("/var/tmp/tc3823-journal-");
    try {
      const layout = botLayout(historyBotId(address), { dataRoot: join(tmp, "data"), egressRoot: join(tmp, "egress"), runRoot: join(tmp, "run") });
      const options = { host, signerDid: backendDid, policy: "notice-then-expiry-30-days" as const };
      let journal = new HistoryJournal(layout, options);
      journal.begin(historyOwner(address), 1000);
      journal.append({ type: "assistant", text: "legacy staged history" });
      const pending = journal.pending()!;
      const path = `${directory}${pending.generation}/${pending.seq}-${pending.challenge}`;
      const aad = Buffer.from(JSON.stringify({ owner: historyOwner(address), spaceId, path })).toString("base64");
      const legacy = { v: 1, networkId, aad, ciphertext: "old ciphertext" };
      journal.stage({ seq: pending.seq, challenge: pending.challenge, batchHash: historyHash(JSON.stringify(pending)), envelope: legacy });
      if (alreadyStored) {
        await f.owned.put(path, legacy);
      } else {
        await expect(f.history.archive(address, journal.pending(), async stage => {
          journal.stage(stage);
          throw new Error("simulated crash after stage");
        })).rejects.toThrow("simulated crash");
        expect(f.owned.entries.has(path)).toBe(false);
      }

      journal = new HistoryJournal(layout, options);
      const recovered = journal.pending()!;
      expect(recovered.record).toEqual(pending.record);
      expect(recovered.staged?.envelope).toHaveProperty("v", alreadyStored ? 1 : 2);
      if (!alreadyStored) {
        expect(() => journal.stage({ ...recovered.staged!, envelope: { ...legacy, v: 2, keyPath: BOT_HISTORY_KEY_PATH } }))
          .toThrow("history_stage_conflict");
      }
      const first = await f.history.archive(address, recovered, async () => { throw new Error("unexpected restage"); });
      const retry = await f.history.archive(address, recovered, async () => { throw new Error("unexpected restage"); });
      expect(retry).toEqual(first);
      expect(f.owned.writes()).toBe(1);
      expect(f.owned.entries.get(path)?.body).toEqual(recovered.staged?.envelope);
      if (alreadyStored) expect(f.encrypted).toEqual([]);
      await journal.accept(first);
      expect(await journal.verifyCoverage()).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test("a committed v1 stage receives a receipt for the owner's bound v2 reseal", async () => {
  const f = await fixture();
  const path = `${directory}${batch.generation}/${batch.seq}-${batch.challenge}`;
  const aad = Buffer.from(JSON.stringify({ owner: historyOwner(address), spaceId, path })).toString("base64");
  const legacy = { v: 1, networkId, aad, ciphertext: "v1 ciphertext" };
  const input = {
    ...batch, staged: { seq: batch.seq, challenge: batch.challenge, batchHash: historyHash(JSON.stringify(batch)), envelope: legacy },
  };
  const resealed = { v: 2, keyPath: BOT_HISTORY_KEY_PATH, keyVersion: 1, networkId, aad, ciphertext: "resealed ciphertext" };
  const noStage = async () => { throw new Error("unexpected restage"); };
  for (const mismatch of [{ aad: "wrong" }, { networkId: "wrong" }, { keyPath: "wrong" }]) {
    await f.owned.put(path, { ...resealed, ...mismatch });
    await expect(f.history.archive(address, input, noStage)).rejects.toThrow("history_integrity_failure");
  }
  await f.owned.put(path, resealed);
  const writes = f.owned.writes();
  const receipt = await f.history.archive(address, input, noStage);
  expect(receipt.body.ciphertextHash).toBe(historyHash(JSON.stringify(resealed)));
  expect(await f.history.archive(address, input, noStage)).toEqual(receipt);
  expect(f.owned.writes()).toBe(writes);
  expect(f.encrypted).toEqual([]);
});

test("an uncommitted named stage can advance to a newer pinned key and survives restart", async () => {
  const f = await fixture();
  await f.history.acceptKeyDescriptor(address, f.grant.signKeyDescriptor({ keyVersion: 2 }));
  const tmp = mkdtempSync("/var/tmp/tc3823-rotated-journal-");
  try {
    const layout = botLayout(historyBotId(address), { dataRoot: join(tmp, "data"), egressRoot: join(tmp, "egress"), runRoot: join(tmp, "run") });
    const options = { host, signerDid: backendDid, policy: "notice-then-expiry-30-days" as const };
    let journal = new HistoryJournal(layout, options);
    journal.begin(historyOwner(address), 1000);
    journal.append({ type: "assistant", text: "stage before rotation" });
    const pending = journal.pending()!;
    const path = `${directory}${pending.generation}/${pending.seq}-${pending.challenge}`;
    const aad = Buffer.from(JSON.stringify({ owner: historyOwner(address), spaceId, path })).toString("base64");
    const previous = {
      seq: pending.seq, challenge: pending.challenge, batchHash: historyHash(JSON.stringify(pending)),
      envelope: { v: 2, keyPath: BOT_HISTORY_KEY_PATH, keyVersion: 1, networkId, aad, ciphertext: "old ciphertext" },
    };
    journal.stage(previous);

    await expect(f.history.archive(address, journal.pending(), async stage => {
      journal.stage(stage);
      throw new Error("simulated crash after rotation restage");
    })).rejects.toThrow("simulated crash");
    expect(f.owned.writes()).toBe(0);

    journal = new HistoryJournal(layout, options);
    expect(journal.pending()?.staged?.envelope).toHaveProperty("keyVersion", 2);
    expect(() => journal.stage(previous)).toThrow("history_stage_conflict");
    const receipt = await f.history.archive(address, journal.pending(), async () => { throw new Error("unexpected restage"); });
    expect(f.owned.entries.get(path)?.body).toHaveProperty("keyVersion", 2);
    expect(f.encrypted).toHaveLength(1);
    await journal.accept(receipt);
    expect(await journal.verifyCoverage()).toBe(true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
