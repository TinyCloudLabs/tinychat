import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { FeedCardAlias } from "./FeedCardAlias";
import { useFeedCardLink } from "./feedCardLink";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

// A link to one Feed card (/chat/feed/<card id>, or the short /feed/<card id>) opens the Feed on that card, or says
// plainly that it is not available. It never writes anything and never navigates to what the address says.

const createdAt = "2026-10-28T12:00:00Z";
const A = "3f2b8c1e-6a4d-5e07-9b1c-0d4e7a8f2c33";
const B = "7a1d9e52-0c3b-5f48-8d26-b1e4c9a07f55";
const C = "c05e41b8-92f7-5d3a-a6e1-4b8d20f93e71";
const MISSING = "11111111-2222-5333-8444-555555555555";

function entry(cardId: string, title: string, extra: Record<string, unknown> = {}, sourceId = "agent-one"): HomeFeedEntry {
  return {
    source: {
      sourceId, agentDid: "did:key:isolated-test-agent", label: "Test agent",
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
    view: { sourceId, cardId, revision: 1, issuanceId: "issuance-1" },
  };
}
const information = (cardId: string, title: string, extra: Record<string, unknown> = {}) => entry(cardId, title, { kind: "progress", needsResponse: false, choices: undefined, ...extra });

interface Store {
  snapshot: HomeFeedSnapshot;
  writes: string[];
  /** Tells the page the feed changed, as a live update does. */
  refresh(): void;
  /** Holds the next load until `release` is called. */
  hold(): { release(): void };
  cache: HomeFeedSnapshot | null;
}
function store(entries: HomeFeedEntry[], options: { defaultSelector?: "needs-action" | "both"; connectionError?: string } = {}): Store {
  const listeners = new Set<() => void>();
  let gate: Promise<void> | null = null;
  const self: Store = {
    snapshot: { entries, settings: { defaultSelector: options.defaultSelector ?? "both" }, ...(options.connectionError ? { connectionError: options.connectionError } : {}) },
    writes: [], cache: null,
    refresh() { for (const listener of listeners) listener(); },
    hold() { let release!: () => void; gate = new Promise<void>((resolve) => { release = resolve; }); return { release: () => { release(); gate = null; } }; },
  };
  (self as { source?: HomeFeedSource }).source = {
    async load() { await gate; return structuredClone(self.snapshot); },
    cached: async () => (self.cache ? structuredClone(self.cache) : null),
    async saveResponse() { self.writes.push("saveResponse"); throw new Error("not used"); },
    async markSeen() {},
    async snooze() { self.writes.push("snooze"); },
    async setDefaultSelector(selector) { self.writes.push(`setDefaultSelector:${selector}`); },
    subscribe(onChange) { listeners.add(onChange); return () => { listeners.delete(onChange); }; },
  };
  return self;
}
const sourceOf = (feed: Store) => (feed as unknown as { source: HomeFeedSource }).source;

let restore: (() => void) | undefined;
let clock: FakeClock | undefined;
const roots = new Set<Root>();
const originalFetch = globalThis.fetch;
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  globalThis.fetch = originalFetch;
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  MotionGlobalConfig.skipAnimations = false;
  clock?.restore(); clock = undefined;
  restore?.(); restore = undefined;
});

/** The Feed screen as the app mounts it: the address decides the link. `at` shows where the address is. */
function Screen({ feed }: { feed: Store }) {
  const linked = useFeedCardLink();
  const { pathname } = useLocation();
  return <><output data-testid="at">{pathname}</output><HomeFeedEntries source={sourceOf(feed)} linked={linked} /></>;
}
async function mount(feed: Store, at: string) {
  restore ??= installDom();
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = window.matchMedia.bind(window);
  window.innerWidth = 800; // these tests open a card in its row (phone width)
  MotionGlobalConfig.skipAnimations = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter initialEntries={[at]}>
    <Routes>
      <Route path="/feed/:cardId" element={<FeedCardAlias />} />
      <Route path="/chat/feed/*" element={<Screen feed={feed} />} />
    </Routes>
  </MemoryRouter>));
  await settle();
  return { host, at: () => host.querySelector('[data-testid="at"]')?.textContent };
}
async function settle() { for (let turn = 0; turn < 4; turn++) await act(async () => {}); }

