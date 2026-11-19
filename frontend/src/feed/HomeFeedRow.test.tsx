import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { HomeFeedEntries } from "./HomeFeedEntries";
import { COURIER_OUTPUT_DATABASE, COURIER_SOURCE_ID } from "./feedData";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";
import { syntheticRecord } from "./sitrep.fixtures";

/**
 * The folded row is the card's post and nothing else of its text (its title when the agent wrote no post); the open
 * card is the post, then the title, then the content; nothing opens on its own; updates run newest first.
 */
const AUTHOR = "Avery";
function entry(cardId: string, title: string, over: { post?: string; summary?: string; body?: string; createdAt?: string; needs?: boolean; priority?: number; typed?: boolean; label?: string } = {}): HomeFeedEntry {
  const needs = over.needs ?? true;
  const record = over.typed ? { ...syntheticRecord("ask"), ...(over.post ? { post: over.post } : {}) } : undefined;
  const payload: Record<string, unknown> = {
    ...(record ? { sitrep: { version: 1, record } } : {}),
    ...(over.summary ? { summary: over.summary } : {}),
    ...(over.priority !== undefined ? { priority: over.priority } : {}),
  };
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: over.label ?? AUTHOR,
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: {
        cardId, revision: 1, issuanceId: `issuance-${cardId}`, kind: needs ? "ask" : "info", needsResponse: needs, title, body: over.body ?? "", urgency: 1,
        createdAt: over.createdAt ?? "2026-10-28T12:00:00Z",
        ...(needs ? { choices: [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }] } : {}),
        ...(Object.keys(payload).length ? { payload } : {}),
      },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: `issuance-${cardId}` },
  };
}

let restore: (() => void) | undefined;
let clock: FakeClock | undefined;
const roots = new Set<Root>();
const originalFetch = globalThis.fetch;
class QuietObserver {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  globalThis.fetch = originalFetch;
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  MotionGlobalConfig.skipAnimations = false;
  clock?.restore(); clock = undefined;
  restore?.(); restore = undefined;
});

