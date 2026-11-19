import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { FeedResponse, HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";
import { ownerActionText, type OwnerAction } from "./ownerActions";
import { syntheticRecord } from "./sitrep.fixtures";

/**
 * An update's Acknowledge, its foot, "Acknowledge all" at the Updates heading, and its history on its face (feed-match
 * slice 6). Updates are typed ship cards and plain information cards.
 */
const WENT_LIVE_AT = "2026-11-16T15:15:00.000Z";
const POSTED_AT = "2026-11-16T15:30:00.000Z";

function update(cardId: string, title: string, over: { typed?: boolean; seenAt?: string } = {}): HomeFeedEntry {
  const typed = over.typed ?? true;
  const payload = typed ? { sitrep: { version: 1, record: { ...syntheticRecord("ship"), id: cardId, title, at: WENT_LIVE_AT } } } : undefined;
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Avery",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: { cardId, revision: 1, issuanceId: `issuance-${cardId}-1`, kind: typed ? "ship" : "info", needsResponse: false, title, body: "Rolled out to every node.", urgency: 1, createdAt: POSTED_AT, ...(payload ? { payload } : {}) },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: `issuance-${cardId}-1`, ...(over.seenAt ? { seenAt: over.seenAt } : {}) },
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

/** An in-memory feed whose owner actions are recorded, can fail per card, and close the card they name once saved. */
function store(entries: HomeFeedEntry[]) {
  const stored = structuredClone(entries);
  const writes: { cardId: string; type: string }[] = [];
  const failing = new Set<string>();
  let started = 0;
  const source: HomeFeedSource = {
    load: async () => structuredClone({ entries: stored, historicalEntries: [], settings: { defaultSelector: "both" as const } }),
    async sendMessage() { throw new Error("not used"); },
    async saveResponse() { throw new Error("not used"); },
    async sendOwnerAction(target, action: OwnerAction) {
      started++;
      await Promise.resolve();
      const card = target.state.card;
      if (failing.has(card.cardId)) throw new Error("offline");
      writes.push({ cardId: card.cardId, type: action.type });
      const saved = { responseId: crypto.randomUUID(), cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, kind: "message", text: ownerActionText(action),
        createdAt: new Date().toISOString(), payloadType: action.type, payloadVersion: 1, sequence: writes.length } as FeedResponse;
      const index = stored.findIndex((candidate) => candidate.state.card.cardId === card.cardId);
      stored[index] = { ...stored[index]!, responses: [...(stored[index]!.responses ?? []), saved] };
      return saved;
    },
    async markSeen() {}, async snooze() {}, async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
  return { source, writes, failing, get started() { return started; } };
}

async function mount(source: HomeFeedSource): Promise<HTMLElement> {
  restore ??= installDom();
  setSystemTime(new Date("2026-11-19T00:00:00.000Z"));
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  window.innerWidth = 800; // these tests open a card in its row (phone width)
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
const openCard = async (host: HTMLElement, cardId: string) => { await act(async () => rowButton(rowOf(host, cardId)).click()); };
const buttonIn = (scope: ParentNode, text: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim().replace(/\+\d+$/, "") === text);
const undoButtons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.textContent === "Undo");
const pillText = (host: HTMLElement) => undoButtons(host)[0]?.parentElement?.textContent ?? null;
const updatesSection = (host: HTMLElement) => host.querySelector<HTMLElement>('section[aria-label="Updates"]')!;
const acknowledgeAll = (host: HTMLElement) => buttonIn(updatesSection(host), "Acknowledge all");
const visible = (host: HTMLElement, cardId: string) => { const row = rowOf(host, cardId); return !!row && !row.hasAttribute("hidden"); };

for (const typed of [true, false]) {
  const kind = typed ? "a typed ship update" : "a plain information update";

  test(`${kind}: Acknowledge goes through the pill, sends once after 5 s, and Undo sends nothing`, async () => {
    const feed = store([update("ship-one", "Release one", { typed }), update("ship-two", "Release two", { typed })]);
    const host = await mount(feed.source);
    await openCard(host, "ship-one");
    await act(async () => buttonIn(rowOf(host, "ship-one"), "Acknowledge")!.click());
    expect(pillText(host)).toBe("Acknowledged·Undo·5");
    expect(visible(host, "ship-one")).toBe(false);
    await clock!.advance(4000);
    expect(feed.started).toBe(0);
    // Undo brings it back and nothing is ever written.
    await act(async () => undoButtons(host)[0]!.click());
    await clock!.advance(10_000);
    expect(feed.writes).toEqual([]);
    expect(visible(host, "ship-one")).toBe(true);
    // Again, left to count: one write, once.
    await act(async () => buttonIn(rowOf(host, "ship-one"), "Acknowledge")!.click());
    await clock!.advance(5000);
    await clock!.advance(10_000);
    expect(feed.writes).toEqual([{ cardId: "ship-one", type: "feed.acknowledge" }]);
  });

  test(`${kind}: the foot is Acknowledge, then Show me later, Comment and Details on one line, and Comment opens the box`, async () => {
    const feed = store([update("ship-one", "Release one", { typed })]);
    const host = await mount(feed.source);
    await openCard(host, "ship-one");
    const foot = rowOf(host, "ship-one").querySelector<HTMLElement>('[aria-label="Card actions"]')!;
    const lines = [...foot.children].map((line) => [...line.querySelectorAll("button")].map((node) => node.textContent?.replace(/\+\d+$/, "")));
    expect(lines).toEqual([["Acknowledge"], ["Show me later", "Comment", "Details"]]);
    expect(rowOf(host, "ship-one").querySelector("textarea")).toBeNull();
    await act(async () => buttonIn(foot, "Comment")!.click());
    expect(rowOf(host, "ship-one").querySelector("textarea")).not.toBeNull();
  });
}

test("an update's face shows the ship record and one rail of the record's steps and the owner's, oldest first, in UTC; Details no longer holds them", async () => {
  const feed = store([update("ship-one", "Release one", { seenAt: "2026-11-16T15:45:00.000Z" })]);
  const host = await mount(feed.source);
  await openCard(host, "ship-one");
  const row = rowOf(host, "ship-one");
  expect(row.querySelector('section[aria-label="Ship record"]')?.textContent).toContain("Rolled out to every node.");
  const steps = [...row.querySelectorAll('section[aria-label="Card history"] li')].map((item) => item.textContent);
  expect(steps).toEqual([
    "Went live16 Nov, 15:15 UTC",
    "Posted to the board16 Nov, 15:30 UTC",
    "You opened it16 Nov, 15:45 UTC",
  ]);
  expect(row.querySelector('section[aria-label="Card history"] li[aria-current="step"]')?.textContent).toContain("You opened it");
  await act(async () => buttonIn(row, "Details")!.click());
  const details = row.querySelector('[aria-label="Details"]')!;
  expect(details.querySelector('section[aria-label="Ship record"]')).toBeNull();
  expect(details.querySelector('section[aria-label="Card history"]')).toBeNull();
});

test("a question keeps its history under Details, not on its face", async () => {
  const entry = update("ask-one", "Which one?", { typed: false });
  entry.state.card = { ...entry.state.card, kind: "ask", needsResponse: true, choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
  const host = await mount(store([entry]).source);
  await openCard(host, "ask-one");
  const row = rowOf(host, "ask-one");
  expect(row.querySelector('section[aria-label="Card history"]')).toBeNull();
  await act(async () => buttonIn(row, "Details")!.click());
  expect(row.querySelector('[aria-label="Details"] section[aria-label="Card history"]')).not.toBeNull();
});

test("Acknowledge all sits at the right of the Updates heading with the count kept, and counts only cards whose own Acknowledge is allowed", async () => {
  const question = update("ask-one", "Which one?", { typed: false });
  question.state.card = { ...question.state.card, kind: "ask", needsResponse: true, choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
  const feed = store([update("ship-one", "Release one"), update("ship-two", "Release two"), update("note-one", "A note", { typed: false }), question]);
  const host = await mount(feed.source);
  const heading = updatesSection(host).querySelector("h2")!;
  expect(heading.textContent).toBe("Updates3");
  expect(acknowledgeAll(host)!.getAttribute("aria-label")).toBe("Acknowledge all 3 updates");
  expect(heading.previousElementSibling?.contains(acknowledgeAll(host)!)).toBe(true);
});

test("Acknowledge all takes every update at once under one pill; one write per card once the 5 s pass; none lost if the page closes first", async () => {
  const feed = store([update("ship-one", "Release one"), update("ship-two", "Release two"), update("note-one", "A note", { typed: false })]);
  const host = await mount(feed.source);
  await act(async () => acknowledgeAll(host)!.click());
  expect(pillText(host)).toBe("3 acknowledged·Undo·5");
  expect(undoButtons(host)).toHaveLength(1);
  for (const id of ["ship-one", "ship-two", "note-one"]) expect(visible(host, id)).toBe(false);
  expect(feed.started).toBe(0);
  // The page goes away mid-count: every card's write starts now, not one after another.
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  expect(feed.started).toBe(3);
  await act(async () => {});
  expect(feed.writes.map((write) => write.cardId).sort()).toEqual(["note-one", "ship-one", "ship-two"]);
  await clock!.advance(10_000);
  expect(feed.writes).toHaveLength(3);
  expect(feed.writes.every((write) => write.type === "feed.acknowledge")).toBe(true);
});

test("Acknowledge all: Undo brings every card back and nothing is written", async () => {
  const feed = store([update("ship-one", "Release one"), update("ship-two", "Release two")]);
  const host = await mount(feed.source);
  await act(async () => acknowledgeAll(host)!.click());
  expect(pillText(host)).toBe("2 acknowledged·Undo·5");
  await clock!.advance(2000);
  await act(async () => undoButtons(host)[0]!.click());
  for (const id of ["ship-one", "ship-two"]) expect(visible(host, id)).toBe(true);
  await clock!.advance(10_000);
  expect(feed.started).toBe(0);
  expect(acknowledgeAll(host)).toBeDefined();
});

test("Acknowledge all: a card whose write failed comes back with the sentence that it didn't reach the agent; the others stay acknowledged", async () => {
  const feed = store([update("ship-one", "Release one"), update("ship-two", "Release two"), update("ship-three", "Release three")]);
  feed.failing.add("ship-two");
  const host = await mount(feed.source);
  await act(async () => acknowledgeAll(host)!.click());
  await clock!.advance(5000);
  await act(async () => {});
  expect(feed.writes.map((write) => write.cardId).sort()).toEqual(["ship-one", "ship-three"]);
  expect(visible(host, "ship-two")).toBe(true);
  expect(host.textContent).toContain("That didn't reach the agent.");
  expect(rowOf(host, "ship-one")?.closest('section[aria-label="Updates"]')).toBeNull();
});

test("no Acknowledge all when there is no update to acknowledge", async () => {
  const question = update("ask-one", "Which one?", { typed: false });
  question.state.card = { ...question.state.card, kind: "ask", needsResponse: true, choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
  const host = await mount(store([question]).source);
  expect(host.textContent).not.toContain("Acknowledge all");
});