const live = (node: Element) => !node.closest("[inert]");
/** The cards open in place, by title. */
const openTitles = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>("article")].filter(live).map((node) => node.querySelector("h2")?.textContent);
const rowTitles = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].map((node) => node.textContent ?? "");
const tab = (host: ParentNode) => host.querySelector<HTMLInputElement>('input[name="feed-view"]:checked')?.value;
const noteOf = (host: ParentNode) => [...host.querySelectorAll('[role="status"]')].find((node) => node.textContent?.includes("isn't available"));
const NOTE = "That card isn't available. It may have been removed or expired, or it may not be in your feed.";

test("a card in the list opens in place, outlined, and nothing is written", async () => {
  const feed = store([entry(A, "First question"), entry(B, "Second question")]);
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(openTitles(view.host)).toEqual(["Second question"]);
  expect(rowTitles(view.host).some((text) => text.includes("First question"))).toBe(true);
  expect(noteOf(view.host)).toBeUndefined();
  expect(view.host.querySelector("li[data-card-key].shadow-\\[inset_0_0_0_2px_hsl\\(var\\(--ring\\)\\)\\]")?.textContent).toContain("Second question");
  expect(feed.writes).toEqual([]);
  // The outline is brief.
  await act(async () => { await clock!.advance(6000); });
  expect(view.host.querySelector("li[data-card-key].shadow-\\[inset_0_0_0_2px_hsl\\(var\\(--ring\\)\\)\\]")).toBeNull();
  expect(openTitles(view.host)).toEqual(["Second question"]);
});

test("a card that is an update is opened in the list, and nothing is written", async () => {
  const feed = store([entry(A, "A question"), information(B, "Just an update")], { defaultSelector: "needs-action" });
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(openTitles(view.host)).toContain("Just an update");
  expect(feed.writes).toEqual([]);
});

test("a closed or expired card opens under History", async () => {
  const feed = store([entry(A, "A question"), information(B, "Old update", { payload: { expiresAt: "2020-01-01T00:00:00Z" } })]);
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(view.host.querySelector('section[aria-label="History"] article h2')?.textContent).toBe("Old update");
  expect(openTitles(view.host)).toEqual(["Old update"]);
  expect(feed.writes).toEqual([]);
});

test("a snoozed card opens in the Snoozed list, not History", async () => {
  const snoozed = entry(B, "Later question");
  snoozed.view.snoozedUntil = "2099-01-01T00:00:00Z";
  const feed = store([entry(A, "A question"), snoozed]);
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(tab(view.host)).not.toBe("history");
  expect(openTitles(view.host)).toEqual(["Later question"]);
  expect(rowTitles(view.host).some((text) => text.includes("A question"))).toBe(false);
});

test("a card that is not in the feed leaves the Feed as it is, with one note, and Dismiss replaces the address", async () => {
  const feed = store([entry(A, "First question"), entry(B, "Second question")]);
  const view = await mount(feed, `/chat/feed/${MISSING}`);
  expect(noteOf(view.host)?.textContent).toContain(NOTE);
  expect(openTitles(view.host)).toEqual([]);
  expect(rowTitles(view.host)).toHaveLength(2);
  expect(feed.writes).toEqual([]);
  const dismiss = [...noteOf(view.host)!.querySelectorAll("button")].find((node) => node.textContent === "Dismiss")!;
  await act(async () => dismiss.click());
  expect(view.at()).toBe("/chat/feed");
  expect(noteOf(view.host)).toBeUndefined();
  expect(rowTitles(view.host)).toHaveLength(2);
});

