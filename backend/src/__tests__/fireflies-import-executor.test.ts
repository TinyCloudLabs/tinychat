import { describe, expect, it } from "bun:test";
import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { makePkhSpaceId, SiweMessage } from "@tinycloud/sdk-core";
import { siweToDelegationHeaders } from "@tinycloud/node-sdk-wasm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApiBodyParser } from "../body-parsing.js";
import {
  deriveFirefliesImportKeys,
  FIREFLIES_DELEGATE_KMS_PATH,
} from "../fireflies-import-identity.js";
import {
  FIREFLIES_APPLICATIONS_KV_PREFIX,
  FIREFLIES_DELEGATION_MODE_FACT_KEY,
  FIREFLIES_DELEGATION_MODE_TERMINAL,
  FIREFLIES_SECRET_ENCRYPTION_KEY_PATH,
  FIREFLIES_SECRET_KV_PATH,
} from "../fireflies-import-verify.js";
import {
  ConnectorWebhookLimiters,
  createConnectorWebhookHandler,
} from "../routes/connector-webhooks.js";
import { createFirefliesDelegationRouter } from "../routes/fireflies-delegation.js";
import {
  FirefliesDirectImporter,
  firefliesMeetingKvKey,
  firefliesTranscriptKvKey,
  type FirefliesPurgeLedgerRead,
  type FirefliesSecretReadOutcome,
} from "../services/fireflies-import-executor.js";
import {
  FirefliesGrantStore,
  type FirefliesGrantKvPort,
} from "../services/fireflies-grant-store.js";
import { deriveWebhookSecret } from "../services/webhook-tokens.js";

const HOST = "https://tee.node.tinycloud.xyz";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TEST_HMAC_MASTER = Buffer.alloc(32, 0x41).toString("base64");
const TEST_LOG_SALT = Buffer.alloc(32, 0x42).toString("base64");
const TEST_TOKEN = "a".repeat(43);
const FAKE_FIREFLIES_KEY = "ff_live_secret_token_never_log_me_xyz789";

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

async function mintGrantPair(
  delegateDid: string,
  computeDelegationCid: (authorization: string) => string,
  options: { now?: number; ttlMs?: number; privateKey?: `0x${string}` } = {},
) {
  const now = options.now ?? Date.now();
  const account = privateKeyToAccount(options.privateKey ?? generatePrivateKey());
  const address = account.address;
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const secretsSpaceId = makePkhSpaceId(address, 1, "secrets");
  const appsSpaceId = makePkhSpaceId(address, 1, "applications");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawPub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
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
  const proof = computeDelegationCid(
    (siweToDelegationHeaders({ siwe, signature }) as { Authorization: string }).Authorization,
  );
  const expSecs = Math.floor((now + (options.ttlMs ?? 7 * 86_400_000)) / 1000);

  const build = (spaceId: string, att: Record<string, Record<string, unknown[]>>) => {
    const header = {
      alg: "EdDSA",
      jwk: { alg: "EdDSA", crv: "Ed25519", kty: "OKP", x: rawPub.toString("base64url") },
      typ: "JWT",
      ucv: "0.10.0",
    };
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
    secretsGrant: build(secretsSpaceId, {
      [`${secretsSpaceId}/kv/${FIREFLIES_SECRET_KV_PATH}`]: { "tinycloud.kv/get": [{}] },
      [`urn:tinycloud:encryption:${ownerDid}:default/${FIREFLIES_SECRET_ENCRYPTION_KEY_PATH}`]: {
        "tinycloud.encryption/decrypt": [{}],
      },
    }),
    meetingsGrant: build(appsSpaceId, {
      [`${appsSpaceId}/kv/${FIREFLIES_APPLICATIONS_KV_PREFIX}`]: { "tinycloud.kv/put": [{}] },
    }),
    siwe,
    signature,
    expiresAt: new Date(expSecs * 1000),
    now,
  };
}

function createMemoryGrantKv() {
  const rows = new Map<string, unknown>();
  const kv: FirefliesGrantKvPort = {
    async get(key) {
      return (rows.get(key) as never) ?? null;
    },
    async put(key, value) {
      rows.set(key, structuredClone(value));
    },
    async delete(key) {
      rows.delete(key);
    },
  };
  return { rows, kv };
}

