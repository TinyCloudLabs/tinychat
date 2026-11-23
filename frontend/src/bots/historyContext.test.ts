import { describe, expect, test } from "bun:test";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { botHistoryDirectory } from "./botHistoryPath";
import { publishBotHistoryKeyDescriptor } from "./botHistoryKey";
import { HISTORY_REBIND_PER_READ, readBotHistory, readHistoryForBot, type BotHistoryContextReport } from "./historyRead";
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

describe("every record needs the exact version and field types", () => {
  const wrong: Array<[string, (batch: Plain) => void]> = [
    ["a missing version", (batch) => { delete batch.v; }],
    ["another version", (batch) => { batch.v = 2; }],
    ["a number as generation", (batch) => { batch.generation = 7; }],
    ["a number as challenge", (batch) => { batch.challenge = 7; }],
    ["a text as sequence", (batch) => { batch.seq = String(batch.seq); }],
    ["a fractional sequence", (batch) => { batch.seq = 1.5; }],
  ];
  for (const [name, change] of wrong) {
    test(`Main's record with ${name} is refused`, async () => {
      const row = await earlier("main", 1, "text")();
      const batch = JSON.parse(new TextDecoder().decode(row.plaintext)) as Plain;
      change(batch);
      // The stored key is the one the changed fields would still spell, so only the type or version check can refuse it.
      row.plaintext = encode(batch);
      const mainPrefix = await botHistoryDirectory(address, "main");
      const rowAt = { ...row, path: `${mainPrefix}${String(batch.generation)}/${String(batch.seq)}-${String(batch.challenge)}` };
      await expect(read([rowAt])).rejects.toThrow("history_binding_mismatch");
    });
  }
});

const keyDescriptor = {
  networkId, keyPath: BOT_HISTORY_KEY_PATH, alg: "x25519-aes256gcm/v1", keyVersion: 1,
  publicEncryptionKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", kind: "deletable", state: "active",
} as const;
const session = {
  address, chainId: 1, sessionKey: "fixture", signature: "fixture",
  siwe: `URI: did:key:fixture\nExpiration Time: ${new Date(Date.now() + 30 * 86_400_000).toISOString()}`,
};

/** An owner's space with etags and a named key that really round-trips plaintext. */
async function ownerSpace(rows: Row[], options: { mismatchOnDecrypt?: boolean; staleEtag?: boolean } = {}) {
  const sealed: Uint8Array[] = [];
  const seal = (plaintext: Uint8Array, aad: string) => {
    sealed.push(plaintext);
    return { v: 2, networkId, keyPath: BOT_HISTORY_KEY_PATH, keyVersion: 1, aad, ct: sealed.length - 1 };
  };
  const entries = new Map<string, { envelope: Plain; etag: number }>();
  let etags = 0;
  const writes: Array<{ key: string; ifMatch?: string }> = [];
  rows.forEach((row) => {
    const aad = btoa(JSON.stringify({ owner, spaceId, path: row.path }));
    const envelope = row.inline ? { v: 1, networkId, aad, ct: sealed.push(row.plaintext) - 1 } : seal(row.plaintext, aad);
    entries.set(row.path, { envelope, etag: ++etags });
  });
  const open = (envelope: { ct: number }) => {
    const plaintext = sealed[envelope.ct]!;
    if (!options.mismatchOnDecrypt) return plaintext;
    // A key that returns the earlier bytes for a rewritten record: the rewrite must not be committed.
    return new TextEncoder().encode(new TextDecoder().decode(plaintext).replace(/,"ctx":.*\}$/, "}"));
  };
  const tcw = {
    session: () => session,
    hasPermissions: () => true,
    signSessionBytes: async () => new Uint8Array(64),
    kvForSpace: () => ({
      list: async (listing: { prefix: string }) => ({ ok: true, data: { keys: [...entries.keys()].filter((key) => key.startsWith(listing.prefix)), truncated: false } }),
      get: async (key: string) => {
        const entry = entries.get(key);
        return entry ? { ok: true, data: { data: entry.envelope, headers: { etag: options.staleEtag ? "stale" : `"${entry.etag}"` } } } : { ok: false };
      },
      put: async (key: string, envelope: Plain, putOptions: { ifMatch?: string; ifNoneMatch?: string }) => {
        const entry = entries.get(key);
        if ((putOptions.ifNoneMatch === "*" && entry) || (putOptions.ifMatch !== undefined && putOptions.ifMatch !== `"${entry?.etag}"`)) return { ok: false };
        if (putOptions.ifNoneMatch !== "*") writes.push({ key, ifMatch: putOptions.ifMatch });
        entries.set(key, { envelope, etag: ++etags });
        return { ok: true };
      },
      delete: async (key: string) => { entries.delete(key); },
    }),
    keys: {
      ensureKey: async () => keyDescriptor,
      encrypt: async (_path: string, plaintext: Uint8Array, encrypt: { aad: Uint8Array }) => seal(plaintext, btoa(new TextDecoder().decode(encrypt.aad))),
      decrypt: async (envelope: { ct: number }) => open(envelope),
    },
    encryption: { decryptEnvelope: async (envelope: { ct: number }) => ({ ok: true, data: open(envelope) }) },
  } as unknown as TinyCloudWeb;
  await publishBotHistoryKeyDescriptor(tcw, keyDescriptor, { post: async () => {} });
  const stored = (path: string) => {
    const entry = entries.get(path)!;
    return { envelope: entry.envelope, plaintext: open(entry.envelope as { ct: number }) };
  };
  return { tcw, entries, writes, stored };
}

