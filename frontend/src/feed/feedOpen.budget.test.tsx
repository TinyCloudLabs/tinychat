// The Feed's request budget per open, counted at a fake node: what each open
// may cost the node before it shows a card, before it is fresh, and while it
// sits idle with a live-update stream. The Feed renders as the app renders it
// (FeedViewEntries over the real store, createHomeFeedSource), so its own call
// pattern is what is counted. No timing is measured: the node answers in
// explicit waves, and a request's round is the wave it went out in.
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { IDBFactory } from "fake-indexeddb";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  appendFeedMessage, appendFeedResponse, feedResourceNames, initializeFeedDatabases, publishFeedCard, recordFeedHandling,
  type FeedCard, type FeedDatabase, type FeedHooks, type FeedResponsePayload, type NewFeedResponse,
} from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { setSetting } from "../lib/threadStore";
import { resetLocalCacheForTests } from "../lib/localFirst/localCache";
import { resetLanesForTests } from "../lib/localFirst/requestLanes";
import { createHomeFeedSource, HOME_FEED_DEFAULT_KEY, HOME_FEED_RESOURCE } from "./feedStore";
import { FeedViewEntries } from "./FeedView";
import { FROZEN_SITREP_RECORDS, SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";
import type { HomeFeedSource } from "./feedStoreTypes";

/** The budgets (home-perf data-2026-11 §6). */
const BUDGET = { warmBeforeFresh: 8, newDeviceBeforeFirstCard: 10, newDeviceBeforeFresh: 8, rounds: 2, idle: 2, idleMs: 60_000 };

type SqlValue = string | number | null | Uint8Array;
type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface NodeRequest {
  /** 1 + the waves the node had answered when the request went out: requests in round N needed only answers from rounds before N. */
  round: number;
  resource: string;
  /** The statement, a batch's statements joined by "; ", or "subscribe". */
  sql: string;
}

/**
 * A TinyCloud node over bun:sqlite. While `counting`, every SQL query, execute
 * and batch and every live-update subscribe is one request, and each waits
 * until `answerWave()` answers everything outstanding at once. Requests that
 * only follow from wave N's answers therefore go out in round N + 1. A stream
 * subscribed in wave N becomes ready once that wave's SQL answers have landed:
 * its handshake (ticket, then the stream) is never quicker than one SQL reply.
 */
class FakeNode {
  readonly requests: NodeRequest[] = [];
  readonly streams: { onReady?: () => void; signal?: AbortSignal }[] = [];
  counting = false;
  private answered = 0;
  private outstanding: (() => void)[] = [];
  private handshakes: (() => void)[] = [];
  private readonly databases = new Map<string, FeedDatabase>();
  readonly hooks: FeedHooks;

  constructor(private readonly opened: Database[]) {
    this.hooks = { subscribe: (subscriptions, options) => this.subscribe(subscriptions.length, options) };
  }

  /** A live-update stream: ready once the node answers its wave, open until aborted. */
  private async *subscribe(resources: number, options?: { onReady?: () => void; signal?: AbortSignal }): AsyncGenerator<never> {
    this.record("hooks", `subscribe(${resources})`);
    this.streams.push(options ?? {});
    if (this.counting) this.handshakes.push(() => { if (!options?.signal?.aborted) options?.onReady?.(); });
    const { promise, resolve } = Promise.withResolvers<void>();
    if (options?.signal?.aborted) resolve();
    else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    await promise;
    yield* [];
  }

  /** Waves the node has answered. */
  get waves() { return this.answered; }

  get waiting() { return this.outstanding.length + this.handshakes.length; }

  /** Answers every outstanding SQL request; returns the streams this wave makes ready, for after those answers land. */
  answerWave(): () => void {
    const wave = this.outstanding.splice(0);
    const handshakes = this.handshakes.splice(0);
    this.answered++;
    for (const answer of wave) answer();
    return () => { for (const ready of handshakes) ready(); };
  }

  /** Every statement since `from`, until `to`. */
  since(from: number, to = this.requests.length) { return this.requests.slice(from, to); }

  private record(resource: string, sql: string) {
    if (this.counting) this.requests.push({ round: this.answered + 1, resource, sql });
  }

  private send<T>(resource: string, sql: string, run: () => T): Promise<T> {
    if (!this.counting) return Promise.resolve(run());
    this.record(resource, sql);
    const { promise, resolve } = Promise.withResolvers<T>();
    this.outstanding.push(() => resolve(run()));
    return promise;
  }

  db(resource: string): FeedDatabase {
    let handle = this.databases.get(resource);
    if (handle) return handle;
    const sqlite = new Database(":memory:");
    this.opened.push(sqlite);
    const failed = (error: unknown) => ({ ok: false as const, error: { code: "SQL_ERROR", message: String(error) } });
    const run = (sql: string, params: SqlValue[]) => {
      const result = sqlite.query(sql).run(...params);
      return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
    };
    handle = {
      query: <T,>(sql: string, params: SqlValue[] = []) => this.send(resource, sql, (): Result<{ columns: string[]; rows: T[][]; rowCount: number }> => {
        try {
          const statement = sqlite.query(sql);
          const rows = statement.values(...params) as T[][];
          return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
        } catch (error) { return failed(error); }
      }),
      execute: (sql: string, params: SqlValue[] = []) => this.send(resource, sql, (): Result<{ changes: number; lastInsertRowId: number }> => {
        try { return { ok: true, data: run(sql, params) }; } catch (error) { return failed(error); }
      }),
      batch: (statements) => this.send(resource, statements.map((statement) => statement.sql).join("; "), (): Result<{ results: { changes: number; lastInsertRowId: number }[] }> => {
        sqlite.exec("BEGIN");
        try {
          const results = statements.map((statement) => run(statement.sql, (statement.params ?? []) as SqlValue[]));
          sqlite.exec("COMMIT");
          return { ok: true, data: { results } };
        } catch (error) { sqlite.exec("ROLLBACK"); return failed(error); }
      }),
    } as FeedDatabase;
    this.databases.set(resource, handle);
    return handle;
  }
}

/** A full Feed load reads the agent registry; a freshness check only tallies it. */
const isFullLoad = (request: NodeRequest) => request.resource === HOME_FEED_RESOURCE && /\bFROM feed_agents\b/.test(request.sql) && !request.sql.startsWith("SELECT (SELECT");
const isDdl = (request: NodeRequest) => /\b(CREATE|ALTER|DROP)\s/i.test(request.sql);
const rounds = (requests: readonly NodeRequest[]) => Math.max(0, ...requests.map((request) => request.round));

// ── Environment: a fresh page per test; window timers on a controlled clock ──

const databases: Database[] = [];
const cleanups: (() => void)[] = [];
const roots = new Set<Root>();
let now = Date.parse(SITREP_NOW);
let timers: Map<number, { at: number; every?: number; run: () => void }>;

beforeEach(() => {
  cleanups.push(installDom());
  timers = new Map();
  now = Date.parse(SITREP_NOW);
  let next = 0;
  const schedule = (every: boolean) => (callback: unknown, delay?: number) => {
    if (typeof callback !== "function") throw new Error("Unexpected string timer");
    const ms = Math.max(0, delay ?? 0);
    timers.set(++next, { at: now + ms, ...(every ? { every: Math.max(1, ms) } : {}), run: callback as () => void });
    return next;
  };
  const cancel = (id?: number) => { if (id !== undefined) timers.delete(id); };
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key), clear: () => stored.clear() },
  });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
  for (const spy of [
    spyOn(Date, "now").mockImplementation(() => now),
    spyOn(window, "setTimeout").mockImplementation(schedule(false) as unknown as typeof window.setTimeout),
    spyOn(window, "setInterval").mockImplementation(schedule(true) as unknown as typeof window.setInterval),
    spyOn(window, "clearTimeout").mockImplementation(cancel as typeof window.clearTimeout),
    spyOn(window, "clearInterval").mockImplementation(cancel as typeof window.clearInterval),
  ]) cleanups.push(() => spy.mockRestore());
  resetLocalCacheForTests();
  resetLanesForTests();
});

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "indexedDB");
  resetLocalCacheForTests();
  resetLanesForTests();
  for (const database of databases.splice(0)) database.close();
});

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "Seeding failed");
  return result.data as T;
}

