import { describe, expect, test } from "bun:test";
import { BotsRegistry, type RegistryKv } from "../bots-registry.js";

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
    const main = { key: "main", name: "Main", shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0.toISOString() };
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
    expect(result).toEqual({ ok: true, bot });
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
    expect((await registry.read(ADDRESS)).bots.map(bot => bot.name)).toEqual(["Main", "One", "Two"]);
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
});