test("text in the address that is not a card id gets no note and no navigation", async () => {
  const feed = store([entry(A, "First question")]);
  for (const hostile of ["https%3A%2F%2Fevil.example", "javascript:alert(1)", "%E0%A4%A", `${A}/extra`]) {
    const view = await mount(feed, `/chat/feed/${hostile}`);
    expect(view.at(), hostile).toBe(`/chat/feed/${hostile}`);
    expect(noteOf(view.host), hostile).toBeUndefined();
    expect(openTitles(view.host), hostile).toEqual([]);
  }
});

test("while the feed is loading there is no note, and the card opens when the load arrives", async () => {
  const feed = store([entry(A, "First question"), entry(B, "Second question")]);
  const held = feed.hold();
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(noteOf(view.host)).toBeUndefined();
  expect(openTitles(view.host)).toEqual([]);
  await act(async () => held.release());
  await settle();
  expect(openTitles(view.host)).toEqual(["Second question"]);
});

test("the device's earlier copy of the feed never decides a card is missing: only a load does", async () => {
  const feed = store([entry(A, "First question"), entry(B, "Second question")]);
  feed.cache = { entries: [entry(A, "First question")], settings: { defaultSelector: "both" } };
  const held = feed.hold();
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(rowTitles(view.host)).toHaveLength(1);
  expect(noteOf(view.host)).toBeUndefined();
  await act(async () => held.release());
  await settle();
  expect(noteOf(view.host)).toBeUndefined();
  expect(openTitles(view.host)).toEqual(["Second question"]);
});

test("when the feed can't be reached there is no note; the link is tried again when a load succeeds", async () => {
  const feed = store([entry(A, "First question")], { connectionError: "Live updates unavailable" });
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(noteOf(view.host)).toBeUndefined();
  feed.snapshot = { entries: [entry(A, "First question"), entry(B, "Second question")], settings: { defaultSelector: "both" } };
  await act(async () => feed.refresh());
  await settle();
  expect(noteOf(view.host)).toBeUndefined();
  expect(openTitles(view.host)).toEqual(["Second question"]);
});

test("the same card id in two agents' feeds is not guessed at: it is the note", async () => {
  const feed = store([entry(B, "From one", {}, "agent-one"), entry(B, "From two", {}, "agent-two")]);
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(noteOf(view.host)).toBeDefined();
  expect(openTitles(view.host)).toEqual([]);
});

test("a link is handled once: a card the owner folds stays folded through a refresh", async () => {
  const feed = store([entry(A, "First question"), entry(B, "Second question")]);
  const view = await mount(feed, `/chat/feed/${B}`);
  expect(openTitles(view.host)).toEqual(["Second question"]);
  const fold = view.host.querySelector<HTMLButtonElement>('button[aria-label="Show less"]')!;
  await act(async () => fold.click());
  expect(openTitles(view.host)).toEqual([]);
  await act(async () => feed.refresh());
  await settle();
  expect(openTitles(view.host)).toEqual([]);
});

test("the short address lands on the same card, and a bad one lands on the plain Feed", async () => {
  const feed = store([entry(A, "First question"), entry(B, "Second question")]);
  const short = await mount(feed, `/feed/${B.toUpperCase()}`);
  expect(short.at()).toBe(`/chat/feed/${B}`);
  expect(openTitles(short.host)).toEqual(["Second question"]);
  const bad = await mount(feed, "/feed/not-a-card");
  expect(bad.at()).toBe("/chat/feed");
  expect(openTitles(bad.host)).toEqual([]);
  expect(noteOf(bad.host)).toBeUndefined();
});

test("a plain Feed address is unchanged: no card open, no note", async () => {
  const feed = store([entry(A, "First question"), entry(C, "Third question")]);
  const view = await mount(feed, "/chat/feed");
  expect(noteOf(view.host)).toBeUndefined();
  expect(feed.writes).toEqual([]);
});
