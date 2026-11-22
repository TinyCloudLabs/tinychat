// TC-3933: the drain sends a live bot's grant end to the bots service again, so a grant held in memory there for a bot that has
// not run yet survives a restart of the service. Fixtures are those of bot-history-sibling-drain.test.ts.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { makeSignedTranscriptGrant, computeDelegationCid } from "./helpers/transcript-grant";
import { BotHistory, HISTORY_PREFIX, historyBotId } from "../bot-history";
import { BotsRegistry, registryKey, type Bot } from "../bots-registry";
import { GRANT_RESEND_MS, startBotHistoryDrain } from "../routes/bot-history";
import type { BotsConfig } from "../routes/bots";
import * as serviceCalls from "../../../bots/src/signed-call";
import { fakeRegistryStore } from "./helpers/fake-registry-store";

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
/** The real registry, over a store holding this owner's record: Main and `bots`. */
const registryOf = (bots: Bot[]) => {
  const kv = fakeRegistryStore();
  kv.rows.set(registryKey(owner), { value: JSON.stringify({ v: 1, seq: 4, bots: [bot("main"), ...bots], deleted: [] }), version: 1 });
  return new BotsRegistry(kv);
};
async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

afterEach(() => { setSystemTime(); });

const permissionPuts = (received: Received[]) => received.filter(call => call.method === "PUT");

describe("the drain's re-send of a bot's grant", () => {
  test("sends a live sibling's validUntil once each interval, never Main's, and nothing for an expired grant", async () => {
    const { history } = backend();
    await history.accept(owner, await grantFor());
    await history.accept(owner, await grantFor(KEY_A), KEY_A);
    const { received, config } = service({});
    const drain = startBotHistoryDrain(history, config, registryOf([bot(KEY_A)]));
    try {
      await until(() => received.some(call => call.bot === KEY_A));
      expect(permissionPuts(received)).toEqual([]); // first seen: the next send is one interval away
      const start = Date.now();
      setSystemTime(start + GRANT_RESEND_MS + 1000);
      await drain.drain();
      const puts = permissionPuts(received);
      expect(puts.map(call => `${call.path} ${call.bot}`)).toEqual([`/v1/bots/${KEY_A}/history/permission ${KEY_A}`]);
      expect(puts[0]!.body!.validUntil).toBeGreaterThan(start + 20 * 86_400_000);
      await drain.drain();
      expect(permissionPuts(received)).toHaveLength(1); // not again within the interval

      setSystemTime(start + 2 * GRANT_RESEND_MS + 2000);
      await drain.drain();
      expect(permissionPuts(received)).toHaveLength(2);

      setSystemTime(start + 31 * 86_400_000);
      await drain.drain();
      setSystemTime(start + 31 * 86_400_000 + GRANT_RESEND_MS + 1000);
      await drain.drain();
      expect(permissionPuts(received)).toHaveLength(2); // the grant has ended
    } finally { drain.stop(); }
  });
});
