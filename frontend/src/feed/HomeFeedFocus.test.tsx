import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";

/**
 * Opening and folding a card in the list keeps the keyboard where the owner is: the row's button is replaced by the
 * open card when it opens, and its Show less by the row when it folds, so focus follows to the control that took
 * its place. Escape folds an open card, except while typing.
 */
function entry(cardId: string, title: string): HomeFeedEntry {
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Avery",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: {
        cardId, revision: 1, issuanceId: `issuance-${cardId}`, kind: "ask", needsResponse: true, title, body: "", urgency: 1,
        createdAt: "2026-10-28T12:00:00Z",
        choices: [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }],
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

async function mount(cards: HomeFeedEntry[]): Promise<HTMLElement> {
  restore ??= installDom();
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = window.matchMedia.bind(window);
  window.innerWidth = 800; // a card opens in its row here (phone width); lifted over the stream it has its own focus
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = QuietObserver;
  MotionGlobalConfig.skipAnimations = true;
  const feed: HomeFeedSource = {
    load: async () => structuredClone({ entries: cards, settings: { defaultSelector: "needs-action" } }),
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
  await act(async () => {});
  return host;
}
const item = (host: HTMLElement, cardId: string) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].find((row) => row.dataset.cardKey?.includes(cardId))!;
const rowButton = (host: HTMLElement, cardId: string) => item(host, cardId).querySelector<HTMLButtonElement>("button[data-card-row]")!;
const showLess = (host: HTMLElement, cardId: string) => item(host, cardId).querySelector<HTMLButtonElement>('button[aria-label="Show less"]')!;
async function press(target: Element, key: string) {
  await act(async () => { target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await act(async () => {});
}

test("opening a row moves focus to the open card's Show less, where the row's own button was", async () => {
  const host = await mount([entry("one", "Ship the update?"), entry("two", "Book the flight?")]);
  await act(async () => rowButton(host, "one").click());
  await act(async () => {});
  expect(showLess(host, "one")).not.toBeNull();
  expect(document.activeElement).toBe(showLess(host, "one"));
});

test("Show less folds the card and puts focus on its row", async () => {
  const host = await mount([entry("one", "Ship the update?"), entry("two", "Book the flight?")]);
  await act(async () => rowButton(host, "one").click());
  await act(async () => showLess(host, "one").click());
  await act(async () => {});
  expect(rowButton(host, "one").getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(rowButton(host, "one"));
});

test("Escape inside an open card folds it and puts focus on its row; another card stays as it was", async () => {
  const host = await mount([entry("one", "Ship the update?"), entry("two", "Book the flight?")]);
  await act(async () => rowButton(host, "one").click());
  await act(async () => {});
  expect(showLess(host, "one")).not.toBeNull();
  await press(document.activeElement!, "Escape");
  expect(showLess(host, "one")).toBeNull();
  expect(document.activeElement).toBe(rowButton(host, "one"));
  expect(showLess(host, "two")).toBeNull();
});

test("Escape on a folded row, or outside any card, changes nothing", async () => {
  const host = await mount([entry("one", "Ship the update?")]);
  const row = rowButton(host, "one");
  row.focus();
  await press(row, "Escape");
  expect(document.activeElement).toBe(row);
  expect(showLess(host, "one")).toBeNull();
  await press(host.querySelector("main")!, "Escape");
  expect(showLess(host, "one")).toBeNull();
});

test("Escape while typing in a card's own field leaves the card open", async () => {
  const host = await mount([entry("one", "Ship the update?")]);
  await act(async () => rowButton(host, "one").click());
  const own = [...item(host, "one").querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((button) => button.textContent?.includes("Your own answer"));
  await act(async () => own!.click());
  const field = item(host, "one").querySelector<HTMLElement>('textarea[aria-label="Your own answer"]');
  expect(field).not.toBeNull();
  field!.focus();
  await press(field!, "Escape");
  expect(showLess(host, "one")).not.toBeNull();
  expect(document.activeElement).toBe(field);
});

test("a folded row says which element it opens into, and the open card is that element", async () => {
  const host = await mount([entry("one", "Ship the update?")]);
  const controls = rowButton(host, "one").getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  expect(document.getElementById(controls!)).toBeNull();
  await act(async () => rowButton(host, "one").click());
  await act(async () => {});
  const opened = document.getElementById(controls!);
  expect(opened).not.toBeNull();
  expect(opened!.contains(showLess(host, "one"))).toBe(true);
});
