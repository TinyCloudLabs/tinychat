import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { HomeFeedEntries } from "./HomeFeedEntries";
import { COURIER_OUTPUT_DATABASE, COURIER_SOURCE_ID } from "./feedData";
import type { FeedResponse, HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

/**
 * Answering a card: one tap on an option takes the card out of sight at once, a black pill at the top
 * counts down with Undo, the answer is sent when the count ends, and the answered card then sits in Pending. One wait
 * at a time: starting another sends the first at once.
 */
function entry(cardId: string, title: string, over: { label?: string; summary?: string; needs?: boolean; choices?: number; typed?: boolean; courier?: { verified: boolean }; revision?: number } = {}): HomeFeedEntry {
  const needs = over.needs ?? true;
  const revision = over.revision ?? 1;
  const choices = [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }, { id: "later", label: "Later" }].slice(0, over.choices ?? 2);
  const payload: Record<string, unknown> = {
    ...(over.typed ? { sitrep: { version: 1, record: syntheticRecord("ask") } } : {}),
    ...(over.summary ? { summary: over.summary } : {}),
    ...(over.courier ? { type: "answer", channel: "courier", source: { label: "Mira · Northwind team" } } : {}),
  };
  const verified = over.courier?.verified;
  return {
    source: {
      sourceId: verified ? COURIER_SOURCE_ID : "agent-one", agentDid: "did:key:isolated-test-agent", label: over.label ?? "Avery",
      output: { spaceId: "test-space", database: verified ? COURIER_OUTPUT_DATABASE : "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: {
        cardId, revision, issuanceId: `issuance-${cardId}-${revision}`, kind: needs ? "ask" : "info", needsResponse: needs, title, body: "", urgency: 1,
        createdAt: "2026-10-28T12:00:00Z",
        ...(needs && !over.typed && choices.length ? { choices } : {}),
        ...(Object.keys(payload).length ? { payload } : {}),
      },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: verified ? COURIER_SOURCE_ID : "agent-one", cardId, revision, issuanceId: `issuance-${cardId}-${revision}` },
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

/** An in-memory feed: every write is recorded, can be held open, or can fail; a new issuance can arrive. */
function store(entries: HomeFeedEntry[], defaultSelector: "needs-action" | "both" = "needs-action") {
  const stored = structuredClone(entries);
  const writes: FeedResponse[] = [];
  const held = new Map<string, PromiseWithResolvers<void>>();
  const failing = new Set<string>();
  const listeners = new Set<() => void>();
  const find = (cardId: string) => stored.findIndex((candidate) => candidate.state.card.cardId === cardId);
  const history: HomeFeedEntry[] = [];
  const source: HomeFeedSource = {
    load: async () => structuredClone({ entries: stored, historicalEntries: history, settings: { defaultSelector } }),
    async saveResponse(target, response) {
      await held.get(target.state.card.cardId)?.promise;
      if (failing.has(target.state.card.cardId)) throw new Error("offline");
      const saved = { ...response, sequence: writes.length + 1 } as FeedResponse;
      writes.push(saved);
      stored[find(target.state.card.cardId)]!.state.response = saved;
      return saved;
    },
    async markSeen() {}, async snooze() {}, async setDefaultSelector() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    source, writes, held, failing,
    /** The agent sends the card again: a new revision and issuance. */
    reissue(cardId: string) {
      const index = find(cardId);
      stored[index] = entry(cardId, stored[index]!.state.card.title, { revision: stored[index]!.state.card.revision + 1, label: stored[index]!.source.label });
      for (const listener of listeners) listener();
    },
    /** The agent replies the feed-skill way: revision+1 of the card with the reply appended, nothing else changed. */
    reply(cardId: string, text: string) {
      const index = find(cardId);
      const current = stored[index]!;
      const revision = current.state.card.revision + 1;
      history.push(current);
      stored[index] = { ...structuredClone(current), responses: [],
        state: { card: { ...structuredClone(current.state.card), revision, issuanceId: `issuance-${cardId}-${revision}`, payload: { ...current.state.card.payload, render: "thread", replies: [{ text }] } }, response: null, acknowledgement: null, outcome: null },
        view: { sourceId: current.source.sourceId, cardId, revision, issuanceId: `issuance-${cardId}-${revision}` } };
      for (const listener of listeners) listener();
    },
  };
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

const rowOf = (host: HTMLElement, cardId: string) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].find((row) => row.dataset.cardKey?.includes(cardId))!;
const rowsOf = (host: HTMLElement, cardId: string) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter((row) => row.dataset.cardKey?.includes(cardId));
const pendingList = (host: HTMLElement) => host.querySelector('section[aria-label="Pending"]');
const inPending = (host: HTMLElement, cardId: string) => !!pendingList(host)?.querySelector(`li[data-card-key*="${cardId}"]`);
/** The row's own button: the first with aria-expanded inside the item. */
const rowButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
async function openCard(host: HTMLElement, cardId: string) {
  await act(async () => rowButton(rowOf(host, cardId)).click());
}
/** A card's options: the buttons of the fieldset "Choose an option". */
function option(row: HTMLElement, label: string) {
  const fieldset = [...row.querySelectorAll("fieldset")].find((node) => node.querySelector("legend")?.textContent === "Choose an option");
  const node = [...(fieldset?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? [])].find((candidate) => candidate.textContent?.includes(label));
  expect(node).toBeDefined();
  return node!;
}
async function answer(host: HTMLElement, cardId: string, label: string) {
  await openCard(host, cardId);
  await act(async () => option(rowOf(host, cardId), label).click());
}
const undoButtons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.textContent === "Undo" && reachable(node));
/** The text of the one pill at the top: its words, Undo and the seconds left. */
const pillText = (host: HTMLElement) => undoButtons(host)[0]?.parentElement?.textContent ?? null;
const lines = (host: HTMLElement) => [...host.querySelectorAll('.sticky.h-0 [class*="rounded-full"]')].map((node) => node.textContent);
const announcement = (host: HTMLElement) => host.querySelector('div.sr-only[role="status"]')?.textContent ?? "";
const needing = (host: HTMLElement) => host.textContent?.match(/(\d+) needs? you\./)?.[1];
/** Whether a screen reader can reach it: no ancestor hides it or makes it inert. */
const reachable = (node: Element) => !node.closest("[hidden], [inert], [aria-hidden='true']");
const focusables = (root: Element) => [...root.querySelectorAll('button, a[href], input, textarea, select, [tabindex]')].filter(reachable);

test("tapping an option takes the card out of sight at once: hidden, inert, nothing focusable, not in the accessibility tree", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  const row = rowOf(host, "alpha");
  expect(row.hasAttribute("hidden")).toBe(true);
  expect(row.className).not.toMatch(/(^|\s)(block|flex|grid|inline|inline-flex|contents)(\s|$)/);
  const wrapper = row.querySelector<HTMLElement>("div[hidden][inert]")!;
  expect(wrapper).not.toBeNull();
  expect(wrapper.className).toBe("");
  expect(wrapper.querySelectorAll("button").length).toBeGreaterThan(0);
  expect(focusables(row)).toEqual([]);
  expect([...row.querySelectorAll("h2, article")].some(reachable)).toBe(false);
  expect(feed.writes).toEqual([]);
});

