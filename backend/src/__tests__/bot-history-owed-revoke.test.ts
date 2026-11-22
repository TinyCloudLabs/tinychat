// A grant the history drain stops holding for a bot that is gone or closed (TC-3818). A node takes a revocation only
// from the owner, so the drain never revokes: it records the delegation as owed in the owner's record, for the
// owner's browser to revoke, and removes the grant only once that is written. The registry and the grants are the
// real ones; the backend node and the bots service are stand-ins.
import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { makeSignedTranscriptGrant, computeDelegationCid } from "./helpers/transcript-grant";
import { fakeRegistryStore, type FakeRegistryStore } from "./helpers/fake-registry-store";
import { BotHistory, HISTORY_PREFIX, historyBotId } from "../bot-history";
import { BotsRegistry, registryKey, type Bot, type DeletedBot, type OwnerBots } from "../bots-registry";
import { startBotHistoryDrain } from "../routes/bot-history";
import type { BotsConfig } from "../routes/bots";

const ownerKey = `0x${"11".repeat(32)}` as const;
const owner = privateKeyToAccount(ownerKey).address;
const other = `0x${"33".repeat(20)}`;
const ownerEntry = `bot-history/grants/${owner.toLowerCase()}`;
const KEY_CLOSED = "de".repeat(16);
const KEY_DELETED = "cd".repeat(16);
const KEY_ACTIVE = "ab".repeat(16);
/** Never in the record: its grant is stored last, so its removal marks the end of a pass. */
const KEY_MARKER = "9f".repeat(16);
const space = makePkhSpaceId(owner, 1, "applications");
const grantFor = async (key: string) => {
  const grant = await makeSignedTranscriptGrant({ privateKey: ownerKey, att: { [`${space}/kv/${HISTORY_PREFIX}${historyBotId(owner, key)}/`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } } });
  return { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature };
};
const bot = (key: string, extra: Partial<Bot> = {}): Bot => ({ key, name: key.slice(0, 4), shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: "2026-11-01T00:00:00.000Z", ...extra });
const closed = (key: string, extra: Partial<Bot> = {}) => bot(key, { state: "deleting", deletingSince: "2026-11-02T00:00:00.000Z", grantClosed: true, ...extra });
const notFound = (key: string) => ({ ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } });

/**
 * The backend's own space, where grants are stored. The node refuses every revocation, as a real one does from the
 * backend. `activated` lists each delegation put to use: accepting a grant uses it once, the drain must not.
 */
function backend() {
  const grants = new Map<string, unknown>();
  const revocations: string[] = [];
  const activated: string[] = [];
  const node = {
    did: "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810", computeDelegationCid,
    useDelegation: async ({ path }: { path: string }) => { activated.push(path); return { kv: {} }; },
    revokeDelegation: async (cid: string) => { revocations.push(cid); return { ok: false, error: { code: "FORBIDDEN" } }; },
    kv: {
      put: async (key: string, value: unknown) => { grants.set(key, value); return { ok: true, data: {} }; },
      get: async (key: string) => (grants.has(key) ? { ok: true, data: { data: grants.get(key) } } : notFound(key)),
      delete: async (key: string) => (grants.delete(key) ? { ok: true, data: {} } : notFound(key)),
      list: async ({ prefix }: { prefix: string }) => ({ ok: true, data: { keys: [...grants.keys()].filter(key => key.startsWith(prefix)), truncated: false } }),
    },
  } as unknown as TinyCloudNode;
  return { grants, revocations, activated, history: new BotHistory(node, `0x${"22".repeat(32)}`, "http://127.0.0.1:9137") };
}

/** A bots service that answers every call; the drain must make none for these bots. */
function service() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    return Response.json({ batch: null });
  }) as typeof fetch;
  const config: BotsConfig = { serviceUrl: "http://bots.test", serviceSecret: "b".repeat(64), accountAllowed: () => true, postTimeoutMs: 1000, fetchImpl };
  return { calls, config };
}

