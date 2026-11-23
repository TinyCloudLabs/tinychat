import { describe, expect, test } from "bun:test";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { connectWallet } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { BOT_HISTORY_KEY_MAX_MS } from "./botHistoryKey";
import { botHistoryDirectory } from "./botHistoryPath";
import { authorizeBotHistory, BOT_HISTORY_LEGACY_APPROVAL_DESCRIPTION, botHistoryOwnerPermissions } from "./historyAuthorization";
import type { BotHistoryResealReport } from "./historyRead";
import { encryptionNetworkId, LEGACY_NETWORK_APPROVAL_MAX_MS } from "../lib/connectors/encryptionGrant";

const address = `0x${"56".repeat(20)}`;
const owner = `did:pkh:eip155:1:${address}`;
const spaceId = makePkhSpaceId(address, 1, "applications");
const networkId = encryptionNetworkId(address);
const generation = "0b".repeat(16);
const challenge = "ef".repeat(32);
const siblingA = "a1".repeat(16);
const siblingB = "b2".repeat(16);
const HOUR = 3_600_000;

const descriptor = {
  networkId, keyPath: BOT_HISTORY_KEY_PATH, alg: "x25519-aes256gcm/v1", keyVersion: 1,
  publicEncryptionKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", kind: "deletable", state: "active",
} as const;

interface Seed { path: string; plaintext: string; inline: boolean }

/** A stored record of `botKey`. Inline records are still sealed to the network key (older), others to the exact key. */
async function record(botKey: string, seq: number, inline = true, change: (batch: Record<string, unknown>) => void = () => {}): Promise<Seed> {
  const path = `${await botHistoryDirectory(address, botKey)}${generation}/${seq}-${challenge}`;
  const batch: Record<string, unknown> = {
    v: 1, generation, seq, challenge, record: { type: "user", text: `${botKey.slice(0, 4)} ${seq}`, at: "2026-11-14T00:00:00Z" },
    ...(botKey === "main" ? {} : { bot: botKey }),
  };
  change(batch);
  return { path, plaintext: JSON.stringify(batch), inline };
}

let sessions = 0;