test("the Needs you count drops when an option is tapped and comes back on Undo", async () => {
  const feed = store([entry("alpha", "First?", { summary: "First post" }), entry("bravo", "Second?", { summary: "Second post" })]);
  const host = await mount(feed.source);
  expect(needing(host)).toBe("2");
  await answer(host, "alpha", "Proceed");
  expect(needing(host)).toBe("1");
  await act(async () => undoButtons(host)[0]!.click());
  expect(needing(host)).toBe("2");
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(false);
});

test("Undo brings the same card back open, with its options, and nothing is ever sent", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  await clock!.advance(2000);
  expect(pillText(host)).toBe("Proceed·Undo·3");
  await act(async () => undoButtons(host)[0]!.click());
  expect(undoButtons(host)).toEqual([]);
  expect(option(rowOf(host, "alpha"), "Hold")).toBeDefined();
  expect(announcement(host)).toContain("Undone. Nothing was sent.");
  await clock!.advance(10_000);
  expect(feed.writes).toEqual([]);
  expect(rowsOf(host, "alpha")).toHaveLength(1);
});

test("the pill says what was answered and counts down; a screen reader hears it, with Undo's window", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  expect(pillText(host)).toBe("Proceed·Undo·5");
  expect(announcement(host)).toContain("Sending Proceed in 5 seconds. Undo is available until then.");
  await clock!.advance(1000);
  expect(pillText(host)).toBe("Proceed·Undo·4");
});

