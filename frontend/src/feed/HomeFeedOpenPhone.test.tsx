import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { useFeedCardLink } from "./feedCardLink";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { FeedResponse, HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";

/**
 * Opening on a phone: one row open at a time, the others dim while one is open, "Show less" at the card's foot, the
 * open row comes to just under the sticky heading. A wide screen with a mouse keeps every card the owner opened.
 */
const createdAt = "2026-10-28T12:00:00Z";
const A = "3f2b8c1e-6a4d-5e07-9b1c-0d4e7a8f2c33";
const B = "7a1d9e52-0c3b-5f48-8d26-b1e4c9a07f55";
const C = "c05e41b8-92f7-5d3a-a6e1-4b8d20f93e71";

function entry(cardId: string, title: string, summary: string): HomeFeedEntry {
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Avery",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: {
        cardId, revision: 1, issuanceId: `issuance-${cardId}`, kind: "ask", needsResponse: true, title, body: "", urgency: 1, createdAt,
        choices: [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }], payload: { summary },
      },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: `issuance-${cardId}` },
  };
}

function store(entries: HomeFeedEntry[]) {
  const stored = structuredClone(entries);
  const writes: FeedResponse[] = [];
  const source: HomeFeedSource = {
    load: async () => structuredClone({ entries: stored, historicalEntries: [], settings: { defaultSelector: "both" } }),
    async saveResponse(target, response) {
      const saved = { ...response, sequence: writes.length + 1 } as FeedResponse;
      writes.push(saved);
      stored.find((candidate) => candidate.state.card.cardId === target.state.card.cardId)!.state.response = saved;
      return saved;
    },
    async markSeen() {}, async snooze() {}, async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
  return { source, writes };
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

/** A screen of these widths and settings: only the queries named here match. */
function media(matching: { desktop?: boolean; reduceMotion?: boolean }) {
  const query = (text: string) => ({
    matches: (text.includes("min-width: 1024px") && !!matching.desktop) || (text.includes("prefers-reduced-motion") && !!matching.reduceMotion),
    media: text, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  });
  return ((text: string) => query(text)) as unknown as typeof matchMedia;
}

function Linked({ source }: { source: HomeFeedSource }) {
  const linked = useFeedCardLink();
  const navigate = useNavigate();
  return <><button type="button" data-testid="visit" onClick={() => navigate(`/chat/feed/${B}`)}>visit</button><HomeFeedEntries source={source} linked={linked} /></>;
}

async function mount(source: HomeFeedSource, options: { desktop?: boolean; reduceMotion?: boolean; linked?: boolean } = {}): Promise<HTMLElement> {
  restore ??= installDom();
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = media(options);
  window.matchMedia = globalThis.matchMedia;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = QuietObserver;
  MotionGlobalConfig.skipAnimations = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter initialEntries={["/chat/feed"]}><Routes><Route path="/chat/feed/*" element={options.linked ? <Linked source={source} /> : <HomeFeedEntries source={source} />} /></Routes></MemoryRouter>));
  await act(async () => {});
  await act(async () => {});
  return host;
}

const rowOf = (host: HTMLElement, cardId: string) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].find((row) => row.dataset.cardKey?.includes(cardId))!;
/** The cards shown open (their article, reachable). */
const openIds = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter((row) => !!row.querySelector("article") && !row.hasAttribute("hidden")).map((row) => row.dataset.cardKey!.match(/[0-9a-f]{8}/)![0]);
const rowButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const tap = (host: HTMLElement, cardId: string) => act(async () => rowButton(rowOf(host, cardId)).click());
const dimmed = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("li[data-card-key][data-dim]")].map((row) => row.dataset.cardKey!.match(/[0-9a-f]{8}/)![0]);
const footShowLess = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Show less");
const three = () => store([entry(A, "First?", "First post"), entry(B, "Second?", "Second post"), entry(C, "Third?", "Third post")]);
const ids = (...cards: string[]) => cards.map((card) => card.slice(0, 8));

test("opening a row folds the one that was open", async () => {
  const feed = three();
  const host = await mount(feed.source);
  await tap(host, A);
  expect(openIds(host)).toEqual(ids(A));
  await tap(host, B);
  expect(openIds(host)).toEqual(ids(B));
  expect(rowOf(host, A).querySelector("article")).toBeNull();
  await tap(host, C);
  expect(openIds(host)).toEqual(ids(C));
});

