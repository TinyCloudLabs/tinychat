import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  appendFeedResponse, feedResourceNames, initializeFeedDatabases, listFeedResponses, publishFeedCard, readFeedResponsePayload,
  type FeedCard, type FeedDatabase, type FeedResponse, type FeedResponsePayload, type FeedSource, type NewFeedResponse,
} from "@tinycloud/sdk-services/feed";
import { prepareSitrepImport, type PrepareSitrepImportInput } from "@tinyboilerplate/core/feed/sitrep";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { useLocalThreadStorage } from "../lib/threadStore";
import { clearHeldAnswers, HELD_ANSWER_TTL_MS, heldAnswerKey, type HeldAnswer } from "./answerOutbox";
import { ANSWER_FAILED_COPY, ANSWER_HELD_COPY, HELD_ANSWER_COPY, NOT_SENT_COPY } from "./cardKit";
import { createHomeFeedSource, HOME_FEED_RESOURCE, SIGN_OUT_FLUSH_MS, settleHeldAnswersForSignOut } from "./feedStore";
import { FeedViewEntries } from "./FeedView";
import { archivePreparedOwnerBundle } from "./sitrepArchiveStore";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";
import type { HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { plainConversation } from "./CardConversation";
import { storedRevisionEntry } from "./replyOnlyRevision";

// Every interaction below runs through the real Home store (createHomeFeedSource) over SQLite,
// with only the browser SDK transport substituted, as in HomeReview.test.tsx.

const PREFIX = "xyz.tinycloud.rocinante/";
const OUTBOX = "tinychat.home.answer-outbox.v1:";
const roots = new Set<Root>();
const databases: Database[] = [];
let restoreDom: (() => void) | undefined;
let clock: FakeClock;
beforeEach(() => {
  restoreDom = installDom();
  // Opening a card scrolls it into view, which asks the browser's bare matchMedia about reduced motion.
  Object.assign(globalThis, { matchMedia: window.matchMedia.bind(window) });
  clock = installFakeClock();
  setSystemTime(new Date(SITREP_NOW));
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  window.localStorage.clear();
  clock.restore();
  restoreDom?.(); restoreDom = undefined;
  Reflect.deleteProperty(globalThis, "matchMedia");
  for (const database of databases.splice(0)) database.close();
  setSystemTime();
});

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "Isolated Home SQL operation failed");
  return result.data as T;
}

type Faults = {
  /** Response writes fail in transport: the page went away before the request reached the node. */
  refuseResponseWrites: boolean;
  /** Response writes wait for this before they run: a slow write still in flight. */
  writeGate?: Promise<void>;
  /** Every read never answers: a hung node. */
  hang: boolean;
  /** Every read fails. */
  failReads?: boolean;
  /** The read matching `match` after `skip` earlier matches signals `reached`, then waits for `gate`: a slow read mid-flush. */
  readPause?: { match: RegExp; skip: number; gate: Promise<void>; reached: PromiseWithResolvers<void>; used?: boolean };
};
function sqliteHandle(database: Database, faults: Faults, responseDatabase: boolean): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    execute,
    query: async <T,>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      if (faults.hang) await new Promise<never>(() => {});
      if (faults.failReads) throw new Error("node unreachable");
      const pause = faults.readPause;
      if (pause && !pause.used && pause.match.test(sql) && pause.skip-- <= 0) { pause.used = true; pause.reached.resolve(); await pause.gate; }
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    async batch(statements) {
      if (responseDatabase && faults.refuseResponseWrites) throw new Error("connection closed");
      if (responseDatabase) await faults.writeGate;
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          const result = await execute(statement.sql, statement.params);
          if (!result.ok) throw new Error(result.error.message);
          results.push(result.data);
        }
        database.exec("COMMIT");
        return { ok: true, data: { results } };
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

function observedSource(tcw: TinyCloudWeb) {
  const actual = createHomeFeedSource(tcw);
  const listeners = new Set<() => void>();
  let pending: Promise<unknown> | undefined;
  const track = <T,>(promise: Promise<T>) => { pending = promise; return promise; };
  const source: HomeFeedSource = {
    ...actual,
    load(focused) { return track(actual.load(focused)); },
    flushHeldAnswers() { return track(actual.flushHeldAnswers!()); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  async function settle() {
    let current: typeof pending;
    do {
      current = pending;
      await act(async () => { await current; for (let index = 0; index < 50; index++) await Promise.resolve(); });
    } while (pending !== current);
  }
  return { source, settle, async notify() { await act(async () => { for (const listener of listeners) listener(); }); await settle(); } };
}

type Agent = { source: FeedSource; output: FeedDatabase; responses: FeedDatabase };
async function ownerFixture() {
  const faults: Faults = { refuseResponseWrites: false, hang: false };
  const handles = new Map<string, { sqlite: Database; handle: FeedDatabase }>();
  function storage(resource: string) {
    let stored = handles.get(resource);
    if (!stored) {
      const sqlite = new Database(":memory:"); databases.push(sqlite);
      const responseDatabase = resource.includes("/feed_responses_");
      stored = { sqlite, handle: sqliteHandle(sqlite, faults, responseDatabase) }; handles.set(resource, stored);
    }
    return stored;
  }
  const spaceId = `isolated-home-store-${crypto.randomUUID()}`;
  const client = { spaceId, hooks: {}, sql: { db: (resource: string) => storage(resource).handle } };
  const tcw = useLocalThreadStorage(client as unknown as TinyCloudWeb);
  /** A new Home launch on this owner's session: a new store over the same data. */
  const fresh = () => observedSource(tcw);
  const initial = fresh(); await initial.source.load();
  await initial.source.setDefaultSelector("both");
  const registry = storage(HOME_FEED_RESOURCE);
  return {
    spaceId, tcw, faults, registry, fresh,
    /** The signed-in account changes under the open page. */
    switchAccount() { client.spaceId = `${spaceId}-other`; },
    async agent(token: string): Promise<Agent> {
      const names = value(feedResourceNames("xyz.tinycloud.tinychat/feed", token));
      const output = storage(names.outputResource).handle;
      const responses = storage(names.responseResource).handle;
      value(await initializeFeedDatabases({ output, responses }));
      const source: FeedSource = { sourceId: token, agentDid: `did:key:synthetic-${token}`, label: "Test agent", output: { spaceId, database: names.outputResource }, responses: { spaceId, database: names.responseResource } };
      registry.sqlite.query("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)").run(source.sourceId, source.agentDid, source.label, source.output.database, source.responses.database, "{}");
      return { source, output, responses };
    },
  };
}

const T1 = "2026-10-29T10:00:00.000Z";
const T2 = "2026-10-29T10:20:00.000Z";
const T3 = "2026-10-29T10:40:00.000Z";
/** SITREP_NOW plus the 5 s undo window: an answer is made when its countdown commits. */
const COMMITTED = "2026-10-29T12:00:05.000Z";
function plainCard(changes: Partial<FeedCard> = {}): FeedCard {
  return { cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "ask", needsResponse: true, title: "Book the Thursday flight?", body: "The 09:10 has two seats left.", urgency: 2, createdAt: T1,
    choices: [{ id: "go", label: "Go" }, { id: "hold", label: "Hold" }], ...changes };
}
/** The same plain card with the agent's replies so far, as a new revision. */
function withReplies(revision: number, replies: string[], createdAt: string): FeedCard {
  return plainCard({ revision, issuanceId: `plain-issuance-${revision}`, createdAt, payload: { render: "thread", replies: replies.map((text) => ({ text })) } });
}
function typedCard(record: Record<string, unknown>, cardId = "typed-card"): FeedCard {
  return { cardId, revision: 1, issuanceId: `${cardId}-issuance`, kind: String(record.kind), needsResponse: true, title: String(record.title), body: String(record.body), urgency: 2, createdAt: String(record.createdAt), payload: { sitrep: { version: 1, record } } };
}

/** Mounts Home and, unless `open` is false, taps every card open. */
async function mount(transport: ReturnType<typeof observedSource>, { open = true } = {}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={transport.source} />));
  await transport.settle();
  if (open) await openCards(host);
  return { host, async unmount() { await act(async () => root.unmount()); roots.delete(root); host.remove(); } };
}
/**
 * Opens every short card in place, as the owner taps a card before answering it (cards are compact by default).
 * Answered cards still waiting or done sit in the Pending card at the end (Sam, 11-13): it is opened first.
 */
