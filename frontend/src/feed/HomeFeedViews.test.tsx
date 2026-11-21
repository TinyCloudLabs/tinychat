import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";

// The feed's three views (Compact, Expanded, Cards), chosen in the Filter panel and kept on the device.

const createdAt = "2026-10-28T12:00:00Z";
function entry(cardId: string, title: string, extra: Record<string, unknown> = {}): HomeFeedEntry {
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Test agent",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: {
        cardId, revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title, body: "Choose a reversible action.",
        urgency: 1, createdAt, choices: [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }], ...extra,
      },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: "issuance-1" },
  };
}
const ENTRIES = () => [
  entry("one", "First question"),
  entry("two", "Second question"),
  entry("post", "A post", { kind: "progress", needsResponse: false, choices: undefined, payload: { page: { image: "https://example.org/a.png", imageAlt: "A picture", questions: [] } } }),
  entry("three", "Third question"),
];

/** Replaces the browser's observer: a test reports which cards have scrolled into view. */
class FakeObserver {
  static all: FakeObserver[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) { FakeObserver.all.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
}
const observed = (node: Element) => FakeObserver.all.some((observer) => observer.targets.has(node));
/** Reports how much of a card is on screen (`ratio`), as the browser does: the card's own height and the scroller's. */
async function report(node: Element, ratio: number, heights = { card: 400, scroller: 800 }) {
  const observer = FakeObserver.all.find((candidate) => candidate.targets.has(node))!;
  expect(observer).toBeDefined();
  const record = { target: node, isIntersecting: ratio > 0, intersectionRatio: ratio, boundingClientRect: { height: heights.card }, rootBounds: { height: heights.scroller } };
  await act(async () => observer.callback([record as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver));
}
/** A card scrolled well into view and read for a moment. */
async function scrollIntoView(node: Element) {
  await report(node, 1);
  await clock!.advance(1000);
}

let restore: (() => void) | undefined;
let clock: FakeClock | undefined;
const roots = new Set<Root>();
const seen: string[] = [];
const originalFetch = globalThis.fetch;
beforeEach(() => { seen.length = 0; FakeObserver.all = []; });
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

function source(entries: HomeFeedEntry[]): HomeFeedSource {
  return {
    load: async () => structuredClone({ entries, settings: { defaultSelector: "both" as const } }),
    async saveResponse() { throw new Error("not used"); },
    async markSeen(item) { seen.push(item.state.card.cardId); },
    async snooze() {},
    async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
}

async function mount(feed: HomeFeedSource) {
  restore ??= installDom();
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = window.matchMedia.bind(window);
  window.innerWidth = 800; // these tests open a card in its row (phone width)
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
  MotionGlobalConfig.skipAnimations = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter><HomeFeedEntries source={feed} /></MemoryRouter>));
  await act(async () => {});
  await act(async () => {});
  return { host, async unmount() { await act(async () => root.unmount()); roots.delete(root); host.remove(); } };
}

const answerButtons = (host: ParentNode) => [...host.querySelectorAll("button")].filter((node) => node.textContent?.trim() === "Proceed");
const foldButtons = (host: ParentNode) => host.querySelectorAll('button[aria-label="Show less"]');
const item = (host: ParentNode, title: string) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].find((node) => node.textContent?.includes(title))!;
const closedRows = (host: ParentNode) => host.querySelectorAll('li[data-card-key] button[aria-expanded="false"]');
const selectedView = (host: ParentNode) => host.querySelector<HTMLInputElement>('input[name="feed-list-view"]:checked')?.value;

async function openFilter(host: ParentNode) {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-controls="home-feed-filters"]')!.click());
}
async function chooseView(host: ParentNode, view: string) {
  await openFilter(host);
  await act(async () => host.querySelector<HTMLInputElement>(`input[name="feed-list-view"][value="${view}"]`)!.click());
}

test("Compact is the view until another is chosen: every card a row, none open", async () => {
  const view = await mount(source(ENTRIES()));
  await openFilter(view.host);
  expect(selectedView(view.host)).toBe("compact");
  expect(answerButtons(view.host)).toHaveLength(0);
  expect(closedRows(view.host).length).toBeGreaterThanOrEqual(3);
});

