import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { IDBFactory } from "fake-indexeddb";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { feedResourceNames, initializeFeedDatabases, publishFeedCard, type FeedCard, type FeedDatabase, type FeedHooks } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { useLocalThreadStorage } from "../lib/threadStore";
import { resetLocalCacheForTests } from "../lib/localFirst/localCache";
import { FOREGROUND_QUIET_MS, resetLanesForTests } from "../lib/localFirst/requestLanes";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import type { HomeFeedSource } from "./feedStoreTypes";

const databases: Database[] = [];
const cleanups: (() => void)[] = [];

/** The source's own timers (notification debounce, hidden window, renewal) run only when a test fires them. */
let timers: Map<number, { delay: number; run: () => void }>;
let stored: Map<string, string>;
const localStorageItems = () => Object.fromEntries(stored);

beforeEach(() => {
  cleanups.push(installDom());
  timers = new Map();
  let next = 0;
  const schedule = (callback: unknown, delay?: number) => {
    if (typeof callback !== "function") throw new Error("Unexpected string timer");
    timers.set(++next, { delay: delay ?? 0, run: callback as () => void });
    return next;
  };
  const cancel = (id?: number) => { if (id !== undefined) timers.delete(id); };
  for (const spy of [
    spyOn(window, "setTimeout").mockImplementation(schedule as unknown as typeof window.setTimeout),
    spyOn(window, "setInterval").mockImplementation(schedule as unknown as typeof window.setInterval),
    spyOn(window, "clearTimeout").mockImplementation(cancel as typeof window.clearTimeout),
    spyOn(window, "clearInterval").mockImplementation(cancel as typeof window.clearInterval),
  ]) cleanups.push(() => spy.mockRestore());
  stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
  });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  resetLocalCacheForTests();
  resetLanesForTests();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "indexedDB");
  resetLocalCacheForTests();
  for (const database of databases.splice(0)) database.close();
});

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message);
  return result.data as T;
}

/** Lets pending SQL answer, then fires the source's 50 ms notification debounce. */
async function settle() {
  for (let step = 0; step < 200; step++) await Promise.resolve();
  for (const [id, timer] of [...timers]) if (timer.delay <= 50) { timers.delete(id); timer.run(); }
  for (let step = 0; step < 200; step++) await Promise.resolve();
}

/** bun:sqlite behind the SDK's SQL handle; records every statement, as the node would see one request each. */
function sqliteHandle(database: Database, requests: string[]): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    requests.push(sql);
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    query: async <T>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      requests.push(sql);
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    execute,
    async batch(statements) {
      requests.push(`batch(${statements.length})`);
      const results = [];
      for (const statement of statements) results.push(value(await execute(statement.sql, statement.params)));
      return { ok: true, data: { results } };
    },
  };
}

/** A live-update service whose streams become ready, and so reconnect, only when the test says. */
function controlledHooks() {
  const opened: { onReady?: () => void; signal?: AbortSignal }[] = [];
  const hooks: FeedHooks = {
    async *subscribe(_subscriptions, options) {
      opened.push(options ?? {});
      const { promise, resolve } = Promise.withResolvers<void>();
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      await promise;
      yield* [];
    },
  };
  return { hooks, opened, ready: () => opened.at(-1)?.onReady?.() };
}

function card(cardId: string, title: string): FeedCard {
  return { cardId, revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title, body: "Body", urgency: 1, createdAt: "2026-10-29T00:00:00Z" };
}

interface Account {
  output: FeedDatabase;
  /** Every SQL statement sent, one node request each. */
  requests: string[];
  live: { opened: { onReady?: () => void; signal?: AbortSignal }[]; ready: () => void };
  open: () => HomeFeedSource;
}

/** A returning account: one agent with one card, and the device copy an earlier open left. */
async function account(): Promise<Account> {
  const requests: string[] = [];
  const handles = new Map<string, FeedDatabase>();
  const handle = (resource: string) => {
    let existing = handles.get(resource);
    if (!existing) {
      const database = new Database(":memory:");
      databases.push(database);
      existing = sqliteHandle(database, requests);
      handles.set(resource, existing);
    }
    return existing;
  };
  const live = controlledHooks();
  const client = { spaceId: "isolated-feed-live-test", did: "did:pkh:eip155:1:0xfeed", hooks: live.hooks, sql: { db: handle } };
  const tcw = useLocalThreadStorage(client as unknown as TinyCloudWeb);
  await createHomeFeedSource(tcw).load();
  const names = value(feedResourceNames("xyz.tinycloud.tinychat/feed", "livetest"));
  const output = handle(names.outputResource);
  value(await initializeFeedDatabases({ output, responses: handle(names.responseResource) }));
  value(await handle(HOME_FEED_RESOURCE).execute("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)",
    ["live-agent", "did:key:live-test-agent", "Test agent", names.outputResource, names.responseResource, "{}"]));
  value(await publishFeedCard(output, card("first", "Already on the feed")));
  const earlier = createHomeFeedSource(tcw);
  await earlier.load();
  for (let i = 0; i < 20 && !(await earlier.cached?.()); i++);
  requests.length = 0;
  return { output, requests, live, open: () => createHomeFeedSource(tcw) };
}

/** Opens the Feed the way `HomeFeedEntries` does: local read, subscribe, then the network load. */
async function openFeed(fixture: Account) {
  const feed = fixture.open();
  let woken = 0;
  const local = feed.cached?.();
  cleanups.push(feed.subscribe(() => { woken++; }));
  const first = feed.load(undefined, { feed: true });
  await local;
  return { feed, first, woken: () => woken };
}