function registry(bots: Bot[], deleted: DeletedBot[] = []) {
  const kv = fakeRegistryStore();
  kv.rows.set(registryKey(owner), { value: JSON.stringify({ v: 1, seq: 4, bots: [bot("main"), ...bots], deleted }), version: 1 });
  return { kv, registry: new BotsRegistry(kv) };
}
const record = (kv: FakeRegistryStore, address = owner) => JSON.parse(kv.rows.get(registryKey(address))!.value) as OwnerBots;

async function until(check: () => boolean) {
  for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}
/** Runs passes until `check` holds. A pass asked for while the first one is still finishing does nothing, so it is asked again. */
async function passUntil(drain: { drain: () => Promise<void> }, check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) { await drain.drain(); await Bun.sleep(5); }
  expect(check()).toBe(true);
}

describe("the drain owes the revocation of a grant it removes", () => {
  test("a closed bot's delegation is written to the bot's entry, and a deleted bot's to its deleted entry, before the grant goes", async () => {
    const { grants, revocations, activated, history } = backend();
    for (const key of [KEY_CLOSED, KEY_DELETED, KEY_MARKER]) await history.accept(owner, await grantFor(key), key);
    activated.length = 0;
    const closedCid = await history.storedGrantCid(owner, KEY_CLOSED);
    const deletedCid = await history.storedGrantCid(owner, KEY_DELETED);
    const { kv, registry: records } = registry([closed(KEY_CLOSED)], [{ key: KEY_DELETED, name: "cdcd" }]);
    const { calls, config } = service();
    const drain = startBotHistoryDrain(history, config, records);
    try {
      await until(() => !grants.has(`${ownerEntry}/${KEY_MARKER}`));
      const row = record(kv);
      expect(row.bots.find(entry => entry.key === KEY_CLOSED)?.revoke).toEqual({ cid: closedCid! });
      expect(row.deleted).toEqual([{ key: KEY_DELETED, name: "cdcd", revoke: { cid: deletedCid! } }]);
      expect(grants.has(`${ownerEntry}/${KEY_CLOSED}`)).toBe(false);
      expect(grants.has(`${ownerEntry}/${KEY_DELETED}`)).toBe(false);
      // The backend never revokes, never puts these grants to use, and never calls the service for these bots.
      expect(revocations).toEqual([]);
      expect(activated).toEqual([]);
      expect(calls).toEqual([]);
    } finally { drain.stop(); }
  });

  test("while another delegation is owed for the bot the grant stays, unused; once the owner has revoked that one it is owed in turn", async () => {
    const { grants, history } = backend();
    for (const key of [KEY_CLOSED, KEY_DELETED, KEY_MARKER]) await history.accept(owner, await grantFor(key), key);
    const closedCid = await history.storedGrantCid(owner, KEY_CLOSED);
    const deletedCid = await history.storedGrantCid(owner, KEY_DELETED);
    const { kv, registry: records } = registry([closed(KEY_CLOSED, { revoke: { cid: "earlier-closed" } })], [{ key: KEY_DELETED, name: "cdcd", revoke: { cid: "earlier-deleted" } }]);
    const { calls, config } = service();
    const drain = startBotHistoryDrain(history, config, records);
    try {
      await until(() => !grants.has(`${ownerEntry}/${KEY_MARKER}`));
      // Nothing owed is replaced, and neither grant is dropped.
      expect(record(kv).bots.find(entry => entry.key === KEY_CLOSED)?.revoke).toEqual({ cid: "earlier-closed" });
      expect(record(kv).deleted[0]!.revoke).toEqual({ cid: "earlier-deleted" });
      expect(grants.has(`${ownerEntry}/${KEY_CLOSED}`)).toBe(true);
      expect(grants.has(`${ownerEntry}/${KEY_DELETED}`)).toBe(true);

      // The owner revokes the earlier delegations; the next pass owes the stored ones and only then removes them.
      await records.clearRevoke(owner, KEY_CLOSED);
      await records.clearRevoke(owner, KEY_DELETED);
      await passUntil(drain, () => !grants.has(`${ownerEntry}/${KEY_CLOSED}`) && !grants.has(`${ownerEntry}/${KEY_DELETED}`));
      expect(record(kv).bots.find(entry => entry.key === KEY_CLOSED)?.revoke).toEqual({ cid: closedCid! });
      expect(record(kv).deleted[0]!.revoke).toEqual({ cid: deletedCid! });
      expect(grants.has(`${ownerEntry}/${KEY_CLOSED}`)).toBe(false);
      expect(grants.has(`${ownerEntry}/${KEY_DELETED}`)).toBe(false);
      expect(calls).toEqual([]);
    } finally { drain.stop(); }
  });

  test("a grant whose delegation cannot be written as owed is kept for a later pass", async () => {
    const { grants, history } = backend();
    for (const key of [KEY_DELETED, KEY_MARKER]) await history.accept(owner, await grantFor(key), key);
    const deletedCid = await history.storedGrantCid(owner, KEY_DELETED);
    const { kv, registry: records } = registry([], [{ key: KEY_DELETED, name: "cdcd" }]);
    kv.beforePut = async () => { throw new Error("store down"); };
    const { config } = service();
    const drain = startBotHistoryDrain(history, config, records);
    try {
      await until(() => !grants.has(`${ownerEntry}/${KEY_MARKER}`));
      expect(record(kv).deleted).toEqual([{ key: KEY_DELETED, name: "cdcd" }]);
      expect(grants.has(`${ownerEntry}/${KEY_DELETED}`)).toBe(true);
      await passUntil(drain, () => !grants.has(`${ownerEntry}/${KEY_DELETED}`));
      expect(record(kv).deleted).toEqual([{ key: KEY_DELETED, name: "cdcd", revoke: { cid: deletedCid! } }]);
      expect(grants.has(`${ownerEntry}/${KEY_DELETED}`)).toBe(false);
    } finally { drain.stop(); }
  });
});

