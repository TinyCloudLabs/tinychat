// TC-4322: a session restored through its renewal lease runs past its SIWE's signed end. The backend takes the renewed
// end only from the bearer that /api/auth/verify-renewal issued, for the same owner and the same session key, and
// never from the request body.
import { afterEach, expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { issueSessionToken, verifySession, verifySessionToken, type SessionRenewal } from "@tinyboilerplate/server";
import { BotHistory, HISTORY_PREFIX, historyBotId, historyOwner } from "../bot-history";
import { projectBotHistoryGrant } from "../bot-history-grant";
import { BOT_HISTORY_KEY_PATH, botHistoryNetworkId, verifyBotHistoryKeyDescriptor } from "../bot-history-key";
import { createAuthMiddleware } from "../middleware/auth";
import { createBotHistoryRouter } from "../routes/bot-history";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const SESSION_KEY = "synthetic-renewed-session-key";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ownerKey = generatePrivateKey();
const backendKey = generatePrivateKey();
const address = privateKeyToAccount(ownerKey).address;
const backendDid = historyOwner(privateKeyToAccount(backendKey).address);
const host = "http://127.0.0.1:9137";
const directory = `${HISTORY_PREFIX}${historyBotId(address)}/`;
const spaceId = makePkhSpaceId(address, 1, "applications");
const historyAtt = { [`${spaceId}/kv/${directory}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } };
const seconds = (ms: number) => Math.floor(ms / 1000);

/** A session whose SIWE ended an hour ago; its grant to the backend and its descriptor end at `grantEnd`. */
async function lapsedSession(now: number, grantEnd = now + 2 * DAY) {
  return makeSignedTranscriptGrant({
    privateKey: ownerKey, now, audience: backendDid, host, att: historyAtt,
    expirationTime: new Date(now - HOUR).toISOString(), expiresAt: seconds(grantEnd),
  });
}

const renewalFor = (sessionDid: string, end: number): SessionRenewal => ({ sessionDid, end: seconds(end) });

function storage() {
  const entries = new Map<string, { body: unknown; etag: string }>();
  let writes = 0;
  return {
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
}

function history() {
  const sealedTo: unknown[] = [];
  const node = {
    did: backendDid, computeDelegationCid, kv: storage(),
    useDelegation: async () => ({ kv: storage() }),
    keys: {
      encrypt: async (path: string, _plaintext: Uint8Array, options: { aad: Uint8Array; descriptor: { keyVersion: number } }) => {
        sealedTo.push(options.descriptor);
        return { v: 2, networkId: botHistoryNetworkId(address), keyPath: path, keyVersion: options.descriptor.keyVersion, aad: Buffer.from(options.aad).toString("base64"), ciphertext: "sealed" };
      },
    },
    encryption: { encryptToNetwork: async () => { throw new Error("network fallback"); } },
  } as unknown as TinyCloudNode;
  return { history: new BotHistory(node, backendKey, host), sealedTo };
}

const batch = { v: 1, generation: "ab".repeat(16), seq: 1, challenge: "cd".repeat(32), record: { type: "assistant", text: "renewed history" } };

const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

test("the session bearer carries the renewal it was issued for, and only a token signed by this backend does", async () => {
  const now = realNow();
  const renewal = renewalFor("did:key:z6MkSessionKey", now + 3 * DAY);
  const { token } = await issueSessionToken(address, SESSION_KEY, { notAfter: new Date(now + DAY), renewal });
  expect(await verifySession(token, SESSION_KEY)).toEqual({ address: address.toLowerCase(), renewal });
  expect(await verifySessionToken(token, SESSION_KEY)).toEqual({ address: address.toLowerCase() });

  const plain = await issueSessionToken(address, SESSION_KEY);
  expect(await verifySession(plain.token, SESSION_KEY)).toEqual({ address: address.toLowerCase() });

  const forged = await issueSessionToken(address, "another-backend-key", { renewal: renewalFor("did:key:z6MkSessionKey", now + 80 * DAY) });
  await expect(verifySession(forged.token, SESSION_KEY)).rejects.toThrow();
});

test("a descriptor past the SIWE end is accepted up to the renewed end for the same session key", async () => {
  const now = realNow();
  const session = await lapsedSession(now);
  const signed = session.signKeyDescriptor({ exp: seconds(now + 2 * DAY) });
  const verified = await verifyBotHistoryKeyDescriptor(address, signed, now, renewalFor(session.sessionDid, now + 3 * DAY));
  expect(verified.expiresAtMs).toBe(seconds(now + 2 * DAY) * 1000);
});

test("a descriptor past the SIWE end is refused without a renewal, for another session key, past the renewed end or after the renewal ended", async () => {
  const now = realNow();
  const session = await lapsedSession(now);
  const other = await lapsedSession(now);
  const signed = session.signKeyDescriptor({ exp: seconds(now + 2 * DAY) });
  await expect(verifyBotHistoryKeyDescriptor(address, signed, now)).rejects.toThrow("history_key_descriptor_rejected");
  await expect(verifyBotHistoryKeyDescriptor(address, signed, now, renewalFor(other.sessionDid, now + 3 * DAY)))
    .rejects.toThrow("history_key_descriptor_rejected");
  await expect(verifyBotHistoryKeyDescriptor(address, signed, now, renewalFor(session.sessionDid, now + DAY)))
    .rejects.toThrow("history_key_descriptor_lifetime_exceeded");
  await expect(verifyBotHistoryKeyDescriptor(address, session.signKeyDescriptor({ exp: seconds(now + 2 * HOUR) }), now,
    renewalFor(session.sessionDid, now - 60_000))).rejects.toThrow("history_key_descriptor_rejected");
});

test("the descriptor route takes the renewal from the verify-renewal bearer, never from the body", async () => {
  const now = realNow();
  const session = await lapsedSession(now);
  const other = await lapsedSession(now);
  const { history: store, sealedTo } = history();
  await store.accept(address, await makeSignedTranscriptGrant({ privateKey: ownerKey, audience: backendDid, host, att: historyAtt }));
  const app = express();
  app.use("/history", createBotHistoryRouter(store, {
    serviceUrl: host, serviceSecret: "fixture", accountAllowed: () => true, postTimeoutMs: 1000,
  }, createAuthMiddleware(SESSION_KEY)));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const bearer = async (renewal?: SessionRenewal) =>
    (await issueSessionToken(address, SESSION_KEY, { notAfter: new Date(now + DAY), ...(renewal ? { renewal } : {}) })).token;
  const post = async (token: string, body: unknown) => fetch(`http://127.0.0.1:${port}/history/key`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  try {
    const signed = session.signKeyDescriptor({ exp: seconds(now + 2 * DAY) });
    const renewal = renewalFor(session.sessionDid, now + 3 * DAY);
    expect((await post(await bearer(), signed)).status).toBe(400);
    expect((await post(await bearer(), { ...signed, renewal })).status).toBe(400);
    expect((await post(await bearer(renewalFor(other.sessionDid, now + 3 * DAY)), signed)).status).toBe(400);
    const accepted = await post(await bearer(renewal), signed);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ validUntil: seconds(now + 2 * DAY) * 1000 });

    // Sealing reads the stored descriptor back later, with no bearer: the renewal stored beside it carries the session.
    await store.archive(address, batch, async () => {});
    expect(sealedTo).toEqual([expect.objectContaining({ keyPath: BOT_HISTORY_KEY_PATH, keyVersion: 1 })]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a history grant past the SIWE end is accepted only up to the renewed end of the same session key", async () => {
  const now = realNow();
  const session = await lapsedSession(now);
  const other = await lapsedSession(now);
  const node = { did: backendDid, computeDelegationCid } as TinyCloudNode;
  const envelope = { serialized: session.serialized, siwe: session.siwe, signature: session.signature };
  const grant = await projectBotHistoryGrant(node, host, address, envelope, undefined, renewalFor(session.sessionDid, now + 3 * DAY));
  expect(grant.expiresAt.getTime()).toBe(seconds(now + 2 * DAY) * 1000);

  await expect(projectBotHistoryGrant(node, host, address, envelope)).rejects.toThrow("history_grant_rejected");
  await expect(projectBotHistoryGrant(node, host, address, envelope, undefined, renewalFor(other.sessionDid, now + 3 * DAY)))
    .rejects.toThrow("history_grant_rejected");
  await expect(projectBotHistoryGrant(node, host, address, envelope, undefined, renewalFor(session.sessionDid, now + DAY)))
    .rejects.toThrow("history_grant_rejected");
});

test("a stored renewed grant is checked against the renewal stored with it each time it is used", async () => {
  const now = realNow();
  const session = await lapsedSession(now, now + 2 * HOUR);
  const { history: store } = history();
  const envelope = { serialized: session.serialized, siwe: session.siwe, signature: session.signature };
  await expect(store.accept(address, envelope)).rejects.toThrow("history_grant_rejected");
  await store.accept(address, envelope, undefined, renewalFor(session.sessionDid, now + 3 * DAY));
  expect(await store.grantPermission(address)).toMatchObject({ validUntil: seconds(now + 2 * HOUR) * 1000 });
  Date.now = () => now + 2 * HOUR;
  expect(await store.grantPermission(address)).toBeUndefined();
});
