import { describe, expect, test } from "bun:test";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { botHistoryDirectory } from "./botHistoryPath";
import { historyAccessFor } from "./botHistoryAccess";
import { historyContextStatus } from "./historyContextStatus";
import { readBotHistory, readHistoryForBot, type BotHistoryContextReport } from "./historyRead";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";

const address = `0x${"34".repeat(20)}`;
const owner = `did:pkh:eip155:1:${address}`;
const spaceId = makePkhSpaceId(address, 1, "applications");
const networkId = encryptionNetworkId(address);
const generation = "0a".repeat(16);
const challenge = "cd".repeat(32);
const sibling = "7e".repeat(16);

type Plain = Record<string, unknown>;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The stored plaintext of a new record, written out literally so the format is pinned here. */
function bound(botKey: string, seq: number, text: string, change: (plain: Plain & { ctx: Plain }) => void = () => {}) {
  return async () => {
    const prefix = await botHistoryDirectory(address, botKey);
    const path = `${prefix}${generation}/${seq}-${challenge}`;
    const batch: Plain = { v: 1, generation, seq, challenge, record: { type: "user", text, at: "2026-11-14T00:00:00Z" }, ...(botKey === "main" ? {} : { bot: botKey }) };
    const ctx: Plain = { v: 1, owner, spaceId, path, bot: botKey, generation, seq, challenge };
    const plain = { ...batch, ctx };
    change(plain);
    return { path, plaintext: encode(plain) };
  };
}

/** A stored record without any context, as written before. */
function earlier(botKey: string, seq: number, text: string, inline = false) {
  return async () => {
    const prefix = await botHistoryDirectory(address, botKey);
    const path = `${prefix}${generation}/${seq}-${challenge}`;
    const batch: Plain = { v: 1, generation, seq, challenge, record: { type: "user", text, at: "2026-11-14T00:00:00Z" }, ...(botKey === "main" ? {} : { bot: botKey }) };
    return { path, plaintext: encode(batch), inline };
  };
}

interface Row { path: string; plaintext: Uint8Array; inline?: boolean; storedAt?: string }

/**
 * A synthetic node holding sealed records. `storedAt` stores a record's ciphertext at another path,
 * with the envelope binding that path would have.
 */
function tcwFor(rows: Row[]): TinyCloudWeb {
  const stored = new Map<string, { envelope: Plain; plaintext: Uint8Array }>();
  rows.forEach((row, index) => {
    const at = row.storedAt ?? row.path;
    const aad = btoa(JSON.stringify({ owner, spaceId, path: at }));
    const envelope = row.inline ? { v: 1, networkId, aad, ct: index } : { v: 2, networkId, keyPath: BOT_HISTORY_KEY_PATH, keyVersion: 1, aad, ct: index };
    stored.set(at, { envelope, plaintext: row.plaintext });
  });
  const open = (envelope: { ct: number }) => rows[envelope.ct]!.plaintext;
  return {
    session: () => ({ address, chainId: 1 }),
    kvForSpace: () => ({
      list: async () => ({ ok: true, data: { keys: [...stored.keys()], truncated: false } }),
      get: async (key: string) => ({ ok: true, data: { data: stored.get(key)!.envelope, headers: { etag: "e" } } }),
    }),
    keys: { decrypt: async (envelope: { ct: number }) => open(envelope) },
    encryption: { decryptEnvelope: async (envelope: { ct: number }) => ({ ok: true, data: open(envelope) }) },
  } as unknown as TinyCloudWeb;
}

async function read(rows: Row[], botKey?: string): Promise<{ texts: string[]; report: BotHistoryContextReport }> {
  const tcw = tcwFor(rows);
  let report: BotHistoryContextReport | undefined;
  const options = { onContextReport: (value: BotHistoryContextReport) => { report = value; } };
  const messages = botKey === undefined ? await readBotHistory(tcw, undefined, options) : await readHistoryForBot(tcw, botKey, undefined, options);
  return { texts: messages.map((message) => message.text), report: report! };
}

