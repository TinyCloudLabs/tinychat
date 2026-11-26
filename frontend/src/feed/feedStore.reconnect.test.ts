import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { IDBFactory } from "fake-indexeddb";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { feedResourceNames, initializeFeedDatabases, publishFeedCard, type FeedCard, type FeedDatabase, type FeedHooks } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { useLocalThreadStorage } from "../lib/threadStore";
import { resetLocalCacheForTests } from "../lib/localFirst/localCache";
import { resetLanesForTests } from "../lib/localFirst/requestLanes";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import type { HomeFeedSource } from "./feedStoreTypes";

// The fakes of feedStore.live.test.ts, with streams the test can also end as a dropped connection would.

const databases: Database[] = [];
const cleanups: (() => void)[] = [];

/** The source's own timers (notification debounce, retries, renewal) run only when a test fires them. */
let timers: Map<number, { delay: number; run: () => void }>;

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
  const stored = new Map<string, string>();
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
  resetLanesForTests();
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

/** The delays of the timers waiting now, past the notification debounce: retries and the 5-minute renewal. */
const waiting = () => [...timers.values()].map((timer) => timer.delay).filter((delay) => delay > 50).sort((a, b) => a - b);

/** Fires the one waiting timer with this delay. */
function fire(delay: number) {
  const due = [...timers].filter(([, timer]) => timer.delay === delay);
  expect(due).toHaveLength(1);
  const [id, timer] = due[0]!;
  timers.delete(id);
  timer.run();
}

function sqliteHandle(database: Database): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    query: async <T>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    execute,
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(value(await execute(statement.sql, statement.params)));
      return { ok: true, data: { results } };
    },
  };
}

interface Stream { onReady?: () => void; signal?: AbortSignal; drop: () => void }

/** A live-update service whose streams become ready, or drop without an abort (a lost connection), only when the test says. */
function controlledHooks() {
  const opened: Stream[] = [];
  const hooks: FeedHooks = {
    async *subscribe(_subscriptions, options) {
      const { promise, resolve } = Promise.withResolvers<void>();
      opened.push({ ...options, drop: resolve });
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      await promise;
      yield* [];
    },
  };
  return { hooks, opened, ready: () => opened.at(-1)?.onReady?.(), drop: () => opened.at(-1)?.drop() };
}

function card(cardId: string, title: string): FeedCard {
  return { cardId, revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title, body: "Body", urgency: 1, createdAt: "2026-10-29T00:00:00Z" };
}

/** A returning account: one agent with one card, and the device copy an earlier open left. */
async function account() {
  const handles = new Map<string, FeedDatabase>();
  const handle = (resource: string) => {
    let existing = handles.get(resource);
    if (!existing) {
      const database = new Database(":memory:");
      databases.push(database);
      existing = sqliteHandle(database);
      handles.set(resource, existing);
    }
    return existing;
  };
  const live = controlledHooks();
  const client = { spaceId: "isolated-feed-reconnect-test", did: "did:pkh:eip155:1:0xfeed", hooks: live.hooks, sql: { db: handle } };
  const tcw = useLocalThreadStorage(client as unknown as TinyCloudWeb);
  await createHomeFeedSource(tcw).load();
  const names = value(feedResourceNames("xyz.tinycloud.tinychat/feed", "reconnecttest"));
  const output = handle(names.outputResource);
  value(await initializeFeedDatabases({ output, responses: handle(names.responseResource) }));
  value(await handle(HOME_FEED_RESOURCE).execute("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)",
    ["live-agent", "did:key:reconnect-test-agent", "Test agent", names.outputResource, names.responseResource, "{}"]));
  value(await publishFeedCard(output, card("first", "Already on the feed")));
  const earlier = createHomeFeedSource(tcw);
  await earlier.load();
  for (let i = 0; i < 20 && !(await earlier.cached?.()); i++);
  return { live, open: () => createHomeFeedSource(tcw) };
}

/**
 * Opens the Feed the way `HomeFeedEntries` does: local read, subscribe, then the network load; every wake reloads,
 * as the Feed's refresh does, so a reload that reconnected would show here as a stream per wake.
 */
async function openFeed(fixture: Awaited<ReturnType<typeof account>>) {
  const feed: HomeFeedSource = fixture.open();
  let latest: Promise<{ connectionError?: string }> | undefined;
  const local = feed.cached?.();
  const unsubscribe = feed.subscribe(() => { latest = feed.load(undefined, { feed: true }); });
  cleanups.push(unsubscribe);
  const first = feed.load(undefined, { feed: true });
  await local;
  await first;
  fixture.live.ready();
  await settle();
  return { feed, unsubscribe, shown: async () => (await latest)?.connectionError };
}

test("a dropped stream reconnects on its own after the first backoff step, and its ready clears the error", async () => {
  const fixture = await account();
  const { shown } = await openFeed(fixture);
  expect(fixture.live.opened).toHaveLength(1);
  expect(waiting()).toEqual([300_000]);

  fixture.live.drop();
  await settle();
  // The failure's reload shows the error and opens nothing: only the retry may.
  expect(await shown()).toBe("Live updates unavailable: Home feed notifications disconnected");
  expect(fixture.live.opened).toHaveLength(1);
  expect(waiting()).toEqual([2_000, 300_000]);

  fire(2_000);
  expect(fixture.live.opened).toHaveLength(2);
  fixture.live.ready();
  await settle();
  expect(await shown()).toBeUndefined();
  expect(waiting()).toEqual([300_000]);
});

test("reconnect opens a new stream at once though the failed one was never aborted", async () => {
  const fixture = await account();
  const { feed } = await openFeed(fixture);
  fixture.live.drop();
  await settle();
  expect(fixture.live.opened[0]!.signal?.aborted).toBe(false);
  // A plain reload keeps the failed stream: this is what left Try again with nothing to do.
  await feed.load(undefined, { feed: true });
  expect(fixture.live.opened).toHaveLength(1);

  feed.reconnect?.();
  expect(fixture.live.opened).toHaveLength(2);
  // The pending retry would replace the new stream: it is cleared.
  expect(waiting()).toEqual([300_000]);
});

test("streams that keep failing back off: one new stream per retry, never one per reload", async () => {
  const fixture = await account();
  await openFeed(fixture);
  const delays: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    fixture.live.drop();
    // Every wake reloads; let many debounce rounds run, as a hot loop would need.
    for (let round = 0; round < 5; round++) await settle();
    expect(fixture.live.opened).toHaveLength(attempt + 1);
    const [retry] = waiting();
    delays.push(retry!);
    fire(retry!);
    expect(fixture.live.opened).toHaveLength(attempt + 2);
  }
  expect(delays).toEqual([2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000]);

  // A ready stream starts the backoff over.
  fixture.live.ready();
  await settle();
  fixture.live.drop();
  await settle();
  expect(waiting()).toEqual([2_000, 300_000]);
});

test("the browser coming back online reconnects at once; after unsubscribe nothing is left to retry", async () => {
  const fixture = await account();
  const { unsubscribe } = await openFeed(fixture);
  fixture.live.drop();
  await settle();
  window.dispatchEvent(new Event("online"));
  expect(fixture.live.opened).toHaveLength(2);

  fixture.live.drop();
  await settle();
  expect(waiting()).toEqual([2_000, 300_000]);
  unsubscribe();
  expect(waiting()).toEqual([]);
  window.dispatchEvent(new Event("online"));
  expect(fixture.live.opened).toHaveLength(2);
});
