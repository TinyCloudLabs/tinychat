// A grant, a storage entry and a path per bot (TC-3325). Main's are what they always were.
import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { makeSignedTranscriptGrant, computeDelegationCid } from "./helpers/transcript-grant";
import { projectBotHistoryGrant } from "../bot-history-grant";
import { BotHistory, checkedBatch, HISTORY_PREFIX, historyBotId, historyOwner, historyReceiptBody } from "../bot-history";

const privateKey = `0x${"11".repeat(32)}` as const;
const address = privateKeyToAccount(privateKey).address;
const otherKey = `0x${"44".repeat(32)}` as const;
const otherAddress = privateKeyToAccount(otherKey).address;
const backendDid = "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810";
const host = "http://127.0.0.1:9137";
const KEY_A = "ab".repeat(16);
const KEY_B = "cd".repeat(16);
const space = makePkhSpaceId(address, 1, "applications");
const actions = { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] };
const directory = (owner: string, key?: string) => `${HISTORY_PREFIX}${historyBotId(owner, key)}/`;
const uri = (key?: string) => `${space}/kv/${directory(address, key)}`;
const node = { did: backendDid, computeDelegationCid } as TinyCloudNode;

async function envelope(att: Record<string, unknown>, signer: `0x${string}` = privateKey) {
  const grant = await makeSignedTranscriptGrant({ privateKey: signer, att });
  return { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature };
}

describe("bot ids and paths", () => {
  const fixed = `0x${"22".repeat(20)}`;

  test("Main's id and directory are pinned byte for byte", () => {
    expect(historyOwner(fixed)).toBe("did:pkh:eip155:1:0x2222222222222222222222222222222222222222");
    expect(historyBotId(fixed)).toBe("11db6cc2930810ec2e88a86f05026feb734250c7b9afbd5914a6a82955e32136");
    expect(historyBotId(fixed, "main")).toBe(historyBotId(fixed));
    expect(directory(fixed)).toBe("xyz.tinycloud.tinychat/threads/bots/v1/11db6cc2930810ec2e88a86f05026feb734250c7b9afbd5914a6a82955e32136/");
  });

  test("another bot's id is the hash the bots service derives, and the address case does not change it", () => {
    expect(historyBotId(fixed, KEY_A)).toBe("c3b8444e14bf08dc624dfd314fb3a4746688b5970324a4dc3f65e10390683643");
    expect(historyBotId(address.toUpperCase().replace("0X", "0x"), KEY_A)).toBe(historyBotId(address.toLowerCase(), KEY_A));
  });

  test("a malformed address or key is refused before anything is hashed", () => {
    for (const bad of ["", "0x22", `${fixed}\n`, ` ${fixed}`, `${fixed}/x`, "did:pkh:eip155:1:0x2222222222222222222222222222222222222222"]) {
      expect(() => historyBotId(bad)).toThrow("history_owner_invalid");
    }
    for (const bad of ["", "AB".repeat(16), "ab".repeat(15), `${KEY_A}/`, `${KEY_A}\n`, "../main", "Main"]) {
      expect(() => historyBotId(fixed, bad)).toThrow("history_bot_key_invalid");
    }
  });
});

