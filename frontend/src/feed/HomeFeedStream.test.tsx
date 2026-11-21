import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { FeedResponse, HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";

/**
 * The Feed is one stream: Needs you, Updates, Pending and History, one under the other, with the island over it as the
 * stream's map. A tap on the island scrolls to a section; scrolling moves the highlight.
 */
function entry(cardId: string, title: string, over: { needs?: boolean; at?: string; answered?: boolean } = {}): HomeFeedEntry {
  const needs = over.needs ?? true;
  const choices = [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }];
  const issuanceId = `issuance-${cardId}-1`;
  const response = over.answered
    ? { responseId: `response-${cardId}`, cardId, revision: 1, issuanceId, kind: "answer", choiceId: "proceed", createdAt: "2026-10-28T12:30:00Z", sequence: 1 } as FeedResponse
    : null;
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Avery",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: {
        cardId, revision: 1, issuanceId, kind: needs ? "ask" : "info", needsResponse: needs, title, body: "", urgency: 1,
        createdAt: over.at ?? "2026-10-28T12:00:00Z",
        ...(needs ? { choices } : {}),
        payload: { summary: `${title} post` },
      },
      response, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId },
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
  setSystemTime();
});

/** An in-memory feed: `past` is what the node keeps of cards that are done. */
function store(entries: HomeFeedEntry[], past: HomeFeedEntry[] = []) {
  const stored = structuredClone(entries);
  const writes: FeedResponse[] = [];
  const source: HomeFeedSource = {
    load: async () => structuredClone({ entries: stored, historicalEntries: past, settings: { defaultSelector: "needs-action" as const } }),
    async saveResponse(target, response) {
      const saved = { ...response, sequence: writes.length + 1 } as FeedResponse;
      writes.push(saved);
      stored[stored.findIndex((candidate) => candidate.state.card.cardId === target.state.card.cardId)]!.state.response = saved;
      return saved;
    },
    async markSeen() {}, async snooze() {}, async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
  return { source, writes };
}

async function mount(source: HomeFeedSource): Promise<HTMLElement> {
  restore ??= installDom();
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = window.matchMedia.bind(window);
  window.innerWidth = 800; // these tests open a card in its row (phone width)
  (globalThis as { history?: History }).history ??= window.history;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = QuietObserver;
  MotionGlobalConfig.skipAnimations = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter><HomeFeedEntries source={source} /></MemoryRouter>));
  await act(async () => {});
  await act(async () => {});
  return host;
}

const rowsOf = (host: HTMLElement, cardId: string) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter((row) => row.dataset.cardKey?.includes(cardId));
const rowButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const section = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
const sectionNames = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("main section[aria-label]")].map((node) => node.getAttribute("aria-label")).filter((name) => ["Needs you", "Updates", "Pending", "History"].includes(name ?? ""));
const island = (host: HTMLElement) => host.querySelector<HTMLElement>('nav[aria-label="Feed sections"]')!;
const mapButton = (host: HTMLElement, label: string) => [...island(host).querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.startsWith(label))!;
const current = (host: HTMLElement) => [...island(host).querySelectorAll("button")].filter((node) => node.getAttribute("aria-current") === "true").map((node) => node.textContent);
const heading = (host: HTMLElement, name: string) => section(host, name)?.querySelector("h2")?.textContent;
/** The pane's scroll calls, and where each section's top is: the test lays the sections out, jsdom has no layout. */
function layout(host: HTMLElement, tops: Record<string, number>) {
  const main = host.querySelector<HTMLElement>("main")!;
  const calls: ScrollToOptions[] = [];
  main.scrollTo = ((options: ScrollToOptions) => { calls.push(options); }) as typeof main.scrollTo;
  main.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 390, width: 390, height: 800, x: 0, y: 0, toJSON: () => ({}) });
  for (const [name, top] of Object.entries(tops)) {
    const node = host.querySelector<HTMLElement>(`[data-stream="${name}"]`)!;
    node.getBoundingClientRect = () => ({ top, bottom: top + 300, left: 0, right: 390, width: 390, height: 300, x: 0, y: top, toJSON: () => ({}) });
  }
  return { main, calls };
}
const done = (cardId: string, title: string) => entry(cardId, title, { needs: false, answered: true, at: "2026-10-27T12:00:00Z" });

test("the default view is one stream: Needs you, Updates, Pending and History together, in that order", async () => {
  const feed = store([entry("ask", "Ship the node update?"), entry("note", "The build is green", { needs: false })], [done("old", "Old release")]);
  const host = await mount(feed.source);
  await act(async () => rowButton(rowsOf(host, "ask")[0]!).click());
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("Proceed"))!.click());
  await clock!.advance(6000);
  expect(sectionNames(host)).toEqual(["Needs you", "Updates", "Pending", "History"]);
  expect(rowsOf(host, "note")).toHaveLength(1);
  expect(section(host, "Updates")?.contains(rowsOf(host, "note")[0]!)).toBe(true);
  expect(section(host, "History")?.contains(rowsOf(host, "old")[0]!)).toBe(true);
});

