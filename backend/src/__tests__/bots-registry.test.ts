import { describe, expect, test } from "bun:test";
import { addressFromOwnerDid, admission, BotsRegistry, parseOwnerBots, turnListHook, type AdmissionRefusal, type BotEnvironment, type RegistryKv } from "../bots-registry.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";

const ADDRESS = `0x${"Ab".repeat(20)}`;
const KEY = `bots/registry/${ADDRESS.toLowerCase()}`;
const T0 = new Date("2026-11-19T00:00:00.000Z");

interface Row {
  value: string;
  version: number;
}

/**
 * The backend's own store: honours `ifMatch` and `ifNoneMatch` with the SDK's result envelopes. Several registries
 * can share one, as two backend processes share one space.
 */
interface FakeStore extends RegistryKv {
  rows: Map<string, Row>;
  /** Runs once, inside the next put, before its condition is checked. */
  beforePut: undefined | (() => Promise<void>);
}

function store(): FakeStore {
  const rows = new Map<string, Row>();
  const precondition = { ok: false, error: { code: "KV_PRECONDITION_FAILED", service: "kv", message: "precondition failed" } };
  const kv: FakeStore = {
    rows,
    beforePut: undefined,
    async get(key) {
      const row = rows.get(key);
      if (!row) return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      return { ok: true, data: { data: row.value, headers: { etag: `"${row.version}"` } } };
    },
    async put(key, value, options) {
      const hook = kv.beforePut;
      kv.beforePut = undefined;
      if (hook) await hook();
      const row = rows.get(key);
      if (options.ifNoneMatch === "*" && row) return precondition;
      if (options.ifMatch !== undefined && (!row || `"${row.version}"` !== options.ifMatch)) return precondition;
      rows.set(key, { value: JSON.stringify(value), version: (row?.version ?? 0) + 1 });
      return { ok: true };
    },
  };
  return kv;
}

const stored = (kv: FakeStore): unknown => JSON.parse(kv.rows.get(KEY)!.value);