// ── The account: one agent, 15 cards, typed asks answered with follow-ups and handling ──

const SPACE = "isolated-feed-budget";
const CREATED = "2026-10-28T12:00:00.000Z";
const PLAIN_TITLE = "Book the Thursday flight?";

function typedCard(record: Record<string, unknown>, cardId: string): FeedCard {
  return { cardId, revision: 1, issuanceId: `${cardId}-issuance`, kind: String(record.kind), needsResponse: true, title: String(record.title), body: String(record.body), urgency: 2, createdAt: String(record.createdAt), payload: { sitrep: { version: 1, record } } };
}
function plainCard(cardId: string, title: string, urgency: number): FeedCard {
  return { cardId, revision: 1, issuanceId: `${cardId}-issuance`, kind: "ask", needsResponse: true, title, body: "Plain card body.", urgency, createdAt: CREATED, choices: [{ id: "go", label: "Go" }, { id: "hold", label: "Hold" }] };
}

/** Publishes the account's feed through the SDK, as an agent would, onto a node nobody is counting yet. */
async function seedAccount(node: FakeNode) {
  const seeder = { spaceId: SPACE, did: `did:pkh:eip155:1:0xseed${crypto.randomUUID()}`, hooks: node.hooks, sql: { db: (resource: string) => node.db(resource) } } as unknown as TinyCloudWeb;
  // The account's registry and settings tables, created by an earlier device.
  await createHomeFeedSource(seeder).load();
  await setSetting(seeder, HOME_FEED_DEFAULT_KEY, "both");
  const names = value(feedResourceNames("xyz.tinycloud.tinychat/feed", "budgetagent"));
  const output = node.db(names.outputResource);
  const responses = node.db(names.responseResource);
  value(await initializeFeedDatabases({ output, responses }));
  value(await node.db(HOME_FEED_RESOURCE).execute("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)",
    ["budget-agent", "did:key:budget-agent", "Budget agent", names.outputResource, names.responseResource, "{}"]));

  const secondAsk = { ...syntheticRecord("ask"), id: "ask-synthetic-2", title: "Choose the second synthetic approach" };
  const records: Record<string, unknown>[] = [...FROZEN_SITREP_RECORDS.map((record) => structuredClone(record) as Record<string, unknown>), secondAsk];
  const typed = records.map((record) => ({ record, card: typedCard(record, `typed-${String(record.id)}`) }));
  const plain = [plainCard("plain-1", PLAIN_TITLE, 3), plainCard("plain-2", "Renew the domain?", 2), plainCard("plain-3", "Approve the invoice?", 1), plainCard("plain-4", "Archive last week's notes?", 1)];
  for (const card of [...typed.map(({ card }) => card), ...plain]) value(await publishFeedCard(output, card));

  // Each typed ask: an answer, then a follow-up that replaces it, the agent's handling of both.
  for (const { record, card } of typed.filter(({ record }) => record.kind === "ask")) {
    const askId = String(record.id);
    const identity = { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId };
    const answer = (text: string, at: string): FeedResponsePayload => ({ type: "sitrep.answer", version: 1, data: { askId, action: "answer", text, at } });
    const first = value(await appendFeedResponse(output, responses, { responseId: `${card.cardId}-answer`, ...identity, kind: "answer", text: "Careful option", createdAt: "2026-10-29T10:00:00.000Z" }, answer("Careful option", "2026-10-29T10:00:00.000Z")));
    const followup: NewFeedResponse = { responseId: `${card.cardId}-followup`, ...identity, kind: "followup", text: "Careful, after review", supersedesResponseId: first.responseId, createdAt: "2026-10-29T10:30:00.000Z" };
    value(await appendFeedResponse(output, responses, followup, answer("Careful, after review", "2026-10-29T10:30:00.000Z")));
    for (const [response, phase, at] of [[first.responseId, "acknowledged", "2026-10-29T10:05:00.000Z"], [followup.responseId, "acknowledged", "2026-10-29T10:35:00.000Z"], [followup.responseId, "succeeded", "2026-10-29T11:00:00.000Z"]] as const) {
      value(await recordFeedHandling(output, { handlingId: `${response}-${phase}`, responseId: response, ...identity, phase, createdAt: at }));
    }
  }
  // A plain card answered and handled, and a comment on another.
  const plainOne = plain[0]!;
  const plainIdentity = { cardId: plainOne.cardId, revision: 1, issuanceId: plainOne.issuanceId };
  value(await appendFeedResponse(output, responses, { responseId: "plain-1-answer", ...plainIdentity, kind: "answer", choiceId: "go", createdAt: "2026-10-29T09:00:00.000Z" }));
  value(await recordFeedHandling(output, { handlingId: "plain-1-ack", responseId: "plain-1-answer", ...plainIdentity, phase: "acknowledged", createdAt: "2026-10-29T09:01:00.000Z" }));
  const plainTwo = plain[1]!;
  value(await appendFeedMessage(output, responses, { responseId: "plain-2-comment", cardId: plainTwo.cardId, revision: 1, issuanceId: plainTwo.issuanceId, kind: "message", text: "Only if it is under $20", createdAt: "2026-10-29T09:30:00.000Z" }));
  return { cards: typed.length + plain.length };
}