describe("the owner's foreground read adds the context to earlier records", () => {
  const reads = async (tcw: TinyCloudWeb, reseal: boolean) => {
    let report: BotHistoryContextReport | undefined;
    const messages = await readBotHistory(tcw, undefined, { reseal, onContextReport: (value) => { report = value; } });
    return { texts: messages.map((message) => message.text), report: report! };
  };

  test("an earlier named record is rewritten with its context, committed against the etag it was read with", async () => {
    const row = await earlier("main", 1, "named before")();
    const space = await ownerSpace([row]);
    const original = JSON.parse(new TextDecoder().decode(space.stored(row.path).plaintext)) as Plain;
    expect(await reads(space.tcw, true)).toEqual({ texts: ["named before"], report: { bound: 0, legacy: [row.path] } });
    expect(space.writes.filter((write) => write.key === row.path)).toEqual([{ key: row.path, ifMatch: "\"1\"" }]);
    const { ctx, ...rest } = JSON.parse(new TextDecoder().decode(space.stored(row.path).plaintext)) as Plain;
    expect(rest).toEqual(original);
    expect(ctx).toEqual({ v: 1, owner, spaceId, path: row.path, bot: "main", generation, seq: 1, challenge });
    // Nothing else is left in the space, and the next read finds a verified record.
    expect([...space.entries.keys()]).toEqual([row.path]);
    expect(await reads(space.tcw, true)).toEqual({ texts: ["named before"], report: { bound: 1, legacy: [] } });
    expect(space.writes).toHaveLength(1);
  });

  test("an earlier inline record is sealed to the key first and given its context by the next read", async () => {
    const row = await earlier("main", 1, "inline before", true)();
    const space = await ownerSpace([row]);
    expect((await reads(space.tcw, true)).report).toEqual({ bound: 0, legacy: [row.path] });
    expect((space.stored(row.path).envelope as Plain).keyPath).toBe(BOT_HISTORY_KEY_PATH);
    expect(space.stored(row.path).plaintext).toEqual(row.plaintext);
    expect((await reads(space.tcw, true)).report).toEqual({ bound: 0, legacy: [row.path] });
    expect(await reads(space.tcw, true)).toEqual({ texts: ["inline before"], report: { bound: 1, legacy: [] } });
  });

  test("a record that already has its context, and a read that does not reseal, write nothing", async () => {
    const fresh = await bound("main", 1, "new")();
    const old = await earlier("main", 2, "old")();
    const space = await ownerSpace([fresh, old]);
    expect((await reads(space.tcw, false)).report).toEqual({ bound: 1, legacy: [old.path] });
    expect(space.writes).toEqual([]);
    expect((await reads(space.tcw, true)).report).toEqual({ bound: 1, legacy: [old.path] });
    expect(space.writes.map((write) => write.key)).toEqual([old.path]);
  });

  test("a sibling bot's earlier record is rewritten with that bot's context", async () => {
    const row = await earlier(sibling, 1, "sibling before")();
    const space = await ownerSpace([row]);
    await readHistoryForBot(space.tcw, sibling, undefined, { reseal: true });
    const { ctx } = JSON.parse(new TextDecoder().decode(space.stored(row.path).plaintext)) as Plain;
    expect(ctx).toEqual({ v: 1, owner, spaceId, path: row.path, bot: sibling, generation, seq: 1, challenge });
  });

  test("a record whose etag changed is left as it was and the read still returns it", async () => {
    const row = await earlier("main", 1, "raced")();
    const space = await ownerSpace([row], { staleEtag: true });
    const before = space.stored(row.path);
    expect(await reads(space.tcw, true)).toEqual({ texts: ["raced"], report: { bound: 0, legacy: [row.path] } });
    expect(space.stored(row.path)).toEqual(before);
    expect([...space.entries.keys()]).toEqual([row.path]);
  });

  test("a rewrite that does not read back as the same batch with its context is not committed", async () => {
    const row = await earlier("main", 1, "unverified")();
    const space = await ownerSpace([row], { mismatchOnDecrypt: true });
    const before = space.stored(row.path);
    expect((await reads(space.tcw, true)).texts).toEqual(["unverified"]);
    expect(space.writes.filter((write) => write.key === row.path)).toEqual([]);
    expect(space.stored(row.path)).toEqual(before);
    expect([...space.entries.keys()]).toEqual([row.path]);
  });

  test(`at most ${HISTORY_REBIND_PER_READ} records are rewritten by one read`, async () => {
    const rows = await Promise.all(Array.from({ length: HISTORY_REBIND_PER_READ + 3 }, (_, index) => earlier("main", index + 1, `m${index}`)()));
    const space = await ownerSpace(rows);
    await reads(space.tcw, true);
    expect((await reads(space.tcw, false)).report).toMatchObject({ bound: HISTORY_REBIND_PER_READ });
    expect((await reads(space.tcw, false)).report.legacy).toHaveLength(3);
  });
});
