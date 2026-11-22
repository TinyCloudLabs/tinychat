// The history drain for bots other than Main (TC-3813): each stored grant of a bot is used only for that bot's
// batches, and only while the owner's record still holds the bot. The backend node and the bots service are stand-ins;
// the grants, the storage keys, the batch checks and the signed calls are the real ones.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { makeSignedTranscriptGrant, computeDelegationCid } from "./helpers/transcript-grant";
import { BotHistory, HISTORY_PREFIX, historyBotId } from "../bot-history";
import type { Bot, OwnerBots } from "../bots-registry";
import { startBotHistoryDrain } from "../routes/bot-history";
import type { BotsConfig } from "../routes/bots";
import * as serviceCalls from "../../../bots/src/signed-call";

const ownerKey = `0x${"11".repeat(32)}` as const;
const owner = privateKeyToAccount(ownerKey).address;
const ownerEntry = `bot-history/grants/${owner.toLowerCase()}`;
const secret = "b".repeat(64);
const backendDid = "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810";
const host = "http://127.0.0.1:9137";
const KEY_A = "ab".repeat(16);
const KEY_GONE = "cd".repeat(16);
const KEY_CLOSED = "de".repeat(16);
const KEY_OTHERS = "ef".repeat(16);
const space = makePkhSpaceId(owner, 1, "applications");
const directory = (key?: string) => `${HISTORY_PREFIX}${historyBotId(owner, key)}/`;
const grantFor = async (key?: string) => {
  const grant = await makeSignedTranscriptGrant({ privateKey: ownerKey, att: { [`${space}/kv/${directory(key)}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } } });
  return { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature };
};
const bot = (key: string, extra: Partial<Bot> = {}): Bot => ({ key, name: key.slice(0, 4), shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: "2026-11-01T00:00:00.000Z", ...extra });
const batchFor = (key?: string) => ({ v: 1, generation: "0".repeat(32), seq: 1, challenge: "1".repeat(64), record: { type: "user", text: "hi" }, ...(key ? { bot: key } : {}) });
const notFound = (key: string) => ({ ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } });

/** The backend's own space (grants) and the owner's space reached through a delegation, both maps. */
function backend() {
  const grants = new Map<string, unknown>();
  const written = new Map<string, unknown>();
  /** The directory of each delegation the drain activated. */
  const activated: string[] = [];
  const node = {
    did: backendDid, computeDelegationCid,
    useDelegation: async ({ path }: { path: string }) => {
      activated.push(path);
      return { kv: {
        get: async (key: string) => (written.has(key) ? { ok: true, data: { data: written.get(key) } } : notFound(key)),
        put: async (key: string, value: unknown) => { written.set(key, value); return { ok: true, data: {} }; },
      } };
    },
    getEncryptionNetworkIdForSpace: () => "network",
    encryption: {
      discoverNetwork: async () => ({ ok: true, data: { ownerDid: `did:pkh:eip155:1:${owner}`, state: "active", networkId: "network" } }),
      encryptToNetwork: async (_network: string, _bytes: Uint8Array, { aad }: { aad: Buffer }) => ({ ok: true, data: { networkId: "network", aad: aad.toString("base64"), ciphertext: "c" } }),
    },
    kv: {
      put: async (key: string, value: unknown) => { grants.set(key, value); return { ok: true, data: {} }; },
      get: async (key: string) => (grants.has(key) ? { ok: true, data: { data: grants.get(key) } } : notFound(key)),
      delete: async (key: string) => (grants.delete(key) ? { ok: true, data: {} } : notFound(key)),
      list: async ({ prefix }: { prefix: string }) => ({ ok: true, data: { keys: [...grants.keys()].filter(key => key.startsWith(prefix)), truncated: false } }),
    },
  } as unknown as TinyCloudNode;
  return { grants, written, activated, history: new BotHistory(node, `0x${"22".repeat(32)}`, host) };
}

interface Received { method: string; path: string; bot: string; body?: Record<string, unknown> }
/** A service that accepts a call only as the real one does, and answers each bot's pending batch from `pending`. */
function service(pending: Record<string, unknown>) {
  const received: Received[] = [];
  const nonces = new serviceCalls.NonceGuard();
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const text = typeof init?.body === "string" ? init.body : undefined;
    const claims = serviceCalls.verifyCall(new Headers(init?.headers).get("authorization"), { method, path: url.pathname + url.search, body: text }, { secret, direction: "to-service", environment: "private", nonces });
    const key = /^\/v1\/bots\/([^/]+)\/history/.exec(url.pathname)?.[1];
    if (!claims || claims.bot !== key) return new Response(null, { status: 401 });
    const body = text === undefined ? undefined : JSON.parse(text);
    received.push({ method, path: url.pathname, bot: claims.bot, body });
    if (url.pathname.endsWith("/history") && method === "GET") return Response.json({ batch: pending[key] ?? null });
    if (url.pathname.endsWith("/history") && method === "POST") { delete pending[key]; return new Response(null, { status: 204 }); }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const config: BotsConfig = { serviceUrl: "http://bots.test", serviceSecret: secret, accountAllowed: () => true, postTimeoutMs: 1000, fetchImpl };
  return { received, config };
}
const registryOf = (bots: Bot[]) => ({ read: async (address: string): Promise<OwnerBots> => ({ v: 1, seq: 4, bots: address.toLowerCase() === owner.toLowerCase() ? [bot("main"), ...bots] : [bot("main"), bot(KEY_OTHERS)], deleted: [] }) });
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

afterEach(() => { setSystemTime(); });

describe("the drain for a bot other than Main", () => {
  test("archives the bot's batch under the bot's own grant, never Main's, and skips malformed stored keys", async () => {
    const { grants, written, activated, history } = backend();
    await history.accept(owner, await grantFor());
    await history.accept(owner, await grantFor(KEY_A), KEY_A);
    // Not one key after the address: never listed as a bot.
    for (const odd of [`${ownerEntry}/main`, `${ownerEntry}/${"AB".repeat(16)}`, `${ownerEntry}/${KEY_A}/x`, `${ownerEntry}/${KEY_A}0`]) grants.set(odd, "x");
    // Stored last: forgetting it marks the end of the pass.
    await history.accept(owner, await grantFor(KEY_GONE), KEY_GONE);
    const { received, config } = service({ [KEY_A]: batchFor(KEY_A) });
    activated.length = 0; // accepting a grant activates it once; only the drain's activations count
    const drain = startBotHistoryDrain(history, config, registryOf([bot(KEY_A)]));
    try {
      await until(() => !grants.has(`${ownerEntry}/${KEY_GONE}`));
      expect(received.map(call => `${call.method} ${call.path} ${call.bot}`)).toEqual([
        "GET /v1/bots/main/history main",
        `GET /v1/bots/${KEY_A}/history ${KEY_A}`,
        `POST /v1/bots/${KEY_A}/history/stage ${KEY_A}`,
        `POST /v1/bots/${KEY_A}/history ${KEY_A}`,
        `GET /v1/bots/${KEY_A}/history ${KEY_A}`,
      ]);
      expect(activated).toEqual([directory(KEY_A)]);
      expect([...written.keys()]).toEqual([`${directory(KEY_A)}${"0".repeat(32)}/1-${"1".repeat(64)}`]);
      expect(received[3]!.body).toMatchObject({ body: { key: KEY_A, botId: historyBotId(owner, KEY_A), path: [...written.keys()][0] } });
      // Main's grant and the malformed entries are left alone.
      expect(grants.has(ownerEntry)).toBe(true);
      expect(grants.has(`${ownerEntry}/${KEY_A}`)).toBe(true);
      expect(grants.has(`${ownerEntry}/main`)).toBe(true);
    } finally { drain.stop(); }
  });

  test("forgets the grant of a bot that is gone, whose deletion closed it, or that is another owner's, and calls nothing for them", async () => {
    const { grants, activated, history } = backend();
    for (const key of [KEY_GONE, KEY_CLOSED, KEY_OTHERS]) await history.accept(owner, await grantFor(key), key);
    const { received, config } = service({ [KEY_GONE]: batchFor(KEY_GONE), [KEY_CLOSED]: batchFor(KEY_CLOSED), [KEY_OTHERS]: batchFor(KEY_OTHERS) });
    activated.length = 0;
    const closed = bot(KEY_CLOSED, { state: "deleting", deletingSince: "2026-11-02T00:00:00.000Z", grantClosed: true });
    const drain = startBotHistoryDrain(history, config, registryOf([closed]));
    try {
      await until(() => grants.size === 0);
      expect(received).toEqual([]);
      expect(activated).toEqual([]);
    } finally { drain.stop(); }
  });

  test("drains a bot being deleted whose permission is still open", async () => {
    const { activated, history } = backend();
    await history.accept(owner, await grantFor(KEY_A), KEY_A);
    const { received, config } = service({ [KEY_A]: batchFor(KEY_A) });
    activated.length = 0;
    const drain = startBotHistoryDrain(history, config, registryOf([bot(KEY_A, { state: "deleting", deletingSince: "2026-11-02T00:00:00.000Z" })]));
    try {
      await until(() => received.some(call => call.method === "POST" && call.path === `/v1/bots/${KEY_A}/history`));
      expect(activated).toEqual([directory(KEY_A)]);
    } finally { drain.stop(); }
  });

  test("an expired grant has its expiry sent to that bot's permission, not Main's", async () => {
    const { activated, history } = backend();
    await history.accept(owner, await grantFor(KEY_A), KEY_A);
    setSystemTime(new Date(Date.now() + 31 * 86_400_000));
    const { received, config } = service({ [KEY_A]: batchFor(KEY_A) });
    activated.length = 0;
    const drain = startBotHistoryDrain(history, config, registryOf([bot(KEY_A)]));
    try {
      await until(() => received.some(call => call.method === "PUT"));
      const puts = received.filter(call => call.method === "PUT");
      expect(puts.map(call => `${call.path} ${call.bot}`)).toEqual([`/v1/bots/${KEY_A}/history/permission ${KEY_A}`]);
      expect(puts[0]!.body).toEqual({ expiresAt: expect.any(Number) });
      expect(activated).toEqual([]);
    } finally { drain.stop(); }
  });
});