/** The signed-in owner on this device: its own did, so no earlier check of the chat store's schema is remembered for it. */
function ownerClient(node: FakeNode): TinyCloudWeb {
  return { spaceId: SPACE, did: `did:pkh:eip155:1:0xowner${crypto.randomUUID()}`, hooks: node.hooks, sql: { db: (resource: string) => node.db(resource) } } as unknown as TinyCloudWeb;
}

/** An earlier open on this device: it leaves the device's copy of the Feed and its schema markers. */
async function earlierOpen(tcw: TinyCloudWeb) {
  const earlier = createHomeFeedSource(tcw);
  await earlier.load(undefined, { feed: true });
  for (let attempt = 0; attempt < 50 && !(await earlier.cached?.()); attempt++) await Bun.sleep(1);
  if (!(await earlier.cached?.())) throw new Error("The earlier open left no device copy");
}

// ── Opening the Feed ──

interface Open {
  host: HTMLElement;
  /** Requests sent before the first card was on screen. */
  firstCard?: number;
  /** Waves the node had answered when the first card showed. */
  firstCardWaves?: number;
  /** Requests sent before the Feed's first load from the node landed. */
  fresh?: number;
  cachedSettled: boolean;
}

/** Renders the Feed as FeedView does, over the real store; the node answers nothing yet. */
async function openFeed(node: FakeNode, tcw: TinyCloudWeb): Promise<Open> {
  const real = createHomeFeedSource(tcw);
  const state: Open = { host: document.createElement("div"), cachedSettled: !real.cached };
  const source: HomeFeedSource = {
    ...real,
    load: async (focused, options) => {
      const snapshot = await real.load(focused, options);
      state.fresh ??= node.requests.length;
      return snapshot;
    },
    ...(real.cached ? { cached: async () => { try { return await real.cached!(); } finally { state.cachedSettled = true; } } } : {}),
  };
  document.body.append(state.host);
  const root = createRoot(state.host);
  roots.add(root);
  node.counting = true;
  await act(async () => root.render(<MemoryRouter><FeedViewEntries realEntries={[]} source={source} /></MemoryRouter>));
  await settle(node, state);
  return state;
}

