// The feed's design switches (feedFlags.ts) and Hunter's always-on parts (agent marks, the agent page, answer steps),
// over the real Home feed. Only the store is substituted. Under each switch, the approved feed's guarantees still hold:
// an answer is held until its write lands, a changed card refuses its answer, a comment with no approved route is held,
// and an owner-routed comment reaches only its approved recipient.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedHandling, FeedResponse, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { FeedViewEntries } from "./FeedView";
import { DEFAULT_FEED_FLAGS, FeedFlagsContext, type FeedFlags } from "./feedFlags";
import type { HomeFeedEntry, HomeFeedMessageDraft, HomeFeedSaveOptions, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { syntheticRecord } from "./sitrep.fixtures";

const createdAt = "2026-10-28T12:00:00Z";
function decision(cardId: string, urgency = 1, extra: Partial<HomeFeedEntry["state"]["card"]> = {}): HomeFeedEntry {
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Test agent",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: { cardId, revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title: `Question ${cardId}`, body: "Choose a reversible action.", urgency, createdAt,
        choices: [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }], payload: { render: "thread" }, ...extra },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: "issuance-1" },
  };
}
function update(cardId: string): HomeFeedEntry {
  const entry = decision(cardId);
  entry.state.card = { ...entry.state.card, kind: "progress", needsResponse: false, title: `Update ${cardId}`, choices: undefined };
  return entry;
}

