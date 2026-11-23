import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { botHistoryDirectory } from "./botHistoryPath";
import { deleteMainHistory, HistoryDeleteIncomplete } from "./historyDelete";

const ADDRESS = "0x00000000000000000000000000000000000a11ce";
const SESSION = { address: ADDRESS, chainId: 1, sessionKey: "k", siwe: "s" };

interface Fake { rows: Set<string>; deleted: string[]; listed: { prefix: string; cursor?: string; source?: string }[] }

function fake(rows: string[], options: { pageSize?: number; fail?: (key: string) => unknown; listFails?: boolean; throws?: boolean } = {}) {
  const state: Fake = { rows: new Set(rows), deleted: [], listed: [] };
  const tcw = {
    session: () => SESSION,
    kvForSpace: () => ({
      list: async (o: { prefix: string; cursor?: string; source?: string }) => {
        state.listed.push(o);
        if (options.listFails) return { ok: false };
        const all = [...state.rows].filter(key => key.startsWith(o.prefix)).sort();
        const start = o.cursor ? Number(o.cursor) : 0;
        const size = options.pageSize ?? all.length + 1;
        const next = start + size < all.length ? String(start + size) : undefined;
        return { ok: true, data: { keys: all.slice(start, start + size), truncated: next !== undefined, nextCursor: next } };
      },
      delete: async (key: string, o: { prefix: string }) => {
        expect(o.prefix).toBe("");
        state.deleted.push(key);
        if (options.throws) throw new Error("network");
        const failure = options.fail?.(key);
        if (failure !== undefined) return failure;
        state.rows.delete(key);
        return { ok: true, data: undefined };
      },
    }),
  } as unknown as TinyCloudWeb;
  return { tcw, state };
}

const RESEAL = "xyz.tinycloud.tinychat/threads/bots/reseal/";

test("deletes every page of Main's records and its reseal leftovers, and nothing of another bot's", async () => {
  const main = await botHistoryDirectory(ADDRESS, "main");
  const sibling = await botHistoryDirectory(ADDRESS, "a".repeat(32));
  const id = main.split("/").at(-2)!;
  const mine = [1, 2, 3, 4, 5].map(n => `${main}${"a".repeat(32)}/${n}-${"b".repeat(64)}`);
  const leftover = `${RESEAL}${id}/${"a".repeat(32)}/1-${"b".repeat(64)}-uuid`;
  const others = [`${sibling}${"a".repeat(32)}/1-${"b".repeat(64)}`, `${RESEAL}${"f".repeat(64)}/x`];
  const { tcw, state } = fake([...mine, leftover, ...others], { pageSize: 2 });
  expect(await deleteMainHistory(tcw)).toBe(6);
  expect([...state.rows].sort()).toEqual([...others].sort());
  expect(state.listed.every(call => call.source === "network")).toBe(true);
  expect(state.listed.filter(call => call.prefix === main).length).toBe(3);
});

test("a record that is already gone counts as deleted; one that fails leaves the rest deleted and says so", async () => {
  const main = await botHistoryDirectory(ADDRESS, "main");
  const keys = [1, 2, 3, 4].map(n => `${main}${"a".repeat(32)}/${n}-${"b".repeat(64)}`);
  const { tcw, state } = fake(keys, {
    fail: key => key === keys[0] ? { ok: false, error: { code: "KV_NOT_FOUND" } }
      : key === keys[1] ? { ok: false, error: { code: "KV_PERMISSION_DENIED" } }
      : undefined,
  });
  const error = await deleteMainHistory(tcw).catch(cause => cause);
  expect(error).toBeInstanceOf(HistoryDeleteIncomplete);
  expect((error as HistoryDeleteIncomplete).remaining).toBe(1);
  expect(state.deleted).toEqual(keys);
});

test("a delete that throws counts as left over, and a list that fails deletes nothing", async () => {
  const main = await botHistoryDirectory(ADDRESS, "main");
  const key = `${main}${"a".repeat(32)}/1-${"b".repeat(64)}`;
  const thrown = fake([key], { throws: true });
  expect(await deleteMainHistory(thrown.tcw).catch(cause => cause)).toBeInstanceOf(HistoryDeleteIncomplete);
  const broken = fake([key], { listFails: true });
  expect((await deleteMainHistory(broken.tcw).catch(cause => cause) as Error).message).toBe("history_read_unavailable");
  expect(broken.state.deleted).toEqual([]);
});

test("stops when the session changes under it", async () => {
  const main = await botHistoryDirectory(ADDRESS, "main");
  const keys = [1, 2].map(n => `${main}${"a".repeat(32)}/${n}-${"b".repeat(64)}`);
  const { tcw, state } = fake(keys);
  let calls = 0;
  (tcw as unknown as { session: () => unknown }).session = () => (++calls <= 1 ? SESSION : { ...SESSION, sessionKey: "other" });
  expect((await deleteMainHistory(tcw).catch(cause => cause) as Error).message).toBe("history_session_changed");
  expect(state.deleted).toEqual([]);
});