test("an answered card is in Pending once, not also in History", async () => {
  const feed = store([entry("ask", "Ship the node update?")], [done("old", "Old release")]);
  const host = await mount(feed.source);
  await act(async () => rowButton(rowsOf(host, "ask")[0]!).click());
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.includes("Proceed"))!.click());
  await clock!.advance(6000);
  expect(feed.writes).toHaveLength(1);
  expect(rowsOf(host, "ask")).toHaveLength(1);
  expect(section(host, "Pending")?.contains(rowsOf(host, "ask")[0]!)).toBe(true);
  expect(section(host, "History")?.contains(rowsOf(host, "ask")[0]!)).toBe(false);
});

test("the island is a map, not a switch: no view radios, and Needs you, Updates and History carry their counts", async () => {
  const feed = store([entry("one", "First?"), entry("two", "Second?"), entry("note", "The build is green", { needs: false })], [done("old", "Old release")]);
  const host = await mount(feed.source);
  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(mapButton(host, "Needs you").textContent).toBe("Needs you2");
  expect(mapButton(host, "Updates").textContent).toBe("Updates1");
  expect(mapButton(host, "History").textContent).toBe("History");
  expect(heading(host, "Needs you")).toBe("Needs you2");
  expect(heading(host, "Updates")).toBe("Updates1");
});

test("a tap on Updates scrolls the pane to the Updates heading and changes nothing on the page", async () => {
  const feed = store([entry("ask", "Ship the node update?"), entry("note", "The build is green", { needs: false })], [done("old", "Old release")]);
  const host = await mount(feed.source);
  const { main, calls } = layout(host, { needs: 120, updates: 520, history: 900 });
  await act(async () => { main.dispatchEvent(new Event("scroll")); });
  const before = sectionNames(host);
  expect(current(host)).toEqual(["Needs you1"]);
  await act(async () => mapButton(host, "Updates").click());
  expect(calls).toHaveLength(1);
  // The section's top (520) under the pinned row (55): where the heading comes to rest.
  expect(calls[0]?.top).toBe(465);
  expect(current(host)).toEqual(["Updates1"]);
  expect(sectionNames(host)).toEqual(before);
  expect(rowsOf(host, "ask")).toHaveLength(1);
});

test("scrolling moves the highlight to the section under the pinned row", async () => {
  const feed = store([entry("ask", "Ship the node update?"), entry("note", "The build is green", { needs: false })], [done("old", "Old release")]);
  const host = await mount(feed.source);
  const { main } = layout(host, { needs: -400, updates: 40, history: 700 });
  await act(async () => { main.dispatchEvent(new Event("scroll")); });
  expect(current(host)).toEqual(["Updates1"]);
  layout(host, { needs: -900, updates: -500, history: 30 });
  await act(async () => { main.dispatchEvent(new Event("scroll")); });
  expect(current(host)).toEqual(["History"]);
  layout(host, { needs: 120, updates: 520, history: 900 });
  await act(async () => { main.dispatchEvent(new Event("scroll")); });
  expect(current(host)).toEqual(["Needs you1"]);
});

test("a section with nothing in it is off on the island: no Updates button without updates, none for History without history", async () => {
  const feed = store([entry("ask", "Ship the node update?")]);
  const host = await mount(feed.source);
  expect(mapButton(host, "Updates").disabled).toBe(true);
  expect(mapButton(host, "History").disabled).toBe(true);
  expect(mapButton(host, "Needs you").disabled).toBe(false);
  expect(section(host, "Updates")).toBeNull();
  expect(section(host, "History")).toBeNull();
});

test("with nothing to answer, Needs you stays at the top and says so while Updates and History follow", async () => {
  const feed = store([entry("note", "The build is green", { needs: false })], [done("old", "Old release")]);
  const host = await mount(feed.source);
  expect(sectionNames(host)).toEqual(["Needs you", "Updates", "History"]);
  expect(heading(host, "Needs you")).toBe("Needs you0");
  expect(section(host, "Needs you")?.textContent).toContain("Nothing needs you.");
  expect(mapButton(host, "Needs you").disabled).toBe(false);
});

test("a card in History opens in place, once", async () => {
  const feed = store([entry("ask", "Ship the node update?")], [done("old", "Old release")]);
  const host = await mount(feed.source);
  expect(rowButton(rowsOf(host, "old")[0]!).getAttribute("aria-expanded")).toBe("false");
  await act(async () => rowButton(rowsOf(host, "old")[0]!).click());
  expect(rowsOf(host, "old")).toHaveLength(1);
  expect(rowsOf(host, "old")[0]!.querySelector('div[id^="feed-card-"]')).not.toBeNull();
  expect(section(host, "History")?.contains(rowsOf(host, "old")[0]!)).toBe(true);
  expect(section(host, "Needs you")?.contains(rowsOf(host, "old")[0]!)).toBe(false);
});

test("there is room under the stream for the last section to come to the top, and none when the Feed is empty", async () => {
  const room = (host: HTMLElement) => host.querySelector<HTMLElement>('main div[aria-hidden="true"][class*="460px"]');
  const full = await mount(store([entry("ask", "Ship the node update?")]).source);
  expect(room(full)).not.toBeNull();
  const empty = await mount(store([]).source);
  expect(room(empty)).toBeNull();
});