describe("the bots registry", () => {
  test("the first read for an owner stores a record that holds only Main", async () => {
    const kv = store();
    const row = await new BotsRegistry(kv, { now: () => T0 }).read(ADDRESS);
    const main = { key: "main", name: "TrustBot", shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0.toISOString() };
    expect(row.bots).toEqual([main]);
    expect(row.deleted).toEqual([]);
    expect(stored(kv)).toEqual({ v: 1, seq: 1, bots: [main], deleted: [] });
  });

  test("a later read returns the stored record and does not write again", async () => {
    const kv = store();
    const first = await new BotsRegistry(kv, { now: () => T0 }).read(ADDRESS);
    const again = await new BotsRegistry(kv, { now: () => new Date("2026-11-20T00:00:00.000Z") }).read(ADDRESS);
    expect(again).toEqual(first);
    expect(kv.rows.get(KEY)!.version).toBe(1);
  });

  test("a stored record that does not read back exactly is refused and left as it is", async () => {
    const main = { key: "main", name: "Main", shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0.toISOString() };
    const other = { ...main, key: "a".repeat(32), name: "Research" };
    const damaged: unknown[] = [
      "not a record",
      { v: 2, seq: 1, bots: [main], deleted: [] },
      { v: 1, seq: 0, bots: [main], deleted: [] },
      { v: 1, seq: 1, bots: [], deleted: [] },
      { v: 1, seq: 1, bots: [main, main], deleted: [] },
      { v: 1, seq: 1, bots: [main, { ...other, key: "../x" }], deleted: [] },
      { v: 1, seq: 1, bots: [main, { ...other, state: "paused" }], deleted: [] },
      { v: 1, seq: 1, bots: [main, { ...other, environment: "elsewhere" }], deleted: [] },
      { v: 1, seq: 1, bots: [main, other], deleted: [{ key: other.key, name: "Research" }] },
      { v: 1, seq: 1, bots: [main], deleted: [{ key: "main", name: "Main" }] },
      { v: 1, seq: 1, bots: [main] },
    ];
    for (const record of damaged) {
      const kv = store();
      kv.rows.set(KEY, { value: JSON.stringify(record), version: 7 });
      await expect(new BotsRegistry(kv, { now: () => T0 }).read(ADDRESS)).rejects.toThrow("bots_registry_unavailable");
      expect(kv.rows.get(KEY)).toEqual({ value: JSON.stringify(record), version: 7 });
    }
  });

  test("two first reads at the same moment agree on one record", async () => {
    const kv = store();
    const a = new BotsRegistry(kv, { now: () => T0 });
    const b = new BotsRegistry(kv, { now: () => new Date("2026-11-19T00:00:01.000Z") });
    let fromB: unknown;
    // B's whole read runs inside A's write, after A has already seen that no record exists.
    kv.beforePut = async () => { fromB = await b.read(ADDRESS); };
    const fromA = await a.read(ADDRESS);
    expect(fromA).toEqual(fromB);
    expect(kv.rows.get(KEY)!.version).toBe(1);
  });

  test("a malformed address is refused before the store is read or written", async () => {
    const kv = store();
    const touched: string[] = [];
    const { get, put } = kv;
    kv.get = async (key, options) => { touched.push(key); return get(key, options); };
    kv.put = async (key, value, options) => { touched.push(key); return put(key, value, options); };
    for (const bad of ["0x22", "", "Ab".repeat(20), `${ADDRESS}/x`, `../${ADDRESS}`, `${ADDRESS}\n`]) {
      await expect(new BotsRegistry(kv, { now: () => T0 }).read(bad)).rejects.toThrow("bots_registry_unavailable");
    }
    expect(touched).toEqual([]);
  });

  test("creating a bot stores it after Main, private and active, under a key the backend chose", async () => {
    const kv = store();
    const key = "a".repeat(32);
    const registry = new BotsRegistry(kv, { now: () => T0, newKey: () => key });
    const main = (await registry.read(ADDRESS)).bots[0];
    const result = await registry.create(ADDRESS, { name: "Research", shape: "sprout", colour: "teal" }, 3);
    const bot = { key, name: "Research", shape: "sprout", colour: "teal", environment: "private", state: "active", createdAt: T0.toISOString() };
    // The counter of the write that stored the bot goes with it: the service is told the bot's state under it.
    expect(result).toEqual({ ok: true, bot, seq: 2 });
    expect(stored(kv)).toEqual({ v: 1, seq: 2, bots: [main, bot], deleted: [] });
  });

  test("a bot is refused once the owner has as many private bots as the limit, Main included", async () => {
    const kv = store();
    let next = 0;
    const registry = new BotsRegistry(kv, { now: () => T0, newKey: () => String(++next).repeat(32) });
    const input = (name: string) => ({ name, shape: "sprout", colour: "teal" });
    expect((await registry.create(ADDRESS, input("One"), 3)).ok).toBe(true);
    expect((await registry.create(ADDRESS, input("Two"), 3)).ok).toBe(true);
    const before = kv.rows.get(KEY);
    expect(await registry.create(ADDRESS, input("Three"), 3)).toEqual({ ok: false, error: "bot_limit" });
    expect(kv.rows.get(KEY)).toEqual(before);
    expect((await registry.read(ADDRESS)).bots.map(bot => bot.name)).toEqual(["TrustBot", "One", "Two"]);
  });

  test("four creates at once for a new owner, across two registries, give two bots and two refusals", async () => {
    const kv = store();
    let conflicts = 0;
    const { put } = kv;
    kv.put = async (key, value, options) => {
      const result = await put(key, value, options);
      if (JSON.stringify(result).includes("KV_PRECONDITION_FAILED")) conflicts += 1;
      return result;
    };
    // Two backend processes: each has its own registry and its own source of keys, and they share one store.
    const registryWithKeys = (letter: string) => {
      let next = 0;
      return new BotsRegistry(kv, { now: () => T0, newKey: () => letter.repeat(31) + String(++next) });
    };
    const a = registryWithKeys("a");
    const b = registryWithKeys("b");
    const input = (name: string) => ({ name, shape: "sprout", colour: "teal" });
    // All four read before any of them writes, so each decides on a record the others are about to change.
    const results = await Promise.all([a.create(ADDRESS, input("One"), 3), b.create(ADDRESS, input("Two"), 3), a.create(ADDRESS, input("Three"), 3), b.create(ADDRESS, input("Four"), 3)]);
    const created = results.flatMap(result => (result.ok ? [result.bot.key] : []));
    expect(created).toHaveLength(2);
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "bot_limit" }, { ok: false, error: "bot_limit" }]);
    const row = await a.read(ADDRESS);
    expect(row.bots).toHaveLength(3);
    expect(row.bots.slice(1).map(bot => bot.key).sort()).toEqual([...created].sort());
    expect(conflicts).toBeGreaterThanOrEqual(3);
  });

  test("a name that is empty, longer than 24 characters, not text or holds a control character is refused before the store is touched", async () => {
    const kv = store();
    const registry = new BotsRegistry(kv, { now: () => T0, newKey: () => "a".repeat(32) });
    for (const bad of ["", "   ", "x".repeat(25), "tab\tname", "line\nbreak", 7, null, undefined]) {
      expect(await registry.create(ADDRESS, { name: bad, shape: "sprout", colour: "teal" }, 3)).toEqual({ ok: false, error: "invalid_name" });
    }
    expect(kv.rows.size).toBe(0);
  });

  test("a shape or colour outside the catalog is refused before the store is touched", async () => {
    const kv = store();
    const registry = new BotsRegistry(kv, { now: () => T0, newKey: () => "a".repeat(32) });
    for (const shape of ["square", "", "Pebble", 3, undefined]) {
      expect(await registry.create(ADDRESS, { name: "Research", shape, colour: "teal" }, 3)).toEqual({ ok: false, error: "invalid_shape" });
    }
    for (const colour of ["#ff0000", "", "Blue", "color", null]) {
      expect(await registry.create(ADDRESS, { name: "Research", shape: "sprout", colour }, 3)).toEqual({ ok: false, error: "invalid_colour" });
    }
    expect(kv.rows.size).toBe(0);
  });

  test("a name another of the owner's bots already has is refused, ignoring case", async () => {
    const kv = store();
    let next = 0;
    const registry = new BotsRegistry(kv, { now: () => T0, newKey: () => String(++next).repeat(32) });
    const input = (name: string) => ({ name, shape: "sprout", colour: "teal" });
    expect((await registry.create(ADDRESS, input("Research"), 3)).ok).toBe(true);
    const before = kv.rows.get(KEY);
    for (const taken of ["Research", "research", "  RESEARCH ", "Main", "main"]) {
      expect(await registry.create(ADDRESS, input(taken), 3)).toEqual({ ok: false, error: "name_taken" });
    }
    expect(kv.rows.get(KEY)).toEqual(before);
  });

  test("a key that is in use, was deleted, or is malformed is never given to a new bot", async () => {
    const kv = store();
    const main = { key: "main", name: "Main", shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0.toISOString() };
    const used = "a".repeat(32);
    const gone = "b".repeat(32);
    const fresh = "c".repeat(32);
    kv.rows.set(KEY, { value: JSON.stringify({ v: 1, seq: 5, bots: [main, { ...main, key: used, name: "One" }], deleted: [{ key: gone, name: "Old" }] }), version: 1 });
    const offered = [used, gone, "NOT-A-KEY", `${fresh}/x`, fresh];
    const registry = new BotsRegistry(kv, { now: () => T0, newKey: () => offered.shift() ?? fresh });
    const result = await registry.create(ADDRESS, { name: "Two", shape: "sprout", colour: "teal" }, 3);
    expect(result.ok && result.bot.key).toBe(fresh);
    expect((await registry.read(ADDRESS)).bots.map(bot => bot.key)).toEqual(["main", used, fresh]);
  });
});