const showsCard = (open: Open) => open.host.querySelector(`article[aria-label="${PLAIN_TITLE}"]`) !== null;

/** The node's Feed, whole: no load error, and the answered typed asks among the cards. */
function expectWholeFeed(open: Open) {
  expect(open.host.textContent).not.toContain("Home didn't load");
  for (const title of [PLAIN_TITLE, "Choose the synthetic approach", "Choose the second synthetic approach", "Synthetic incident"]) {
    expect(open.host.querySelector(`article[aria-label="${title}"]`)).not.toBeNull();
  }
}

/** Lets everything not waiting on the node run (the device copy's read included), and notes the first card. */
async function settle(node: FakeNode, open: Open) {
  let stable = 0;
  let mark = "";
  for (let step = 0; step < 500 && stable < 3; step++) {
    await act(async () => { await Bun.sleep(1); });
    const next = `${node.requests.length}:${node.waiting}:${open.cachedSettled}`;
    stable = open.cachedSettled && next === mark ? stable + 1 : 0;
    mark = next;
  }
  if (open.firstCard === undefined && showsCard(open)) {
    open.firstCard = node.requests.length;
    open.firstCardWaves = node.waves;
  }
}

/** The node answers one wave at a time until `done`. */
async function answerUntil(node: FakeNode, open: Open, done: () => boolean) {
  for (let wave = 0; !done(); wave++) {
    if (!node.waiting || wave > 20) throw new Error(`The Feed is waiting on nothing the node holds (after ${wave} waves)`);
    let streamsReady = () => {};
    await act(async () => { streamsReady = node.answerWave(); });
    await settle(node, open);
    await act(async () => streamsReady());
    await settle(node, open);
  }
}
const answerAll = (node: FakeNode, open: Open) => answerUntil(node, open, () => node.waiting === 0);