function persistence(entries: HomeFeedEntry[], defaultSelector: "needs-action" | "both" = "needs-action") {
  const durable: HomeFeedSnapshot = { entries: structuredClone(entries), settings: { defaultSelector } };
  const listeners = new Set<() => void>();
  const responses: FeedResponse[] = [];
  const options: (HomeFeedSaveOptions | undefined)[] = [];
  const messages: FeedResponse[] = [];
  const stored = (entry: { cardId: string; revision: number; issuanceId: string }) => durable.entries.find((candidate) => candidate.state.card.cardId === entry.cardId && candidate.state.card.revision === entry.revision && candidate.state.card.issuanceId === entry.issuanceId);
  const source: HomeFeedSource = {
    async load() { return structuredClone(durable); },
    async saveResponse(entry, response: NewFeedResponse, _payload, saveOptions) {
      const saved = { ...response, sequence: responses.length + 1 };
      responses.push(saved); options.push(saveOptions);
      const target = stored(entry.state.card);
      if (!target) throw new Error("Question revision not found");
      target.state.response = saved;
      return saved;
    },
    async sendMessage(entry, message) {
      const saved = { ...message, sequence: 1000 + messages.length };
      messages.push(saved);
      (stored(entry.state.card)!.responses ??= []).push(saved);
      return saved;
    },
    async markSeen() {},
    async snooze() {},
    async setDefaultSelector() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  /** The agent changes the card (not a reply-only revision): revision 2 replaces revision 1. */
  function edit(cardId: string, body: string) {
    const index = durable.entries.findIndex((entry) => entry.state.card.cardId === cardId);
    const current = durable.entries[index]!;
    durable.historicalEntries = [...(durable.historicalEntries ?? []), current];
    durable.entries[index] = { ...structuredClone(current), state: { card: { ...structuredClone(current.state.card), revision: 2, issuanceId: "issuance-2", body }, response: null, acknowledgement: null, outcome: null },
      view: { sourceId: current.source.sourceId, cardId, revision: 2, issuanceId: "issuance-2" } };
  }
  return { durable, responses, options, messages, source, edit, notify: () => { for (const listener of listeners) listener(); } };
}

/** A typed card with an owner, as SitrepFeed.test.tsx builds it; comments land as messages or held notes. */
function typed(route: HomeFeedEntry["recipientRoute"]) {
  const record = { ...syntheticRecord("ask"), owner: "SyntheticOwner / MissingOfficer" };
  const owner = { answers: [] as unknown[], states: [] as unknown[], claimDecisions: [] as unknown[], threads: [] as unknown[], deliveries: [] as unknown[], heldNotes: [] as { intendedRecipient: string; text: string }[] };
  const entry: HomeFeedEntry = {
    source: { sourceId: "synthetic-agent-token", agentDid: "did:key:synthetic-publisher", label: "SyntheticOfficer", output: { spaceId: "isolated-owner", database: "xyz.tinycloud.tinychat/feed/feed_output_synthetic" }, responses: { spaceId: "isolated-owner", database: "xyz.tinycloud.tinychat/feed/feed_responses_synthetic" } },
    state: { card: { cardId: "synthetic-ask", revision: 1, issuanceId: "synthetic-issuance", kind: "ask", needsResponse: true, title: String(record.title), body: String(record.body), urgency: 2, createdAt: String(record.createdAt), payload: { sitrep: { version: 1, record } } },
      response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "synthetic-agent-token", cardId: "synthetic-ask", revision: 1, issuanceId: "synthetic-issuance" },
    ...(route ? { recipientRoute: route } : {}),
  };
  const sent: { message: HomeFeedMessageDraft; payload: unknown }[] = [];
  const source: HomeFeedSource = {
    async load() { return Object.assign(structuredClone({ entries: [entry], settings: { defaultSelector: "both" } }), { sitrep: structuredClone(owner) }); },
    async saveResponse() { throw new Error("A comment never answers the card"); },
    async sendMessage(_entry, message, payload) { sent.push(structuredClone({ message, payload })); return { ...message, sequence: sent.length }; },
    async saveHeldNote(_entry, note) { owner.heldNotes.push(structuredClone(note)); },
    async markSeen() {}, async snooze() {}, async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
  return { entry, owner, sent, source, title: String(record.title) };
}

let restore: (() => void) | undefined;
let clock: FakeClock | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  clock?.restore(); clock = undefined;
  restore?.(); restore = undefined;
});
async function mount(source: HomeFeedSource, flags: Partial<FeedFlags> = {}) {
  restore ??= installDom();
  clock ??= installFakeClock();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<FeedFlagsContext.Provider value={{ ...DEFAULT_FEED_FLAGS, ...flags }}><FeedViewEntries realEntries={[]} source={source} /></FeedFlagsContext.Provider>));
  return host;
}
function button(scope: ParentNode, label: string) {
  const node = [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(node === undefined ? `no button "${label}"` : label).toBe(label);
  return node!;
}
function option(scope: ParentNode, label: string) {
  const node = [...scope.querySelectorAll('[role="group"][aria-label="Answers"] button')].find((candidate) => candidate.textContent?.includes(label));
  expect(node === undefined ? `no option "${label}"` : label).toBe(label);
  return node as HTMLButtonElement;
}
const openCard = (host: ParentNode) => host.querySelector<HTMLElement>('section[aria-label="Open card"] article');
const rowTitles = (host: ParentNode) => [...host.querySelectorAll<HTMLButtonElement>("li > button")].filter((node) => !node.closest("article")).map((node) => node.querySelector("span span")?.textContent);
function row(host: ParentNode, title: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>("li > button")].find((candidate) => !candidate.closest("article") && candidate.textContent?.includes(title));
  expect(node === undefined ? `no row "${title}"` : title).toBe(title);
  return node!;
}
const headings = (host: ParentNode) => [...host.querySelectorAll("section > h2")].map((node) => node.textContent);
async function enter(scope: ParentNode, label: string, text: string) {
  const input = scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input === null ? `no input "${label}"` : label).toBe(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function handling(response: FeedResponse, phase: FeedHandling["phase"]): FeedHandling {
  return { cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId, handlingId: `handling-${phase}`, phase, createdAt, detail: {} };
}

test("with the 4 s undo, the pill counts from 4 and the answer is written at 4 s, once", async () => {
  const store = persistence([decision("one")]);
  const host = await mount(store.source, { undoSeconds: 4 });
  await act(async () => option(host, "Hold").click());
  expect(host.querySelector('button[aria-label^="Undo"]')?.getAttribute("aria-label")).toBe("Undo, 4 seconds left");
  expect(host.textContent).toContain("Sending Hold in 4 seconds. Undo available.");
  await clock!.advance(3900);
  expect(store.responses).toEqual([]);
  await clock!.advance(100);
  expect(store.responses.map((response) => response.choiceId)).toEqual(["hold"]);
  await clock!.advance(10_000);
  expect(store.responses).toHaveLength(1);
});

test("open card: the first card that needs you is open and raised, the others are rows, and a row opens its card", async () => {
  const store = persistence([decision("two", 1), decision("one", 2), update("news")], "both");
  const host = await mount(store.source, { layout: "open-card" });
  expect(openCard(host)?.getAttribute("aria-label")).toBe("Question one");
  expect(openCard(host)?.className).toContain("shadow-float");
  expect(host.querySelectorAll("article")).toHaveLength(1);
  expect(rowTitles(host)).toEqual(["Question two", "Update news"]);
  await act(async () => row(host, "Question two").click());
  expect(openCard(host)?.getAttribute("aria-label")).toBe("Question two");
  expect(option(openCard(host)!, "Hold")).toBeDefined();
  expect(rowTitles(host)).toEqual(["Question one", "Update news"]);
});

test("open card: moving to another card mid-countdown sends the answer at once, once, held until it lands", async () => {
  const store = persistence([decision("one", 2), decision("two", 1)]);
  const host = await mount(store.source, { layout: "open-card" });
  await act(async () => option(openCard(host)!, "Hold").click());
  await clock!.advance(1000);
  expect(store.responses).toEqual([]);
  await act(async () => row(host, "Question two").click());
  expect(store.responses.map((response) => [response.cardId, response.choiceId])).toEqual([["one", "hold"]]);
  expect(store.options).toEqual([{ hold: true }]);
  await clock!.advance(10_000);
  expect(store.responses).toHaveLength(1);
});

test("open card: a card changed during the countdown refuses the answer, as the list does", async () => {
  const store = persistence([decision("one")]);
  const host = await mount(store.source, { layout: "open-card" });
  await act(async () => option(openCard(host)!, "Hold").click());
  await clock!.advance(2000);
  store.edit("one", "The flight times changed.");
  await act(async () => store.notify());
  expect(openCard(host)?.textContent).toContain("A newer version of this card arrived");
  await clock!.advance(3000);
  expect(store.responses).toEqual([]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Not sent: Hold. This card changed. Answer the newer version.");
  await act(async () => button(host, "Show the newer version").click());
  await act(async () => option(openCard(host)!, "Hold").click());
  await clock!.advance(5000);
  expect(store.responses.map((response) => `${response.revision}:${response.choiceId}`)).toEqual(["2:hold"]);
});

test("agents menu: a view menu, then Agents and Filter; All reads Needs you · N and Updates · N", async () => {
  const store = persistence([decision("one"), update("news"), update("later")], "both");
  const host = await mount(store.source, { nav: "agents" });
  expect(host.querySelector('[role="group"][aria-label="Show"]')).toBeNull();
  const menu = host.querySelector<HTMLSelectElement>('select[aria-label="Feed view"]')!;
  expect(menu.value).toBe("all");
  expect([...menu.options].map((item) => item.textContent)).toEqual(["Needs you 1", "All", "History"]);
  expect(headings(host)).toEqual(["Needs you · 1", "Updates · 2"]);
  await act(async () => { menu.value = "needs-you"; menu.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(headings(host)).toEqual(["Needs you · 1"]);
  await act(async () => button(host, "Agents").click());
  expect(host.textContent).toContain("Your agents");
  expect(host.querySelector("article")).toBeNull();
});

test("the approved menu keeps its headings: All reads Needs you N and Earlier", async () => {
  const store = persistence([decision("one"), update("news")], "both");
  const host = await mount(store.source);
  expect(host.querySelector('select[aria-label="Feed view"]')).toBeNull();
  expect(headings(host)).toEqual(["Needs you1", "Earlier"]);
});

test("an agent's page shows its cards and your answers, and opens a card even where the view leaves it out", async () => {
  const answered = decision("one", 2);
  answered.state.response = { responseId: "r-1", cardId: "one", revision: 1, issuanceId: "issuance-1", kind: "answer", choiceId: "hold", createdAt: "2026-10-28T12:05:00Z", sequence: 1 };
  answered.responses = [answered.state.response];
  const store = persistence([answered, decision("two", 1)]);
  const host = await mount(store.source);
  // Needs you leaves the answered card out.
  expect([...host.querySelectorAll("article")].map((node) => node.getAttribute("aria-label"))).toEqual(["Question two"]);
  const name = host.querySelector<HTMLButtonElement>("article button[aria-expanded]")!;
  expect(name.textContent).toBe("Test agent");
  await act(async () => name.click());
  expect(host.querySelector('section[aria-label="About Test agent"]')?.textContent).toContain("Post cards to your Home and read your answers to them");
  await act(async () => button(host, "Open conversation").click());
  const page = host.querySelector('section[aria-label="Conversation with Test agent"]')!;
  expect([...page.querySelectorAll('ol[aria-label="Everything in time order"] > li')].map((node) => node.textContent)).toEqual([
    expect.stringContaining("Question one"), expect.stringContaining("Question two"), expect.stringContaining("Chose Hold"),
  ]);
  await act(async () => button(host, "Agents").click());
  expect(row(host, "Test agent").textContent).toContain("Needs you 1");
  await act(async () => row(host, "Test agent").click());
  await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent?.includes("Question one"))!.click());
  const opened = host.querySelector<HTMLElement>('article[aria-label="Question one"]');
  expect(opened?.querySelector('[role="status"][aria-label="Your answer"]')?.textContent).toContain("You chose Hold.");
  expect(store.responses).toEqual([]);
});

test("an answer's steps tick as the agent's receipts arrive: Sent, received, then Done", async () => {
  const store = persistence([decision("one")]);
  const host = await mount(store.source);
  await act(async () => option(host, "Hold").click());
  await clock!.advance(5000);
  const steps = () => [...host.querySelectorAll('ol[aria-label="Answer steps"] li')].map((node) => `${node.textContent}:${node.getAttribute("data-state")}`);
  expect(steps()).toEqual([expect.stringMatching(/^Sent.*:done$/), "Test agent received it, not yet:upcoming", "Done, not yet:upcoming"]);
  store.durable.entries[0]!.state.acknowledgement = handling(store.responses[0]!, "acknowledged");
  await act(async () => store.notify());
  expect(steps()[1]).toMatch(/^Test agent received it.*:done$/);
  store.durable.entries[0]!.state.outcome = handling(store.responses[0]!, "failed");
  await act(async () => store.notify());
  expect(steps()[2]).toMatch(/^Failed.*:failed$/);
});

test("captions off: the control names the agent and nothing explains it; the comment is still only a message", async () => {
  const store = persistence([decision("one")]);
  const host = await mount(store.source, { captions: "hidden" });
  expect([...host.querySelectorAll("button")].some((node) => node.textContent?.trim() === "Comment")).toBe(false);
  await act(async () => button(host, "Leave a comment for Test agent").click());
  expect(host.textContent).not.toContain("This doesn't answer the card.");
  await enter(host, "Tell Test agent something", "Looks fine.");
  await act(async () => button(host, "Send").click());
  expect(store.messages.map((message) => [message.kind, message.text])).toEqual([["message", "Looks fine."]]);
  expect(store.responses).toEqual([]);
});

test("open card, captions off: a comment with no approved route is held privately and says who doesn't get it", async () => {
  const fixture = typed({ recipients: [], unresolved: ["SyntheticOwner"] });
  const host = await mount(fixture.source, { layout: "open-card", captions: "hidden" });
  const article = openCard(host)!;
  expect(article.getAttribute("aria-label")).toBe(fixture.title);
  await act(async () => button(article, "Comment").click());
  expect(article.textContent).toContain("SyntheticOwner isn't connected, so it doesn't get it.");
  expect(article.textContent).not.toContain("Only you see this.");
  await enter(article, "Write a comment", "Hold this until the owner is mapped.");
  await act(async () => button(article, "Send").click());
  expect(fixture.sent).toEqual([]);
  expect(fixture.owner.heldNotes).toContainEqual(expect.objectContaining({ intendedRecipient: "SyntheticOwner", text: "Hold this until the owner is mapped." }));
});

test("open card: an owner-routed comment reaches only the approved recipient, and the unapproved one is held", async () => {
  const fixture = typed({ recipients: [{ recipientKey: "known-owner", legacyName: "SyntheticOwner", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000001" } }], unresolved: ["MissingOfficer"] });
  const host = await mount(fixture.source, { layout: "open-card", nav: "agents" });
  const article = openCard(host)!;
  await act(async () => button(article, "Comment").click());
  await enter(article, "Tell SyntheticOwner something", "Ship it after the review.");
  await act(async () => button(article, "Send").click());
  expect(fixture.sent).toHaveLength(1);
  expect(fixture.sent[0]!.payload).toMatchObject({ type: "sitrep.thread", data: { text: "Ship it after the review.", delivery: { targets: [{ recipientKey: "known-owner", agentId: "00000000-0000-4000-8000-000000000001" }] } } });
  expect(fixture.owner.heldNotes).toContainEqual(expect.objectContaining({ intendedRecipient: "MissingOfficer", text: "Ship it after the review." }));
});

test("a switch away from its default shows on the feed; the approved feed shows no marker", async () => {
  const store = persistence([decision("one")]);
  const plain = await mount(store.source);
  expect(plain.querySelector("[data-feed-flags]")).toBeNull();
  const switched = await mount(store.source, { layout: "open-card", undoSeconds: 4 });
  expect(switched.querySelector("[data-feed-flags]")?.textContent).toBe("Feed switches: open card · 4 s undo");
});