async function mount(cards: HomeFeedEntry[], defaultSelector: "needs-action" | "both" = "needs-action"): Promise<HTMLElement> {
  restore ??= installDom();
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = window.matchMedia.bind(window);
  window.innerWidth = 800; // these tests open a card in its row (phone width)
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = QuietObserver;
  MotionGlobalConfig.skipAnimations = true;
  const feed: HomeFeedSource = {
    load: async () => structuredClone({ entries: cards, settings: { defaultSelector } }),
    async saveResponse() { throw new Error("not used"); },
    async markSeen() {}, async snooze() {}, async setDefaultSelector() {}, subscribe() { return () => {}; },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter><HomeFeedEntries source={feed} /></MemoryRouter>));
  await act(async () => {});
  await act(async () => {});
  return host;
}
const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")];
const rowOf = (host: HTMLElement, cardId: string) => rows(host).find((row) => row.dataset.cardKey?.includes(cardId))!;
/** What the row says: its text column, without the agent's letter mark beside it. */
const sayings = (row: Element) => row.querySelector("button")!.children[1]!.textContent;
async function open(row: HTMLElement) {
  await act(async () => row.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
}

test("a folded typed card is its post: not its title, its author, its time, or a count of options", async () => {
  const host = await mount([entry("typed", "Ship the node update?", { typed: true, post: "Ship the node update and lose two old databases for now? Nothing is deleted." })]);
  const row = rowOf(host, "typed");
  const own = row.querySelector("button")!;
  expect(own.textContent).toContain("Ship the node update and lose two old databases for now? Nothing is deleted.");
  expect(own.textContent).not.toContain("Ship the node update?");
  expect(own.textContent).not.toContain(AUTHOR);
  expect(own.textContent).not.toMatch(/\boptions?\b|Read more|See \d/);
  expect(own.querySelector("time")).toBeNull();
});

test("a folded plain card with a summary is the summary alone, with no author or time beside it", async () => {
  const host = await mount([entry("plain", "Book the flight?", { summary: "Book the Thursday 08:15 train? £24.50, refundable." })]);
  const row = rowOf(host, "plain");
  expect(sayings(row)).toBe("Book the Thursday 08:15 train? £24.50, refundable.");
});

test("a card whose agent wrote no post is its title, once", async () => {
  const host = await mount([entry("bare", "Book the flight?")]);
  expect(sayings(rowOf(host, "bare"))).toBe("Book the flight?");
});

test("a folded card keeps its priority mark beside the post, on the same row", async () => {
  const host = await mount([entry("urgent", "Pay now?", { summary: "Pay the invoice today?", priority: 0 })]);
  const text = rowOf(host, "urgent").textContent ?? "";
  expect(text).toContain("Pay the invoice today?");
  expect(text).toContain("P0");
});

test("a folded row's accessible name leads with its author, though the row prints no author", async () => {
  const host = await mount([entry("named", "Pay now?", { summary: "Pay the invoice today?", priority: 0 })]);
  const row = rowOf(host, "named");
  expect(row.textContent).not.toContain(AUTHOR);
  const name = row.querySelector("button")!.getAttribute("aria-label")!;
  expect(name.startsWith(`${AUTHOR}. Pay the invoice today?`)).toBe(true);
  expect(name).toContain("Priority 0");
});

test("a folded row from a card with no author gets no empty prefix in its accessible name", async () => {
  const host = await mount([entry("anon", "Pay now?", { summary: "Pay the invoice today?", label: "" })]);
  const name = rowOf(host, "anon").querySelector("button")!.getAttribute("aria-label")!;
  expect(name.startsWith("Pay the invoice today?")).toBe(true);
});

const SENDER = "Mira · Northwind team";
/** A card that says it is a Courier message from SENDER; `verified` puts it on the owner's Courier connection, as the registry has it. */
function courierCard(cardId: string, verified: boolean, label: string): HomeFeedEntry {
  const base = entry(cardId, "Book the flight?", { summary: "Book the Thursday train?", label });
  const payload = { ...base.state.card.payload, type: "answer", channel: "courier", source: { label: SENDER } };
  const source = verified ? { ...base.source, sourceId: COURIER_SOURCE_ID, output: { ...base.source.output, database: COURIER_OUTPUT_DATABASE } } : base.source;
  return { ...base, source, state: { ...base.state, card: { ...base.state.card, payload } } };
}
const nameOfRow = (host: HTMLElement, cardId: string) => rowOf(host, cardId).querySelector("button")!.getAttribute("aria-label")!;

test("a verified Courier row's accessible name carries the verified sender and the agent that relayed it", async () => {
  const host = await mount([courierCard("real", true, "Relay agent")]);
  expect(nameOfRow(host, "real").startsWith(`${SENDER}. Book the Thursday train?`)).toBe(true);
  expect(nameOfRow(host, "real")).toContain("via Relay agent");
});

test("a card that only says Courier, from another agent, is named for that agent and never gets the sender", async () => {
  const host = await mount([courierCard("spoof", false, "Courier")]);
  const name = nameOfRow(host, "spoof");
  expect(name.startsWith("Courier. Book the Thursday train?")).toBe(true);
  expect(name).not.toContain(SENDER);
  expect(name).not.toContain("via");
});

test("nothing is open until the owner taps a card, in Needs you", async () => {
  const host = await mount([entry("first", "First?", { summary: "First post" }), entry("second", "Second?", { summary: "Second post" })]);
  expect(host.querySelectorAll("article").length).toBe(0);
  const buttons = rows(host).map((row) => row.querySelector("button"));
  expect(buttons.length).toBe(2);
  expect(buttons.every((button) => button?.getAttribute("aria-expanded") === "false")).toBe(true);
});

test("an open card reads the post, then the title, then the content", async () => {
  const host = await mount([entry("open", "Book the flight?", { summary: "Book the Thursday train, £24.50?", body: "The 08:15 is the last one with seats together." })]);
  await open(rowOf(host, "open"));
  const article = host.querySelector("article")!;
  const post = article.querySelector("[data-card-post]")!;
  const title = [...article.querySelectorAll("h2")].find((node) => node.textContent === "Book the flight?")!;
  const content = [...article.querySelectorAll("p")].find((node) => node.textContent === "The 08:15 is the last one with seats together.")!;
  expect(post.textContent).toBe("Book the Thursday train, £24.50?");
  expect(post.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(title.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an open typed card shows the record's post above its title", async () => {
  const host = await mount([entry("typed-open", "Ship the node update?", { typed: true, post: "Ship the node update now? It waits on your yes." })]);
  await open(rowOf(host, "typed-open"));
  const article = host.querySelector("article")!;
  const post = article.querySelector("[data-card-post]")!;
  const title = [...article.querySelectorAll("h2")].find((node) => node.textContent === "Ship the node update?")!;
  expect(post.textContent).toBe("Ship the node update now? It waits on your yes.");
  expect(post.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("an open card with no post does not repeat its title above itself", async () => {
  const host = await mount([entry("nopost", "Book the flight?", { body: "Details here." })]);
  await open(rowOf(host, "nopost"));
  expect(host.querySelector("article [data-card-post]")).toBeNull();
});

test("updates run newest first in All", async () => {
  const host = await mount([
    entry("old", "Old update", { needs: false, summary: "Saturday's ship", createdAt: "2026-10-24T12:00:00Z" }),
    entry("new", "New update", { needs: false, summary: "Today's ship", createdAt: "2026-10-28T09:00:00Z" }),
    entry("mid", "Mid update", { needs: false, summary: "Sunday's ship", createdAt: "2026-10-25T12:00:00Z" }),
  ], "both");
  const updates = host.querySelector('section[aria-label="Updates"]')!;
  const order = [...updates.querySelectorAll("li[data-card-key]")].map(sayings);
  expect(order).toEqual(["Today's ship", "Sunday's ship", "Saturday's ship"]);
});
