import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { loadLedger } from "./loadLedger";
import { LEDGER_PREFIX } from "./model";

// KV is the network boundary. Every operation not supplied here must remain unused.
test("reads all pages and only task events, with JSON decoding", async () => {
  const keys = [`${LEDGER_PREFIX}task/a/event/one.json`, `${LEDGER_PREFIX}task/a/event/two.json`];
  const calls: string[] = [];
  const kv = {
    list: async ({ path, cursor }: { path: string; cursor?: string }) => {
      calls.push(`${path}:${cursor ?? "first"}`);
      return { ok: true, data: { keys: cursor ? [keys[1]] : [keys[0], "other/secret", `${LEDGER_PREFIX}catalog`], nextCursor: cursor ? null : "page-2" } };
    },
    get: async (key: string) => ({ ok: true, data: { data: key === keys[0] ? '{"title":"First"}' : { title: "Second" } } }),
  };
  const records = await loadLedger({ kv } as unknown as Pick<TinyCloudWeb, "kv">);
  expect(records).toEqual([{ key: keys[0], value: { title: "First" } }, { key: keys[1], value: { title: "Second" } }]);
  expect(calls).toEqual([`${LEDGER_PREFIX}task/:first`, `${LEDGER_PREFIX}task/:page-2`]);
});
test("a failed event read is a failed load, never an empty or partial ledger", async () => {
  const kv = {
    list: async () => ({ ok: true, data: { keys: [`${LEDGER_PREFIX}task/a/task/one.json`] } }),
    get: async () => ({ ok: false, error: { message: "offline" } }),
  };
  await expect(loadLedger({ kv } as unknown as Pick<TinyCloudWeb, "kv">)).rejects.toThrow();
});