describe("oweRevoke", () => {
  test("writes only to the owner's own record, never for a bot whose permission is open, never for Main, and never replaces what is owed", async () => {
    const { kv, registry: records } = registry([closed(KEY_CLOSED), bot(KEY_ACTIVE), bot(KEY_DELETED, { state: "deleting", deletingSince: "2026-11-02T00:00:00.000Z" })]);
    const otherRow = JSON.stringify({ v: 1, seq: 2, bots: [bot("main"), closed(KEY_CLOSED)], deleted: [] });
    kv.rows.set(registryKey(other), { value: otherRow, version: 1 });

    expect(await records.oweRevoke(owner, KEY_CLOSED, "cid-1")).toBe("owed");
    expect(await records.oweRevoke(owner, KEY_CLOSED, "cid-1")).toBe("owed");
    expect(await records.oweRevoke(owner, KEY_CLOSED, "cid-2")).toBe("busy");
    const after = record(kv);
    expect(after.seq).toBe(5); // one write: the repeat and the refusal wrote nothing
    expect(after.bots.find(entry => entry.key === KEY_CLOSED)?.revoke).toEqual({ cid: "cid-1" });

    // Active, and being deleted with the permission still open: nothing is owed.
    expect(await records.oweRevoke(owner, KEY_ACTIVE, "cid-3")).toBe("open");
    expect(await records.oweRevoke(owner, KEY_DELETED, "cid-3")).toBe("open");
    expect(await records.oweRevoke(owner, "main", "cid-3")).toBe("unknown");
    expect(await records.oweRevoke(owner, KEY_MARKER, "cid-3")).toBe("unknown");
    expect(record(kv)).toEqual(after);

    // The other owner's record holds the same key and is never touched.
    expect(kv.rows.get(registryKey(other))).toEqual({ value: otherRow, version: 1 });
  });
});