/** An owner's session and space: older records need the decrypt grant, a rewrite round-trips through a named key. */
function fixture(seeds: Seed[], options: { sessionMs?: number; failCommit?: Set<string>; held?: "whole-network"; decline?: boolean } = {}) {
  const session = {
    address, chainId: 1, sessionKey: `fixture-${++sessions}`, signature: "fixture",
    siwe: `URI: did:key:fixture\nExpiration Time: ${new Date(Date.now() + (options.sessionMs ?? 30 * 86_400_000)).toISOString()}`,
  };
  const grantKey = (permission: { path: string; actions: string[] }) => `${permission.path}|${permission.actions.join()}`;
  // A session that already holds the exact key and, from a longer grant, the whole network.
  const granted = new Set<string>(options.held ? [`${networkId}|decrypt`, ...botHistoryOwnerPermissions(address).map(grantKey)] : []);
  const requests: Array<{ permissions: Array<{ path: string; actions: string[]; description: string }>; expiryMs: number }> = [];
  const plaintexts: string[] = [];
  const entries = new Map<string, { envelope: Record<string, unknown>; etag: number }>();
  let etags = 0;
  const aadOf = (path: string) => btoa(JSON.stringify({ owner, spaceId, path }));
  for (const seed of seeds) {
    plaintexts.push(seed.plaintext);
    const ct = plaintexts.length - 1;
    entries.set(seed.path, {
      envelope: seed.inline ? { v: 1, networkId, aad: aadOf(seed.path), ct }
        : { v: 2, networkId, keyPath: BOT_HISTORY_KEY_PATH, keyVersion: 1, aad: aadOf(seed.path), ct },
      etag: ++etags,
    });
  }
  const legacyKey = () => `${networkId}|decrypt`;
  const kvCalls: string[] = [];
  const tcw = {
    session: () => session,
    hasPermissions: (permissions: Array<{ path: string; actions: string[] }>) => permissions.every((p) => granted.has(grantKey(p))),
    setRuntimePermissionSigner: () => {},
    requestPermissions: async (permissions: Array<{ path: string; actions: string[]; description: string }>, request: { expiryMs: number }) => {
      requests.push({ permissions, expiryMs: request.expiryMs });
      if (options.decline) return { approved: false };
      for (const permission of permissions) granted.add(grantKey(permission));
      return { approved: true };
    },
    getEncryptionNetwork: async () => ({}),
    ensureEncryptionNetwork: async () => {},
    signSessionBytes: async () => new Uint8Array(64),
    kvForSpace: () => ({
      list: async (listing: { prefix: string }) => {
        kvCalls.push("list");
        return { ok: true, data: { keys: [...entries.keys()].filter((key) => key.startsWith(listing.prefix)), truncated: false } };
      },
      get: async (key: string) => {
        const entry = entries.get(key);
        return entry ? { ok: true, data: { data: entry.envelope, headers: { etag: `"${entry.etag}"` } } } : { ok: false };
      },
      put: async (key: string, envelope: Record<string, unknown>, put: { ifMatch?: string; ifNoneMatch?: string }) => {
        const entry = entries.get(key);
        if ((put.ifNoneMatch === "*" && entry) || (put.ifMatch !== undefined && put.ifMatch !== `"${entry?.etag}"`)) return { ok: false };
        if (put.ifMatch !== undefined && options.failCommit?.has(key)) return { ok: false };
        entries.set(key, { envelope, etag: ++etags });
        return { ok: true };
      },
      delete: async (key: string) => { entries.delete(key); },
    }),
    encryption: {
      decryptEnvelope: async (envelope: { ct: number }) => granted.has(legacyKey() + "") || [...granted].some((g) => g.startsWith(`${networkId}|`) && g.endsWith("decrypt"))
        ? { ok: true, data: new TextEncoder().encode(plaintexts[envelope.ct]!) }
        : { ok: false },
    },
    keys: {
      ensureKey: async () => descriptor,
      encrypt: async (_path: string, plaintext: Uint8Array, encrypt: { aad: Uint8Array }) => {
        plaintexts.push(new TextDecoder().decode(plaintext));
        return { v: 2, networkId, keyPath: BOT_HISTORY_KEY_PATH, keyVersion: 1, aad: btoa(new TextDecoder().decode(encrypt.aad)), ct: plaintexts.length - 1 };
      },
      decrypt: async (envelope: { ct: number }) => new TextEncoder().encode(plaintexts[envelope.ct]!),
    },
  } as unknown as TinyCloudWeb;
  const connect = (async () => ({ address, openkey: { signMessage: async () => ({ signature: "fixture" }) } })) as unknown as typeof connectWallet;
  const authorize = (extra: { includeLegacyNetwork?: boolean; onResealReport?: (report: BotHistoryResealReport) => void; sessionEndMs?: () => Promise<number | null> } = {}) =>
    authorizeBotHistory(tcw, connect, async () => ({ enabled: true }), { postDescriptor: async () => {}, ...extra });
  const stored = (path: string) => {
    const entry = entries.get(path)!;
    return { envelope: entry.envelope, plaintext: plaintexts[entry.envelope.ct as number]! };
  };
  const legacyRequest = () => requests.find((request) => request.permissions[0]!.actions.join() === "decrypt");
  return { authorize, requests, entries, stored, kvCalls, legacyRequest };
}

const isNamed = (envelope: Record<string, unknown>) => envelope.keyPath === BOT_HISTORY_KEY_PATH;

