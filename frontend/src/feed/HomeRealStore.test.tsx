import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
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
import { heldAnswerKey } from "./answerOutbox";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import { FeedViewEntries } from "./FeedView";
import { archivePreparedOwnerBundle } from "./sitrepArchiveStore";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";
import type { HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

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
  clock = installFakeClock();
  setSystemTime(new Date(SITREP_NOW));
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  window.localStorage.clear();
  clock.restore();
  restoreDom?.(); restoreDom = undefined;
  for (const database of databases.splice(0)) database.close();
  setSystemTime();
});

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "Isolated Home SQL operation failed");
  return result.data as T;
}

function sqliteHandle(database: Database, refuseWrites: () => boolean): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    execute,
    query: async <T,>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    async batch(statements) {
      // The page went away before this request reached the node.
      if (refuseWrites()) throw new Error("connection closed");
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
  const faults = { refuseResponseWrites: false };
  const handles = new Map<string, { sqlite: Database; handle: FeedDatabase }>();
  function storage(resource: string) {
    let stored = handles.get(resource);
    if (!stored) {
      const sqlite = new Database(":memory:"); databases.push(sqlite);
      const responseDatabase = resource.includes("/feed_responses_");
      stored = { sqlite, handle: sqliteHandle(sqlite, () => responseDatabase && faults.refuseResponseWrites) }; handles.set(resource, stored);
    }
    return stored;
  }
  const spaceId = `isolated-home-store-${crypto.randomUUID()}`;
  const tcw = useLocalThreadStorage({ spaceId, hooks: {}, sql: { db: (resource: string) => storage(resource).handle } } as unknown as TinyCloudWeb);
  /** A new Home launch on this owner's session: a new store over the same data. */
  const fresh = () => observedSource(tcw);
  const initial = fresh(); await initial.source.load();
  await initial.source.setDefaultSelector("both");
  const registry = storage(HOME_FEED_RESOURCE);
  return {
    spaceId, faults, registry, fresh,
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

async function mount(transport: ReturnType<typeof observedSource>) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={transport.source} />));
  await transport.settle();
  return { host, async unmount() { await act(async () => root.unmount()); roots.delete(root); host.remove(); } };
}
function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Expected visible action: ${label}`);
  return found;
}
function option(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Answers"] button')].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`Expected option: ${label}`);
  return found;
}
function card(scope: ParentNode, title: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(`article[aria-label="${title}"]`);
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
  expect(view.host.textContent).toContain("Your answer wasn't saved. Try again.");
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
  await act(async () => button(view.host, "Answer in your own words").click());
  await enter(view.host, "Your answer", "Only if the aisle seat is free");
  await act(async () => button(view.host, "Send answer").click());
  await countdown(transport);
  const rows = await stored(agent);
  expect(rows).toHaveLength(1);
  expect(header(rows[0]!)).toEqual({ responseId: rows[0]!.responseId, cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "answer", text: "Only if the aisle seat is free", createdAt: COMMITTED });
});

test("a written answer is sitrep.answer text on a typed card", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("written-typed");
  value(await publishFeedCard(agent.output, typedCard(syntheticRecord("ask"))));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => button(view.host, "Answer in your own words").click());
  await enter(view.host, "Your answer", "Neither: wait for the review");
  await act(async () => button(view.host, "Send answer").click());
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
  await act(async () => button(view.host, "Comment").click());
  await enter(view.host, "Tell Test agent something", "Window seat, please");
  await click(transport, button(view.host, "Send"));
  const rows = await stored(agent);
  expect(rows).toHaveLength(1);
  expect(header(rows[0]!)).toEqual({ responseId: rows[0]!.responseId, cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "message", text: "Window seat, please", createdAt: SITREP_NOW });
  expect(option(view.host, "Go").disabled).toBe(false);
  expect(view.host.textContent).toContain("1 needs you.");
});

test("a comment on a typed card without an owner route is a sitrep thread message to its publisher", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("comment-typed");
  value(await publishFeedCard(agent.output, typedCard(syntheticRecord("ask"))));
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => button(view.host, "Comment").click());
  await enter(view.host, "Tell Test agent something", "Which one is cheaper?");
  await click(transport, button(view.host, "Send"));
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
  await act(async () => button(view.host, "Comment").click());
  await enter(view.host, "Tell SyntheticOwner something", "Go ahead after lunch.");
  await click(transport, button(view.host, "Send"));
  const rows = await stored(agent);
  expect(rows.map((row) => row.kind)).toEqual(["message"]);
  expect(value(await readFeedResponsePayload(agent.responses, rows[0]!))).toMatchObject({ type: "sitrep.thread", data: { text: "Go ahead after lunch.",
    delivery: { version: 1, targets: [{ recipientKey: "known-owner", agentId: "00000000-0000-4000-8000-000000000001", provider: "omp" }] } } });
});

test("a comment for a recipient that isn't connected yet is held privately and sent to no one", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("comment-held");
  await routedCard(owner, agent, { ...syntheticRecord("ask"), owner: "MissingOfficer" }, [{ recipientKey: "missing-officer", legacyName: "MissingOfficer" }]);
  const transport = owner.fresh(); const view = await mount(transport);
  await act(async () => button(view.host, "Comment").click());
  await enter(view.host, "Write a comment", "Keep this until MissingOfficer connects.");
  await click(transport, button(view.host, "Send"));
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
  expect(relaunched.host.textContent).toContain("Sent when you came back.");
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
  const view = await mount(transport);
  await act(async () => view.host.querySelector<HTMLButtonElement>('button[aria-label="2 comments. Open comments"]')!.click());
  const comments = [...card(view.host, "Book the Thursday flight?").querySelectorAll('section[aria-label="Comments"] li')]
    .map((item) => [item.querySelector("time")?.getAttribute("datetime"), item.textContent?.includes("Two seats held.") ? "first" : "second"]);
  expect(comments).toEqual([[T2, "first"], [T3, "second"]]);
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
  expect(view.host.textContent).not.toContain("Sent when you came back.");
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
  expect(card(relaunched.host, "Book the Thursday flight?").textContent).toContain("Sent when you came back.");
  expect(relaunched.host.textContent).toContain("You chose Go.");
});

test("a held answer whose card was replaced is not sent at the next launch, and the options are live again", async () => {
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
  const replaced = card(relaunched.host, "Book the Friday flight?");
  expect(replaced.textContent).toContain("Your answer wasn't sent: this request changed.");
  expect(option(replaced, "Go").disabled).toBe(false);
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
      if (options?.pageClosing) built.push(structuredClone({ response, ...(payload ? { payload } : {}) }));
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
    const original = built[0]!;
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
