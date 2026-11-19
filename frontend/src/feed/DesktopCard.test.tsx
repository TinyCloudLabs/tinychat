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
 * Opening a card on a wide screen with a mouse (Feed-match slice 5): the row lifts into a card over the dimmed
 * stream. X, Escape and a press on the dim close it and focus returns to the row; Tab stays in the card; the stream
 * behind is inert; an answer started in the card still counts down in its pill and is sent once. A phone-width screen
 * keeps opening the card in place.
 */
function entry(cardId: string, title: string, post: string): HomeFeedEntry {
  const choices = [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }];
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Avery",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: { cardId, revision: 1, issuanceId: `issuance-${cardId}-1`, kind: "ask", needsResponse: true, title, body: "", urgency: 1, createdAt: "2026-10-28T12:00:00Z", choices, payload: { summary: post } },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: `issuance-${cardId}-1` },
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

function store(entries: HomeFeedEntry[]) {
  const stored = structuredClone(entries);
  const writes: FeedResponse[] = [];
  const source: HomeFeedSource = {
    load: async () => structuredClone({ entries: stored, historicalEntries: [], settings: { defaultSelector: "needs-action" as const } }),
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

async function mount(source: HomeFeedSource, width = 1280): Promise<HTMLElement> {
  restore ??= installDom();
  clock ??= installFakeClock();
  window.innerWidth = width;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = window.matchMedia.bind(window);
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

const rowOf = (host: HTMLElement, cardId: string) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].find((row) => row.dataset.cardKey?.includes(cardId))!;
const rowButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const dialogs = () => [...document.querySelectorAll<HTMLElement>("[role=dialog]")].filter((node) => !node.closest("[inert]"));
const dialog = () => dialogs()[0]!;
const closeButton = () => document.querySelector<HTMLButtonElement>("[data-desktop-close]")!;
/** Whether the stream (any row in it) sits under an inert ancestor. */
const streamInert = (host: HTMLElement) => !!rowOf(host, "alpha").closest("[inert]");
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const undoButtons = () => [...document.querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.textContent === "Undo" && !node.closest("[hidden], [inert]"));
async function open(host: HTMLElement, cardId: string) {
  await act(async () => rowButton(rowOf(host, cardId)).click());
  await clock!.advance(50);
}
async function closeAndSettle(close: () => void) {
  await act(async () => close());
  await clock!.advance(100);
}

const two = () => store([entry("alpha", "Ship the node update?", "Ship it?"), entry("bravo", "Rotate the keys?", "Rotate them?")]);

test("tapping a row lifts its card into a dialog over the stream; the row stays, the stream is inert, focus is on the X", async () => {
  const host = await mount(two().source);
  await open(host, "alpha");
  expect(dialogs()).toHaveLength(1);
  expect(dialog().getAttribute("aria-modal")).toBe("true");
  expect(dialog().getAttribute("aria-label")).toBe("Ship the node update?");
  expect(dialog().className).toContain("max-w-[600px]");
  expect(dialog().textContent).toContain("Ship the node update?");
  expect(document.activeElement).toBe(closeButton());
  expect(rowOf(host, "alpha")).toBeDefined();
  expect(rowOf(host, "alpha").contains(dialog())).toBe(false);
  expect(streamInert(host)).toBe(true);
});

test("Escape closes the card and focus returns to its row", async () => {
  const host = await mount(two().source);
  await open(host, "alpha");
  await closeAndSettle(() => { press(document.activeElement!, "Escape"); });
  expect(dialogs()).toEqual([]);
  expect(streamInert(host)).toBe(false);
  expect(rowOf(host, "alpha").contains(document.activeElement)).toBe(true);
});

test("the X closes the card and focus returns to its row", async () => {
  const host = await mount(two().source);
  await open(host, "bravo");
  await closeAndSettle(() => closeButton().click());
  expect(dialogs()).toEqual([]);
  expect(rowOf(host, "bravo").contains(document.activeElement)).toBe(true);
});

test("a press on the dimmed stream closes the card; a press inside the card does not", async () => {
  const host = await mount(two().source);
  await open(host, "alpha");
  await act(async () => { dialog().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  expect(dialogs()).toHaveLength(1);
  const dim = document.querySelector<HTMLElement>("[data-desktop-card-dim]")!;
  await closeAndSettle(() => { dim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  expect(dialogs()).toEqual([]);
  expect(rowOf(host, "alpha").contains(document.activeElement)).toBe(true);
});

test("Tab stays inside the open card, wrapping at both ends", async () => {
  const host = await mount(two().source);
  await open(host, "alpha");
  const stops = [...dialog().querySelectorAll<HTMLElement>("button, a[href], input, textarea, select")].filter((node) => !node.closest("[inert],[hidden]"));
  expect(stops.length).toBeGreaterThan(2);
  stops.at(-1)!.focus();
  await act(async () => { press(stops.at(-1)!, "Tab"); });
  expect(document.activeElement).toBe(stops[0]!);
  await act(async () => { press(stops[0]!, "Tab", { shiftKey: true }); });
  expect(document.activeElement).toBe(stops.at(-1)!);
  // Focus pushed to the stream behind (it is inert, but a script or a click on a sidebar can still try) comes back.
  await act(async () => { rowButton(rowOf(host, "bravo")).focus(); });
  expect(dialog().contains(document.activeElement)).toBe(true);
});

test("an answer started in the card hides it, shows the pill outside the inert stream, and is sent once when the count ends", async () => {
  const feed = two();
  const host = await mount(feed.source);
  await open(host, "alpha");
  const proceed = [...dialog().querySelectorAll<HTMLButtonElement>("fieldset button[aria-pressed]")].find((node) => node.textContent?.includes("Proceed"))!;
  await act(async () => proceed.click());
  expect(dialogs()).toEqual([]);
  expect(streamInert(host)).toBe(false);
  const undo = undoButtons();
  expect(undo).toHaveLength(1);
  expect(undo[0]!.closest("[inert], [hidden], [aria-hidden='true']")).toBeNull();
  expect(feed.writes).toEqual([]);
  await clock!.advance(5100);
  expect(feed.writes).toHaveLength(1);
  expect(feed.writes[0]).toMatchObject({ cardId: "alpha", choiceId: "proceed", kind: "answer" });
  await clock!.advance(10_000);
  expect(feed.writes).toHaveLength(1);
  expect(dialogs()).toEqual([]);
});

test("Undo brings the card back in the dialog with focus on the X and nothing is sent", async () => {
  const feed = two();
  const host = await mount(feed.source);
  await open(host, "alpha");
  const hold = [...dialog().querySelectorAll<HTMLButtonElement>("fieldset button[aria-pressed]")].find((node) => node.textContent?.includes("Hold"))!;
  await act(async () => hold.click());
  await act(async () => undoButtons()[0]!.click());
  await clock!.advance(50);
  expect(dialogs()).toHaveLength(1);
  expect(document.activeElement).toBe(closeButton());
  expect(streamInert(host)).toBe(true);
  await clock!.advance(10_000);
  expect(feed.writes).toEqual([]);
});

test("opening another card while an answer counts down does not drop the answer", async () => {
  const feed = two();
  const host = await mount(feed.source);
  await open(host, "alpha");
  const proceed = [...dialog().querySelectorAll<HTMLButtonElement>("fieldset button[aria-pressed]")].find((node) => node.textContent?.includes("Proceed"))!;
  await act(async () => proceed.click());
  await open(host, "bravo");
  expect(dialogs()).toHaveLength(1);
  expect(dialog().textContent).toContain("Rotate the keys?");
  await clock!.advance(5100);
  expect(feed.writes).toHaveLength(1);
  expect(feed.writes[0]).toMatchObject({ cardId: "alpha", choiceId: "proceed" });
});

test("a phone-width screen still opens the card in its row, with no dialog", async () => {
  const host = await mount(two().source, 390);
  await open(host, "alpha");
  expect(dialogs()).toEqual([]);
  expect(streamInert(host)).toBe(false);
  expect(rowOf(host, "alpha").textContent).toContain("Ship the node update?");
  expect(rowOf(host, "alpha").querySelector("fieldset")).not.toBeNull();
});