describe("the older-history decrypt request", () => {
  test("lasts one hour at most, while the exact key keeps seven days", async () => {
    const f = fixture([await record("main", 1)]);
    await f.authorize();
    expect(f.requests[0]!.expiryMs).toBe(BOT_HISTORY_KEY_MAX_MS);
    expect(f.legacyRequest()!.expiryMs).toBe(LEGACY_NETWORK_APPROVAL_MAX_MS);
    expect(LEGACY_NETWORK_APPROVAL_MAX_MS).toBe(HOUR);
  });

  test("is asked for even when the session already covers the whole network through a longer grant", async () => {
    const f = fixture([await record("main", 1), await record(siblingA, 1)], { held: "whole-network" });
    const reports: BotHistoryResealReport[] = [];
    await f.authorize({ onResealReport: (report) => reports.push(report) });
    expect(f.legacyRequest()!.expiryMs).toBe(LEGACY_NETWORK_APPROVAL_MAX_MS);
    expect(reports).toEqual([{ resealed: 2, failed: [] }]);
  });

  test("is asked once per session, not again while that approval lasts", async () => {
    const f = fixture([await record("main", 1)], { held: "whole-network" });
    await f.authorize();
    await f.authorize();
    expect(f.requests.filter((request) => request.permissions[0]!.actions.join() === "decrypt")).toHaveLength(1);
  });

  test("a longer grant already held is not used when the approval is declined, and nothing is opened", async () => {
    const seed = await record("main", 1);
    const f = fixture([seed], { held: "whole-network", decline: true });
    await expect(f.authorize()).rejects.toThrow();
    expect(f.legacyRequest()).toBeDefined();
    expect(isNamed(f.stored(seed.path).envelope)).toBe(false);
  });

  test("a longer grant already held is not asked for again when no record is left sealed to the network key", async () => {
    const f = fixture([await record("main", 1, false)], { held: "whole-network" });
    await f.authorize();
    expect(f.legacyRequest()).toBeUndefined();
  });

  test("is measured to the end of a renewed session, past its first signed end", async () => {
    const f = fixture([await record("main", 1)], { sessionMs: 5 * 60_000 });
    await f.authorize({ sessionEndMs: async () => Date.now() + 3 * HOUR });
    expect(f.requests[0]!.expiryMs).toBeGreaterThan(2.9 * HOUR);
    expect(f.legacyRequest()!.expiryMs).toBe(LEGACY_NETWORK_APPROVAL_MAX_MS);

    const shorter = fixture([await record("main", 1)], { sessionMs: 5 * 60_000 });
    await shorter.authorize({ sessionEndMs: async () => Date.now() + 20 * 60_000 });
    expect(shorter.legacyRequest()!.expiryMs).toBeGreaterThan(19 * 60_000);
    expect(shorter.legacyRequest()!.expiryMs).toBeLessThanOrEqual(20 * 60_000);
  });

  test("falls back to the signed end when no renewed end is known, and refuses a session past it", async () => {
    const f = fixture([await record("main", 1)], { sessionMs: -60_000 });
    await expect(f.authorize({ sessionEndMs: async () => null })).rejects.toThrow("history_session_expired");
    expect(f.requests).toEqual([]);
  });

  test("never outlasts a session that ends sooner", async () => {
    const f = fixture([await record("main", 1)], { sessionMs: 20 * 60_000 });
    await f.authorize();
    const expiry = f.legacyRequest()!.expiryMs;
    expect(expiry).toBeGreaterThan(0);
    expect(expiry).toBeLessThanOrEqual(20 * 60_000);
  });

  test("says what it opens and for how long, without the seven days", async () => {
    const f = fixture([await record("main", 1)]);
    await f.authorize();
    const description = f.legacyRequest()!.permissions[0]!.description;
    expect(description).toBe(BOT_HISTORY_LEGACY_APPROVAL_DESCRIPTION);
    expect(description).toContain("secrets");
    expect(description).toContain("1 hour");
    expect(description).not.toContain("7 days");
  });

  test("is not requested when no record is left sealed to the network key", async () => {
    const f = fixture([await record("main", 1, false)]);
    await f.authorize();
    expect(f.legacyRequest()).toBeUndefined();
  });
});

