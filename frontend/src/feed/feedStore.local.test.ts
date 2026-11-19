import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { IDBFactory } from "fake-indexeddb";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { appendFeedResponse, feedResourceNames, initializeFeedDatabases, publishFeedCard, type FeedCard, type FeedDatabase } from "@tinycloud/sdk-services/feed";
import { useLocalThreadStorage } from "../lib/threadStore";
import { resetLocalCacheForTests } from "../lib/localFirst/localCache";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";

const SPACE = "isolated-feed-local-test";
const databases: Database[] = [];
let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
  });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  resetLocalCacheForTests();
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "indexedDB");
  resetLocalCacheForTests();
  for (const database of databases.splice(0)) database.close();
});

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message);
  return result.data as T;
}

/** bun:sqlite behind the SDK's SQL handle; counts the calls each resource receives. */
function sqliteHandle(database: Database, calls: string[]): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    query: async <T>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      calls.push(`query ${sql.replace(/\s+/g, " ").slice(0, 40)}`);
      try {
        const statement = database.query(sql);
        const rows = statement.values(...params) as T[][];
        return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
      } catch (error) {
        return { ok: false, error: { code: "SQL_ERROR", message: (error as Error).message, service: "sql" } };
      }
    },
    execute: async (sql, params) => { calls.push(`execute ${sql.slice(0, 40)}`); return execute(sql, params); },
    async batch(statements) {
      calls.push(`batch(${statements.length})`);
      const results = [];
      for (const statement of statements) results.push(value(await execute(statement.sql, statement.params)));
      return { ok: true, data: { results } };
    },
  };
}

/** One account's node: databases survive across sources, like the real space does across opens. */
function node() {
  const handles = new Map<string, FeedDatabase>();
  const calls: string[] = [];
  const handle = (resource: string) => {
    let existing = handles.get(resource);
    if (!existing) {
      const database = new Database(":memory:");
      databases.push(database);
      existing = sqliteHandle(database, calls);
      handles.set(resource, existing);
    }
    return existing;
  };
  const open = () => {
    const client = { spaceId: SPACE, did: "did:pkh:eip155:1:0xfeed", hooks: {}, sql: { db: handle } };
    return createHomeFeedSource(useLocalThreadStorage(client as unknown as TinyCloudWeb));
  };
  return { handle, calls, open, drop: (resource: string) => handles.delete(resource) };
}

test("the registry tables are created once per device; a later open reads without the CREATE batch", async () => {
  const account = node();
  await account.open().load();
  expect(account.calls.filter((call) => call.startsWith("batch"))).toHaveLength(1);

  account.calls.length = 0;
  await account.open().load();
  expect(account.calls.filter((call) => call.startsWith("batch"))).toHaveLength(0);
});

test("a registry table that went missing is created again instead of failing the feed", async () => {
  const account = node();
  await account.open().load();
  account.drop(HOME_FEED_RESOURCE); // the next open sees a database without the tables

  account.calls.length = 0;
  const snapshot = await account.open().load();
  expect(snapshot.entries).toEqual([]);
  expect(account.calls.filter((call) => call.startsWith("batch"))).toHaveLength(1);
});

test("a load leaves the feed on the device for the next open, with each card's saved answer", async () => {
  const account = node();
  const first = account.open();
  await first.load();
  const names = value(feedResourceNames("xyz.tinycloud.tinychat/feed", "localtest"));
  const output = account.handle(names.outputResource);
  const responses = account.handle(names.responseResource);
  value(await initializeFeedDatabases({ output, responses }));
  value(await account.handle(HOME_FEED_RESOURCE).execute("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)",
    ["local-agent", "did:key:local-test-agent", "Test agent", names.outputResource, names.responseResource, "{}"]));
  const card: FeedCard = { cardId: "kept", revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title: "Kept on this device", body: "Body", urgency: 1, createdAt: "2026-10-29T00:00:00Z" };
  value(await publishFeedCard(output, card));
  value(await appendFeedResponse(output, responses, { cardId: "kept", revision: 1, issuanceId: "issuance-1", responseId: "answer-1", kind: "answer", text: "Yes", createdAt: "2026-10-29T00:01:00Z" }));
  const loaded = await first.load();
  expect(loaded.entries[0]?.state.response?.responseId).toBe("answer-1");
  // Let the best-effort device write land.
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  const next = account.open();
  let local = await next.cached?.();
  for (let i = 0; !local && i < 20; i++) local = await next.cached?.();
  expect(local?.entries.map((entry) => entry.state.card.title)).toEqual(["Kept on this device"]);
  expect(local?.entries[0]?.state.response?.responseId).toBe("answer-1");
});
