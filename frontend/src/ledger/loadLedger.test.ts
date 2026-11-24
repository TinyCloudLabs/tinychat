import { expect, test } from "bun:test";
import { loadLedger } from "./loadLedger";
import { LEDGER_PREFIX } from "./model";

const event = (folder: string, task: string, second: number) => `${LEDGER_PREFIX}task/${folder}/${task}/20261123T1200${String(second).padStart(2, "0")}000Z-aabbccdd.json`;
const check = (checker: string, doer: string, task: string, second: number) => `${LEDGER_PREFIX}task/${checker}/checks/${doer}/${task}/20261123T1300${String(second).padStart(2, "0")}000Z-aabbccdd.json`;
const A = "a".repeat(16), B = "b".repeat(16);

// KV is the network boundary. Every operation not supplied here must remain unused.
function fake(keysByPage: string[][], failing: (key: string) => boolean = () => false) {
  const calls = { list: [] as string[], get: [] as string[] };
  const kv = {
    list: async ({ path, cursor }: { path: string; cursor?: string }) => {
      calls.list.push(`${path}:${cursor ?? "first"}`);
      const page = cursor ? Number(cursor) : 0;
      return { ok: true, data: { keys: keysByPage[page] ?? [], nextCursor: page + 1 < keysByPage.length ? String(page + 1) : null } };
    },
    get: async (key: string) => {
      calls.get.push(key);
      return failing(key) ? { ok: false, error: { message: "offline" } } : { ok: true, data: { data: JSON.stringify({ key }) } };
    },
  };
  return { kv: kv as never, calls };
}

test("reads all pages, only task events, with JSON decoding", async () => {
  const { kv, calls } = fake([[event(A, "t1", 1), "other/secret"], [`${LEDGER_PREFIX}catalog`, check(B, A, "t1", 2)]]);
  const records = await loadLedger({ kv });
  expect(records.map((record) => record.key).sort()).toEqual([event(A, "t1", 1), check(B, A, "t1", 2)].sort());
  expect(records[0]!.value).toEqual({ key: records[0]!.key });
  expect(calls.list).toEqual([`${LEDGER_PREFIX}task/:first`, `${LEDGER_PREFIX}task/:1`]);
});
test("reads only the newest events of each task and of each check, never the whole history", async () => {
  const history = Array.from({ length: 30 }, (_, index) => event(A, "t1", index));
  const checks = Array.from({ length: 30 }, (_, index) => check(B, A, "t1", index));
  const { kv, calls } = fake([[...history, ...checks, event(A, "t2", 3)]]);
  const records = await loadLedger({ kv });
  expect(calls.get.length).toBe(5 + 5 + 1);
  expect(records.map((record) => record.key)).toContain(event(A, "t1", 29));
  expect(records.map((record) => record.key)).not.toContain(event(A, "t1", 0));
});
test("an event that cannot be read is skipped, but nothing readable is a failed load", async () => {
  const keys = [event(A, "t1", 1), event(A, "t2", 2)];
  const partial = await loadLedger({ kv: fake([keys], (key) => key === keys[0]).kv });
  expect(partial.map((record) => record.key)).toEqual([keys[1]!]);
  await expect(loadLedger({ kv: fake([keys], () => true).kv })).rejects.toThrow();
});
test("one agent's future-dated checks cannot crowd out another agent's check", async () => {
  const C = "c".repeat(16);
  const future = Array.from({ length: 8 }, (_, index) => `${LEDGER_PREFIX}task/${C}/checks/${A}/t1/20270101T1300${String(index).padStart(2, "0")}000Z-aabbccdd.json`);
  const crowd = Array.from({ length: 8 }, (_, index) => `${LEDGER_PREFIX}task/${C}/checks/${A}/t1/20261123T1301${String(index).padStart(2, "0")}000Z-aabbccdd.json`);
  const { kv } = fake([[event(A, "t1", 1), check(B, A, "t1", 2), ...future, ...crowd]]);
  const keys = (await loadLedger({ kv }, Date.parse("2026-11-23T14:00:00Z"))).map((record) => record.key);
  expect(keys).toContain(check(B, A, "t1", 2));
  expect(keys.filter((key) => key.includes(`/${C}/checks/`)).length).toBe(5);
  expect(keys.some((key) => key.includes("20270101"))).toBe(false);
});