describe("may one bot message another", () => {
  // A bot that is being deleted always carries the time its deletion began; the record is refused without it.
  const bot = (key: string, name: string, state = "active", environment = "private", createdAt = T0.toISOString()) =>
    ({ key, name, shape: "pebble", colour: "blue", environment, state, createdAt, ...(state === "deleting" ? { deletingSince: createdAt } : {}) });
  const A = "a".repeat(32);
  const SUSPENDED = "5".repeat(32);
  const DELETING = "d".repeat(32);
  const REGULAR = "e".repeat(32);
  const row = parseOwnerBots({
    v: 1, seq: 9, deleted: [{ key: "f".repeat(32), name: "Gone" }],
    bots: [bot("main", "Main"), bot(A, "A"), bot(SUSPENDED, "Paused", "suspended"), bot(DELETING, "Leaving", "deleting"), bot(REGULAR, "Regular", "active", "regular")],
  });

  test("an active bot may message another active bot of the same owner and environment", () => {
    expect(admission(row, "main", A)).toEqual({ admitted: true });
    expect(admission(row, A, "main")).toEqual({ admitted: true });
    expect(admission(row, "main", A, "private")).toEqual({ admitted: true });
  });

  test("a message is refused with the reason that applies", () => {
    const UNKNOWN = "9".repeat(32);
    const GONE = "f".repeat(32);
    const cases: Array<[source: string, target: string, caller: BotEnvironment | undefined, reason: AdmissionRefusal]> = [
      [UNKNOWN, A, undefined, "unknown_source"],
      ["../x", A, undefined, "unknown_source"],
      [GONE, A, undefined, "unknown_source"],
      ["main", UNKNOWN, undefined, "unknown_target"],
      ["main", "Main", undefined, "unknown_target"],
      ["main", GONE, undefined, "unknown_target"],
      [A, A, undefined, "same_bot"],
      [SUSPENDED, A, undefined, "source_not_active"],
      [DELETING, A, undefined, "source_not_active"],
      ["main", SUSPENDED, undefined, "target_not_active"],
      ["main", DELETING, undefined, "target_not_active"],
      ["main", REGULAR, undefined, "different_environment"],
      [REGULAR, "main", undefined, "different_environment"],
      // The service that asks may only ask about bots of its own environment.
      ["main", A, "regular", "unknown_source"],
      [REGULAR, "main", "private", "unknown_source"],
    ];
    for (const [source, target, caller, reason] of cases) {
      expect(admission(row, source, target, caller)).toEqual({ admitted: false, reason });
    }
  });

  test("a bot's key counts only in its own owner's record", async () => {
    const kv = store();
    const other = `0x${"cd".repeat(20)}`;
    const registry = new BotsRegistry(kv, { now: () => T0, newKey: () => A });
    await registry.create(ADDRESS, { name: "A", shape: "sprout", colour: "teal" }, 3);
    expect(await registry.admit(ADDRESS, "main", A)).toEqual({ admitted: true });
    expect(await registry.admit(other, "main", A)).toEqual({ admitted: false, reason: "unknown_target" });
    expect(await registry.admit(other, A, "main")).toEqual({ admitted: false, reason: "unknown_source" });
  });

  test("admission is refused, never thrown, when the record cannot be read", async () => {
    const down = store();
    down.get = async () => { throw new Error("store down"); };
    const damaged = store();
    damaged.rows.set(KEY, { value: JSON.stringify({ v: 9 }), version: 1 });
    for (const [kv, address] of [[down, ADDRESS], [damaged, ADDRESS], [store(), "0x22"]] as const) {
      expect(await new BotsRegistry(kv, { now: () => T0 }).admit(address, "main", A)).toEqual({ admitted: false, reason: "unavailable" });
    }
  });

  test("a turn may message the owner's other active bots of its own environment, Main first, then oldest first", async () => {
    const NEWER = "b".repeat(32);
    const kv = store();
    kv.rows.set(KEY, {
      version: 1,
      value: JSON.stringify({
        v: 1, seq: 9, deleted: [],
        bots: [bot(NEWER, "Newer", "active", "private", "2026-11-19T02:00:00.000Z"), bot(SUSPENDED, "Paused", "suspended"), bot(A, "Older", "active", "private", "2026-11-19T01:00:00.000Z"),
          bot("main", "Main"), bot(DELETING, "Leaving", "deleting"), bot(REGULAR, "Regular", "active", "regular")],
      }),
    });
    const registry = new BotsRegistry(kv, { now: () => T0 });
    expect(await registry.listForTurn(ADDRESS, "main")).toEqual([A, NEWER]);
    expect(await registry.listForTurn(ADDRESS, NEWER)).toEqual(["main", A]);
    for (const source of [SUSPENDED, DELETING, REGULAR, "9".repeat(32), "../x"]) {
      expect(await registry.listForTurn(ADDRESS, source)).toEqual([]);
    }
  });

  test("the list of bots a turn may message is empty when the record cannot be read", async () => {
    const down = store();
    down.get = async () => { throw new Error("store down"); };
    const damaged = store();
    damaged.rows.set(KEY, { value: JSON.stringify({ v: 9 }), version: 1 });
    for (const [kv, address] of [[down, ADDRESS], [damaged, ADDRESS], [store(), "0x22"]] as const) {
      expect(await new BotsRegistry(kv, { now: () => T0 }).listForTurn(address, "main")).toEqual([]);
    }
  });

  test("an owner's DID gives its address only in the one canonical form", () => {
    const did = `did:pkh:eip155:1:${ADDRESS.toLowerCase()}`;
    expect(addressFromOwnerDid(did)).toBe(ADDRESS.toLowerCase());
    for (const bad of [ADDRESS, `did:pkh:eip155:1:${ADDRESS}`, `did:pkh:eip155:137:${ADDRESS.toLowerCase()}`, `${did}/x`, `${did}\n`, ` ${did}`, "did:key:z6Mk", ""]) {
      expect([bad, addressFromOwnerDid(bad)]).toEqual([bad, undefined]);
    }
  });

  test("the list a turn is given can be asked for by the owner's DID, and a malformed DID gives an empty list", async () => {
    const registry = new BotsRegistry(store(), { now: () => T0, newKey: () => A });
    await registry.create(ADDRESS, { name: "A", shape: "sprout", colour: "teal" }, 3);
    const hook = turnListHook(registry);
    expect(await hook(`did:pkh:eip155:1:${ADDRESS.toLowerCase()}`, "main")).toEqual([A]);
    expect(await hook(`did:pkh:eip155:1:${ADDRESS}`, "main")).toEqual([]);
    expect(await hook(ADDRESS, "main")).toEqual([]);
  });
});