/** The Feed's registry read: one per load. */
const loads = (requests: string[]) => requests.filter((sql) => sql.startsWith("SELECT 'a', agent_id")).length;
/** A freshness fingerprint's reads: tallies only. */
const checks = (requests: string[]) => requests.filter((sql) => sql.startsWith("SELECT (SELECT")).length;
const titles = (snapshot: { entries: { state: { card: { title: string } } }[] }) => snapshot.entries.map((entry) => entry.state.card.title).sort();

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

test("connecting live updates loads the feed once: the first ready stream reloads nothing", async () => {
  const fixture = await account();
  const { first, woken } = await openFeed(fixture);
  expect(fixture.live.opened).toHaveLength(1);
  // The network load does not wait for the stream: the registry and the agent's two databases, one request each.
  expect(titles(await first)).toEqual(["Already on the feed"]);
  expect(fixture.requests).toHaveLength(3);
  expect(loads(fixture.requests)).toBe(1);

  fixture.live.ready();
  await settle();
  expect(woken()).toBe(0);
  expect(loads(fixture.requests)).toBe(1);
  // One freshness fingerprint (registry, the agent's output and responses), equal to the load's own.
  expect(checks(fixture.requests)).toBe(3);
  expect(fixture.live.opened).toHaveLength(1);
});

test("a stream that becomes ready while the load is in flight compares once it lands", async () => {
  const fixture = await account();
  const { first, woken } = await openFeed(fixture);
  fixture.live.ready();
  await first;
  await settle();
  expect(woken()).toBe(0);
  expect(loads(fixture.requests)).toBe(1);
});

test("a write after the load read but before the stream was ready is caught by the first ready", async () => {
  const fixture = await account();
  const { feed, first, woken } = await openFeed(fixture);
  expect(titles(await first)).toEqual(["Already on the feed"]);
  // No notification covers this write: the stream was not ready yet.
  value(await publishFeedCard(fixture.output, card("gap", "Written before the stream was ready")));
  fixture.live.ready();
  await settle();
  expect(woken()).toBe(1);
  expect(titles(await feed.load(undefined, { feed: true }))).toEqual(["Already on the feed", "Written before the stream was ready"]);
});

test("a load from another view never moves the Feed's freshness baseline", async () => {
  const fixture = await account();
  const { feed, first, woken } = await openFeed(fixture);
  fixture.live.ready();
  await first;
  await settle();
  value(await publishFeedCard(fixture.output, card("other", "Seen only by a card view")));
  await feed.load();
  fixture.live.ready();
  await settle();
  expect(woken()).toBe(1);
});

test("a new device reads before it creates: the registry, then the agents, then the schema batch behind the first load", async () => {
  const fixture = await account();
  for (const key of Object.keys(localStorageItems())) if (key.includes("feed-schema")) localStorage.removeItem(key);
  resetLocalCacheForTests();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  const { first } = await openFeed(fixture);
  expect(titles(await first)).toEqual(["Already on the feed"]);
  expect(fixture.requests.map((sql) => sql.match(/SELECT '(\w)'/)?.[1])).toEqual(["a", "c", "r"]);
  expect(fixture.requests.filter((sql) => sql.startsWith("batch("))).toEqual([]);
  // The background lane starts once the foreground has been quiet for FOREGROUND_QUIET_MS.
  await Bun.sleep(FOREGROUND_QUIET_MS + 50);
  await settle();
  expect(fixture.requests.filter((sql) => sql.startsWith("batch("))).toEqual(["batch(4)"]);
  expect(localStorageItems()).toHaveProperty(["tinychat:feed-schema:v1:isolated-feed-live-test"]);
});

test("a reconnect after writes it was not told about catches up, and one after none reloads nothing", async () => {
  const fixture = await account();
  const { feed, first, woken } = await openFeed(fixture);
  fixture.live.ready();
  await first;
  await settle();

  // The SDK reconnected on its own; nothing was written meanwhile.
  fixture.requests.length = 0;
  fixture.live.ready();
  await settle();
  expect(woken()).toBe(0);
  expect(loads(fixture.requests)).toBe(0);
  expect(checks(fixture.requests)).toBe(3);

  // A write lands while the stream is down: no notification will ever say so.
  value(await publishFeedCard(fixture.output, card("missed", "Written while disconnected")));
  fixture.live.ready();
  await settle();
  expect(woken()).toBe(1);
  expect(titles(await feed.load(undefined, { feed: true }))).toEqual(["Already on the feed", "Written while disconnected"]);

  // The catch-up moved the fingerprint forward: the next quiet reconnect stays quiet.
  fixture.live.ready();
  await settle();
  expect(woken()).toBe(1);
});

test("a resume within the freshness window makes no requests; a longer absence makes one check", async () => {
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  cleanups.push(() => clock.mockRestore());
  const fixture = await account();
  const { first, woken } = await openFeed(fixture);
  fixture.live.ready();
  await first;
  await settle();

  fixture.requests.length = 0;
  setVisibility("hidden");
  now += 10_000;
  setVisibility("visible");
  await settle();
  expect(fixture.requests).toEqual([]);
  expect(fixture.live.opened).toHaveLength(1);
  expect(woken()).toBe(0);

  setVisibility("hidden");
  now += 120_000;
  setVisibility("visible");
  expect(fixture.live.opened).toHaveLength(2);
  fixture.live.ready();
  await settle();
  expect(loads(fixture.requests)).toBe(0);
  expect(checks(fixture.requests)).toBe(3);
  expect(woken()).toBe(0);
});