describe("a grant for a bot other than Main", () => {
  test("is accepted only for exactly that bot's directory, with get and put", async () => {
    const good = await envelope({ [uri(KEY_A)]: actions });
    expect((await projectBotHistoryGrant(node, host, address, good, KEY_A)).resources).toEqual([
      { service: "kv", space, path: directory(address, KEY_A), actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    ]);
    const refused: Record<string, unknown>[] = [
      // Main's directory, another bot's, the parent of them all.
      { [uri()]: actions },
      { [uri(KEY_B)]: actions },
      { [`${space}/kv/${HISTORY_PREFIX}`]: actions },
      // The right directory without its closing slash, or with something after it.
      { [uri(KEY_A).slice(0, -1)]: actions },
      { [`${uri(KEY_A)}x/`]: actions },
      // An extra action, a missing one, a second resource.
      { [uri(KEY_A)]: { ...actions, "tinycloud.kv/del": [{}] } },
      { [uri(KEY_A)]: { ...actions, "tinycloud.kv/list": [{}] } },
      { [uri(KEY_A)]: { "tinycloud.kv/put": [{}] } },
      { [uri(KEY_A)]: actions, [uri()]: actions },
      // Another service on the same path.
      { [uri(KEY_A).replace("/kv/", "/sql/")]: actions },
    ];
    for (const att of refused) {
      await expect(projectBotHistoryGrant(node, host, address, await envelope(att), KEY_A)).rejects.toThrow("history_grant_rejected");
    }
  });

  test("is not a grant for Main, for another bot, or for another owner", async () => {
    const good = await envelope({ [uri(KEY_A)]: actions });
    await expect(projectBotHistoryGrant(node, host, address, good)).rejects.toThrow();
    await expect(projectBotHistoryGrant(node, host, address, good, "main")).rejects.toThrow();
    await expect(projectBotHistoryGrant(node, host, address, good, KEY_B)).rejects.toThrow();
    await expect(projectBotHistoryGrant(node, host, otherAddress, good, KEY_A)).rejects.toThrow();
    // Another owner cannot mint a grant for this owner's bot.
    const forged = await envelope({ [uri(KEY_A)]: actions }, otherKey);
    await expect(projectBotHistoryGrant(node, host, address, forged, KEY_A)).rejects.toThrow();
  });

  test("Main's grant is checked as before, and is not a grant for another bot", async () => {
    const main = await envelope({ [uri()]: actions });
    expect((await projectBotHistoryGrant(node, host, address, main)).resources[0]!.path).toBe(directory(address));
    expect((await projectBotHistoryGrant(node, host, address, main, "main")).resources[0]!.path).toBe(directory(address));
    await expect(projectBotHistoryGrant(node, host, address, main, KEY_A)).rejects.toThrow("history_grant_rejected");
  });

  test("a malformed key is refused before the grant is read", async () => {
    const unread = { serialized: "not json", siwe: "", signature: "" };
    await expect(projectBotHistoryGrant(node, host, address, unread, "AB".repeat(16))).rejects.toThrow("history_bot_key_invalid");
    await expect(projectBotHistoryGrant(node, host, "0x22", unread, KEY_A)).rejects.toThrow("history_owner_invalid");
  });
});

/** A backend node whose storage is a map, and which reaches the point of looking up the owner's encryption network. */
function storage() {
  const entries = new Map<string, unknown>();
  const read: string[] = [];
  const fake = {
    ...node,
    useDelegation: async () => ({}),
    getEncryptionNetworkIdForSpace: () => "network",
    encryption: { discoverNetwork: async () => ({ ok: false }) },
    kv: {
      put: async (key: string, value: unknown) => { entries.set(key, value); return { ok: true, data: {} }; },
      get: async (key: string) => {
        read.push(key);
        return entries.has(key)
          ? { ok: true, data: { data: entries.get(key) } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } };
      },
    },
  } as unknown as TinyCloudNode;
  return { entries, read, history: new BotHistory(fake, privateKey, host) };
}
const batchFor = (key?: string) => ({ v: 1, generation: "0".repeat(32), seq: 1, challenge: "1".repeat(64), record: { type: "user", text: "hi" }, ...(key ? { bot: key } : {}) });
const noStage = async () => {};
/** The grant was found, opened and verified: the next step, which this fake node refuses, is the encryption network. */
const OPENED = "history_recipient_unavailable";