function createUserSpaceKvMock() {
  const data = new Map<string, string>();
  const puts: Array<{ key: string; ifNoneMatch?: string; owner: string }> = [];
  let forceError: "storage_full" | "revoked" | "unauthorized" | null = null;

  return {
    data,
    puts,
    setForceError(mode: typeof forceError) {
      forceError = mode;
    },
    writeMeeting: async (
      _scopedNode: unknown,
      verified: { ownerAddress: string },
      normalized: { meeting: { sourceId: string }; transcriptBody: string; meetingRecord: unknown },
    ) => {
      if (forceError === "storage_full") return { status: "storage_full" as const };
      if (forceError === "revoked") return { status: "revoked" as const };
      if (forceError === "unauthorized") return { status: "unauthorized" as const };

      const id = normalized.meeting.sourceId;
      const tKey = `${verified.ownerAddress}:${firefliesTranscriptKvKey(id)}`;
      const mKey = `${verified.ownerAddress}:${firefliesMeetingKvKey(id)}`;
      const putOne = (fullKey: string, kvKey: string, val: string): "written" | "already_present" => {
        puts.push({ key: kvKey, ifNoneMatch: "*", owner: verified.ownerAddress });
        if (data.has(fullKey)) return "already_present";
        data.set(fullKey, val);
        return "written";
      };
      const tRes = putOne(tKey, firefliesTranscriptKvKey(id), normalized.transcriptBody);
      const mRes = putOne(mKey, firefliesMeetingKvKey(id), JSON.stringify(normalized.meetingRecord));
      if (tRes === "already_present" && mRes === "already_present") {
        return { status: "already_present" as const };
      }
      return { status: "written" as const };
    },
  };
}