describe("renaming and restyling a bot", () => {
  const KEY_A = "a".repeat(32);
  const KEY_B = "b".repeat(32);
  const LEAVING = "d".repeat(32);
  const GONE = "f".repeat(32);
  const bot = (key: string, name: string, state = "active") =>
    ({ key, name, shape: "pebble", colour: "blue", environment: "private", state, createdAt: T0.toISOString(), ...(state === "deleting" ? { deletingSince: T0.toISOString() } : {}) });
  /** A store whose record holds Main, Research, Notes and one bot that is being deleted, and remembers one deleted key. */
  const seeded = () => {
    const kv = store();
    kv.rows.set(KEY, { version: 1, value: JSON.stringify({ v: 1, seq: 4, deleted: [{ key: GONE, name: "Gone" }], bots: [bot("main", "Main"), bot(KEY_A, "Research"), bot(KEY_B, "Notes"), bot(LEAVING, "Leaving", "deleting")] }) });
    return kv;
  };

  test("a new name, shape or colour is stored, and the key and everything else stay as they were", async () => {
    const registry = new BotsRegistry(seeded(), { now: () => new Date("2026-12-01T00:00:00.000Z") });
    expect(await registry.update(ADDRESS, KEY_A, { name: "  Reading  " })).toEqual({ ok: true, bot: bot(KEY_A, "Reading") });
    const restyled = { ...bot(KEY_A, "Reading"), shape: "moon", colour: "indigo" };
    expect(await registry.update(ADDRESS, KEY_A, { shape: "moon", colour: "indigo" })).toEqual({ ok: true, bot: restyled });
    const row = await registry.read(ADDRESS);
    expect(row.seq).toBe(6);
    expect(row.bots).toEqual([bot("main", "TrustBot"), restyled, bot(KEY_B, "Notes"), bot(LEAVING, "Leaving", "deleting")]);
  });

  test("Main can be renamed and restyled, and stays Main", async () => {
    const registry = new BotsRegistry(seeded());
    const changed = { ...bot("main", "Home base"), shape: "star", colour: "red" };
    expect(await registry.update(ADDRESS, "main", { name: "Home base", shape: "star", colour: "red" })).toEqual({ ok: true, bot: changed });
    expect((await registry.read(ADDRESS)).bots[0]).toEqual(changed);
  });

  test("a change that is empty or not valid is refused before the store is touched", async () => {
    const kv = seeded();
    const before = kv.rows.get(KEY);
    const touched: string[] = [];
    const { get } = kv;
    kv.get = async (key, options) => { touched.push(key); return get(key, options); };
    const registry = new BotsRegistry(kv);
    const cases: Array<[input: { name?: unknown; shape?: unknown; colour?: unknown }, error: string]> = [
      [{}, "invalid"],
      [{ name: "" }, "invalid_name"],
      [{ name: "x".repeat(25) }, "invalid_name"],
      [{ name: 7 }, "invalid_name"],
      [{ shape: "square" }, "invalid_shape"],
      [{ colour: "#ffffff" }, "invalid_colour"],
      [{ name: "Fine", shape: "square" }, "invalid_shape"],
    ];
    for (const [input, error] of cases) {
      expect([input, await registry.update(ADDRESS, KEY_A, input)]).toEqual([input, { ok: false, error }]);
    }
    expect(touched).toEqual([]);
    expect(kv.rows.get(KEY)).toEqual(before);
  });

  test("a name another bot has is refused, ignoring case, but a bot may keep its own name or change only its case", async () => {
    const registry = new BotsRegistry(seeded());
    for (const taken of ["Notes", "notes", "MAIN", " Leaving "]) {
      expect([taken, await registry.update(ADDRESS, KEY_A, { name: taken })]).toEqual([taken, { ok: false, error: "name_taken" }]);
    }
    expect(await registry.update(ADDRESS, KEY_A, { name: "Research" })).toEqual({ ok: true, bot: bot(KEY_A, "Research") });
    expect(await registry.update(ADDRESS, KEY_A, { name: "RESEARCH" })).toEqual({ ok: true, bot: bot(KEY_A, "RESEARCH") });
  });

  test("a key that is unknown, malformed or deleted is not found, and a bot that is being deleted cannot be changed", async () => {
    const kv = seeded();
    const before = kv.rows.get(KEY);
    const registry = new BotsRegistry(kv);
    for (const key of ["9".repeat(32), "../x", "Research", GONE]) {
      expect([key, await registry.update(ADDRESS, key, { name: "New" })]).toEqual([key, { ok: false, error: "not_found" }]);
    }
    expect(await registry.update(ADDRESS, LEAVING, { name: "New" })).toEqual({ ok: false, error: "bot_deleting" });
    expect(kv.rows.get(KEY)).toEqual(before);
  });

  test("a change that changes nothing writes nothing", async () => {
    const kv = seeded();
    const registry = new BotsRegistry(kv);
    expect(await registry.update(ADDRESS, KEY_A, { name: "Research", shape: "pebble", colour: "blue" })).toEqual({ ok: true, bot: bot(KEY_A, "Research") });
    expect(kv.rows.get(KEY)!.version).toBe(1);
  });
});

