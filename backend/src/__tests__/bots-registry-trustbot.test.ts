import { expect, test } from "bun:test";
import { BotsRegistry, MAIN_BOT_NAME, type RegistryKv } from "../bots-registry.js";

// TC-3790: the main bot's default name is TrustBot. A record written before that still holds "Main" on it.
const ADDRESS = `0x${"Cd".repeat(20)}`;
const KEY = `bots/registry/${ADDRESS.toLowerCase()}`;
const T0 = "2026-11-19T00:00:00.000Z";
const SIBLING = "a".repeat(32);

const bot = (key: string, name: string) => ({ key, name, shape: "pebble", colour: "blue", environment: "private", state: "active", createdAt: T0 });

function store(bots: unknown[] | undefined) {
  const rows = new Map<string, { value: string; version: number }>();
  if (bots) rows.set(KEY, { value: JSON.stringify({ v: 1, seq: 1, bots, deleted: [] }), version: 1 });
  const kv: RegistryKv = {
    async get(key) {
      const row = rows.get(key);
      if (!row) return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
      return { ok: true, data: { data: row.value, headers: { etag: `"${row.version}"` } } };
    },
    async put(key, value) {
      rows.set(key, { value: JSON.stringify(value), version: (rows.get(key)?.version ?? 0) + 1 });
      return { ok: true };
    },
  };
  return { kv, stored: () => JSON.parse(rows.get(KEY)!.value) as { bots: { key: string; name: string }[] } };
}

const names = (bots: { name: string }[]) => bots.map(entry => entry.name);

test("a new owner's main bot is called TrustBot", async () => {
  const { kv } = store(undefined);
  expect(MAIN_BOT_NAME).toBe("TrustBot");
  expect(names((await new BotsRegistry(kv).read(ADDRESS)).bots)).toEqual(["TrustBot"]);
});

test("the old default name on the main bot reads as TrustBot and is saved that way with the next change", async () => {
  const { kv, stored } = store([bot("main", "Main"), bot(SIBLING, "Research")]);
  const registry = new BotsRegistry(kv);
  expect(names((await registry.read(ADDRESS)).bots)).toEqual(["TrustBot", "Research"]);
  // A read alone writes nothing.
  expect(names(stored().bots)).toEqual(["Main", "Research"]);
  expect(await registry.update(ADDRESS, SIBLING, { name: "Notes" })).toMatchObject({ ok: true });
  expect(names(stored().bots)).toEqual(["TrustBot", "Notes"]);
  // TrustBot is taken now, as any bot's name is.
  expect(await registry.create(ADDRESS, { name: "trustbot", shape: "pebble", colour: "blue" }, 5)).toEqual({ ok: false, error: "name_taken" });
});

test("the main bot keeps the old name when the owner already has a bot called TrustBot", async () => {
  const { kv } = store([bot("main", "Main"), bot(SIBLING, "trustbot")]);
  expect(names((await new BotsRegistry(kv).read(ADDRESS)).bots)).toEqual(["Main", "trustbot"]);
});

test("a name the owner gave the main bot is kept", async () => {
  const { kv } = store([bot("main", "Jarvis")]);
  expect(names((await new BotsRegistry(kv).read(ADDRESS)).bots)).toEqual(["Jarvis"]);
});

test("no other bot can take the old name, so none is mistaken for TrustBot", async () => {
  const { kv } = store([bot("main", "Jarvis"), bot(SIBLING, "Research")]);
  const registry = new BotsRegistry(kv);
  expect(await registry.create(ADDRESS, { name: " MAIN ", shape: "pebble", colour: "blue" }, 5)).toEqual({ ok: false, error: "name_taken" });
  expect(await registry.update(ADDRESS, SIBLING, { name: "Main" })).toEqual({ ok: false, error: "name_taken" });
});