test("Expanded opens every card in full, with its answers and without Show less; a post stays a row", async () => {
  const view = await mount(source(ENTRIES()));
  await chooseView(view.host, "expanded");
  expect(answerButtons(view.host)).toHaveLength(3);
  expect(foldButtons(view.host)).toHaveLength(0);
  const post = item(view.host, "A post");
  expect(post.querySelector('button[aria-haspopup="dialog"]')).not.toBeNull();
  expect(post.querySelector('button[aria-label="Show less"]')).toBeNull();
});

test("Cards keeps its tiles: a tapped tile opens in place and the others stay tiles", async () => {
  const view = await mount(source(ENTRIES()));
  await chooseView(view.host, "cards");
  expect(answerButtons(view.host)).toHaveLength(0);
  await act(async () => item(view.host, "Second question").querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
  expect(answerButtons(item(view.host, "Second question"))).toHaveLength(1);
  expect(answerButtons(view.host)).toHaveLength(1);
});

test("the chosen view is kept: a feed mounted later on the same device starts in it", async () => {
  const first = await mount(source(ENTRIES()));
  await chooseView(first.host, "expanded");
  await first.unmount();
  const second = await mount(source(ENTRIES()));
  expect(answerButtons(second.host)).toHaveLength(3);
  await openFilter(second.host);
  expect(selectedView(second.host)).toBe("expanded");
});

test("switching back to Compact folds every card to a row again", async () => {
  const view = await mount(source(ENTRIES()));
  await chooseView(view.host, "expanded");
  expect(answerButtons(view.host)).toHaveLength(3);
  await act(async () => view.host.querySelector<HTMLInputElement>('input[name="feed-list-view"][value="compact"]')!.click());
  expect(answerButtons(view.host)).toHaveLength(0);
});

test("in Expanded a card counts as seen when it scrolls into view, not when the list loads, and a post is left to its own page", async () => {
  const view = await mount(source(ENTRIES()));
  await chooseView(view.host, "expanded");
  expect(seen).toEqual([]);
  const second = item(view.host, "Second question");
  expect(observed(second)).toBe(true);
  expect(observed(item(view.host, "A post"))).toBe(false);
  await scrollIntoView(second);
  expect(seen).toEqual(["two"]);
  await scrollIntoView(second);
  expect(seen).toEqual(["two"]);
  await scrollIntoView(item(view.host, "Third question"));
  expect(seen).toEqual(["two", "three"]);
});

test("in Compact and Cards scrolling past a closed card does not mark it seen", async () => {
  const view = await mount(source(ENTRIES()));
  expect(FakeObserver.all.some((observer) => observer.targets.size > 0)).toBe(false);
  await chooseView(view.host, "cards");
  expect(FakeObserver.all.some((observer) => observer.targets.size > 0)).toBe(false);
  expect(seen).toEqual([]);
});

test("in Expanded a quick scroll past a card marks nothing seen, so no unread comment is cleared", async () => {
  const view = await mount(source(ENTRIES()));
  await chooseView(view.host, "expanded");
  const second = item(view.host, "Second question");
  await report(second, 1);
  await clock!.advance(600);
  await report(second, 0);
  await clock!.advance(5000);
  expect(seen).toEqual([]);
  // Back again and kept: it counts.
  await scrollIntoView(second);
  expect(seen).toEqual(["two"]);
});

test("in Expanded a card with only a sliver on screen never counts, however long, and one half on screen does", async () => {
  const view = await mount(source(ENTRIES()));
  await chooseView(view.host, "expanded");
  const second = item(view.host, "Second question");
  await report(second, 0.2);
  await clock!.advance(10_000);
  expect(seen).toEqual([]);
  await report(second, 0.5);
  await clock!.advance(1000);
  expect(seen).toEqual(["two"]);
});

test("in Expanded a card taller than the screen counts once the screen is nearly full of it", async () => {
  const view = await mount(source(ENTRIES()));
  await chooseView(view.host, "expanded");
  const second = item(view.host, "Second question");
  const tall = { card: 4000, scroller: 800 };
  await report(second, 0.1, tall);
  await clock!.advance(5000);
  expect(seen).toEqual([]);
  await report(second, 0.19, tall);
  await clock!.advance(1000);
  expect(seen).toEqual(["two"]);
});