describe("deleting a bot", () => {
  const KEY_A = "a".repeat(32);
  const KEY_B = "b".repeat(32);
  const GONE = "f".repeat(32);
  const LATER = new Date("2026-12-01T00:00:00.000Z");
  const bot = (key: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ key, name, shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0.toISOString(), ...extra });
  const deleting = (key: string, name: string, extra: Record<string, unknown> = {}) => bot(key, name, { state: "deleting", deletingSince: LATER.toISOString(), ...extra });
  const seed = (bots: unknown[], deleted: unknown[] = [{ key: GONE, name: "Gone" }]) => {
    const kv = store();
    kv.rows.set(KEY, { version: 1, value: JSON.stringify({ v: 1, seq: 4, deleted, bots }) });
    return kv;
  };
  /** Main, Research (active) and Notes (suspended). */
  const usual = () => seed([bot("main", "Main"), bot(KEY_A, "Research"), bot(KEY_B, "Notes", { state: "suspended" })]);
  const wanted = { name: "More", shape: "sprout", colour: "teal" };

  test("marks the bot as being deleted, with the time, under a new counter", async () => {
    const registry = new BotsRegistry(usual(), { now: () => LATER });
    expect(await registry.beginDelete(ADDRESS, KEY_A)).toEqual({ ok: true, bot: deleting(KEY_A, "Research"), seq: 5 });
    expect((await registry.read(ADDRESS)).bots[1]).toEqual(deleting(KEY_A, "Research"));
    // A suspended bot can be deleted too.
    expect(await registry.beginDelete(ADDRESS, KEY_B)).toEqual({ ok: true, bot: deleting(KEY_B, "Notes"), seq: 6 });
  });

  test("asked again, answers the same bot and writes nothing", async () => {
    const kv = usual();
    const first = await new BotsRegistry(kv, { now: () => LATER }).beginDelete(ADDRESS, KEY_A);
    expect(first.ok).toBe(true);
    const version = kv.rows.get(KEY)!.version;
    expect(await new BotsRegistry(kv, { now: () => new Date("2027-01-01T00:00:00.000Z") }).beginDelete(ADDRESS, KEY_A)).toEqual(first);
    expect(kv.rows.get(KEY)!.version).toBe(version);
  });

  test("a bot that is being deleted no longer counts toward the limit", async () => {
    const registry = new BotsRegistry(usual(), { now: () => LATER, newKey: () => "c".repeat(32) });
    expect(await registry.create(ADDRESS, wanted, 3)).toEqual({ ok: false, error: "bot_limit" });
    await registry.beginDelete(ADDRESS, KEY_A);
    expect((await registry.create(ADDRESS, wanted, 3)).ok).toBe(true);
  });

  test("Main cannot be deleted, and a key that is unknown, malformed or already deleted is not found", async () => {
    const kv = usual();
    const before = kv.rows.get(KEY);
    const registry = new BotsRegistry(kv, { now: () => LATER });
    expect(await registry.beginDelete(ADDRESS, "main")).toEqual({ ok: false, error: "main_fixed" });
    for (const key of ["9".repeat(32), "../x", "Research", GONE]) {
      expect([key, await registry.beginDelete(ADDRESS, key)]).toEqual([key, { ok: false, error: "not_found" }]);
    }
    expect(kv.rows.get(KEY)).toEqual(before);
  });

  test("with three bots already being deleted, a fourth deletion is refused", async () => {
    const kv = seed([bot("main", "Main"), deleting("1".repeat(32), "One"), deleting("2".repeat(32), "Two"), deleting("3".repeat(32), "Three"), bot(KEY_A, "Research")]);
    const before = kv.rows.get(KEY);
    expect(await new BotsRegistry(kv, { now: () => LATER }).beginDelete(ADDRESS, KEY_A)).toEqual({ ok: false, error: "delete_limit" });
    expect(kv.rows.get(KEY)).toEqual(before);
  });

  test("closing a bot's permission is recorded with the delegation to revoke, and only for a bot that is being deleted", async () => {
    const kv = seed([bot("main", "Main"), deleting(KEY_A, "Research"), bot(KEY_B, "Notes")]);
    const registry = new BotsRegistry(kv);
    const closed = deleting(KEY_A, "Research", { grantClosed: true, revoke: { cid: "cid-1" } });
    expect(await registry.closeGrant(ADDRESS, KEY_A, "cid-1")).toEqual(closed);
    expect((await registry.read(ADDRESS)).bots[1]).toEqual(closed);
    // Asked again, even with another delegation, the first one stays: it is the one still to revoke.
    const version = kv.rows.get(KEY)!.version;
    expect(await registry.closeGrant(ADDRESS, KEY_A, "cid-2")).toEqual(closed);
    // A bot that is not being deleted keeps accepting permissions, and so does Main.
    expect(await registry.closeGrant(ADDRESS, KEY_B, "cid-3")).toBeUndefined();
    expect(await registry.closeGrant(ADDRESS, "main", "cid-4")).toBeUndefined();
    expect(kv.rows.get(KEY)!.version).toBe(version);
  });

  test("a bot with no stored permission is closed with nothing to revoke", async () => {
    const registry = new BotsRegistry(seed([bot("main", "Main"), deleting(KEY_A, "Research")]));
    expect(await registry.closeGrant(ADDRESS, KEY_A, undefined)).toEqual(deleting(KEY_A, "Research", { grantClosed: true }));
  });

  test("a bot leaves the record only after its permission was closed, and its key and name are remembered", async () => {
    const kv = seed([bot("main", "Main"), deleting(KEY_A, "Research"), bot(KEY_B, "Notes")]);
    const registry = new BotsRegistry(kv);
    expect(await registry.finishDelete(ADDRESS, KEY_A)).toBe(false);
    expect((await registry.read(ADDRESS)).bots).toHaveLength(3);
    await registry.closeGrant(ADDRESS, KEY_A, "cid-1");
    expect(await registry.finishDelete(ADDRESS, KEY_A)).toBe(true);
    const row = await registry.read(ADDRESS);
    expect(row.bots.map(entry => entry.key)).toEqual(["main", KEY_B]);
    expect(row.deleted).toEqual([{ key: GONE, name: "Gone" }, { key: KEY_A, name: "Research", revoke: { cid: "cid-1" } }]);
    // Asked again it is still gone, and nothing is written. A bot that is not being deleted cannot be finished.
    const version = kv.rows.get(KEY)!.version;
    expect(await registry.finishDelete(ADDRESS, KEY_A)).toBe(true);
    expect(await registry.finishDelete(ADDRESS, KEY_B)).toBe(false);
    expect(await registry.finishDelete(ADDRESS, "main")).toBe(false);
    expect(kv.rows.get(KEY)!.version).toBe(version);
  });

  test("once the delegation is revoked nothing is left to retry, for a bot being deleted and for a deleted one", async () => {
    const kv = seed([bot("main", "Main"), deleting(KEY_A, "Research", { grantClosed: true, revoke: { cid: "cid-1" } })], [{ key: GONE, name: "Gone", revoke: { cid: "cid-0" } }]);
    const registry = new BotsRegistry(kv);
    await registry.clearRevoke(ADDRESS, KEY_A);
    await registry.clearRevoke(ADDRESS, GONE);
    const row = await registry.read(ADDRESS);
    expect(row.bots[1]).toEqual(deleting(KEY_A, "Research", { grantClosed: true }));
    expect(row.deleted).toEqual([{ key: GONE, name: "Gone" }]);
  });

  test("a record whose deletion bookkeeping does not fit a bot's state is refused and left as it is", async () => {
    const main = bot("main", "Main");
    const damaged: Array<[bots: unknown[], deleted?: unknown[]]> = [
      [[main, bot(KEY_A, "Research", { deletingSince: LATER.toISOString() })]],
      [[main, bot(KEY_A, "Research", { grantClosed: true })]],
      [[main, bot(KEY_A, "Research", { revoke: { cid: "cid-1" } })]],
      [[main, bot(KEY_A, "Research", { state: "deleting" })]],
      [[bot("main", "Main", { state: "deleting", deletingSince: LATER.toISOString() })]],
      [[main, deleting(KEY_A, "Research", { grantClosed: false })]],
      [[main, deleting(KEY_A, "Research", { grantClosed: "yes" })]],
      [[main, deleting(KEY_A, "Research", { revoke: {} })]],
      [[main, deleting(KEY_A, "Research", { revoke: { cid: "" } })]],
      [[main, deleting(KEY_A, "Research", { revoke: "cid-1" })]],
      [[main], [{ key: GONE, name: "Gone", revoke: { cid: 5 } }]],
    ];
    for (const [bots, deleted] of damaged) {
      const kv = seed(bots, deleted);
      const before = kv.rows.get(KEY);
      await expect(new BotsRegistry(kv).read(ADDRESS)).rejects.toThrow("bots_registry_unavailable");
      expect(kv.rows.get(KEY)).toEqual(before);
    }
  });
});