test("the pill takes focus when it appears, since its card is gone, and Escape undoes the wait", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  expect(document.activeElement).toBe(undoButtons(host)[0]!);
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(undoButtons(host)).toEqual([]);
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(false);
  await clock!.advance(10_000);
  expect(feed.writes).toEqual([]);
});

test("the answer is written once, when the count ends, and then the card is in Pending waiting on its agent", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  await clock!.advance(4900);
  expect(feed.writes).toEqual([]);
  await clock!.advance(200);
  expect(feed.writes).toHaveLength(1);
  expect(feed.writes[0]).toMatchObject({ cardId: "alpha", choiceId: "proceed", kind: "answer" });
  await clock!.advance(10_000);
  expect(feed.writes).toHaveLength(1);
  expect(inPending(host, "alpha")).toBe(true);
  const row = pendingList(host)!.querySelector("li")!;
  expect(row.textContent).toContain("You chose Proceed");
  expect(row.textContent).toContain("Ship it?");
  expect(row.textContent).toContain("Waiting on Avery");
  expect(rowsOf(host, "alpha")).toHaveLength(1);
});

test("Sent to appears only after the held write lands, and goes after a moment", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  feed.held.set("alpha", Promise.withResolvers<void>());
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  await clock!.advance(5000);
  expect(feed.writes).toEqual([]);
  expect(pillText(host)).toBeNull();
  expect(lines(host).join("|")).toContain("Sending…");
  expect(host.textContent).not.toContain("Sent to");
  expect(announcement(host)).not.toContain("Sent to");
  await act(async () => feed.held.get("alpha")!.resolve());
  expect(feed.writes).toHaveLength(1);
  expect(lines(host).join("|")).toContain("Sent to Avery");
  expect(announcement(host)).toContain("Sent to Avery.");
  await clock!.advance(3000);
  expect(host.textContent).not.toContain("Sent to Avery");
});

test("a write that fails brings the card back with the failure line, and says nothing was sent", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  feed.failing.add("alpha");
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  await clock!.advance(5000);
  expect(feed.writes).toEqual([]);
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(false);
  expect(rowOf(host, "alpha").textContent).toContain("Your answer wasn't saved. Try again.");
  expect(host.textContent).not.toContain("Sent to");
  expect(inPending(host, "alpha")).toBe(false);
});

