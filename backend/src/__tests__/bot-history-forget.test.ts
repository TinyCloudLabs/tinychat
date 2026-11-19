// What deleting a bot needs from its stored history grant (TC-3325): its delegation id, its removal, its revocation.
import { describe, expect, setSystemTime, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { makeSignedTranscriptGrant, computeDelegationCid } from "./helpers/transcript-grant";
import { BotHistory, HISTORY_PREFIX, historyBotId, HistoryPermissionExpired } from "../bot-history";

const privateKey = `0x${"11".repeat(32)}` as const;
const address = privateKeyToAccount(privateKey).address;
const backendDid = "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810";
const host = "http://127.0.0.1:9137";
const KEY_A = "ab".repeat(16);
const KEY_B = "cd".repeat(16);
const space = makePkhSpaceId(address, 1, "applications");
const actions = { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] };
const uri = (key?: string) => `${space}/kv/${HISTORY_PREFIX}${historyBotId(address, key)}/`;
const stored = (key?: string) => `bot-history/grants/${address.toLowerCase()}${key ? `/${key}` : ""}`;
const missing = (key: string) => ({ ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } });
const down = { ok: false, error: { code: "NETWORK_ERROR", message: "down", service: "kv" } };

async function envelope(key?: string) {
  const grant = await makeSignedTranscriptGrant({ privateKey, att: { [uri(key)]: actions } });
  return { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature };
}
const cidOf = (signed: { serialized: string }): string => JSON.parse(signed.serialized).cid;

/** A backend node whose storage is a map and which writes down what it was asked to revoke. Nothing leaves the process. */
function world() {
  const entries = new Map<string, unknown>();
  const revoked: string[] = [];
  const state = { getFails: false, deleteFails: false, revokeRefused: false };
  const fake = {
    did: backendDid,
    computeDelegationCid,
    useDelegation: async () => ({}),
    kv: {
      put: async (key: string, value: unknown) => { entries.set(key, value); return { ok: true, data: {} }; },
      get: async (key: string) => (state.getFails ? down : entries.has(key) ? { ok: true, data: { data: entries.get(key) } } : missing(key)),
      delete: async (key: string) => {
        if (state.deleteFails) return down;
        if (!entries.has(key)) return missing(key);
        entries.delete(key);
        return { ok: true, data: undefined };
      },
    },
    revokeDelegation: async (cid: string) => {
      revoked.push(cid);
      return state.revokeRefused ? { ok: false, error: { code: "PERMISSION_DENIED", message: "refused", service: "delegation" } } : { ok: true, data: { cid } };
    },
  } as unknown as TinyCloudNode;
  return { entries, revoked, state, history: new BotHistory(fake, privateKey, host) };
}

describe("a deleted bot's stored history grant", () => {
  test("gives up its delegation id, and none when nothing is stored", async () => {
    const { history } = world();
    const signed = await envelope(KEY_A);
    await history.accept(address, signed, KEY_A);
    expect(await history.storedGrantCid(address, KEY_A)).toBe(cidOf(signed));
    expect(await history.storedGrantCid(address, KEY_B)).toBeUndefined();
  });

  test("still gives its id after it has expired", async () => {
    const { history } = world();
    const signed = await envelope(KEY_A);
    await history.accept(address, signed, KEY_A);
    try {
      setSystemTime(new Date(Date.now() + 40 * 86_400_000));
      // It is expired: nothing can be saved under it any more.
      await expect(history.archive(address, { v: 1, generation: "0".repeat(32), seq: 1, challenge: "1".repeat(64), record: { type: "user", text: "hi" }, bot: KEY_A }, async () => {}, KEY_A))
        .rejects.toBeInstanceOf(HistoryPermissionExpired);
      expect(await history.storedGrantCid(address, KEY_A)).toBe(cidOf(signed));
    } finally {
      setSystemTime();
    }
  });

  test("a stored entry that cannot be opened has no id to give", async () => {
    const { entries, history } = world();
    entries.set(stored(KEY_A), "not a sealed grant");
    expect(await history.storedGrantCid(address, KEY_A)).toBeUndefined();
  });

  test("a storage failure is an error, never 'nothing stored' and never 'removed'", async () => {
    const { state, entries, history } = world();
    await history.accept(address, await envelope(KEY_A), KEY_A);
    state.getFails = true;
    await expect(history.storedGrantCid(address, KEY_A)).rejects.toThrow();
    state.getFails = false;
    state.deleteFails = true;
    await expect(history.forget(address, KEY_A)).rejects.toThrow();
    expect(entries.has(stored(KEY_A))).toBe(true);
  });

  test("removing it removes that bot's only, and removing what is not there succeeds", async () => {
    const { entries, history } = world();
    await history.accept(address, await envelope());
    await history.accept(address, await envelope(KEY_A), KEY_A);
    await history.accept(address, await envelope(KEY_B), KEY_B);
    await history.forget(address, KEY_A);
    expect([...entries.keys()].sort()).toEqual([stored(), stored(KEY_B)].sort());
    await history.forget(address, KEY_A);
    expect([...entries.keys()].sort()).toEqual([stored(), stored(KEY_B)].sort());
  });

  test("Main's cannot be removed this way, and a malformed key or address is refused before anything is touched", async () => {
    const { entries, history } = world();
    await history.accept(address, await envelope());
    await expect(history.forget(address, "main")).rejects.toThrow("history_main_grant_kept");
    await expect(history.forget(address, "AB".repeat(16))).rejects.toThrow("history_bot_key_invalid");
    await expect(history.forget(address, "../main")).rejects.toThrow("history_bot_key_invalid");
    await expect(history.forget("0x22", KEY_A)).rejects.toThrow("history_owner_invalid");
    await expect(history.storedGrantCid(address, "main")).rejects.toThrow("history_main_grant_kept");
    expect([...entries.keys()]).toEqual([stored()]);
  });

  test("revoking asks the node to revoke exactly that delegation, and a refusal is an error", async () => {
    const { revoked, state, history } = world();
    await history.revoke("cid-1");
    expect(revoked).toEqual(["cid-1"]);
    state.revokeRefused = true;
    await expect(history.revoke("cid-2")).rejects.toThrow("history_revoke_failed");
    expect(revoked).toEqual(["cid-1", "cid-2"]);
  });
});