describe("every owner that has a record", () => {
  const address = (digit: string) => `0x${digit.repeat(40)}`;
  const record = JSON.stringify({ v: 1, seq: 1, deleted: [], bots: [{ key: "main", name: "Main", shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0.toISOString() }] });
  const filled = () => {
    // The shared stand-in store, which can list and page; the one above in this file cannot.
    const kv = fakeRegistryStore();
    for (const digit of ["1", "2", "3", "4", "5"]) kv.rows.set(`bots/registry/${address(digit)}`, { version: 1, value: record });
    // Neither of these is an owner's record.
    kv.rows.set("bots/registry/not-an-address", { version: 1, value: record });
    kv.rows.set(`bots/other/${address("9")}`, { version: 1, value: record });
    return kv;
  };
  const all = ["1", "2", "3", "4", "5"].map(address);

  test("is found, across as many pages as the listing takes", async () => {
    for (const pageSize of [undefined, 1, 2, 5]) {
      const kv = filled();
      kv.pageSize = pageSize;
      expect([pageSize, (await new BotsRegistry(kv).owners()).sort()]).toEqual([pageSize, all]);
    }
  });

  test("a listing that is cut short with no way to continue is an error, never a shorter list", async () => {
    const kv = filled();
    kv.pageSize = 2;
    kv.cutShort = true;
    await expect(new BotsRegistry(kv).owners()).rejects.toThrow("bots_registry_unavailable");
  });

  test("a store that cannot be reached, or cannot list, is an error", async () => {
    const kv = filled();
    kv.down = true;
    await expect(new BotsRegistry(kv).owners()).rejects.toThrow();
    const reachable = filled();
    await expect(new BotsRegistry({ get: reachable.get, put: reachable.put }).owners()).rejects.toThrow("bots_registry_unavailable");
  });
});