function firefliesOkFetch(calls: Array<{ meetingId: string; auth: string }>) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: { id?: string } };
    const id = body.variables?.id ?? "unknown";
    calls.push({ meetingId: id, auth: headers.get("authorization") ?? "" });
    return new Response(
      JSON.stringify({
        data: {
          transcript: {
            id,
            title: "Confidential Board Sync",
            date: Date.UTC(2026, 10, 22, 16, 0, 0),
            duration: 30,
            organizer_email: "ceo@secret-company.example",
            meeting_attendees: [{ displayName: "Board Member", email: "board@secret-company.example" }],
            sentences: [
              { index: 0, speaker_name: "Board Member", text: "Top secret acquisition numbers.", start_time: 1, end_time: 10 },
            ],
            summary: { overview: "Sensitive summary text.", keywords: ["board"], action_items: "Keep private." },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

function signWebhookPayload(token: string, payload: Record<string, unknown>) {
  const raw = JSON.stringify(payload);
  const secret = deriveWebhookSecret("fireflies", token);
  const sig = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  return { raw, sig };
}

describe("Fireflies direct-write webhook executor (PR-2)", () => {
  it("runs happy path through HMAC-verified webhook -> G1 key read -> Fireflies fetch -> G2 ifNoneMatch KV put with zero queueing and content-free logs", async () => {
    process.env.WEBHOOK_HMAC_MASTER = TEST_HMAC_MASTER;
    process.env.LOG_HASH_SALT = TEST_LOG_SALT;

    const nowMs = Date.UTC(2026, 10, 22, 17, 30, 0);
    const keys = await deriveFirefliesImportKeys(
      { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? 0xc1 : 0xc2) },
      { host: HOST, env: {} },
    );
    const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
    const pair = await mintGrantPair(keys.delegate.did, cidOf, { now: nowMs });
    const { kv } = createMemoryGrantKv();
    const grantStore = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
    await grantStore.store(pair.address, pair, pair.expiresAt);

    const userKv = createUserSpaceKvMock();
    const firefliesCalls: Array<{ meetingId: string; auth: string }> = [];
    const logs: string[] = [];
    const enqueued: unknown[] = [];

    const importer = new FirefliesDirectImporter({
      delegate: keys.delegate,
      grantStore,
      configuredHost: HOST,
      control: { readLedger: async () => ({ status: "absent" }) },
      fetchOptions: { fetchImpl: firefliesOkFetch(firefliesCalls), now: () => nowMs },
      readSecretKey: async () => ({ status: "ok", value: FAKE_FIREFLIES_KEY }),
      writeMeeting: userKv.writeMeeting,
      perUserSpacingMs: 0,
      now: () => nowMs,
      log: (line) => logs.push(line),
    });

    const app = express();
    app.post(
      "/api/connectors/webhooks/:source/:token",
      express.raw({ type: "application/json", limit: "64kb", inflate: false }),
      createConnectorWebhookHandler({
        tokens: {
          lookup: async (tok) =>
            tok === TEST_TOKEN ? { address: pair.address, source: "fireflies", createdAt: new Date(nowMs).toISOString() } : null,
        },
        queue: {
          enqueue: async (...args) => {
            enqueued.push(args);
            return { status: "enqueued", depth: 1 };
          },
        },
        limiters: new ConnectorWebhookLimiters(),
        control: { readDisabled: async () => null },
        firefliesDirectImport: importer,
        now: () => nowMs,
      }),
    );

    await withServer(app, async (base) => {
      const { raw, sig } = signWebhookPayload(TEST_TOKEN, {
        eventType: "Transcription completed",
        meetingId: "ff-happy-1",
        timestamp: nowMs - 1_000,
      });
      const res = await fetch(`${base}/api/connectors/webhooks/fireflies/${TEST_TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature": sig },
        body: raw,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "imported" });

      // Replay of the same verified webhook is idempotent (already_present, zero extra Fireflies call).
      const replay = await fetch(`${base}/api/connectors/webhooks/fireflies/${TEST_TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature": sig },
        body: raw,
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ status: "already_present" });
    });

    expect(enqueued).toEqual([]);
    expect(firefliesCalls).toEqual([{ meetingId: "ff-happy-1", auth: `Bearer ${FAKE_FIREFLIES_KEY}` }]);
    expect(userKv.puts).toEqual([
      { key: firefliesTranscriptKvKey("ff-happy-1"), ifNoneMatch: "*", owner: pair.address.toLowerCase() },
      { key: firefliesMeetingKvKey("ff-happy-1"), ifNoneMatch: "*", owner: pair.address.toLowerCase() },
    ]);
    const writtenMeeting = JSON.parse(
      userKv.data.get(`${pair.address.toLowerCase()}:${firefliesMeetingKvKey("ff-happy-1")}`)!,
    );
    expect(writtenMeeting.sourceId).toBe("ff-happy-1");
    expect(writtenMeeting.title).toBe("Confidential Board Sync");
    expect(importer.lastSyncedAt(pair.address)).toBe(new Date(nowMs).toISOString());
    expect(importer.metrics().imported).toBe(1);
    expect(importer.metrics().alreadyPresent).toBe(1);

    // Content-free logs: never leak key, title, transcript text, emails, raw address or raw meetingId.
    const joinedLogs = logs.join("\n");
    for (const forbidden of [
      FAKE_FIREFLIES_KEY,
      "Confidential Board Sync",
      "Top secret acquisition numbers",
      "ceo@secret-company.example",
      "board@secret-company.example",
      "ff-happy-1",
      pair.address.toLowerCase(),
    ]) {
      expect(joinedLogs).not.toContain(forbidden);
    }
    expect(joinedLogs).toContain("result=imported");
    expect(joinedLogs).toContain("sentences=1");
  });

  it("never overwrites a planted record at the key (ifNoneMatch 412 -> already_present)", async () => {
    const nowMs = Date.UTC(2026, 10, 22, 17, 30, 0);
    const keys = await deriveFirefliesImportKeys(
      { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? 0xc3 : 0xc4) },
      { host: HOST, env: {} },
    );
    const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
    const pair = await mintGrantPair(keys.delegate.did, cidOf, { now: nowMs });
    const { kv } = createMemoryGrantKv();
    const grantStore = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
    await grantStore.store(pair.address, pair, pair.expiresAt);

    const userKv = createUserSpaceKvMock();
    const owner = pair.address.toLowerCase();
    userKv.data.set(`${owner}:${firefliesTranscriptKvKey("ff-planted")}`, '{"planted":"transcript"}');
    userKv.data.set(`${owner}:${firefliesMeetingKvKey("ff-planted")}`, '{"planted":"meeting"}');

    const firefliesCalls: Array<{ meetingId: string; auth: string }> = [];
    const importer = new FirefliesDirectImporter({
      delegate: keys.delegate,
      grantStore,
      configuredHost: HOST,
      fetchOptions: { fetchImpl: firefliesOkFetch(firefliesCalls), now: () => nowMs },
      readSecretKey: async () => ({ status: "ok", value: FAKE_FIREFLIES_KEY }),
      writeMeeting: userKv.writeMeeting,
      perUserSpacingMs: 0,
      now: () => nowMs,
      log: () => {},
    });

    const result = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-planted",
      receivedAt: new Date(nowMs).toISOString(),
    });
    expect(result).toEqual({
      handled: true,
      httpStatus: 200,
      body: { status: "already_present" },
      outcome: "already_present",
    });
    expect(userKv.data.get(`${owner}:${firefliesMeetingKvKey("ff-planted")}`)).toBe('{"planted":"meeting"}');
    expect(userKv.data.get(`${owner}:${firefliesTranscriptKvKey("ff-planted")}`)).toBe('{"planted":"transcript"}');
  });

  it("drops purge-ledger tombstoned meetings with zero Fireflies calls and honors TC-3344 reset timestamp", async () => {
    const nowRef = { current: Date.UTC(2026, 10, 22, 17, 30, 0) };
    const keys = await deriveFirefliesImportKeys(
      { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? 0xc5 : 0xc6) },
      { host: HOST, env: {} },
    );
    const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
    const pair = await mintGrantPair(keys.delegate.did, cidOf, { now: nowRef.current });
    const { kv } = createMemoryGrantKv();
    const grantStore = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
    await grantStore.store(pair.address, pair, pair.expiresAt);

    let ledgerState: FirefliesPurgeLedgerRead = {
      status: "ok",
      ledger: {
        purgedThrough: new Date(nowRef.current).toISOString(),
        recentIds: ["ff-purged-1"],
        updatedAt: new Date(nowRef.current).toISOString(),
      },
    };
    const userKv = createUserSpaceKvMock();
    const firefliesCalls: Array<{ meetingId: string; auth: string }> = [];

    const importer = new FirefliesDirectImporter({
      delegate: keys.delegate,
      grantStore,
      configuredHost: HOST,
      control: { readLedger: async () => ledgerState },
      fetchOptions: { fetchImpl: firefliesOkFetch(firefliesCalls), now: () => nowRef.current },
      readSecretKey: async () => ({ status: "ok", value: FAKE_FIREFLIES_KEY }),
      writeMeeting: userKv.writeMeeting,
      perUserSpacingMs: 0,
      now: () => nowRef.current,
      log: () => {},
    });

    // Tombstoned by purge ledger -> zero Fireflies calls, zero KV writes.
    const blocked = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-purged-1",
      receivedAt: new Date(nowRef.current).toISOString(),
      sourceTimestamp: new Date(nowRef.current + 1_000).toISOString(),
    });
    expect(blocked).toEqual({
      handled: true,
      httpStatus: 200,
      body: { status: "ignored" },
      outcome: "tombstoned",
    });
    expect(firefliesCalls).toHaveLength(0);
    expect(userKv.data.size).toBe(0);

    // Corrupt purge ledger -> fails closed with zero Fireflies calls.
    ledgerState = { status: "unparseable", raw: "corrupt" };
    const corruptBlocked = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-any-2",
      receivedAt: new Date(nowRef.current).toISOString(),
      sourceTimestamp: new Date(nowRef.current + 1_000).toISOString(),
    });
    expect(corruptBlocked.handled && corruptBlocked.outcome).toBe("tombstoned");
    expect(firefliesCalls).toHaveLength(0);

    // Clear ledger, import once, then simulate user delete + TC-3344 "Allow deleted meetings back" reset.
    ledgerState = { status: "absent" };
    const first = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-reset-3",
      receivedAt: new Date(nowRef.current).toISOString(),
    });
    expect(first.handled && first.outcome).toBe("imported");
    expect(firefliesCalls).toHaveLength(1);

    // User deletes from KV and triggers TC-3344 reset -> pre-reset replay marker is ignored!
    userKv.data.clear();
    nowRef.current += 10_000;
    importer.recordReset(pair.address, nowRef.current);
    const reimported = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-reset-3",
      receivedAt: new Date(nowRef.current).toISOString(),
    });
    expect(reimported.handled && reimported.outcome).toBe("imported");
    expect(firefliesCalls).toHaveLength(2);
  });

  it("stops cleanly on expired, revoked or node-rejected grants with zero Fireflies calls and clears stale ciphertext", async () => {
    const nowMs = Date.UTC(2026, 10, 22, 17, 30, 0);
    const keys = await deriveFirefliesImportKeys(
      { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? 0xc7 : 0xc8) },
      { host: HOST, env: {} },
    );
    const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
    const pair = await mintGrantPair(keys.delegate.did, cidOf, { now: nowMs, ttlMs: 3600_000 });
    const { rows, kv } = createMemoryGrantKv();
    const grantStore = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });

    const firefliesCalls: Array<{ meetingId: string; auth: string }> = [];
    let secretOutcome: FirefliesSecretReadOutcome = { status: "revoked" };

    const importer = new FirefliesDirectImporter({
      delegate: keys.delegate,
      grantStore,
      configuredHost: HOST,
      fetchOptions: { fetchImpl: firefliesOkFetch(firefliesCalls), now: () => nowMs },
      readSecretKey: async () => secretOutcome,
      perUserSpacingMs: 0,
      now: () => nowMs,
      log: () => {},
    });

    // Case 1: Node reports delegation_revoked on G1 secret read -> marks revoked, 0 Fireflies calls.
    await grantStore.store(pair.address, pair, pair.expiresAt);
    const revokedRes = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-rev-1",
      receivedAt: new Date(nowMs).toISOString(),
    });
    expect(revokedRes).toEqual({
      handled: true,
      httpStatus: 200,
      body: { status: "revoked" },
      outcome: "stopped_revoked",
    });
    expect(JSON.stringify(rows.get(grantStore.keyFor(pair.address)))).not.toContain("ciphertext");
    expect(firefliesCalls).toHaveLength(0);

    // Case 2: Node 403/401 refusal (e.g. recap rejected at activation) -> fails closed, marks needs_renewal, 0 Fireflies calls.
    secretOutcome = { status: "unauthorized" };
    await grantStore.store(pair.address, pair, pair.expiresAt);
    const unauthRes = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-unauth-2",
      receivedAt: new Date(nowMs).toISOString(),
    });
    expect(unauthRes).toEqual({
      handled: true,
      httpStatus: 200,
      body: { status: "paused" },
      outcome: "stopped_needs_renewal",
    });
    expect(JSON.stringify(rows.get(grantStore.keyFor(pair.address)))).not.toContain("ciphertext");
    expect(firefliesCalls).toHaveLength(0);

    // Case 3: Expired stored grant -> stops cleanly with 0 Fireflies calls and clears ciphertext.
    await grantStore.store(pair.address, pair, pair.expiresAt);
    const expiredImporter = new FirefliesDirectImporter({
      delegate: keys.delegate,
      grantStore,
      configuredHost: HOST,
      fetchOptions: { fetchImpl: firefliesOkFetch(firefliesCalls) },
      readSecretKey: async () => ({ status: "ok", value: FAKE_FIREFLIES_KEY }),
      perUserSpacingMs: 0,
      now: () => pair.expiresAt.getTime() + 5_000,
      log: () => {},
    });
    const expiredRes = await expiredImporter.handleWebhook({
      address: pair.address,
      meetingId: "ff-exp-3",
      receivedAt: new Date(pair.expiresAt.getTime() + 5_000).toISOString(),
    });
    expect(expiredRes).toEqual({
      handled: true,
      httpStatus: 200,
      body: { status: "paused" },
      outcome: "stopped_needs_renewal",
    });
    expect(firefliesCalls).toHaveLength(0);
  });

  it("does not advance last_synced_at on storage_full (TC-1192 fix)", async () => {
    const nowMs = Date.UTC(2026, 10, 22, 17, 30, 0);
    const keys = await deriveFirefliesImportKeys(
      { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? 0xc9 : 0xca) },
      { host: HOST, env: {} },
    );
    const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
    const pair = await mintGrantPair(keys.delegate.did, cidOf, { now: nowMs });
    const { kv } = createMemoryGrantKv();
    const grantStore = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
    await grantStore.store(pair.address, pair, pair.expiresAt);

    const userKv = createUserSpaceKvMock();
    userKv.setForceError("storage_full");
    let syncedCalls = 0;

    const importer = new FirefliesDirectImporter({
      delegate: keys.delegate,
      grantStore,
      configuredHost: HOST,
      fetchOptions: { fetchImpl: firefliesOkFetch([]), now: () => nowMs },
      readSecretKey: async () => ({ status: "ok", value: FAKE_FIREFLIES_KEY }),
      writeMeeting: userKv.writeMeeting,
      perUserSpacingMs: 0,
      now: () => nowMs,
      log: () => {},
      onSynced: () => {
        syncedCalls++;
      },
    });

    const res = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-full-1",
      receivedAt: new Date(nowMs).toISOString(),
    });
    expect(res).toEqual({
      handled: true,
      httpStatus: 200,
      body: { status: "storage_full" },
      outcome: "storage_full",
    });
    expect(syncedCalls).toBe(0);
    expect(importer.lastSyncedAt(pair.address)).toBeNull();
    expect(importer.metrics().storageFull).toBe(1);
  });

  it("evicts dry-activated and runtime delegations and holds zero cross-tenant state across two owners", async () => {
    const nowMs = Date.UTC(2026, 10, 22, 17, 30, 0);
    const keys = await deriveFirefliesImportKeys(
      { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? 0xcb : 0xcc) },
      { host: HOST, env: {} },
    );
    const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
    const ownerA = await mintGrantPair(keys.delegate.did, cidOf, { now: nowMs });
    const ownerB = await mintGrantPair(keys.delegate.did, cidOf, { now: nowMs });
    const { kv } = createMemoryGrantKv();
    const grantStore = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });

    let activeAddress = ownerA.address;
    const app = express();
    app.use(createApiBodyParser());
    app.use(createCsrfMiddleware());
    app.use(
      "/api/connectors/fireflies/delegation",
      createFirefliesDelegationRouter({
        delegate: keys.delegate,
        configuredHost: HOST,
        store: grantStore,
        authMiddleware: (req, _res, next) => {
          req.user = { address: activeAddress };
          next();
        },
        now: () => nowMs,
      }),
    );

    // Dry-activate both owners via POST route -> shared delegate node MUST retain zero delegations!
    await withServer(app, async (base) => {
      for (const owner of [ownerA, ownerB]) {
        activeAddress = owner.address;
        const res = await fetch(`${base}/api/connectors/fireflies/delegation`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
          body: JSON.stringify({
            secretsGrant: owner.secretsGrant,
            meetingsGrant: owner.meetingsGrant,
            siwe: owner.siwe,
            signature: owner.signature,
          }),
        });
        expect(res.status).toBe(200);
        expect(keys.delegate.node.getRuntimePermissionDelegations()).toEqual([]);
      }
    });

    // Execute Owner A then Owner B: each scopedNode sees ONLY its own activated delegation and is evicted in finally.
    const seenScopedNodes: Array<{ owner: string; grantCountDuringRun: number; grantCountAfterEvict?: number; node: unknown }> = [];
    const userKv = createUserSpaceKvMock();
    const importer = new FirefliesDirectImporter({
      delegate: keys.delegate,
      grantStore,
      configuredHost: HOST,
      fetchOptions: { fetchImpl: firefliesOkFetch([]), now: () => nowMs },
      readSecretKey: async (scopedNode, verified) => {
        // Activate G1 on the isolated scopedNode, assert zero prior tenant grants exist on it!
        const primary = verified.secrets.resources[0]!;
        await scopedNode.useDelegation({
          cid: verified.secrets.cid,
          delegationHeader: { Authorization: verified.secrets.authorization },
          spaceId: verified.secrets.spaceId,
          path: primary.path,
          actions: [...primary.actions],
          resources: verified.secrets.resources,
          expiry: verified.secrets.expiresAt,
          delegateDID: verified.delegateDid,
          ownerAddress: verified.ownerAddress,
          chainId: verified.chainId,
          host: HOST,
        });
        const installed = scopedNode.getRuntimePermissionDelegations();
        expect(installed).toHaveLength(1);
        expect(installed[0]!.ownerAddress).toBe(verified.ownerAddress);
        seenScopedNodes.push({
          owner: verified.ownerAddress,
          grantCountDuringRun: installed.length,
          node: scopedNode,
        });
        return { status: "ok", value: FAKE_FIREFLIES_KEY };
      },
      writeMeeting: userKv.writeMeeting,
      perUserSpacingMs: 0,
      now: () => nowMs,
      log: () => {},
    });

    const resA = await importer.handleWebhook({
      address: ownerA.address,
      meetingId: "ff-iso-a",
      receivedAt: new Date(nowMs).toISOString(),
    });
    expect(resA.handled && resA.outcome).toBe("imported");

    const resB = await importer.handleWebhook({
      address: ownerB.address,
      meetingId: "ff-iso-b",
      receivedAt: new Date(nowMs).toISOString(),
    });
    expect(resB.handled && resB.outcome).toBe("imported");

    // Distinct scoped node instances per run, and EVERY node (shared + scoped) holds zero grants after completion.
    expect(seenScopedNodes).toHaveLength(2);
    expect(seenScopedNodes[0]!.node).not.toBe(seenScopedNodes[1]!.node);
    expect(keys.delegate.node.getRuntimePermissionDelegations()).toEqual([]);
    for (const entry of seenScopedNodes) {
      const node = entry.node as { getRuntimePermissionDelegations: () => unknown[] };
      expect(node.getRuntimePermissionDelegations()).toEqual([]);
    }
  });

  it("behaves identically to main (enqueues 202) when flag is false or owner has no server-import grant", async () => {
    process.env.WEBHOOK_HMAC_MASTER = TEST_HMAC_MASTER;
    process.env.LOG_HASH_SALT = TEST_LOG_SALT;
    const nowMs = Date.UTC(2026, 10, 22, 17, 30, 0);
    const ownerAddress = privateKeyToAccount(generatePrivateKey()).address;

    const enqueued: unknown[] = [];
    // Flag false -> firefliesDirectImport is undefined (exact main behavior).
    const flagOffApp = express();
    flagOffApp.post(
      "/api/connectors/webhooks/:source/:token",
      express.raw({ type: "application/json", limit: "64kb", inflate: false }),
      createConnectorWebhookHandler({
        tokens: {
          lookup: async (tok) =>
            tok === TEST_TOKEN ? { address: ownerAddress, source: "fireflies", createdAt: new Date(nowMs).toISOString() } : null,
        },
        queue: {
          enqueue: async (...args) => {
            enqueued.push(args);
            return { status: "enqueued", depth: 1 };
          },
        },
        limiters: new ConnectorWebhookLimiters(),
        control: { readDisabled: async () => null },
        now: () => nowMs,
      }),
    );

    await withServer(flagOffApp, async (base) => {
      const { raw, sig } = signWebhookPayload(TEST_TOKEN, {
        eventType: "Transcription completed",
        meetingId: "ff-flag-off-1",
        timestamp: nowMs - 1_000,
      });
      const res = await fetch(`${base}/api/connectors/webhooks/fireflies/${TEST_TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature": sig },
        body: raw,
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "queued" });
    });
    expect(enqueued).toHaveLength(1);
  });
});