test("the other rows dim while one is open, and the dimming goes when it folds", async () => {
  const feed = three();
  const host = await mount(feed.source);
  expect(dimmed(host)).toEqual([]);
  await tap(host, B);
  expect(dimmed(host).sort()).toEqual(ids(A, C).sort());
  expect(rowOf(host, B).hasAttribute("data-dim")).toBe(false);
  await act(async () => rowOf(host, B).querySelector<HTMLButtonElement>('button[aria-label="Show less"]')!.click());
  expect(openIds(host)).toEqual([]);
  expect(dimmed(host)).toEqual([]);
});

test("Show less at the card's foot folds it", async () => {
  const feed = three();
  const host = await mount(feed.source);
  await tap(host, A);
  const foot = footShowLess(rowOf(host, A));
  expect(foot).toBeDefined();
  await act(async () => foot!.click());
  expect(openIds(host)).toEqual([]);
  expect(dimmed(host)).toEqual([]);
  expect(rowButton(rowOf(host, A)).getAttribute("aria-expanded")).toBe("false");
});

test("an answer counting down is not lost when another row is opened: it stays mounted, out of sight, and is sent", async () => {
  const feed = three();
  const host = await mount(feed.source);
  await tap(host, A);
  const choose = [...rowOf(host, A).querySelectorAll<HTMLButtonElement>("fieldset button[aria-pressed]")].find((node) => node.textContent?.includes("Proceed"))!;
  await act(async () => choose.click());
  expect(rowOf(host, A).hasAttribute("hidden")).toBe(true);
  await tap(host, B);
  expect(openIds(host)).toEqual(ids(B));
  // The waiting card is still mounted in its hidden wrapper, and it does not hold the others dimmed on its account.
  expect(rowOf(host, A).querySelector("div[hidden][inert] article")).not.toBeNull();
  expect(feed.writes).toEqual([]);
  await act(async () => { await clock!.advance(7000); });
  expect(feed.writes.map((write) => write.cardId)).toEqual([A]);
});

test("with only a waiting card open nothing is dimmed", async () => {
  const feed = three();
  const host = await mount(feed.source);
  await tap(host, A);
  const choose = [...rowOf(host, A).querySelectorAll<HTMLButtonElement>("fieldset button[aria-pressed]")].find((node) => node.textContent?.includes("Proceed"))!;
  await act(async () => choose.click());
  expect(dimmed(host)).toEqual([]);
});

test("a card's link opens that card, folds the one that was open, and outlines it once", async () => {
  const feed = three();
  const host = await mount(feed.source, { linked: true });
  await tap(host, A);
  expect(openIds(host)).toEqual(ids(A));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="visit"]')!.click());
  await act(async () => {}); await act(async () => {});
  expect(openIds(host)).toEqual(ids(B));
  expect(rowOf(host, B).className).toContain("shadow-[inset_0_0_0_2px_hsl(var(--ring))]");
  await act(async () => { await clock!.advance(6000); });
  expect(rowOf(host, B).className).not.toContain("shadow-[inset_0_0_0_2px_hsl(var(--ring))]");
  expect(openIds(host)).toEqual(ids(B));
});

test("the opened card is brought to just under the sticky heading, smoothly", async () => {
  const feed = three();
  const host = await mount(feed.source);
  const main = host.querySelector<HTMLElement>("main")!;
  const calls: ScrollToOptions[] = [];
  main.scrollTo = ((options: ScrollToOptions) => { calls.push(options); }) as typeof main.scrollTo;
  await tap(host, B);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.behavior).toBe("smooth");
});

test("with reduced motion the opened card still comes into view, without easing", async () => {
  const feed = three();
  const host = await mount(feed.source, { reduceMotion: true });
  const main = host.querySelector<HTMLElement>("main")!;
  const calls: ScrollToOptions[] = [];
  main.scrollTo = ((options: ScrollToOptions) => { calls.push(options); }) as typeof main.scrollTo;
  await tap(host, B);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.behavior).toBe("auto");
  expect(dimmed(host).sort()).toEqual(ids(A, C).sort());
});

test("on a wide screen with a mouse the card lifts over the stream instead: no row opens in place, nothing dims, no foot link", async () => {
  const feed = three();
  const host = await mount(feed.source, { desktop: true });
  await tap(host, A);
  await tap(host, B);
  expect(openIds(host)).toEqual([]);
  expect(dimmed(host)).toEqual([]);
  expect(footShowLess(rowOf(host, A))).toBeUndefined();
});