/** Fires the window timers due within `ms` of fake time, answering whatever they send. */
async function advance(node: FakeNode, open: Open, ms: number) {
  const end = now + ms;
  for (;;) {
    const due = [...timers].filter(([, timer]) => timer.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
    if (!due) break;
    const [id, timer] = due;
    now = Math.max(now, timer.at);
    if (timer.every) timer.at += timer.every;
    else timers.delete(id);
    await act(async () => timer.run());
    await settle(node, open);
    await answerAll(node, open);
  }
  now = end;
}

// ── Observations, printed once so a run shows what each open cost ──

const observed: Record<string, Record<string, number>> = {};
afterAll(() => { console.log(`Feed open request budget (observed):\n${Object.entries(observed).map(([name, counts]) => `  ${name}: ${JSON.stringify(counts)}`).join("\n")}`); });
const describeRequests = (requests: readonly NodeRequest[]) => requests.map((request) => `r${request.round} ${request.resource.split("/").at(-1)}: ${request.sql.replace(/\s+/g, " ").slice(0, 60)}`).join("\n");

async function warmOpen() {
  const node = new FakeNode(databases);
  await seedAccount(node);
  const tcw = ownerClient(node);
  await earlierOpen(tcw);
  resetLanesForTests();
  const open = await openFeed(node, sameOwner(tcw));
  return { node, open };
}

/** The same owner on a new page: a new client object, the device's storage kept. */
function sameOwner(tcw: TinyCloudWeb): TinyCloudWeb {
  return { spaceId: tcw.spaceId, did: tcw.did, hooks: tcw.hooks, sql: tcw.sql } as unknown as TinyCloudWeb;
}

test("warm open: the device copy shows the first card before any answer; the Feed is fresh within budget, loaded once", async () => {
  const { node, open } = await warmOpen();
  expect(showsCard(open)).toBe(true);
  expect(open.firstCardWaves).toBe(0);

  await answerUntil(node, open, () => open.fresh !== undefined);
  const beforeFresh = node.since(0, open.fresh);
  observed["warm open"] = { responsesBeforeFirstCard: open.firstCardWaves!, requestsBeforeFresh: beforeFresh.length, roundsBeforeFresh: rounds(beforeFresh), fullLoads: beforeFresh.filter(isFullLoad).length };
  const detail = describeRequests(beforeFresh);
  if (process.env.FEED_BUDGET_DETAIL) console.log(detail);
  expect({ requests: beforeFresh.length, detail }).toEqual({ requests: Math.min(beforeFresh.length, BUDGET.warmBeforeFresh), detail });
  expect({ rounds: rounds(beforeFresh), detail }).toEqual({ rounds: Math.min(rounds(beforeFresh), BUDGET.rounds), detail });
  await answerAll(node, open);
  expectWholeFeed(open);
  expect(node.requests.filter(isFullLoad)).toHaveLength(1);
});

test("new device: an empty device copy shows the first card and is fresh within budget, loaded once, with no schema DDL first", async () => {
  const node = new FakeNode(databases);
  await seedAccount(node);
  const open = await openFeed(node, ownerClient(node));
  expect(showsCard(open)).toBe(false);

  await answerUntil(node, open, () => open.fresh !== undefined);
  await settle(node, open);
  expect(showsCard(open)).toBe(true);
  const beforeFirstCard = node.since(0, open.firstCard);
  const beforeFresh = node.since(0, open.fresh);
  observed["new device"] = { requestsBeforeFirstCard: beforeFirstCard.length, requestsBeforeFresh: beforeFresh.length, roundsBeforeFresh: rounds(beforeFresh), fullLoads: beforeFresh.filter(isFullLoad).length, ddlBeforeFresh: beforeFresh.filter(isDdl).length };
  const detail = describeRequests(beforeFresh);
  if (process.env.FEED_BUDGET_DETAIL) console.log(detail);
  expect({ requests: beforeFirstCard.length, detail }).toEqual({ requests: Math.min(beforeFirstCard.length, BUDGET.newDeviceBeforeFirstCard), detail });
  expect({ requests: beforeFresh.length, detail }).toEqual({ requests: Math.min(beforeFresh.length, BUDGET.newDeviceBeforeFresh), detail });
  expect({ rounds: rounds(beforeFresh), detail }).toEqual({ rounds: Math.min(rounds(beforeFresh), BUDGET.rounds), detail });
  expect(beforeFresh.filter(isDdl)).toEqual([]);
  await answerAll(node, open);
  expectWholeFeed(open);
  expect(node.requests.filter(isFullLoad)).toHaveLength(1);
});

test("first ready after the load: the stream's freshness check reloads nothing", async () => {
  const { node, open } = await warmOpen();
  await answerUntil(node, open, () => open.fresh !== undefined);
  // The stream subscribed with the load becomes ready once the load's answers have landed.
  await answerAll(node, open);
  const check = node.since(open.fresh ?? 0);
  observed["first ready"] = { requests: check.length, rounds: new Set(check.map((request) => request.round)).size, fullLoads: check.filter(isFullLoad).length };
  expect({ fullLoads: check.filter(isFullLoad).length, detail: describeRequests(check) }).toEqual({ fullLoads: 0, detail: describeRequests(check) });
  expect(node.requests.filter(isFullLoad)).toHaveLength(1);
});

test(`idle: ${BUDGET.idleMs / 1000} s on a fresh Feed with a ready stream costs at most ${BUDGET.idle} requests`, async () => {
  const { node, open } = await warmOpen();
  await answerUntil(node, open, () => open.fresh !== undefined);
  await answerAll(node, open);
  const streams = node.streams.length;
  const before = node.requests.length;
  await advance(node, open, BUDGET.idleMs);
  const idle = node.since(before);
  observed.idle = { requests: idle.length, streamsOpened: node.streams.length - streams };
  expect({ requests: idle.length, detail: describeRequests(idle) }).toEqual({ requests: Math.min(idle.length, BUDGET.idle), detail: describeRequests(idle) });
  // The stream's 5-minute renewal is not due within the idle minute.
  expect(node.streams.length).toBe(streams);
});