async function openCards(host: HTMLElement) {
  const pending = host.querySelector<HTMLButtonElement>('section[aria-label="Pending"] > button[aria-expanded="false"]');
  if (pending) await act(async () => pending.click());
  for (const item of host.querySelectorAll<HTMLElement>("li[data-card-key]")) {
    if (item.querySelector("article")) continue;
    const toggle = item.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    if (toggle) await act(async () => toggle.click());
  }
}
function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Expected visible action: ${label}`);
  return found;
}
/** A question's options (AnswerOptions): a fieldset whose legend is "Choose an option". */
function answers(scope: ParentNode): HTMLFieldSetElement | undefined {
  return [...scope.querySelectorAll<HTMLFieldSetElement>("fieldset")].find((node) => node.querySelector("legend")?.textContent === "Choose an option");
}
/** An option row's button (never the Undo laid over a waiting row). */
function option(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...answers(scope)?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? []].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`Expected option: ${label}`);
  return found;
}
/** An open card, by the title it shows. */
function card(scope: ParentNode, title: string): HTMLElement {
  const found = [...scope.querySelectorAll<HTMLElement>("article")].find((node) => [...node.children].some((child) => child.tagName === "H2" && child.textContent === title));
  if (!found) throw new Error(`Expected card: ${title}`);
  return found;
}
async function click(transport: ReturnType<typeof observedSource>, element: HTMLElement) {
  await act(async () => element.click()); await transport.settle();
}
async function enter(scope: ParentNode, label: string, text: string) {
  const input = scope.querySelector<HTMLTextAreaElement | HTMLInputElement>(`textarea[aria-label="${label}"], input[aria-label="${label}"]`);
  if (!input) throw new Error(`Expected field: ${label}`);
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Lets the 5 s undo window run out, then waits for the write and the reload it starts. */
async function countdown(transport: ReturnType<typeof observedSource>, ms = 5000) {
  await clock.advance(ms); await transport.settle();
}
async function closePage(transport: ReturnType<typeof observedSource>): Promise<string[]> {
  let held: string[] = [];
  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
    // Read before anything async runs: this is all a closing page is sure to keep.
    held = outboxKeys().map((key) => window.localStorage.getItem(key)!);
  });
  await transport.settle();
  return held;
}
function outboxKeys(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)!).filter((key) => key.startsWith(OUTBOX));
}
async function stored(agent: Agent): Promise<FeedResponse[]> {
  return value(await listFeedResponses(agent.responses));
}
/** A stored row's header as the writer built it (without the store's sequence). */
function header(response: FeedResponse) {
  const { sequence: _sequence, payloadType: _type, payloadVersion: _version, dispatchBefore: _dispatch, ...built } = response;
  return built;
}
function rawRow(sourceKey: string, record: unknown) {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  return { sourceKey, sourceArea: "kv" as const, encoding: "base64" as const, rawBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
/** A typed card imported with its owner route: who its comments may reach. */
async function routedCard(owner: Awaited<ReturnType<typeof ownerFixture>>, agent: Agent, record: Record<string, unknown>, recipients: PrepareSitrepImportInput["recipients"]) {
  const sourceKey = `${PREFIX}board/${String(record.kind)}/${String(record.id)}.json`;
  const bundle = await prepareSitrepImport({
    source: { spaceId: "routed-origin", namespace: PREFIX, snapshotId: "routed-first", completePrefixSnapshot: false }, frozenAt: SITREP_NOW,
    rows: [rawRow(sourceKey, record)],
    publishers: [{ publisherId: "routed-publisher", agentId: agent.source.sourceId, agentDid: agent.source.agentDid, outputResource: agent.source.output.database, responseResource: agent.source.responses.database }],
    publisherBindings: [{ sourceKey, publisherId: "routed-publisher", identity: { cardId: "routed-card", revision: 1, issuanceId: "routed-issuance" } }],
    recipients,
  });
  await archivePreparedOwnerBundle(owner.registry.handle, bundle);
  const prepared = bundle.cards[0]?.canonicalCard; if (!prepared) throw new Error("Prepared routed card is missing");
  value(await publishFeedCard(agent.output, prepared));
  return prepared;
}

test("one tap writes one answer after the 5 s window, with the same header as before", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("one-tap");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => option(view.host, "Go").click());
  await countdown(transport, 4999);
  expect(await stored(agent)).toEqual([]);
  await countdown(transport, 1);
  const rows = await stored(agent);
  expect(rows).toHaveLength(1);
  expect(header(rows[0]!)).toEqual({ responseId: rows[0]!.responseId, cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "answer", choiceId: "go", createdAt: COMMITTED });
  expect(value(await readFeedResponsePayload(agent.responses, rows[0]!))).toBeUndefined();
  expect(view.host.textContent).toContain("You chose Go.");
});

test("a retried tap reuses its responseId, so an answer whose reply was lost is stored once", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("retry");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh();
  const save = transport.source.saveResponse;
  const attempts: string[] = [];
  transport.source.saveResponse = async (entry, response, payload, options) => {
    attempts.push(response.responseId);
    const saved = await save(entry, response, payload, options);
    // The write landed, but its reply never reached the page.
    if (attempts.length === 1) throw new Error("reply lost");
    return saved;
  };
  const view = await mount(transport);
  await act(async () => option(view.host, "Go").click());
  await countdown(transport);
  expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => option(view.host, "Go").click());
  await countdown(transport);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]!);
  expect((await stored(agent)).map((row) => row.responseId)).toEqual([attempts[0]!]);
});

test("a written answer is the response text on a plain card", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("written-plain");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => option(view.host, "Your own answer").click());
  await enter(view.host, "Your own answer", "Only if the aisle seat is free");
  await act(async () => button(view.host, "Send").click());
  await countdown(transport);
  const rows = await stored(agent);
  expect(rows).toHaveLength(1);
  expect(header(rows[0]!)).toEqual({ responseId: rows[0]!.responseId, cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "answer", text: "Only if the aisle seat is free", createdAt: COMMITTED });
});

test("a written answer is sitrep.answer text on a typed card", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("written-typed");
  value(await publishFeedCard(agent.output, typedCard(syntheticRecord("ask"))));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => option(view.host, "Your own answer").click());
  await enter(view.host, "Your own answer", "Neither: wait for the review");
  await act(async () => button(view.host, "Send").click());
  await countdown(transport);
  const rows = await stored(agent);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "answer", cardId: "typed-card" });
  expect(rows[0]!.choiceId).toBeUndefined();
  expect(value(await readFeedResponsePayload(agent.responses, rows[0]!))).toEqual({ type: "sitrep.answer", version: 1, data: { askId: "ask-synthetic", action: "answer", text: "Neither: wait for the review", at: COMMITTED } });
});

test("a comment on a plain card is a message to the publishing agent and doesn't answer it", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("comment-plain");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => button(view.host, "Leave a comment for Test agent").click());
  await enter(view.host, "Leave a comment for Test agent", "Window seat, please");
  await click(transport, button(view.host, "Send"));
  // A comment waits out the same 5 s undo as an answer before it is written.
  expect(await stored(agent)).toEqual([]);
  await countdown(transport);
  const rows = await stored(agent);
  expect(rows).toHaveLength(1);
  expect(header(rows[0]!)).toEqual({ responseId: rows[0]!.responseId, cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "message", text: "Window seat, please", createdAt: COMMITTED });
  expect(option(view.host, "Go").disabled).toBe(false);
  expect(view.host.textContent).toContain("1 needs you.");
});

test("a comment on a typed card without an owner route is a sitrep thread message to its publisher", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("comment-typed");
  value(await publishFeedCard(agent.output, typedCard(syntheticRecord("ask"))));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => button(view.host, "Leave a comment for Test agent").click());
  await enter(view.host, "Leave a comment for Test agent", "Which one is cheaper?");
  await click(transport, button(view.host, "Send"));
  await countdown(transport);
  const rows = await stored(agent);
  expect(rows.map((row) => row.kind)).toEqual(["message"]);
  const payload = value(await readFeedResponsePayload(agent.responses, rows[0]!));
  expect(payload).toMatchObject({ type: "sitrep.thread", version: 1, data: { side: "sam", kind: "ask", id: "ask-synthetic", text: "Which one is cheaper?" } });
  expect((payload?.data as Record<string, unknown>).delivery).toBeUndefined();
});

test("a comment on an owner-routed card goes only to its approved, connected recipients", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("comment-routed");
  await routedCard(owner, agent, { ...syntheticRecord("ask"), owner: "SyntheticOwner" }, [
    { recipientKey: "known-owner", legacyName: "SyntheticOwner", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000001", provider: "omp" } },
  ]);
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => button(view.host, "Leave a comment for SyntheticOwner").click());
  await enter(view.host, "Leave a comment for SyntheticOwner", "Go ahead after lunch.");
  await click(transport, button(view.host, "Send"));
  await countdown(transport);
  const rows = await stored(agent);
  expect(rows.map((row) => row.kind)).toEqual(["message"]);
  expect(value(await readFeedResponsePayload(agent.responses, rows[0]!))).toMatchObject({ type: "sitrep.thread", data: { text: "Go ahead after lunch.",
    delivery: { version: 1, targets: [{ recipientKey: "known-owner", agentId: "00000000-0000-4000-8000-000000000001", provider: "omp" }] } } });
});

test("a comment for a recipient that isn't connected yet is held privately and sent to no one", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("comment-held");
  await routedCard(owner, agent, { ...syntheticRecord("ask"), owner: "MissingOfficer" }, [{ recipientKey: "missing-officer", legacyName: "MissingOfficer" }]);
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => button(view.host, "Leave a comment for MissingOfficer").click());
  await enter(view.host, "Leave a comment for MissingOfficer", "Keep this until MissingOfficer connects.");
  await click(transport, button(view.host, "Send"));
  await countdown(transport);
  expect(await stored(agent)).toEqual([]);
  const reloaded = await owner.fresh().source.load();
  expect(reloaded.entries[0]?.owner?.heldNotes).toEqual([expect.objectContaining({ intendedRecipient: "MissingOfficer", text: "Keep this until MissingOfficer connects." })]);
});

test("a held answer to an unanswered card goes to the reply-only revision that followed it", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("close-reply");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Go").click());
  owner.faults.refuseResponseWrites = true;
  const [held] = await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;
  value(await publishFeedCard(agent.output, withReplies(2, ["Two seats held."], T2)));

  const next = owner.fresh(); const relaunched = await mount(next);
  await next.settle();
  const entry = JSON.parse(held!) as { responseId: string };
  expect((await stored(agent)).map((row) => [row.responseId, row.revision, row.choiceId])).toEqual([[entry.responseId, 2, "go"]]);
  expect(outboxKeys()).toEqual([]);
  expect(relaunched.host.textContent).toContain(HELD_ANSWER_COPY.sent);
});

test("a plain card's agent replies are read across stored revisions, each timed by the revision that first carried it", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("replies");
  value(await publishFeedCard(agent.output, plainCard()));
  value(await publishFeedCard(agent.output, withReplies(2, ["Two seats held."], T2)));
  value(await publishFeedCard(agent.output, withReplies(3, ["Two seats held.", "Aisle is free too."], T3)));
  const transport = owner.fresh();
  // None of the earlier revisions has owner history, so none loads as an entry of its own.
  const snapshot: HomeFeedSnapshot = await transport.source.load();
  expect(snapshot.entries.map((entry) => entry.state.card.revision)).toEqual([3]);
  expect(snapshot.historicalEntries ?? []).toEqual([]);
  // Each reply is timed by the revision that first carried it (the chat draws them as one run under the first time).
  const entry = snapshot.entries[0]!;
  expect(plainConversation(entry, (entry.earlierRevisions ?? []).map((earlier) => storedRevisionEntry(entry.source, earlier))).map((line) => [line.at, line.text]))
    .toEqual([[T2, "Two seats held."], [T3, "Aisle is free too."]]);
  const view = await mount(transport);
  // Opened (mount taps the card), its conversation shows both replies in order, timed from the first.
  const thread = card(view.host, "Book the Thursday flight?").querySelector('section[aria-label="Comments"]')!;
  expect(thread.querySelector("time")?.getAttribute("datetime")).toBe(T2);
  expect([...thread.querySelectorAll("li p")].map((node) => node.textContent).filter((text) => text === "Two seats held." || text === "Aisle is free too.")).toEqual(["Two seats held.", "Aisle is free too."]);
});

test("a countdown on an untouched revision 1 re-targets to a reply-only revision 2 the store returns alone", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("retarget");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => option(view.host, "Go").click());
  await clock.advance(2000);
  // The first reply turns the (absent-render) post into a thread: still the same request.
  value(await publishFeedCard(agent.output, withReplies(2, ["Two seats held."], T2)));
  await transport.notify();
  expect(view.host.textContent).not.toContain("A newer version of this card arrived.");
  await countdown(transport, 3000);
  const rows = await stored(agent);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ revision: 2, issuanceId: "plain-issuance-2", kind: "answer", choiceId: "go" });
});

test("an answer on revision 1 stays bound to it when a reply-only revision follows", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("carry");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => option(view.host, "Go").click());
  await countdown(transport);
  value(await publishFeedCard(agent.output, withReplies(2, ["Booked."], T2)));
  await transport.notify();
  expect(view.host.textContent).toContain("You chose Go.");
  expect(view.host.textContent).toContain("Nothing needs you.");
  expect((await stored(agent)).map((row) => [row.revision, row.kind])).toEqual([[1, "answer"]]);
});

test("any other revision during the countdown refuses the commit: nothing is written", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("stale");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => option(view.host, "Go").click());
  await clock.advance(2000);
  value(await publishFeedCard(agent.output, plainCard({ revision: 2, issuanceId: "plain-issuance-2", body: "Only the 11:40 is left." })));
  await transport.notify();
  await countdown(transport, 3000);
  expect(await stored(agent)).toEqual([]);
  expect(view.host.textContent).toContain("This card changed. Answer the newer version.");
});

/** A tap as a pointer makes it: pointerdown, then click. */
async function tap(element: HTMLElement) {
  await act(async () => { element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); element.click(); });
}

test("Needs you's first card, open without a tap: any other revision during the countdown refuses the commit too, nothing is written", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("stale-full");
  value(await publishFeedCard(agent.output, plainCard()));
  // Not tapped open first (that alone binds the card): Needs you shows its first card open, and the tap on Go must bind it.
  const transport = owner.fresh(); const view = await mount(transport, { open: false });
  await act(async () => view.host.querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="Feed view"] input[value="needs-action"]')!.click());
  await tap(option(card(view.host, "Book the Thursday flight?"), "Go"));
  await clock.advance(2000);
  value(await publishFeedCard(agent.output, plainCard({ revision: 2, issuanceId: "plain-issuance-2", body: "Only the 11:40 is left." })));
  await transport.notify();
  await countdown(transport, 3000);
  expect(await stored(agent)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
  expect(view.host.textContent).toContain("This card changed. Answer the newer version.");
});

/** The bottom bar a card's Drop, Acknowledge or later time shows while it counts, by what it says. */
function undoBar(host: HTMLElement, text: string): HTMLElement | undefined {
  return [...host.querySelectorAll<HTMLElement>('p[role="status"]')].find((node) => node.querySelector("button")?.textContent === "Undo" && node.textContent?.startsWith(`${text} · `));
}

test("Drop this card writes one feed.drop message once the bar's 5 s pass, held in the outbox until it lands, and the card is in History as Dropped", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("drop");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  const gate = Promise.withResolvers<void>();
  owner.faults.writeGate = gate.promise;
  await act(async () => button(card(view.host, "Book the Thursday flight?"), "Drop this card").click());
  // Gone at once, with the bar counting; nothing is written or held yet.
  expect(view.host.textContent).not.toContain("Book the Thursday flight?");
  expect(undoBar(view.host, "Dropped")?.textContent).toBe("Dropped · 5sUndo");
  await countdown(transport, 4750);
  expect(outboxKeys()).toEqual([]);
  expect(await stored(agent)).toEqual([]);
  await countdown(transport, 250);
  expect(undoBar(view.host, "Dropped")).toBeUndefined();
  // The count ended: the drop is held while its write is in flight.
  expect(outboxKeys()).toHaveLength(1);
  expect(JSON.parse(window.localStorage.getItem(outboxKeys()[0]!)!)).toMatchObject({ sourceId: "drop", cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", ownerAction: { type: "feed.drop" } });
  expect(await stored(agent)).toEqual([]);
  gate.resolve();
  await transport.settle();
  const rows = await stored(agent);
  expect(rows.map((row) => [row.kind, row.text, row.payloadType])).toEqual([["message", "Dropped", "feed.drop"]]);
  expect(header(rows[0]!)).toEqual({ responseId: rows[0]!.responseId, cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "message", text: "Dropped", createdAt: COMMITTED });
  expect(value(await readFeedResponsePayload(agent.responses, rows[0]!))).toEqual({ type: "feed.drop", version: 1, data: {} });
  expect(outboxKeys()).toEqual([]);
  // Out of Needs you and Updates, a row under All's Done today, and in History marked Dropped.
  await transport.notify();
  const done = view.host.querySelector<HTMLElement>('section[aria-label="Done today"]');
  expect(done?.textContent).toContain("Book the Thursday flight?");
  expect(done?.querySelector("article")).toBeNull();
  for (const section of ["Needs you", "Updates"]) expect(view.host.querySelector(`section[aria-label="${section}"]`)?.textContent ?? "").not.toContain("Book the Thursday flight?");
  await click(transport, view.host.querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="Feed view"] input[value="history"]')!);
  const history = view.host.querySelector<HTMLElement>('section[aria-label="History"]');
  const item = [...history?.querySelectorAll<HTMLElement>("li[data-card-key]") ?? []].find((node) => node.textContent?.includes("Book the Thursday flight?"));
  expect(item?.textContent).toContain("Dropped");
});

test("Acknowledge on a plain update: the card stays away while its write is in flight after the bar's 5 s, then is acknowledged in History (it came back as an open row in production)", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("ack");
  value(await publishFeedCard(agent.output, plainCard({ kind: "update", needsResponse: false, title: "The 09:10 flight was rebooked", body: "Seat 14C, no change to the fare.", choices: [] })));
  const transport = owner.fresh(); const view = await mount(transport);
  const listed = () => ["Needs you", "Updates"].some((section) => (view.host.querySelector(`section[aria-label="${section}"]`)?.textContent ?? "").includes("The 09:10 flight was rebooked"));
  // The write is slow, as it is over a real node: the bar's count ends while it is still in flight.
  const gate = Promise.withResolvers<void>();
  owner.faults.writeGate = gate.promise;
  await act(async () => button(card(view.host, "The 09:10 flight was rebooked"), "Acknowledge").click());
  expect(view.host.textContent).not.toContain("The 09:10 flight was rebooked");
  expect(undoBar(view.host, "Acknowledged")?.textContent).toBe("Acknowledged · 5sUndo");
  await countdown(transport, 5000);
  expect(undoBar(view.host, "Acknowledged")).toBeUndefined();
  expect(await stored(agent)).toEqual([]);
  // The bar is gone and nothing is saved yet: the card must not be back among the open ones.
  expect(listed()).toBe(false);
  await countdown(transport, 1500);
  expect(listed()).toBe(false);
  gate.resolve();
  await transport.settle();
  const rows = await stored(agent);
  expect(rows.map((row) => [row.kind, row.text, row.payloadType])).toEqual([["message", "Acknowledged", "feed.acknowledge"]]);
  // Saved: still away from the live list, and in History marked Acknowledged.
  await transport.notify();
  await countdown(transport, 2000);
  expect(listed()).toBe(false);
  await click(transport, view.host.querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="Feed view"] input[value="history"]')!);
  const history = view.host.querySelector<HTMLElement>('section[aria-label="History"]');
  const item = [...history?.querySelectorAll<HTMLElement>("li[data-card-key]") ?? []].find((node) => node.textContent?.includes("The 09:10 flight was rebooked"));
  expect(item?.textContent).toContain("Acknowledged");
});

test("Drop this card on a plain card stays away while its write is in flight after the bar's 5 s", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("drop-flight");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  const gate = Promise.withResolvers<void>();
  owner.faults.writeGate = gate.promise;
  await act(async () => button(card(view.host, "Book the Thursday flight?"), "Drop this card").click());
  await countdown(transport, 5000);
  await countdown(transport, 1500);
  expect(undoBar(view.host, "Dropped")).toBeUndefined();
  expect(view.host.textContent).not.toContain("Book the Thursday flight?");
  gate.resolve();
  await transport.settle();
  expect((await stored(agent)).map((row) => row.payloadType)).toEqual(["feed.drop"]);
  expect(view.host.textContent).not.toContain("That didn't reach the agent.");
});

test("Acknowledge whose write is refused brings the card back with the sentence that it didn't reach the agent", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("ack-refused");
  value(await publishFeedCard(agent.output, plainCard({ kind: "update", needsResponse: false, title: "The 09:10 flight was rebooked", body: "Seat 14C, no change to the fare.", choices: [] })));
  const transport = owner.fresh(); const view = await mount(transport);
  owner.faults.refuseResponseWrites = true;
  await act(async () => button(card(view.host, "The 09:10 flight was rebooked"), "Acknowledge").click());
  await countdown(transport, 5000);
  await transport.settle();
  expect(await stored(agent)).toEqual([]);
  expect(view.host.textContent).toContain("That didn't reach the agent.");
  expect(view.host.textContent).toContain("The 09:10 flight was rebooked");
  owner.faults.refuseResponseWrites = false;
});

test("Undo on the Drop bar writes nothing, holds nothing, and puts the card back", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("drop-undo");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => button(card(view.host, "Book the Thursday flight?"), "Drop this card").click());
  await countdown(transport, 2000);
  await click(transport, button(undoBar(view.host, "Dropped")!, "Undo"));
  expect(undoBar(view.host, "Dropped")).toBeUndefined();
  expect(option(card(view.host, "Book the Thursday flight?"), "Go").disabled).toBe(false);
  // Past the bar's time, and past a page close that sends whatever still counts: nothing.
  await countdown(transport, 10_000);
  expect(await closePage(transport)).toEqual([]);
  expect(await stored(agent)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
  expect(view.host.textContent).toContain("1 needs you.");
});

test("closing the page mid-countdown sends at once and holds only the pending answer until the write is confirmed", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("close-send");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => option(view.host, "Go").click());
  await clock.advance(2000);
  const held = await closePage(transport);
  expect(held).toHaveLength(1);
  const entry = JSON.parse(held[0]!) as Record<string, unknown>;
  expect(entry).toEqual({ sourceId: "close-send", cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", responseId: entry.responseId, choiceId: "go", at: "2026-10-29T12:00:02.000Z" });
  expect(outboxKeys()).toEqual([]);
  const rows = await stored(agent);
  expect(rows.map((row) => [row.responseId, row.choiceId])).toEqual([[entry.responseId, "go"]]);
  expect(view.host.textContent).not.toContain(HELD_ANSWER_COPY.sent);
});

test("an answer the closing page couldn't write is sent at the next launch with the same responseId", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("close-flush");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Go").click());
  owner.faults.refuseResponseWrites = true;
  const [held] = await closePage(first);
  await view.unmount();
  expect(await stored(agent)).toEqual([]);
  const entry = JSON.parse(held!) as { responseId: string };
  expect(outboxKeys()).toEqual([heldAnswerKey(owner.spaceId, { sourceId: "close-flush", cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1" })]);

  owner.faults.refuseResponseWrites = false;
  const next = owner.fresh(); const relaunched = await mount(next);
  await next.settle();
  const rows = await stored(agent);
  expect(rows.map((row) => [row.responseId, row.revision, row.choiceId])).toEqual([[entry.responseId, 1, "go"]]);
  expect(outboxKeys()).toEqual([]);
  expect(card(relaunched.host, "Book the Thursday flight?").textContent).toContain(HELD_ANSWER_COPY.sent);
  expect(relaunched.host.textContent).toContain("You chose Go.");
});

test("a held answer whose card was replaced is not sent at the next launch: the answered card refuses it, as during the countdown", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("close-replaced");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Go").click());
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;
  value(await publishFeedCard(agent.output, plainCard({ revision: 2, issuanceId: "plain-issuance-2", title: "Book the Friday flight?" })));

  const next = owner.fresh(); const relaunched = await mount(next);
  await next.settle();
  expect(await stored(agent)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
  const answered = card(relaunched.host, "Book the Thursday flight?");
  expect(answered.textContent).toContain(`Not sent: Go. ${NOT_SENT_COPY.changed}`);
  expect(option(answered, "Go").disabled).toBe(true);
  await click(next, button(answered, "Show the newer version"));
  await openCards(relaunched.host);
  const newer = card(relaunched.host, "Book the Friday flight?");
  expect(newer.textContent).not.toContain("Not sent");
  expect(option(newer, "Go").disabled).toBe(false);
});

test("a held answer whose request the agent closed is not sent: the closed card says so and offers no way to answer", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("close-closed");
  const record = syntheticRecord("ask");
  const asked = typedCard(record);
  value(await publishFeedCard(agent.output, asked));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Quick option").click());
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;
  value(await publishFeedCard(agent.output, { ...asked, revision: 2, issuanceId: "typed-card-closed", payload: { sitrep: { version: 1, record: { ...record, status: "expired", expiredAt: SITREP_NOW } } } }));

  const next = owner.fresh(); const relaunched = await mount(next);
  await next.settle();
  expect(await stored(agent)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
  const closed = card(relaunched.host, String(record.title));
  const line = closed.querySelector('[role="alert"]')?.textContent;
  expect(line).toBe("Not sent: Quick option.");
  expect(closed.textContent).toContain("Expired");
  expect(answers(closed)).toBeUndefined();
  expect(closed.querySelector('textarea[aria-label="Your own answer"]')).toBeNull();
  expect([...closed.querySelectorAll("button")].some((node) => ["Fine, go ahead", "Your own answer", "Send"].includes(node.textContent?.trim() ?? ""))).toBe(false);
});

/** A page whose held-answer flush starts only after `before` opens, and hands its result over only after `after` opens (a slow node). */
function withSlowFlush(transport: ReturnType<typeof observedSource>, { before, after }: { before?: Promise<void>; after?: Promise<void> }) {
  return { ...transport, source: { ...transport.source, flushHeldAnswers: async () => { await before; const outcomes = await transport.source.flushHeldAnswers!(); await after; return outcomes; } } };
}

test("a held answer whose card the agent closed while the answered card was open on screen still says Not sent (production: it said nothing)", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("lost-retained");
  const record = syntheticRecord("ask");
  const asked = typedCard(record);
  value(await publishFeedCard(agent.output, asked));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Quick option").click());
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;

  // The reopened page paints the card as the owner left it, and the owner has it open before the flush has read the
  // revision the agent has since closed: that card stays on screen as the answered one.
  const next = owner.fresh();
  const flushStarts = Promise.withResolvers<void>();
  const relaunched = await mount(withSlowFlush(next, { before: flushStarts.promise }));
  await act(async () => option(card(relaunched.host, String(record.title)), "Quick option").dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  value(await publishFeedCard(agent.output, { ...asked, revision: 2, issuanceId: "typed-card-closed", payload: { sitrep: { version: 1, record: { ...record, status: "expired", expiredAt: SITREP_NOW } } } }));
  await next.notify();
  expect(relaunched.host.textContent).toContain("A newer version of this card arrived");
  flushStarts.resolve();
  await next.settle();
  expect(await stored(agent)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
  expect([...relaunched.host.querySelectorAll('[role="alert"]')].some((node) => node.textContent?.startsWith("Not sent: Quick option."))).toBe(true);
});

const LONG_WORDS = "Only if the aisle seat is free, the flight is not after nine, and the fare stays under the budget we agreed last week";
for (const [name, words, line, full] of [
  ["says what the owner wrote, so they can say it again", "Only if the aisle seat is free", "Not sent: “Only if the aisle seat is free”.", undefined],
  ["drops its own full stop when the owner's words already end in one", "Is the aisle seat free?", "Not sent: “Is the aisle seat free?”", undefined],
  ["shows the first 80 characters of a long answer, the whole of it in the title", LONG_WORDS, `Not sent: “${LONG_WORDS.slice(0, 80).trimEnd()}…”.`, LONG_WORDS],
] as const) {
  test(`an answer in words that was not sent ${name}`, async () => {
    const owner = await ownerFixture(); const agent = await owner.agent("lost-words");
    value(await publishFeedCard(agent.output, plainCard()));
    const first = owner.fresh(); const view = await mount(first);
    await act(async () => option(view.host, "Your own answer").click());
    await enter(view.host, "Your own answer", words);
    await act(async () => button(view.host, "Send").click());
    await countdown(first, 1200);
    owner.faults.refuseResponseWrites = true;
    await closePage(first);
    await view.unmount();
    owner.faults.refuseResponseWrites = false;
    value(await publishFeedCard(agent.output, plainCard({ revision: 2, issuanceId: "plain-issuance-2", title: "Book the Friday flight?" })));
    const next = owner.fresh(); const relaunched = await mount(next);
    await next.settle();
    expect(await stored(agent)).toEqual([]);
    const article = card(relaunched.host, "Book the Thursday flight?");
    expect(article.textContent).toContain(`${line} ${NOT_SENT_COPY.changed}`);
    const quoted = [...article.querySelectorAll<HTMLElement>("b")].find((node) => node.textContent?.startsWith("“"));
    expect(quoted?.getAttribute("title") ?? undefined).toBe(full);
    expect(quoted?.getAttribute("aria-label") ?? undefined).toBe(full ? `“${full}”` : undefined);
  });
}

test("a held answer whose outcome the page never got (it went away while the flush finished) is told at the next launch, until the owner has seen it", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("lost-gone");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Go").click());
  await countdown(first, 1200);
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;
  value(await publishFeedCard(agent.output, plainCard({ revision: 2, issuanceId: "plain-issuance-2", title: "Book the Friday flight?" })));

  // A launch whose page goes away before the flush's result arrives: the held entry is already released.
  const gate = Promise.withResolvers<void>();
  const gone = owner.fresh(); const goneView = await mount(withSlowFlush(gone, { after: gate.promise }));
  await goneView.unmount();
  gate.resolve();
  await gone.settle();
  expect(outboxKeys()).toEqual([]);
  expect(await stored(agent)).toEqual([]);

  const next = owner.fresh(); const relaunched = await mount(next);
  await next.settle();
  expect(relaunched.host.textContent).toContain(`Not sent: Go. ${NOT_SENT_COPY.changed}`);
  // On screen for as long as an undo lasts: the owner has seen it, and the next launch does not repeat it.
  await countdown(next, 5000);
  await relaunched.unmount();
  const again = owner.fresh(); const reopened = await mount(again);
  await again.settle();
  expect(reopened.host.textContent).not.toContain("Not sent");
});

test("an answer whose agent is no longer connected is told in a notice of its own, with the owner's words, until they dismiss it (it was released silently)", async () => {
  const owner = await ownerFixture();
  // Another agent stays connected, so the feed has cards; the answer's own agent never registered.
  const other = await owner.agent("still-here");
  value(await publishFeedCard(other.output, plainCard()));
  hold(owner.spaceId, { sourceId: "gone-agent", cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", responseId: "held-gone-agent", text: "Only if the aisle seat is free", at: SITREP_NOW });
  const first = await relaunch(owner);
  expect(outboxKeys()).toEqual([]);
  expect(first.view.host.textContent).toContain(`Not sent: “Only if the aisle seat is free”. ${NOT_SENT_COPY.disconnected}`);
  // Left unseen, it is there at the next launch too.
  await first.view.unmount();
  const second = await relaunch(owner);
  expect(second.view.host.textContent).toContain(`Not sent: “Only if the aisle seat is free”. ${NOT_SENT_COPY.disconnected}`);
  await click(second.next, button(second.view.host, "Dismiss"));
  expect(second.view.host.textContent).not.toContain("Not sent");
  await second.view.unmount();
  const third = await relaunch(owner);
  expect(third.view.host.textContent).not.toContain("Not sent");
});

test("an answer the node could not be reached for stays held and says it is not sent yet, with the owner's words, then goes at the next launch (it said nothing)", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("flush-down");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Your own answer").click());
  await enter(view.host, "Your own answer", "Only if the aisle seat is free");
  await act(async () => button(view.host, "Send").click());
  await countdown(first, 1200);
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;

  // The reopened page loads, then the node stops answering just as the flush reads.
  const next = owner.fresh();
  const flushStarts = Promise.withResolvers<void>();
  const relaunched = await mount(withSlowFlush(next, { before: flushStarts.promise }));
  owner.faults.failReads = true;
  flushStarts.resolve();
  // The reload the page starts after the flush fails as well while the node is down.
  await next.settle().catch(() => {});
  owner.faults.failReads = false;
  expect(outboxKeys()).toHaveLength(1);
  expect(await stored(agent)).toEqual([]);
  expect(relaunched.host.textContent).toContain("Your answer isn't sent yet.");
  expect(relaunched.host.textContent).toContain("“Only if the aisle seat is free”");
  await relaunched.unmount();

  // The next launch reaches the node: the same answer goes, once.
  const again = await relaunch(owner);
  expect((await stored(agent)).map((row) => row.text)).toEqual(["Only if the aisle seat is free"]);
  expect(outboxKeys()).toEqual([]);
  expect(again.view.host.textContent).toContain(HELD_ANSWER_COPY.sent);
});

for (const kind of ["Change answer", "Fine, go ahead"] as const) {
  test(`a flushed "${kind}" reproduces the original header and payload exactly, so its responseId is accepted again`, async () => {
    const owner = await ownerFixture(); const agent = await owner.agent(kind === "Change answer" ? "flush-followup" : "flush-default");
    const typed = kind === "Fine, go ahead";
    value(await publishFeedCard(agent.output, typed ? typedCard({ ...syntheticRecord("ask"), mode: "proceeding", default: "quick", recommend: "careful", decideBy: "2099-01-01T00:00:00.000Z" }) : plainCard()));
    const first = owner.fresh();
    const save = first.source.saveResponse;
    const built: { response: NewFeedResponse; payload?: FeedResponsePayload }[] = [];
    first.source.saveResponse = (entry, response, payload, options) => {
      if (options?.hold) built.push(structuredClone({ response, ...(payload ? { payload } : {}) }));
      return save(entry, response, payload, options);
    };
    const view = await mount(first);
    let earlier: string | undefined;
    if (typed) await act(async () => button(view.host, "Fine, go ahead").click());
    else {
      await act(async () => option(view.host, "Go").click());
      await countdown(first);
      earlier = (await stored(agent))[0]?.responseId;
      await act(async () => button(view.host, "Change answer").click());
      await act(async () => option(view.host, "Hold").click());
    }
    owner.faults.refuseResponseWrites = true;
    const [held] = await closePage(first);
    await view.unmount();
    owner.faults.refuseResponseWrites = false;
    const entry = JSON.parse(held!) as Record<string, unknown>;
    if (typed) expect(entry).toMatchObject({ action: "accept-default", choiceId: "quick" });
    else expect(entry).toMatchObject({ choiceId: "hold", supersedesResponseId: earlier });

    const next = owner.fresh(); await mount(next); await next.settle();
    // The last answer the page built: the one it was closing on.
    const original = built.at(-1)!;
    const flushed = (await stored(agent)).find((row) => row.responseId === original.response.responseId);
    if (!flushed) throw new Error("The held answer was not flushed");
    expect(header(flushed)).toEqual(original.response);
    if (!typed) expect(flushed).toMatchObject({ kind: "followup", supersedesResponseId: earlier });
    expect(value(await readFeedResponsePayload(agent.responses, flushed))).toEqual(original.payload);
    // Same id, same content: the feed accepts it again instead of refusing a reused responseId.
    const again = await appendFeedResponse(agent.output, agent.responses, original.response, original.payload);
    expect(again.ok).toBe(true);
    expect((await stored(agent)).filter((row) => row.responseId === original.response.responseId)).toHaveLength(1);
  });
}

/** An answer the outbox holds, as a page that closed before its write landed left it. */
function hold(spaceId: string, entry: HeldAnswer) {
  window.localStorage.setItem(heldAnswerKey(spaceId, entry), JSON.stringify(entry));
}
function plainHeld(sourceId: string, changes: Partial<HeldAnswer> = {}): HeldAnswer {
  return { sourceId, cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", responseId: `held-${sourceId}`, choiceId: "go", at: SITREP_NOW, ...changes };
}
/** An answer from another device or tab, written straight to the feed. */
async function answerElsewhere(agent: Agent, card: FeedCard, choiceId: string, responseId = crypto.randomUUID()) {
  return value(await appendFeedResponse(agent.output, agent.responses, { responseId, cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, kind: "answer", choiceId, createdAt: SITREP_NOW }));
}
async function relaunch(owner: Awaited<ReturnType<typeof ownerFixture>>) {
  const next = owner.fresh(); const view = await mount(next);
  await next.settle();
  return { next, view };
}

test("a held answer never overwrites a newer answer from another device: only that answer is stored and shown", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("newer-elsewhere");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Go").click());
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;
  await answerElsewhere(agent, plainCard(), "hold");

  const { view: relaunched } = await relaunch(owner);
  expect((await stored(agent)).map((row) => [row.revision, row.kind, row.choiceId])).toEqual([[1, "answer", "hold"]]);
  expect(outboxKeys()).toEqual([]);
  expect(relaunched.host.textContent).toContain("You chose Hold.");
  expect(relaunched.host.textContent).not.toContain("Not sent");
  expect(relaunched.host.textContent).not.toContain(HELD_ANSWER_COPY.sent);
});

test("a held answer is not moved to a reply-only revision of a card answered meanwhile", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("newer-then-reply");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Go").click());
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;
  await answerElsewhere(agent, plainCard(), "hold");
  value(await publishFeedCard(agent.output, withReplies(2, ["Holding it."], T2)));

  const { view: relaunched } = await relaunch(owner);
  expect((await stored(agent)).map((row) => [row.revision, row.kind, row.choiceId])).toEqual([[1, "answer", "hold"]]);
  expect(outboxKeys()).toEqual([]);
  expect(relaunched.host.textContent).toContain("You chose Hold.");
});

test("a held answer the feed refuses outright is cleared and reported not sent", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("refused");
  value(await publishFeedCard(agent.output, plainCard()));
  // An option this issuance never had: the feed rejects the write as invalid, not as a transport failure.
  hold(owner.spaceId, plainHeld("refused", { choiceId: "withdrawn" }));
  const { view } = await relaunch(owner);
  expect(await stored(agent)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
  expect(card(view.host, "Book the Thursday flight?").querySelector('[role="alert"]')?.textContent).toBe("Not sent: your answer.");
});

test("an answer whose page-close write did land is cleared at the next launch, never reported not sent", async () => {
  const owner = await ownerFixture();
  // Then a reply-only revision: the card stays the same request.
  const replied = await owner.agent("landed-reply");
  value(await publishFeedCard(replied.output, plainCard()));
  hold(owner.spaceId, plainHeld("landed-reply"));
  await answerElsewhere(replied, plainCard(), "go", "held-landed-reply");
  value(await publishFeedCard(replied.output, withReplies(2, ["Booked."], T2)));
  // Then a newer version that changed the request.
  const changed = await owner.agent("landed-changed");
  value(await publishFeedCard(changed.output, plainCard({ title: "Book the Thursday train?" })));
  hold(owner.spaceId, plainHeld("landed-changed"));
  await answerElsewhere(changed, plainCard(), "go", "held-landed-changed");
  value(await publishFeedCard(changed.output, plainCard({ revision: 2, issuanceId: "plain-issuance-2", title: "Book the Friday train?" })));

  const { view } = await relaunch(owner);
  expect(outboxKeys()).toEqual([]);
  expect((await stored(replied)).map((row) => row.responseId)).toEqual(["held-landed-reply"]);
  expect((await stored(changed)).map((row) => row.responseId)).toEqual(["held-landed-changed"]);
  expect(view.host.textContent).not.toContain("Not sent");
  expect(card(view.host, "Book the Thursday flight?").textContent).toContain("You chose Go.");
});

test("one space's held answers are neither sent nor deleted by another space's launch", async () => {
  const first = await ownerFixture(); const firstAgent = await first.agent("shared-token");
  const second = await ownerFixture(); const secondAgent = await second.agent("shared-token");
  for (const agent of [firstAgent, secondAgent]) value(await publishFeedCard(agent.output, plainCard()));
  hold(first.spaceId, plainHeld("shared-token"));
  const key = heldAnswerKey(first.spaceId, plainHeld("shared-token"));

  const other = await relaunch(second);
  expect(await stored(secondAgent)).toEqual([]);
  expect(outboxKeys()).toEqual([key]);
  await other.view.unmount();

  await relaunch(first);
  expect((await stored(firstAgent)).map((row) => row.responseId)).toEqual(["held-shared-token"]);
  expect(outboxKeys()).toEqual([]);
});

test("a held follow-up goes to the issuance it changes, not to a later reply-only revision", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("followup-own");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Go").click());
  await countdown(first);
  const earlier = (await stored(agent))[0]!.responseId;
  await act(async () => button(view.host, "Change answer").click());
  await act(async () => option(view.host, "Hold").click());
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;
  value(await publishFeedCard(agent.output, withReplies(2, ["Noted."], T2)));

  await relaunch(owner);
  expect((await stored(agent)).map((row) => [row.revision, row.kind, row.choiceId, row.supersedesResponseId])).toEqual([[1, "answer", "go", undefined], [1, "followup", "hold", earlier]]);
  expect(outboxKeys()).toEqual([]);
});

test("a held answer for a typed card already closed or expired at its own issuance writes nothing", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("typed-closed");
  const record = { ...syntheticRecord("ask"), status: "expired", expiredAt: SITREP_NOW };
  const closedCard = typedCard(record);
  value(await publishFeedCard(agent.output, closedCard));
  hold(owner.spaceId, { sourceId: "typed-closed", cardId: closedCard.cardId, revision: 1, issuanceId: closedCard.issuanceId, responseId: "held-typed-closed", choiceId: "quick", action: "answer", at: SITREP_NOW });
  const { view } = await relaunch(owner);
  expect(await stored(agent)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
  expect(card(view.host, String(record.title)).querySelector('[role="alert"]')?.textContent).toBe("Not sent: Quick option.");
});

test("a held answer older than 7 days is deleted unsent, and the card can be answered again", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("expired-hold");
  value(await publishFeedCard(agent.output, plainCard()));
  hold(owner.spaceId, plainHeld("expired-hold", { at: new Date(Date.parse(SITREP_NOW) - HELD_ANSWER_TTL_MS - 1000).toISOString() }));
  const { view } = await relaunch(owner);
  expect(await stored(agent)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
  const article = card(view.host, "Book the Thursday flight?");
  expect(article.textContent).not.toContain("Not sent");
  expect(option(article, "Go").disabled).toBe(false);
});

test("an answer is held while its write is in flight, and cleared once the write is confirmed", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("in-flight");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh(); const view = await mount(transport);
  const gate = Promise.withResolvers<void>();
  owner.faults.writeGate = gate.promise;
  await act(async () => option(view.host, "Go").click());
  await clock.advance(5000);
  expect(outboxKeys()).toHaveLength(1);
  expect(await stored(agent)).toEqual([]);
  gate.resolve();
  await transport.settle();
  expect((await stored(agent)).map((row) => row.choiceId)).toEqual(["go"]);
  expect(outboxKeys()).toEqual([]);
});

test("sign-out sends a held answer that is still valid, once, then clears it", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("sign-out-valid");
  value(await publishFeedCard(agent.output, plainCard()));
  hold(owner.spaceId, plainHeld("sign-out-valid"));
  await settleHeldAnswersForSignOut(owner.tcw);
  expect((await stored(agent)).map((row) => [row.responseId, row.choiceId])).toEqual([["held-sign-out-valid", "go"]]);
  expect(outboxKeys()).toEqual([]);
});

test("sign-out sends nothing for a stale held answer (answered since, or replaced) and clears it", async () => {
  const owner = await ownerFixture();
  const answered = await owner.agent("sign-out-answered");
  value(await publishFeedCard(answered.output, plainCard()));
  hold(owner.spaceId, plainHeld("sign-out-answered"));
  await answerElsewhere(answered, plainCard(), "hold");
  const replaced = await owner.agent("sign-out-replaced");
  value(await publishFeedCard(replaced.output, plainCard()));
  hold(owner.spaceId, plainHeld("sign-out-replaced"));
  value(await publishFeedCard(replaced.output, plainCard({ revision: 2, issuanceId: "plain-issuance-2", body: "Only the 11:40 is left." })));

  await settleHeldAnswersForSignOut(owner.tcw);
  expect((await stored(answered)).map((row) => row.choiceId)).toEqual(["hold"]);
  expect(await stored(replaced)).toEqual([]);
  expect(outboxKeys()).toEqual([]);
});

test(`sign-out with a hung node gives up after ${SIGN_OUT_FLUSH_MS / 1000} s and clears the held answers`, async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("sign-out-hung");
  value(await publishFeedCard(agent.output, plainCard()));
  hold(owner.spaceId, plainHeld("sign-out-hung"));
  owner.faults.hang = true;
  let settled = false;
  const signingOut = settleHeldAnswersForSignOut(owner.tcw).then(() => { settled = true; });
  await clock.advance(SIGN_OUT_FLUSH_MS - 1);
  expect(settled).toBe(false);
  await clock.advance(1);
  await act(async () => { await signingOut; });
  expect(settled).toBe(true);
  expect(outboxKeys()).toEqual([]);
  owner.faults.hang = false;
  expect(await stored(agent)).toEqual([]);
});

test("a held follow-up is not sent when a newer follow-up was made on another device, and its entry is cleared", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("followup-newer");
  value(await publishFeedCard(agent.output, plainCard()));
  const first = owner.fresh(); const view = await mount(first);
  await act(async () => option(view.host, "Go").click());
  await countdown(first);
  const earlier = (await stored(agent))[0]!.responseId;
  await act(async () => button(view.host, "Change answer").click());
  await act(async () => option(view.host, "Hold").click());
  owner.faults.refuseResponseWrites = true;
  await closePage(first);
  await view.unmount();
  owner.faults.refuseResponseWrites = false;
  value(await appendFeedResponse(agent.output, agent.responses, { responseId: "other-device-followup", cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "followup", choiceId: "go", supersedesResponseId: earlier, createdAt: SITREP_NOW }));

  const { view: relaunched } = await relaunch(owner);
  expect((await stored(agent)).map((row) => row.responseId)).toEqual([earlier, "other-device-followup"]);
  expect(outboxKeys()).toEqual([]);
  expect(relaunched.host.textContent).not.toContain("Not sent");
});

test("a live write the feed refuses clears its hold, and a failed transport keeps it", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("live-refused");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh();
  const entry = (await transport.source.load()).entries[0]!;
  const answer = (choiceId: string) => ({ responseId: `live-${choiceId}`, cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "answer" as const, choiceId, createdAt: SITREP_NOW });
  await expect(transport.source.saveResponse(entry, answer("withdrawn"), undefined, { hold: true })).rejects.toThrow();
  expect(outboxKeys()).toEqual([]);
  owner.faults.refuseResponseWrites = true;
  await expect(transport.source.saveResponse(entry, answer("go"), undefined, { hold: true })).rejects.toThrow();
  expect(outboxKeys()).toHaveLength(1);
});

test("sign-out still clears the held answers when the flush throws", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("sign-out-throws");
  value(await publishFeedCard(agent.output, plainCard()));
  hold(owner.spaceId, plainHeld("sign-out-throws"));
  owner.faults.failReads = true;
  await settleHeldAnswersForSignOut(owner.tcw);
  expect(outboxKeys()).toEqual([]);
  owner.faults.failReads = false;
  expect(await stored(agent)).toEqual([]);
});

test("after the sign-out bound only the write already in flight lands; a held answer that hadn't started is not sent", async () => {
  const owner = await ownerFixture();
  const agents = [await owner.agent("slow-a"), await owner.agent("slow-b")];
  for (const agent of agents) value(await publishFeedCard(agent.output, plainCard()));
  hold(owner.spaceId, plainHeld("slow-a"));
  hold(owner.spaceId, plainHeld("slow-b"));
  const gate = Promise.withResolvers<void>();
  owner.faults.writeGate = gate.promise;
  const signingOut = settleHeldAnswersForSignOut(owner.tcw);
  // Let the flush reach its first write, held back by the slow node.
  await act(async () => { for (let index = 0; index < 400; index++) await Promise.resolve(); });
  await clock.advance(SIGN_OUT_FLUSH_MS);
  await act(async () => { await signingOut; });
  expect(outboxKeys()).toEqual([]);
  gate.resolve();
  await act(async () => { for (let index = 0; index < 400; index++) await Promise.resolve(); });
  const landed = [...(await stored(agents[0]!)), ...(await stored(agents[1]!))];
  expect(landed).toHaveLength(1);
});

for (const typed of [false, true]) {
  test(`after a failed send on a ${typed ? "typed" : "plain"} card the answer is held, the options are live, and a second tap sends again`, async () => {
    const owner = await ownerFixture(); const agent = await owner.agent(typed ? "live-typed" : "live-plain");
    value(await publishFeedCard(agent.output, typed ? typedCard(syntheticRecord("ask")) : plainCard()));
    const transport = owner.fresh(); const view = await mount(transport);
    const choice = typed ? "Quick option" : "Go";
    owner.faults.refuseResponseWrites = true;
    await act(async () => option(view.host, choice).click());
    await countdown(transport);
    // The failed send is shown, the answer is held for the next launch, and nothing was stored.
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(outboxKeys()).toHaveLength(1);
    expect(await stored(agent)).toEqual([]);
    // Every option is enabled, the written answer ("Your own answer") among them.
    const options = [...answers(view.host)?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? []];
    expect(options.length).toBeGreaterThan(2);
    expect(options.every((node) => !node.disabled)).toBe(true);
    expect(option(view.host, "Your own answer").disabled).toBe(false);
    // A second tap sends again and, once the node takes it, is stored and no longer held.
    owner.faults.refuseResponseWrites = false;
    await act(async () => option(view.host, choice).click());
    await countdown(transport);
    expect((await stored(agent)).map((row) => row.kind)).toEqual(["answer"]);
    expect(outboxKeys()).toEqual([]);
  });
}

test("after a failed written answer the box keeps its text and its Send is live as Retry", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("live-written");
  value(await publishFeedCard(agent.output, plainCard()));
  const transport = owner.fresh();
  // In this test DOM the send button's exit animation never completes, so its leaving words stay inside it, and a tap
  // that swaps them again cancels that animation: happy-dom rejects its `finished`, and motion doesn't observe it.
  const animate = window.Element.prototype.animate;
  const animations = spyOn(window.Element.prototype, "animate").mockImplementation(function (this: Element, ...args: Parameters<Element["animate"]>) {
    const animation = animate.apply(this, args);
    animation.finished.catch(() => {});
    return animation;
  });
  const view = await mount(transport);
  await act(async () => option(view.host, "Your own answer").click());
  await enter(view.host, "Your own answer", "Only if the aisle seat is free");
  owner.faults.refuseResponseWrites = true;
  await act(async () => button(view.host, "Send").click());
  await countdown(transport);
  expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your own answer"]')?.value).toBe("Only if the aisle seat is free");
  const retry = [...view.host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.endsWith("Couldn't send · Retry"))!;
  try {
    expect(retry.disabled).toBe(false);
    owner.faults.refuseResponseWrites = false;
    await click(transport, retry);
    expect((await stored(agent)).map((row) => row.text)).toEqual(["Only if the aisle seat is free"]);
  } finally { animations.mockRestore(); }
});

test("a sign-out bound that lands during a held answer's reads stops its write: only the re-check right before the write can", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("slow-read");
  value(await publishFeedCard(agent.output, plainCard()));
  hold(owner.spaceId, plainHeld("slow-read"));
  // The local-first launch loader reads card state in bulk, so the first matching response read is the flush's.
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  owner.faults.readPause = { match: /IN \('answer', 'followup'\)/, skip: 0, gate: gate.promise, reached };
  const signingOut = settleHeldAnswersForSignOut(owner.tcw);
  await act(async () => { await reached.promise; });
  await clock.advance(SIGN_OUT_FLUSH_MS);
  await act(async () => { await signingOut; });
  expect(outboxKeys()).toEqual([]);
  gate.resolve();
  await act(async () => { for (let index = 0; index < 400; index++) await Promise.resolve(); });
  expect(await stored(agent)).toEqual([]);
});

/** A card of either kind, its title, and the option to tap. */
const KINDS = [
  { kind: "plain", title: "Book the Thursday flight?", choice: "Go", publish: (agent: Agent) => publishFeedCard(agent.output, plainCard()) },
  { kind: "typed", title: String(syntheticRecord("ask").title), choice: "Quick option", publish: (agent: Agent) => publishFeedCard(agent.output, typedCard(syntheticRecord("ask"))) },
] as const;
function failedLine(view: { host: HTMLElement }, title: string) {
  return card(view.host, title).querySelector('[role="alert"]')?.textContent;
}

for (const { kind, title, choice, publish } of KINDS) {
  describe(`the failed-answer line on a ${kind} card says Home will send it only while it is held`, () => {
    test("a transport failure: the entry is held, and the held line shows", async () => {
      const owner = await ownerFixture(); const agent = await owner.agent(`line-held-${kind}`);
      value(await publish(agent));
      const transport = owner.fresh(); const view = await mount(transport);
      owner.faults.refuseResponseWrites = true;
      await act(async () => option(view.host, choice).click());
      await countdown(transport);
      expect(outboxKeys()).toHaveLength(1);
      expect(failedLine(view, title)).toBe(ANSWER_HELD_COPY);
    });

    test("a definitive refusal: not held, and the older line shows", async () => {
      const owner = await ownerFixture(); const agent = await owner.agent(`line-refused-${kind}`);
      value(await publish(agent));
      const transport = owner.fresh(); const view = await mount(transport);
      // The agent withdrew the card: the feed refuses the answer outright, not as a transport failure.
      await agent.output.execute("DELETE FROM feed_cards", []);
      await act(async () => option(view.host, choice).click());
      await countdown(transport);
      expect(outboxKeys()).toEqual([]);
      expect(failedLine(view, title)).toBe(ANSWER_FAILED_COPY);
    });

    test("a failure before the answer is held (the account changed): not held, and the older line shows", async () => {
      const owner = await ownerFixture(); const agent = await owner.agent(`line-prehold-${kind}`);
      value(await publish(agent));
      const transport = owner.fresh(); const view = await mount(transport);
      owner.switchAccount();
      await act(async () => option(view.host, choice).click());
      await countdown(transport);
      expect(outboxKeys()).toEqual([]);
      expect(failedLine(view, title)).toBe(ANSWER_FAILED_COPY);
    });

    test("the entry cleared while the card is on screen (expiry or sign-out): the older line replaces the held one", async () => {
      const owner = await ownerFixture(); const agent = await owner.agent(`line-cleared-${kind}`);
      value(await publish(agent));
      const transport = owner.fresh(); const view = await mount(transport);
      owner.faults.refuseResponseWrites = true;
      await act(async () => option(view.host, choice).click());
      await countdown(transport);
      expect(failedLine(view, title)).toBe(ANSWER_HELD_COPY);
      clearHeldAnswers(owner.spaceId);
      await transport.notify();
      expect(failedLine(view, title)).toBe(ANSWER_FAILED_COPY);
    });
  });
}

for (const action of ["an option tap", "Fine, go ahead"] as const) {
  test(`a typed ${action} whose reply was lost is stored once: the retry reuses its responseId`, async () => {
    const owner = await ownerFixture(); const agent = await owner.agent(action === "Fine, go ahead" ? "typed-retry-default" : "typed-retry-tap");
    const record = action === "Fine, go ahead"
      ? { ...syntheticRecord("ask"), mode: "proceeding", default: "quick", recommend: "careful", decideBy: "2099-01-01T00:00:00.000Z" }
      : syntheticRecord("ask");
    value(await publishFeedCard(agent.output, typedCard(record)));
    const transport = owner.fresh();
    const save = transport.source.saveResponse;
    const attempts: string[] = [];
    transport.source.saveResponse = async (entry, response, payload, options) => {
      attempts.push(response.responseId);
      const saved = await save(entry, response, payload, options);
      // The write landed, but its reply never reached the page.
      if (attempts.length === 1) throw new Error("reply lost");
      return saved;
    };
    const view = await mount(transport);
    const tap = () => act(async () => (action === "Fine, go ahead" ? button(view.host, "Fine, go ahead") : option(view.host, "Quick option")).click());
    await tap(); await countdown(transport);
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    await tap(); await countdown(transport);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]!);
    const rows = await stored(agent);
    expect(rows.map((row) => row.responseId)).toEqual([attempts[0]!]);
    expect(rows[0]!.kind).toBe("answer");
  });
}