test("one wait at a time: a second answer sends the first at once, and its pill says where it went", async () => {
  const feed = store([entry("alpha", "First?", { summary: "First post", label: "Avery" }), entry("bravo", "Second?", { summary: "Second post", label: "Mira" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  expect(undoButtons(host)).toHaveLength(1);
  await clock!.advance(2000);
  await answer(host, "bravo", "Hold");
  expect(feed.writes).toHaveLength(1);
  expect(feed.writes[0]).toMatchObject({ cardId: "alpha", choiceId: "proceed" });
  expect(undoButtons(host)).toHaveLength(1);
  expect(pillText(host)).toBe("Hold·Undo·5");
  expect(lines(host).join("|")).toContain("Sent to Avery");
  expect(feed.writes.filter((write) => write.cardId === "alpha")).toHaveLength(1);
  await clock!.advance(5000);
  expect(feed.writes).toHaveLength(2);
  expect(feed.writes[1]).toMatchObject({ cardId: "bravo", choiceId: "hold" });
  expect(inPending(host, "alpha")).toBe(true);
  expect(inPending(host, "bravo")).toBe(true);
  const texts = [...pendingList(host)!.querySelectorAll("li")].map((row) => row.textContent);
  expect(texts.join("|")).toContain("You chose Proceed");
  expect(texts.join("|")).toContain("Waiting on Mira");
});

test("leaving the page mid-wait sends the held answer once", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  await clock!.advance(1000);
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  expect(feed.writes).toHaveLength(1);
  await clock!.advance(10_000);
  expect(feed.writes).toHaveLength(1);
  expect(host.textContent).toBeDefined();
});

test("a newer version arriving while the hidden card counts: nothing is written, and the card shows what happened", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  await act(async () => feed.reissue("alpha"));
  // Same item, same place, still out of sight while it counts.
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(true);
  expect(inPending(host, "alpha")).toBe(false);
  await clock!.advance(5000);
  expect(feed.writes).toEqual([]);
  await clock!.advance(10_000);
  expect(feed.writes).toEqual([]);
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(false);
  expect(rowOf(host, "alpha").textContent).toMatch(/newer version|not sent|Not sent/i);
});

test("an answered card leaves All for Pending; it does not also stay in the list", async () => {
  const feed = store([entry("alpha", "First?", { summary: "First post" }), entry("bravo", "Second?", { summary: "Second post" })], "both");
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  await clock!.advance(5000);
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  expect(inPending(host, "alpha")).toBe(true);
  expect(rowsOf(host, "bravo")).toHaveLength(1);
  expect(inPending(host, "bravo")).toBe(false);
});

test("Pending is not on the page until a card is in it", async () => {
  const feed = store([entry("alpha", "First?", { summary: "First post" })]);
  const host = await mount(feed.source);
  expect(pendingList(host)).toBeNull();
  await answer(host, "alpha", "Proceed");
  expect(pendingList(host)).toBeNull();
  await clock!.advance(5000);
  expect(pendingList(host)).not.toBeNull();
});

test("a Pending row opens its card with Change answer; changing the answer hides that same card in place and Undo reopens it, with no second card", async () => {
  const feed = store([entry("alpha", "First?", { summary: "First post" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  await clock!.advance(5000);
  await act(async () => pendingList(host)!.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
  const change = [...rowOf(host, "alpha").querySelectorAll("button")].find((node) => node.textContent === "Change answer")!;
  expect(change).toBeDefined();
  await act(async () => change.click());
  await act(async () => option(rowOf(host, "alpha"), "Hold").click());
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(true);
  expect(host.querySelectorAll("article")).toHaveLength(1);
  expect(pillText(host)).toBe("Hold·Undo·5");
  await act(async () => undoButtons(host)[0]!.click());
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(false);
  expect(feed.writes).toHaveLength(1);
});

test("while a card counts there is never a second copy of it in the page", async () => {
  const feed = store([entry("alpha", "First?", { summary: "First post" })], "both");
  const host = await mount(feed.source);
  await answer(host, "alpha", "Proceed");
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  expect(host.querySelectorAll("article")).toHaveLength(1);
  expect(pendingList(host)).toBeNull();
});

test("the agent named after a send is the verified one the row uses: a card that only says Courier is not given the sender", async () => {
  const feed = store([entry("spoof", "Book the flight?", { summary: "Book the Thursday train?", label: "Courier", courier: { verified: false } }), entry("real", "Pay the invoice?", { summary: "Pay it?", label: "Relay agent", courier: { verified: true } })]);
  const host = await mount(feed.source);
  await answer(host, "spoof", "Proceed");
  await clock!.advance(5000);
  expect(lines(host).join("|")).toContain("Sent to Courier");
  expect(host.textContent).not.toContain("Sent to Mira");
  const row = pendingList(host)!.querySelector("li")!;
  expect(row.textContent).toContain("Waiting on Courier");
  expect(row.textContent).not.toContain("Mira");
  await answer(host, "real", "Proceed");
  await clock!.advance(5000);
  // The answer goes to the agent that relayed the message, the same name the row gives; the sender is not who is waiting.
  expect(pendingList(host)!.textContent).toContain("Waiting on Relay agent");
  expect(pendingList(host)!.textContent).not.toContain("Waiting on Mira");
});

test("Drop, Acknowledge and Ask me later wait in the same pill, with their own words and no Sent to", async () => {
  const feed = store([entry("alpha", "Drop me?", { summary: "Drop post" }), entry("note", "An update", { summary: "Update post", needs: false })], "both");
  const host = await mount(feed.source);
  await openCard(host, "alpha");
  const dropButton = [...rowOf(host, "alpha").querySelectorAll("button")].find((node) => node.textContent?.trim() === "Drop this card")!;
  await act(async () => dropButton.click());
  expect(pillText(host)).toBe("Dropped·Undo·5");
  expect(announcement(host)).toContain("Dropping this card in 5 seconds. Undo is available until then.");
  await act(async () => undoButtons(host)[0]!.click());
  expect(announcement(host)).toContain("Undone. Nothing was sent.");
  await openCard(host, "note");
  const acknowledge = [...rowOf(host, "note").querySelectorAll("button")].find((node) => node.textContent?.trim() === "Acknowledge")!;
  await act(async () => acknowledge.click());
  expect(pillText(host)).toBe("Acknowledged·Undo·5");
  expect(announcement(host)).toContain("Acknowledging this card in 5 seconds. Undo is available until then.");
  await clock!.advance(6000);
  expect(host.textContent).not.toContain("Sent to");
});

test("Ask me later waits in the pill with the time it comes back, and sends nothing", async () => {
  const feed = store([entry("alpha", "Later?", { summary: "Later post" })]);
  const host = await mount(feed.source);
  await openCard(host, "alpha");
  await act(async () => [...rowOf(host, "alpha").querySelectorAll("button")].find((node) => node.textContent?.trim() === "Ask me later")!.click());
  const preset = [...rowOf(host, "alpha").querySelectorAll<HTMLButtonElement>("section[aria-label='Ask me later'] button, button")].find((node) => /^(In an hour|This evening|Tomorrow)/.test(node.textContent ?? ""));
  expect(preset).toBeDefined();
  await act(async () => preset!.click());
  expect(pillText(host)).toMatch(/^Back at .+·Undo·5$/);
  expect(announcement(host)).toMatch(/Snoozing this card until .+ in 5 seconds\. Undo is available until then\./);
  await clock!.advance(6000);
  expect(host.textContent).not.toContain("Sent to");
  expect(feed.writes).toEqual([]);
});

// "See N options": the mock's second opener of the same card.
const seeOptions = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>("button")].find((node) => /^(See \d+ options?|Hide options)/.test(node.getAttribute("aria-label") ?? ""));

test("a card that asks shows See N options, with the right count and the singular for one", async () => {
  const feed = store([entry("two", "Two?", { summary: "Two choices" }), entry("three", "Three?", { summary: "Three choices", choices: 3 }), entry("one", "One?", { summary: "One choice", choices: 1 })]);
  const host = await mount(feed.source);
  expect(seeOptions(rowOf(host, "two"))!.textContent).toBe("See 2 options");
  expect(seeOptions(rowOf(host, "three"))!.textContent).toBe("See 3 options");
  expect(seeOptions(rowOf(host, "one"))!.textContent).toBe("See 1 option");
});

test("a typed ask counts its record's options", async () => {
  const total = (syntheticRecord("ask").options as unknown[]).length;
  const feed = store([entry("typed", "Typed?", { typed: true })]);
  const host = await mount(feed.source);
  expect(seeOptions(rowOf(host, "typed"))!.textContent).toBe(`See ${total} ${total === 1 ? "option" : "options"}`);
});

test("no See N options on a card with no options, an update, or an answered card", async () => {
  const feed = store([entry("bare", "Bare?", { summary: "No choices", choices: 0 }), entry("note", "An update", { summary: "Update", needs: false }), entry("done", "Done?", { summary: "Done post" })], "both");
  const host = await mount(feed.source);
  expect(seeOptions(rowOf(host, "bare"))).toBeUndefined();
  expect(seeOptions(rowOf(host, "note"))).toBeUndefined();
  await answer(host, "done", "Proceed");
  await clock!.advance(5000);
  expect(seeOptions(rowOf(host, "done"))).toBeUndefined();
});

test("the control's name starts with its words and names the post, cut at 80 characters, or the title when there is no post", async () => {
  const long = `${"Ship the node update now ".repeat(5)}and then the rest`;
  const feed = store([entry("long", "Long?", { summary: long }), entry("short", "Short?", { summary: "Ship it?" }), entry("notitle", "Which database should we keep?")]);
  const host = await mount(feed.source);
  const cut = `${long.replace(/\s+/g, " ").trim().slice(0, 80)}…`;
  expect(seeOptions(rowOf(host, "long"))!.getAttribute("aria-label")).toBe(`See 2 options for ${cut}`);
  expect(seeOptions(rowOf(host, "short"))!.getAttribute("aria-label")).toBe("See 2 options for Ship it?");
  expect(seeOptions(rowOf(host, "notitle"))!.getAttribute("aria-label")).toBe("See 2 options for Which database should we keep?");
  expect(seeOptions(rowOf(host, "short"))!.getAttribute("aria-label")).not.toMatch(/collapsed|expanded/i);
});

test("the control opens the same card in place, becomes Hide options, and closes it again", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  const row = rowOf(host, "alpha");
  const folded = seeOptions(row)!;
  expect(folded.getAttribute("aria-expanded")).toBe("false");
  const target = folded.getAttribute("aria-controls")!;
  await act(async () => folded.click());
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  expect(host.querySelectorAll("article")).toHaveLength(1);
  const hide = seeOptions(rowOf(host, "alpha"))!;
  expect(hide.textContent).toBe("Hide options");
  expect(hide.getAttribute("aria-label")).toBe("Hide options for Ship it?");
  expect(hide.getAttribute("aria-expanded")).toBe("true");
  expect(hide.getAttribute("aria-controls")).toBe(target);
  expect(document.getElementById(target)!.contains(option(rowOf(host, "alpha"), "Proceed"))).toBe(true);
  await act(async () => hide.click());
  expect(host.querySelectorAll("article")).toHaveLength(0);
  expect(seeOptions(rowOf(host, "alpha"))!.getAttribute("aria-expanded")).toBe("false");
});

test("opening with the control moves no focus: the first option is the next stop", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  const before = document.activeElement;
  await act(async () => seeOptions(rowOf(host, "alpha"))!.click());
  expect(document.activeElement).toBe(before);
  expect(rowOf(host, "alpha").contains(document.activeElement)).toBe(false);
});

test("an option chosen after the control opened the card goes through the one pill, once", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  await act(async () => seeOptions(rowOf(host, "alpha"))!.click());
  await act(async () => option(rowOf(host, "alpha"), "Hold").click());
  expect(undoButtons(host)).toHaveLength(1);
  expect(pillText(host)).toBe("Hold·Undo·5");
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(true);
  await clock!.advance(5000);
  expect(feed.writes).toHaveLength(1);
  expect(feed.writes[0]).toMatchObject({ cardId: "alpha", choiceId: "hold" });
});

test("a folded row's own name is unchanged by the control beside it", async () => {
  const feed = store([entry("alpha", "Ship the node update?", { summary: "Ship it?" })]);
  const host = await mount(feed.source);
  const name = rowButton(rowOf(host, "alpha")).getAttribute("aria-label")!;
  expect(name.startsWith("Avery. Ship it?")).toBe(true);
  expect(name).not.toMatch(/options/);
});

test("Give the go is a black pill, and its wait is the one pill at the top, with nothing written until it ends", async () => {
  setSystemTime(new Date(SITREP_NOW));
  const record = syntheticRecord("approval");
  const base = entry("go", String(record.title), { needs: true });
  const feed = store([{ ...base, state: { ...base.state, card: { ...base.state.card, kind: String(record.kind), choices: undefined, payload: { sitrep: { version: 1, record } } } } }]);
  const host = await mount(feed.source);
  await openCard(host, "go");
  const go = [...rowOf(host, "go").querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Give the go")!;
  expect(go.className).toMatch(/\brounded-full\b/);
  expect(go.className).toMatch(/\bbg-foreground\b/);
  await act(async () => go.click());
  expect(pillText(host)).toMatch(/·Undo·5$/);
  expect(announcement(host)).toContain("in 5 seconds. Undo is available until then.");
  expect(rowOf(host, "go").hasAttribute("hidden")).toBe(true);
  expect(feed.writes).toEqual([]);
  await clock!.advance(5000);
  expect(feed.writes).toHaveLength(1);
  // The agent the record names, the same one the card shows as its author.
  expect(lines(host).join("|")).toContain("Sent to SyntheticOfficer");
});

test("the agent replying to an answered card swaps the card in place in Pending, with no banner and no copy left in the list", async () => {
  const feed = store([entry("alpha", "First?", { summary: "First post" })], "both");
  const host = await mount(feed.source);
  await answer(host, "alpha", "Hold");
  await clock!.advance(5000);
  expect(inPending(host, "alpha")).toBe(true);
  await act(async () => feed.reply("alpha", "Noted, holding."));
  expect(host.textContent).not.toContain("A newer version of this card arrived");
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  expect(inPending(host, "alpha")).toBe(true);
  expect(feed.writes).toHaveLength(1);
});

test("an agent reply while the hidden card counts changes nothing the owner sees, and the one write goes to the newest revision", async () => {
  const feed = store([entry("alpha", "First?", { summary: "First post" })]);
  const host = await mount(feed.source);
  await answer(host, "alpha", "Hold");
  await clock!.advance(2000);
  await act(async () => feed.reply("alpha", "Noted."));
  expect(host.textContent).not.toContain("A newer version of this card arrived");
  expect(pillText(host)).toBe("Hold·Undo·3");
  expect(rowsOf(host, "alpha")).toHaveLength(1);
  expect(rowOf(host, "alpha").hasAttribute("hidden")).toBe(true);
  await clock!.advance(3000);
  expect(feed.writes).toHaveLength(1);
  expect(feed.writes[0]).toMatchObject({ cardId: "alpha", choiceId: "hold", revision: 2 });
});

/** An answer counting, then a post page opened over the feed: the feed under it goes inert, the pill does not. */
async function countingBehindPostPage() {
  const post = entry("post", "A post", { needs: false });
  post.state.card.payload = { page: { image: "https://example.org/a.png", imageAlt: "A picture", questions: [] } };
  const feed = store([entry("alpha", "First?", { summary: "First post" }), post], "both");
  const host = await mount(feed.source);
  await answer(host, "alpha", "Hold");
  await clock!.advance(2000);
  await act(async () => rowOf(host, "post").querySelector("button")!.click());
  expect(host.querySelector("main > div > div[inert]")).not.toBeNull();
  return { feed, host };
}

test("a post page opened while an answer counts leaves the pill's Undo reachable, and Undo writes nothing", async () => {
  const { feed, host } = await countingBehindPostPage();
  expect(undoButtons(host)).toHaveLength(1);
  await act(async () => undoButtons(host)[0]!.click());
  await clock!.advance(6000);
  expect(feed.writes).toEqual([]);
});

test("a post page opened while an answer counts does not send it early: left alone, the count still ends in exactly one write", async () => {
  const { feed, host } = await countingBehindPostPage();
  expect(pillText(host)).toBe("Hold·Undo·3");
  expect(feed.writes).toEqual([]);
  await clock!.advance(3000);
  expect(feed.writes).toHaveLength(1);
  expect(feed.writes[0]).toMatchObject({ cardId: "alpha", choiceId: "hold" });
});

test("a Pending row for a card with no title and no post shows only what was chosen, with no empty line under it", async () => {
  const feed = store([entry("blank", "")]);
  const host = await mount(feed.source);
  await answer(host, "blank", "Hold");
  await clock!.advance(5000);
  const column = rowOf(host, "blank").querySelector("button")!.children[1]!;
  expect(column.textContent).toBe("You chose Hold");
  expect(column.children).toHaveLength(1);
});