describe("the pass that moves older records to the exact key", () => {
  test("moves every bot's older records in one pass, including bots nobody opened, byte for byte", async () => {
    const seeds = [
      await record("main", 1), await record("main", 2),
      await record(siblingA, 1), await record(siblingB, 1), await record(siblingB, 2),
      await record("main", 3, false),
    ];
    const f = fixture(seeds);
    const before = seeds.map((seed) => f.stored(seed.path).plaintext);
    const reports: BotHistoryResealReport[] = [];
    await f.authorize({ onResealReport: (report) => reports.push(report) });
    expect(reports).toEqual([{ resealed: 5, failed: [] }]);
    seeds.forEach((seed, index) => {
      expect(isNamed(f.stored(seed.path).envelope)).toBe(true);
      expect(f.stored(seed.path).plaintext).toBe(before[index]!);
    });
    // Staged copies are gone and nothing else was added to the space.
    expect([...f.entries.keys()].sort()).toEqual(seeds.map((seed) => seed.path).sort());
    // Each record was committed against the version that was read.
    expect(f.legacyRequest()).toBeDefined();
  });

  test("a record that cannot be moved stays as it is and does not stop the others; the next sign-in step finishes it", async () => {
    const seeds = [await record("main", 1), await record(siblingA, 1), await record(siblingB, 1)];
    const failing = new Set([seeds[1]!.path]);
    const f = fixture(seeds, { failCommit: failing });
    const reports: BotHistoryResealReport[] = [];
    const onResealReport = (report: BotHistoryResealReport) => reports.push(report);
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args); };
    try {
      const unchanged = f.stored(seeds[1]!.path);
      await f.authorize({ onResealReport });
      expect(reports).toEqual([{ resealed: 2, failed: [{ reason: "commit_failed" }] }]);
      expect(f.stored(seeds[1]!.path)).toEqual(unchanged);
      expect(isNamed(f.stored(seeds[0]!.path).envelope)).toBe(true);
      expect(isNamed(f.stored(seeds[2]!.path).envelope)).toBe(true);
      expect(warned).toHaveLength(1);
      // The warning carries counts and reasons only.
      expect(JSON.stringify(warned[0])).not.toContain(seeds[1]!.path);

      failing.clear();
      await f.authorize({ onResealReport });
      expect(reports.at(-1)).toEqual({ resealed: 1, failed: [] });
      expect(isNamed(f.stored(seeds[1]!.path).envelope)).toBe(true);
      // Done: a further step does not scan again.
      const lists = f.kvCalls.length;
      await f.authorize({ onResealReport });
      expect(f.kvCalls.length).toBe(lists);
      expect(reports).toHaveLength(2);
    } finally {
      console.warn = warn;
    }
  });

  test("a record stored under another bot's directory than its batch names is counted and left untouched", async () => {
    const misplaced = await record("main", 1, true, (batch) => { batch.bot = siblingA; });
    const fine = await record(siblingB, 1);
    const f = fixture([misplaced, fine]);
    const reports: BotHistoryResealReport[] = [];
    const before = f.stored(misplaced.path);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await f.authorize({ onResealReport: (report) => reports.push(report) });
    } finally {
      console.warn = warn;
    }
    expect(reports).toEqual([{ resealed: 1, failed: [{ reason: "record_unreadable" }] }]);
    expect(f.stored(misplaced.path)).toEqual(before);
    expect(isNamed(f.stored(fine.path).envelope)).toBe(true);
  });

  test("a record whose version or field types are wrong is counted and left untouched", async () => {
    const wrongVersion = await record("main", 1, true, (batch) => { delete batch.v; });
    const wrongType = await record("main", 2, true, (batch) => { batch.seq = String(batch.seq); });
    const f = fixture([wrongVersion, wrongType]);
    const reports: BotHistoryResealReport[] = [];
    const warn = console.warn;
    console.warn = () => {};
    try {
      await f.authorize({ onResealReport: (report) => reports.push(report) });
    } finally {
      console.warn = warn;
    }
    expect(reports).toEqual([{ resealed: 0, failed: [{ reason: "record_unreadable" }, { reason: "record_unreadable" }] }]);
    expect(isNamed(f.stored(wrongVersion.path).envelope)).toBe(false);
    expect(isNamed(f.stored(wrongType.path).envelope)).toBe(false);
  });

  test("a sign-in that skips older history neither requests the decrypt nor scans", async () => {
    const f = fixture([await record("main", 1)]);
    await f.authorize({ includeLegacyNetwork: false });
    expect(f.legacyRequest()).toBeUndefined();
    expect(f.kvCalls).toEqual([]);
  });
});