describe("where grants are stored", () => {
  test("Main's under the address alone, never under <address>/main; another bot's under <address>/<key>", async () => {
    const { entries, history } = storage();
    await history.accept(address, await envelope({ [uri()]: actions }));
    await history.accept(address, await envelope({ [uri()]: actions }), "main");
    await history.accept(address, await envelope({ [uri(KEY_A)]: actions }), KEY_A);
    expect([...entries.keys()].sort()).toEqual([
      `bot-history/grants/${address.toLowerCase()}`,
      `bot-history/grants/${address.toLowerCase()}/${KEY_A}`,
    ]);
  });

  test("a malformed key never becomes a storage key", async () => {
    const { entries, history } = storage();
    for (const bad of ["AB".repeat(16), "../x", `${KEY_A}/x`, ""]) {
      await expect(history.accept(address, await envelope({ [uri()]: actions }), bad)).rejects.toThrow("history_bot_key_invalid");
    }
    expect(entries.size).toBe(0);
  });

  test("a malformed address never becomes a storage key, for Main or for another bot", async () => {
    const { entries, read, history } = storage();
    for (const bad of ["0x22", `${address}/x`, `${address}/${KEY_B}`, `../${address}`, ""]) {
      await expect(history.archive(bad, batchFor(), noStage)).rejects.toThrow("history_owner_invalid");
      await expect(history.archive(bad, batchFor(KEY_A), noStage, KEY_A)).rejects.toThrow("history_owner_invalid");
      await expect(history.accept(bad, await envelope({ [uri()]: actions }))).rejects.toThrow("history_owner_invalid");
    }
    expect(read).toEqual([]);
    expect(entries.size).toBe(0);
  });

  test("a stored grant opens only where it was stored", async () => {
    const { entries, history } = storage();
    const mainEntry = `bot-history/grants/${address.toLowerCase()}`;
    await history.accept(address, await envelope({ [uri()]: actions }));
    await history.accept(address, await envelope({ [uri(KEY_A)]: actions }), KEY_A);
    await history.accept(address, await envelope({ [uri(KEY_B)]: actions }), KEY_B);
    // In place, each opens and verifies.
    await expect(history.archive(address, batchFor(), noStage)).rejects.toThrow(OPENED);
    await expect(history.archive(address, batchFor(KEY_A), noStage, KEY_A)).rejects.toThrow(OPENED);
    const sealedA = entries.get(`${mainEntry}/${KEY_A}`);
    // Copied to Main's entry, to another bot's, or to another owner's, it does not.
    const swapped = async (target: string, run: () => Promise<unknown>) => {
      const kept = entries.get(target);
      entries.set(target, sealedA);
      const failure = await run().then(() => "resolved", (error: Error) => error.message);
      expect(failure).not.toBe(OPENED);
      expect(failure).not.toBe("resolved");
      if (kept === undefined) entries.delete(target); else entries.set(target, kept);
    };
    await swapped(mainEntry, () => history.archive(address, batchFor(), noStage));
    await swapped(`${mainEntry}/${KEY_B}`, () => history.archive(address, batchFor(KEY_B), noStage, KEY_B));
    await swapped(`bot-history/grants/${otherAddress.toLowerCase()}/${KEY_A}`, () => history.archive(otherAddress, batchFor(KEY_A), noStage, KEY_A));
    await swapped(`bot-history/grants/${otherAddress.toLowerCase()}`, () => history.archive(otherAddress, batchFor(), noStage));
  });
});

describe("a batch is bound to its bot", () => {
  test("the checked batch keeps a well-formed bot key, in the service's field order, and refuses a malformed one", () => {
    expect(Object.keys(checkedBatch({ ...batchFor(KEY_A), staged: {} }))).toEqual(["v", "generation", "seq", "challenge", "record", "bot"]);
    expect(Object.keys(checkedBatch(batchFor()))).toEqual(["v", "generation", "seq", "challenge", "record"]);
    for (const bot of ["main", "AB".repeat(16), "", 7]) {
      expect(() => checkedBatch({ ...batchFor(), bot })).toThrow("invalid_history_batch");
    }
  });

  test("a batch that names another bot than the one asked for is refused before any grant is used", async () => {
    const { history } = storage();
    await expect(history.archive(address, batchFor(KEY_B), noStage, KEY_A)).rejects.toThrow("history_bot_mismatch");
    await expect(history.archive(address, batchFor(KEY_A), noStage)).rejects.toThrow("history_bot_mismatch");
    await expect(history.archive(address, batchFor(), noStage, KEY_A)).rejects.toThrow("history_bot_mismatch");
  });

  test("a sibling's receipt names the bot's id, its key and the path; Main's receipt has today's fields", () => {
    const owner = historyOwner(address);
    const batch = checkedBatch(batchFor(KEY_A));
    const path = `${directory(address, KEY_A)}${batch.generation}/${batch.seq}-${batch.challenge}`;
    expect(historyReceiptBody(owner, batch, space, host, "c".repeat(64), { key: KEY_A, path })).toMatchObject({ botId: historyBotId(address, KEY_A), key: KEY_A, path });
    const main = historyReceiptBody(owner, checkedBatch(batchFor()), space, host, "c".repeat(64));
    expect(Object.keys(main)).toEqual(["v", "owner", "botId", "generation", "seq", "challenge", "batchHash", "spaceId", "host", "ciphertextHash"]);
    expect(main.botId).toBe(historyBotId(address));
  });
});