describe("opening bot history verifies the full record context", () => {
  test("a new record opens and is reported as verified", async () => {
    const row = await bound("main", 1, "new")();
    expect(await read([row])).toEqual({ texts: ["new"], report: { bound: 1, legacy: [] } });
  });

  test("a sibling bot's new record opens when read for that bot", async () => {
    const row = await bound(sibling, 1, "sibling new")();
    expect(await read([row], sibling)).toEqual({ texts: ["sibling new"], report: { bound: 1, legacy: [] } });
  });

  test("an earlier record, named or inline, opens and is identified as legacy by its stored key", async () => {
    const named = await earlier("main", 1, "named before")();
    const inline = await earlier("main", 2, "inline before", true)();
    const fresh = await bound("main", 3, "new")();
    const { texts, report } = await read([named, inline, fresh]);
    expect(texts.sort()).toEqual(["inline before", "named before", "new"]);
    expect(report.bound).toBe(1);
    expect(report.legacy.sort()).toEqual([named.path, inline.path].sort());
  });

  const refused: Array<[string, (plain: Plain & { ctx: Plain }) => void]> = [
    ["owner", ({ ctx }) => { ctx.owner = `did:pkh:eip155:1:0x${"56".repeat(20)}`; }],
    ["applications space", ({ ctx }) => { ctx.spaceId = makePkhSpaceId(address, 1, "default"); }],
    ["stored path", ({ ctx }) => { ctx.path = `${String(ctx.path)}0`; }],
    ["bot", ({ ctx }) => { ctx.bot = sibling; }],
    ["generation", ({ ctx }) => { ctx.generation = "0b".repeat(16); }],
    ["sequence", ({ ctx }) => { ctx.seq = 2; }],
    ["challenge", ({ ctx }) => { ctx.challenge = "ef".repeat(32); }],
    ["version", ({ ctx }) => { ctx.v = 2; }],
    ["field set (one added)", ({ ctx }) => { ctx.extra = true; }],
    ["field set (one missing)", ({ ctx }) => { delete ctx.owner; }],
    ["shape (not an object)", (plain) => { plain.ctx = "x" as unknown as Plain; }],
    ["shape (null)", (plain) => { plain.ctx = null as unknown as Plain; }],
  ];
  for (const [name, change] of refused) {
    test(`a record with the wrong ${name} in its context is refused`, async () => {
      const row = await bound("main", 1, "secret text", change)();
      await expect(read([row])).rejects.toThrow("history_binding_mismatch");
    });
  }

  test("a record stored at another path is refused", async () => {
    const original = await bound("main", 1, "moved")();
    const other = await bound("main", 2, "target")();
    await expect(read([{ ...original, storedAt: other.path }])).rejects.toThrow("history_binding_mismatch");
  });

  test("a main record stored under a sibling bot's path is refused", async () => {
    const main = await bound("main", 1, "main text")();
    const target = await bound(sibling, 1, "sibling text")();
    await expect(read([{ ...main, storedAt: target.path }], sibling)).rejects.toThrow("history_binding_mismatch");
  });

  test("a record whose context says another bot than its batch is refused", async () => {
    const row = await bound(sibling, 1, "sibling", ({ ctx }) => { ctx.bot = "main"; })();
    await expect(read([row], sibling)).rejects.toThrow("history_binding_mismatch");
  });

  test("no record is returned from a read that holds a refused record", async () => {
    const good = await bound("main", 1, "good")();
    const bad = await bound("main", 2, "bad", ({ ctx }) => { ctx.seq = 3; })();
    await expect(read([good, bad])).rejects.toThrow("history_binding_mismatch");
  });

  test("a sibling bot's earlier record stored in Main's history is refused, and so is an unknown batch version", async () => {
    const mainPrefix = await botHistoryDirectory(address, "main");
    const siblingRecord = await earlier(sibling, 1, "sibling earlier")();
    await expect(read([{ ...siblingRecord, storedAt: `${mainPrefix}${generation}/1-${challenge}` }])).rejects.toThrow("history_binding_mismatch");
    const unknown = await earlier("main", 2, "unknown version")();
    unknown.plaintext = encode({ ...JSON.parse(new TextDecoder().decode(unknown.plaintext)), v: 2 });
    await expect(read([unknown])).rejects.toThrow("history_binding_mismatch");
  });

  test("Main's own earlier record still opens", async () => {
    const row = await earlier("main", 1, "main earlier")();
    expect(await read([row])).toEqual({ texts: ["main earlier"], report: { bound: 0, legacy: [row.path] } });
  });
});

describe("the history access records what each read found", () => {
  test("counts of verified and earlier records are kept per bot, without keys", async () => {
    const fresh = await bound("main", 1, "new")();
    const old = await earlier("main", 2, "old")();
    await historyAccessFor(tcwFor([fresh, old])).read("main");
    expect(historyContextStatus("main")).toEqual({ bound: 1, legacy: 1 });
    const siblingRecord = await earlier(sibling, 1, "sibling old")();
    await historyAccessFor(tcwFor([siblingRecord])).read(sibling);
    expect(historyContextStatus(sibling)).toEqual({ bound: 0, legacy: 1 });
  });
});
