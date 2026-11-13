import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedHandling, FeedResponse, FeedSelector, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { FeedViewEntries } from "./FeedView";
import type { HomeFeedEntriesProps, HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

const createdAt = "2026-10-28T12:00:00Z";
function decision(cardId = "decision-one", revision = 1, urgency = 1): HomeFeedEntry {
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Test agent",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: {
        cardId, revision, issuanceId: `issuance-${revision}`, kind: "ask", needsResponse: true,
        title: `Question ${cardId}`, body: "Choose a reversible action.", urgency, createdAt,
        choices: [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }],
        payload: { source: { label: "Source record", url: "https://example.org/source" }, report: { label: "Full report", url: "https://example.org/report" } },
      },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision, issuanceId: `issuance-${revision}` },
  };
}
function information(): HomeFeedEntry {
  const entry = decision("information");
  entry.state.card = { ...entry.state.card, kind: "progress", needsResponse: false, title: "Informational update", choices: undefined };
  return entry;
}

// Only the remote persistence/notification boundary is substituted. The actual
// FeedViewEntries owns rendering, drafts, focus, filtering, and save transitions.
// The saved view is All unless a test says otherwise: every card a row, an answered card keeping its place. Needs
// you (its first card open, an answered card moving to Pending) has tests of its own.
function persistence(entries: HomeFeedEntry[], options: { beforeSave?: () => Promise<void>; defaultSelector?: FeedSelector } = {}) {
  const durable: HomeFeedSnapshot = { entries: structuredClone(entries), settings: { defaultSelector: options.defaultSelector ?? "both" } };
  const archive = [...durable.entries];
  const listeners = new Set<() => void>();
  const responses: FeedResponse[] = [];
  const messages: FeedResponse[] = [];
  const identity = (entry: HomeFeedEntry, response: NewFeedResponse) => entry.state.card.cardId === response.cardId && entry.state.card.revision === response.revision && entry.state.card.issuanceId === response.issuanceId;
  const storedEntry = (entry: HomeFeedEntry) => [...durable.entries, ...archive].find((candidate) => candidate.source.sourceId === entry.source.sourceId && identity(candidate, entry.state.card));
  function source(): HomeFeedSource {
    return {
      async load(focused?: HomeFeedEntry) {
        const focusedEntry = focused ? storedEntry(focused) : undefined;
        return structuredClone({ ...durable, ...(focusedEntry ? { focusedEntry } : {}) });
      },
      async saveResponse(entry, response) {
        await options.beforeSave?.();
        const saved = { ...response, sequence: responses.length + 1 };
        responses.push(saved);
        const target = storedEntry(entry);
        if (!target) throw new Error("Question revision not found");
        target.state.response = saved;
        return saved;
      },
      async sendMessage(entry, message) {
        const saved = { ...message, sequence: 1000 + messages.length };
        messages.push(saved);
        const target = storedEntry(entry);
        if (target) (target.responses ??= []).push(saved);
        return saved;
      },
      async markSeen(entry) {
        const target = storedEntry(entry);
        if (target) target.view.seenAt = createdAt;
      },
      async snooze(entry, until) {
        const target = storedEntry(entry);
        if (target) target.view.snoozedUntil = until;
      },
      async setDefaultSelector(selector) { durable.settings.defaultSelector = selector; },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
  }
  /** The agent replies the feed-skill way: revision+1 of the card with the reply appended to payload.replies. */
  function reply(cardId: string, text: string, at: string) {
    const index = durable.entries.findIndex((entry) => entry.state.card.cardId === cardId);
    const current = durable.entries[index]!;
    const revision = current.state.card.revision + 1;
    const replies = Array.isArray(current.state.card.payload?.replies) ? current.state.card.payload.replies : [];
    const next: HomeFeedEntry = { ...structuredClone(current), responses: [],
      state: { card: { ...structuredClone(current.state.card), revision, issuanceId: `issuance-${revision}`, createdAt: at, payload: { ...current.state.card.payload, render: "thread", replies: [...replies, { text }] } }, response: null, acknowledgement: null, outcome: null },
      view: { sourceId: current.source.sourceId, cardId, revision, issuanceId: `issuance-${revision}` } };
    archive.push(next);
    durable.historicalEntries = [...(durable.historicalEntries ?? []), current];
    durable.entries[index] = next;
  }
  return { durable, archive, responses, messages, reply, source, notify: () => { for (const listener of listeners) listener(); } };
}

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
async function mount(source: HomeFeedSource) {
  restore ??= installDom();
  clock ??= installFakeClock();
  // Legacy sample transport is inert, never used as evidence of real feed data.
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  // The DOM installs window.matchMedia only; an opened card's scroll-into-view reads the global.
  globalThis.matchMedia = window.matchMedia.bind(window);
  // The DOM's Web Animations reject a cancelled morph; these tests read the cards, not the motion.
  MotionGlobalConfig.skipAnimations = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const props: HomeFeedEntriesProps = { realEntries: [], source };
  await act(async () => root.render(<FeedViewEntries {...props} />));
  return { host, async unmount() { await act(async () => root.unmount()); roots.delete(root); host.remove(); } };
}
/** Content still on screen: a card's shape on its way out of a morph is inert. */
const live = (node: Element) => !node.closest("[inert]");
function button(host: ParentNode, label: string) {
  const node = [...host.querySelectorAll("button")].filter(live).find((candidate) => candidate.textContent?.trim() === label);
  expect(node).toBeDefined();
  return node!;
}
function hasButton(host: ParentNode, label: string) {
  return [...host.querySelectorAll("button")].filter(live).some((candidate) => candidate.textContent?.trim() === label);
}
/** A card in the list, short or open, by its title. */
function item(host: ParentNode, title: string) {
  return [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].find((node) => node.textContent?.includes(title)) ?? null;
}
/**
 * Opens a card in place by tapping its row; Needs you's first card is open already. An answered card still waiting
 * or done sits in the Pending card at the end of the list (Sam, 11-13), so that opens first when the card isn't listed.
 */
async function open(host: ParentNode, title = "Question decision-one") {
  const pending = host.querySelector<HTMLButtonElement>('section[aria-label="Pending"] > button[aria-expanded="false"]');
  if (!item(host, title) && pending) await act(async () => pending.click());
  const already = [...host.querySelectorAll<HTMLElement>("article")].filter(live).some((candidate) => candidate.querySelector("h2")?.textContent === title);
  if (!already) {
    const row = [...(item(host, title)?.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]') ?? [])].filter(live)[0];
    expect(row).toBeDefined();
    await act(async () => row!.click());
  }
  expect(card(host, title)).toBeDefined();
}
/** An open card, by the title it shows. */
function card(host: ParentNode, title: string) {
  const node = [...host.querySelectorAll<HTMLElement>("article")].filter(live).find((candidate) => candidate.querySelector("h2")?.textContent === title);
  expect(node).toBeDefined();
  return node!;
}
/** The question's options: a fieldset whose legend is "Choose an option". */
function answers(host: ParentNode) {
  return [...host.querySelectorAll("fieldset")].filter(live).find((node) => node.querySelector("legend")?.textContent === "Choose an option") ?? null;
}
function option(host: ParentNode, label: string) {
  const node = [...(answers(host)?.querySelectorAll<HTMLButtonElement>("button[aria-pressed]") ?? [])].find((candidate) => candidate.textContent?.includes(label));
  expect(node).toBeDefined();
  return node!;
}
function undoButton(host: ParentNode) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].filter(live).find((candidate) => candidate.textContent === "Undo") ?? null;
}
/** The bottom bar's line for a decision counting down ("Answered: Hold · 5s"), as a screen reader hears it. */
function bar(host: ParentNode) {
  return [...host.querySelectorAll('[role="status"]')].find((node) => node.querySelector("button")?.textContent === "Undo")?.querySelector(".sr-only")?.textContent ?? null;
}
function answer(host: ParentNode) {
  const node = [...host.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Your own answer"]')].filter(live)[0];
  expect(node).toBeDefined();
  return node!;
}
function hasAnswerBox(host: ParentNode) {
  return [...host.querySelectorAll('textarea[aria-label="Your own answer"]')].some(live);
}
/** Whether the "Your own answer" field offers any way to send: a replaced card's field is off and has no Send. */
function canSendOwn(host: ParentNode) {
  return !answer(host).disabled || !!answer(host).parentElement!.querySelector("button");
}
/** The Send control inside the "Your own answer" field: after the words (Cancel sits before them). */
function sendButton(host: ParentNode) {
  const node = answer(host).nextElementSibling?.querySelector("button") ?? null;
  expect(node).not.toBeNull();
  return node!;
}
function status(host: ParentNode) {
  return [...host.querySelectorAll('[role="status"][aria-label="Your answer"]')].filter(live)[0]?.textContent ?? null;
}
/** The open card's conversation. */
function comments(host: ParentNode) {
  return [...host.querySelectorAll('section[aria-label="Comments"]')].filter(live)[0] ?? null;
}
/** The line under Home: how many cards need you. */
function needsLine(host: HTMLElement) {
  return host.querySelector("header p")?.textContent ?? "";
}
/** Taps an option, then lets its 5 s undo window run out so the answer is sent. */
async function choose(host: ParentNode, label: string) {
  await act(async () => option(host, label).click());
  await clock!.advance(5000);
}
/** Sends the answer in words, then lets its undo window run out. */
async function sendReply(host: ParentNode) {
  await act(async () => sendButton(host).click());
  await clock!.advance(5000);
}
async function openNote(host: ParentNode) {
  await act(async () => option(host, "Your own answer").click());
}
async function type(node: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function typeAnswer(host: ParentNode, value: string) {
  await type(answer(host), value);
}
/** Writes a comment to the card's agent and taps Send (its 5 s undo window starts). */
async function comment(host: ParentNode, value: string) {
  await act(async () => button(host, "Leave a comment for Test agent").click());
  const input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Leave a comment for Test agent"]');
  expect(input).not.toBeNull();
  await type(input!, value);
  await act(async () => input!.nextElementSibling!.querySelector<HTMLButtonElement>("button")!.click());
}
type View = "Needs you" | "All" | "History";
function viewRadio(host: HTMLElement, label: View) {
  const value = ({ "Needs you": "needs-action", All: "both", History: "history" } as const)[label];
  const node = host.querySelector<HTMLInputElement>(`[role="radiogroup"][aria-label="Feed view"] input[value="${value}"]`);
  expect(node).not.toBeNull();
  return node!;
}
async function chooseView(host: HTMLElement, label: View) {
  await act(async () => viewRadio(host, label).click());
}
/** History (the island's third tab), or Filter → Snoozed (the Filter panel opens the first time). */
async function filter(host: HTMLElement, label: "History" | "Snoozed") {
  if (label === "History") { await chooseView(host, "History"); return; }
  if (!hasButton(host, label)) await act(async () => button(host, "Filter").click());
  await act(async () => button(host, label).click());
}
function handling(response: FeedResponse, phase: FeedHandling["phase"]): FeedHandling {
  return { cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId, handlingId: `handling-${phase}`, phase, createdAt, detail: { message: phase === "failed" ? "Action failed safely" : "Reversible action completed" } };
}

test("saving an answer waits for durability, then distinguishes saved, received, and completed", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await open(view.host);
  await openNote(view.host);
  await typeAnswer(view.host, "Proceed with the isolated action");
  await sendReply(view.host);
  // The card is away while its write is pending (TC-2998): nothing is shown as saved, and nothing is recorded yet.
  expect(store.responses).toEqual([]);
  expect(status(view.host)).toBeNull();
  await act(async () => write.resolve());
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1", kind: "answer", text: "Proceed with the isolated action" });
  // Saved, it sits in Pending; opened there, it shows the answer.
  await open(view.host);
  expect(status(view.host)).toContain("Proceed with the isolated action");
  expect(status(view.host)).not.toContain("got it");
  expect(status(view.host)).not.toContain("finished it");
  store.durable.entries[0]!.state.acknowledgement = handling(store.responses[0]!, "acknowledged");
  await act(async () => store.notify());
  expect(status(view.host)).toContain("Test agent got it.");
  expect(status(view.host)).not.toContain("finished it");
  store.durable.entries[0]!.state.outcome = handling(store.responses[0]!, "succeeded");
  await act(async () => store.notify());
  expect(status(view.host)).toContain("Test agent finished it.");
  expect(status(view.host)).toContain("Reversible action completed");
  await view.unmount();
  const reopened = await mount(store.source());
  await chooseView(reopened.host, "All");
  await open(reopened.host);
  expect(status(reopened.host)).toContain("Proceed with the isolated action");
  expect(status(reopened.host)).toContain("finished it");
});

test("one tap saves the option once, and Change answer saves a follow-up that replaces it", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await choose(view.host, "Hold");
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1", kind: "answer", choiceId: "hold" });
  expect(store.responses[0]!.supersedesResponseId).toBeUndefined();
  // The answered card moves to Pending (TC-2998); opened there, it shows the label (never the id) and Change answer.
  await open(view.host);
  expect(status(view.host)).toContain("You chose Hold.");
  expect(answers(view.host)).toBeNull();
  await act(async () => button(view.host, "Change answer").click());
  await choose(view.host, "Proceed");
  expect(store.responses).toHaveLength(2);
  expect(store.responses[1]).toMatchObject({ kind: "followup", choiceId: "proceed", supersedesResponseId: store.responses[0]!.responseId });
  await open(view.host);
  expect(status(view.host)).toContain("You chose Proceed.");
});

test("Keep my answer leaves the saved answer untouched", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await choose(view.host, "Hold");
  await open(view.host);
  await act(async () => button(view.host, "Change answer").click());
  await act(async () => button(view.host, "Keep my answer").click());
  expect(store.responses).toHaveLength(1);
  expect(status(view.host)).toContain("You chose Hold.");
});

test("a rejected write keeps the draft actionable and does not imply receipt", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await open(view.host);
  await openNote(view.host);
  await typeAnswer(view.host, "Keep this unsaved answer");
  await sendReply(view.host);
  await act(async () => write.reject(new Error("Isolated SQL write denied")));
  expect(answer(view.host).value).toBe("Keep this unsaved answer");
  expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(sendButton(view.host).disabled).toBe(false);
  expect(status(view.host)).toBeNull();
  expect(store.responses).toEqual([]);
  await view.unmount();
  const reopened = await mount(store.source());
  await open(reopened.host);
  await openNote(reopened.host);
  expect(answer(reopened.host).value).toBe("");
});

test("a retried tap after a failed write reuses its response identity", async () => {
  let fail = true;
  const store = persistence([decision()], { beforeSave: async () => { if (fail) throw new Error("Isolated SQL write denied"); } });
  const ids: string[] = [];
  const base = store.source();
  const view = await mount({ ...base, async saveResponse(entry, response, payload) { ids.push(response.responseId); return base.saveResponse(entry, response, payload); } });
  await open(view.host);
  await choose(view.host, "Hold");
  expect(store.responses).toEqual([]);
  fail = false;
  await choose(view.host, "Hold");
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]!);
  expect(store.responses).toHaveLength(1);
});

test("Needs you shows what needs you with its first card open; All adds updates as rows; information is nonactionable", async () => {
  const store = persistence([decision(), information()], { defaultSelector: "needs-action" });
  const view = await mount(store.source());
  expect(viewRadio(view.host, "Needs you").checked).toBe(true);
  // The first card is open without a tap, and that counts as seen.
  expect(answers(card(view.host, "Question decision-one"))).not.toBeNull();
  expect(store.durable.entries[0]!.view.seenAt).toBeDefined();
  expect(view.host.textContent).not.toContain("Informational update");
  await chooseView(view.host, "All");
  expect(viewRadio(view.host, "All").checked).toBe(true);
  expect(view.host.querySelector('section[aria-label="Needs you"]')?.textContent).toContain("Question decision-one");
  expect(view.host.querySelector('section[aria-label="Updates"]')?.textContent).toContain("Informational update");
  // Rows in All: a row isn't seen; opening it is.
  expect(view.host.querySelector('section[aria-label="Updates"] article')).toBeNull();
  expect(store.durable.entries[1]!.view.seenAt).toBeUndefined();
  await open(view.host, "Informational update");
  expect(store.durable.entries[1]!.view.seenAt).toBeDefined();
  const info = card(view.host, "Informational update");
  expect(info.querySelector("textarea")).toBeNull();
  expect(answers(info)).toBeNull();
  expect(hasButton(info, "Acknowledge")).toBe(true);
  await chooseView(view.host, "Needs you");
  expect(view.host.textContent).not.toContain("Informational update");
  expect(store.responses).toEqual([]);
});

test("an answer in Needs you leaves once it is saved, to Pending, and the next card opens in its place", async () => {
  const store = persistence([decision("first", 1, 3), decision("second", 1, 2)], { defaultSelector: "needs-action" });
  const view = await mount(store.source());
  expect(answers(card(view.host, "Question first"))).not.toBeNull();
  expect(item(view.host, "Question second")!.querySelector("article")).toBeNull();
  await choose(view.host, "Hold");
  expect(store.responses).toEqual([expect.objectContaining({ cardId: "first", choiceId: "hold" })]);
  await act(async () => store.notify());
  expect(item(view.host, "Question first")).toBeNull();
  expect(pendingToggle(view.host)?.textContent).toContain("1 · answered, not closed yet");
  expect(answers(card(view.host, "Question second"))).not.toBeNull();
  // Folded by the owner, the first card stays a row.
  await act(async () => card(view.host, "Question second").querySelector<HTMLButtonElement>('button[aria-label="Show less"]')!.click());
  expect(item(view.host, "Question second")!.querySelector("article")).toBeNull();
});

test("a short card opens in place, and folds back without writing anything", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  // A row lives in the bordered list of rows; open, the card stands on its own in the same place.
  const row = item(view.host, "Question decision-one")!;
  expect(row.querySelector("a[href='https://example.org/source']")).toBeNull();
  expect(answers(row)).toBeNull();
  await open(view.host);
  const opened = item(view.host, "Question decision-one")!;
  expect(opened.dataset.cardKey).toBe(row.dataset.cardKey);
  expect(opened.querySelector("a[href='https://example.org/source']")).not.toBeNull();
  expect(answers(opened)).not.toBeNull();
  await act(async () => opened.querySelector<HTMLButtonElement>('button[aria-label="Show less"]')!.click());
  const folded = item(view.host, "Question decision-one")!;
  expect(answers(folded)).toBeNull();
  expect([...folded.querySelectorAll('button[aria-expanded="false"]')].some(live)).toBe(true);
  expect(store.responses).toEqual([]);
});

test("a typed own answer survives Show less: reopening shows the box with the text, and nothing is written", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await openNote(view.host);
  await typeAnswer(view.host, "Draft kept while folded");
  await act(async () => item(view.host, "Question decision-one")!.querySelector<HTMLButtonElement>('button[aria-label="Show less"]')!.click());
  expect(hasAnswerBox(view.host)).toBe(false);
  await open(view.host);
  expect(hasAnswerBox(view.host)).toBe(true);
  expect(answer(view.host).value).toBe("Draft kept while folded");
  await clock!.advance(10_000);
  expect(store.responses).toEqual([]);
});

test("new urgent arrivals cannot replace the focused response or its input node", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await openNote(view.host);
  await typeAnswer(view.host, "Still answering the original question");
  const activeInput = answer(view.host);
  activeInput.focus();
  store.durable.entries.unshift(decision("urgent-new", 1, 100));
  await act(async () => store.notify());
  expect(item(view.host, "Question urgent-new")).not.toBeNull();
  expect(answer(view.host) === activeInput).toBe(true);
  expect(document.activeElement === activeInput).toBe(true);
  expect(activeInput.value).toBe("Still answering the original question");
  await sendReply(card(view.host, "Question decision-one"));
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, text: "Still answering the original question" });
});

test("an in-flight answer retains its exact issuance and loads its outcome after the latest snapshot replaces it", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await open(view.host);
  await openNote(view.host);
  await typeAnswer(view.host, "Answer for revision one only");
  await sendReply(view.host);
  // The write is in flight once the undo window closes, the card away meanwhile (TC-2998); then a newer revision lands.
  store.durable.entries = [decision("decision-one", 2)];
  // As the store does, the replaced revision stays in History with its answer.
  store.durable.historicalEntries = [store.archive[0]!];
  await act(async () => store.notify());
  await act(async () => write.resolve());
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1" });
  expect(store.durable.entries[0]!.state.response).toBeNull();
  store.archive[0]!.state.acknowledgement = handling(store.responses[0]!, "acknowledged");
  store.archive[0]!.state.outcome = handling(store.responses[0]!, "succeeded");
  await act(async () => store.notify());
  // The answered revision carries its outcome, in History; the newer one still asks.
  await chooseView(view.host, "History");
  await open(view.host);
  expect(status(view.host)).toContain("finished it");
  expect(status(view.host)).toContain("Answer for revision one only");
  await chooseView(view.host, "Needs you");
  await open(view.host);
  expect(status(view.host)).toBeNull();
  await openNote(view.host);
  expect(answer(view.host).value).toBe("");
  await view.unmount();
  const reopened = await mount(store.source());
  await open(reopened.host);
  expect(status(reopened.host)).toBeNull();
});

test("Ask me later takes the card away without writing an answer, writes the snooze after its undo, and expiry restores it", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await act(async () => button(view.host, "Ask me later").click());
  const presets = view.host.querySelector('section[aria-label="Ask me later"]')!;
  await act(async () => presets.querySelector("button")!.click());
  expect(item(view.host, "Question decision-one")).toBeNull();
  // Nothing is written while the bar's undo counts.
  expect(store.durable.entries[0]!.view.snoozedUntil).toBeUndefined();
  await clock!.advance(5_500);
  expect(store.responses).toEqual([]);
  expect(store.durable.entries[0]!.view.snoozedUntil).toBeDefined();
  expect(item(view.host, "Question decision-one")).toBeNull();
  store.durable.entries[0]!.view.snoozedUntil = "2000-01-01T00:00:00Z";
  await act(async () => store.notify());
  expect(view.host.textContent).toContain("Question decision-one");
  await open(view.host);
  expect(status(view.host)).toBeNull();
  expect(option(view.host, "Hold")).toBeDefined();
});

test("the last view is remembered for the next session; History is not", async () => {
  const store = persistence([decision(), information()]);
  const view = await mount(store.source());
  await chooseView(view.host, "All");
  expect(store.durable.settings.defaultSelector).toBe("both");
  await chooseView(view.host, "Needs you");
  expect(store.durable.settings.defaultSelector).toBe("needs-action");
  await chooseView(view.host, "History");
  expect(store.durable.settings.defaultSelector).toBe("needs-action");
  await view.unmount();
  const secondSession = await mount(store.source());
  expect(viewRadio(secondSession.host, "Needs you").checked).toBe(true);
  expect(secondSession.host.textContent).toContain("Question decision-one");
  expect(secondSession.host.textContent).not.toContain("Informational update");
  expect(secondSession.host.querySelector('section[aria-label="History"]')).toBeNull();
});

test("a failed outcome stays distinct from an unsaved answer and keeps source/report links", async () => {
  const entry = decision();
  entry.state.response = { cardId: "decision-one", revision: 1, issuanceId: "issuance-1", responseId: "saved-response", sequence: 1, kind: "answer", choiceId: "hold", createdAt };
  entry.state.acknowledgement = handling(entry.state.response, "acknowledged");
  entry.state.outcome = handling(entry.state.response, "failed");
  const store = persistence([entry], { defaultSelector: "both" });
  const view = await mount(store.source());
  await open(view.host);
  expect(status(view.host)).toContain("You chose Hold.");
  expect(status(view.host)).toContain("Test agent got it.");
  expect(status(view.host)).toContain("couldn't finish it");
  expect(status(view.host)).toContain("Action failed safely");
  expect(view.host.querySelector("a[href='https://example.org/report']")).not.toBeNull();
  expect(view.host.querySelector("a[href='https://example.org/source']")).not.toBeNull();
  await chooseView(view.host, "Needs you");
  expect(view.host.querySelector("textarea")).toBeNull();
  expect(store.responses).toEqual([]);
});

test("a true latest-issuance replacement preserves the draft until explicit navigation", async () => {
  const original = decision();
  original.state.card.title = "Original question";
  const store = persistence([original]);
  const view = await mount(store.source());
  await open(view.host, "Original question");
  await openNote(view.host);
  await typeAnswer(view.host, "Unsubmitted original draft");
  const originalInput = answer(view.host);
  originalInput.focus();
  const successor = decision("decision-one", 2);
  successor.state.card.title = "Replacement question";
  store.durable.entries = [successor];
  await act(async () => store.notify());
  expect(answer(view.host) === originalInput).toBe(true);
  expect(document.activeElement === originalInput).toBe(true);
  expect(originalInput.value).toBe("Unsubmitted original draft");
  expect(card(view.host, "Original question")).toBeDefined();
  expect(view.host.querySelectorAll("li[data-card-key]")).toHaveLength(1);
  expect(view.host.textContent).not.toContain("Replacement question");
  await act(async () => button(view.host, "Show the newer version").click());
  expect(view.host.textContent).toContain("Replacement question");
  expect(view.host.textContent).not.toContain("Original question");
  expect(hasAnswerBox(view.host)).toBe(false);
  await open(view.host, "Replacement question");
  expect(hasAnswerBox(view.host)).toBe(false);
  expect(option(view.host, "Your own answer")).toBeDefined();
  expect(store.responses).toEqual([]);
});

test("a (Recommended) label shows without the marker and with the Suggested tag, and a tap saves the unchanged choice", async () => {
  const entry = decision();
  entry.state.card.choices = [{ id: "proceed", label: "Proceed (Recommended)" }, { id: "hold", label: "Hold" }];
  const store = persistence([entry]);
  const view = await mount(store.source());
  await open(view.host);
  const proceed = option(view.host, "Proceed");
  expect(proceed.textContent).toContain("Suggested");
  expect(proceed.textContent).not.toContain("Recommended");
  expect(option(view.host, "Hold").textContent).toBe("Hold");
  await act(async () => proceed.click());
  await clock!.advance(5000);
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ kind: "answer", choiceId: "proceed" });
  expect(store.durable.entries[0]!.state.card.choices?.[0]?.label).toBe("Proceed (Recommended)");
  await open(view.host);
  expect(status(view.host)).toContain("You chose Proceed.");
});

test("a replaced issuance refuses new answers: no write ever carries the old identity", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await openNote(view.host);
  await typeAnswer(view.host, "Drafted against revision one");
  store.durable.entries = [decision("decision-one", 2)];
  await act(async () => store.notify());
  // The old issuance stays on screen with its draft, but every way to answer it is refused.
  expect(answer(view.host).value).toBe("Drafted against revision one");
  expect(option(view.host, "Hold").disabled).toBe(true);
  expect(canSendOwn(view.host)).toBe(false);
  await act(async () => option(view.host, "Hold").click());
  await act(async () => { answer(view.host).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await clock!.advance(10_000);
  expect(store.responses).toEqual([]);
  await act(async () => button(view.host, "Show the newer version").click());
  await open(view.host);
  await choose(view.host, "Hold");
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 2, issuanceId: "issuance-2", choiceId: "hold" });
  expect(store.responses.some((response) => response.revision === 1)).toBe(false);
});

test("a snoozed card stays out of the views and shows no options until it is brought back, then one tap saves once", async () => {
  const entry = decision();
  entry.view.snoozedUntil = "2099-01-01T00:00:00Z";
  const store = persistence([entry], { defaultSelector: "both" });
  const view = await mount(store.source());
  expect(item(view.host, "Question decision-one")).toBeNull();
  await filter(view.host, "Snoozed");
  const row = item(view.host, "Question decision-one")!;
  expect(row.textContent).toContain("Back at");
  expect(answers(row)).toBeNull();
  await act(async () => button(row, "Bring back now").click());
  expect(Date.parse(store.durable.entries[0]!.view.snoozedUntil!)).toBeLessThanOrEqual(Date.now());
  await filter(view.host, "Snoozed");
  await open(view.host);
  await choose(view.host, "Hold");
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, kind: "answer", choiceId: "hold" });
});

test("an answer waits 5 seconds: nothing is written before, exactly one write at 5", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await act(async () => option(view.host, "Hold").click());
  // The card leaves at once (TC-2998); the bottom bar counts the wait, with Undo.
  expect(answers(view.host)).toBeNull();
  expect(undoButton(view.host)).not.toBeNull();
  expect(bar(view.host)).toBe("Answered: Hold · 5s");
  await clock!.advance(2000);
  expect(bar(view.host)).toBe("Answered: Hold · 3s");
  await clock!.advance(2900);
  expect(store.responses).toEqual([]);
  await clock!.advance(100);
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1", kind: "answer", choiceId: "hold" });
  expect(bar(view.host)).toBeNull();
  await open(view.host);
  expect(status(view.host)).toContain("You chose Hold.");
  await clock!.advance(10_000);
  expect(store.responses).toHaveLength(1);
});

test("undo at 3 seconds writes nothing and brings the card and its options back", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await act(async () => option(view.host, "Hold").click());
  await clock!.advance(2000);
  await act(async () => undoButton(view.host)!.click());
  expect(undoButton(view.host)).toBeNull();
  expect(option(view.host, "Hold").disabled).toBe(false);
  await act(async () => option(view.host, "Proceed").click());
  await act(async () => undoButton(view.host)!.click());
  expect(option(view.host, "Proceed").disabled).toBe(false);
  await clock!.advance(10_000);
  expect(store.responses).toEqual([]);
});

test("the last card leaving with a decision counts as gone: Nothing needs you while the bar counts, and Undo brings the card and its count back", async () => {
  const store = persistence([decision()], { defaultSelector: "needs-action" });
  const view = await mount(store.source());
  await open(view.host);
  expect(needsLine(view.host)).toContain("1 needs you.");
  await act(async () => option(view.host, "Hold").click());
  expect(needsLine(view.host)).toContain("Nothing needs you.");
  // Once its space has closed, the empty state takes its place.
  await clock!.advance(200);
  expect(view.host.querySelector("[data-feed-empty]")?.textContent).toBe("Nothing needs you.");
  await act(async () => undoButton(view.host)!.click());
  expect(needsLine(view.host)).toContain("1 needs you.");
  expect(view.host.querySelector("[data-feed-empty]")).toBeNull();
  expect(option(view.host, "Hold").disabled).toBe(false);
  await clock!.advance(10_000);
  expect(store.responses).toEqual([]);
});

test("a reply in words waits too, and undo keeps the draft", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await openNote(view.host);
  await typeAnswer(view.host, "Hold until Friday");
  await act(async () => sendButton(view.host).click());
  expect(undoButton(view.host)).not.toBeNull();
  await act(async () => undoButton(view.host)!.click());
  expect(answer(view.host).value).toBe("Hold until Friday");
  await clock!.advance(10_000);
  expect(store.responses).toEqual([]);
  await sendReply(view.host);
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ kind: "answer", text: "Hold until Friday" });
  expect(store.responses[0]!.choiceId).toBeUndefined();
});

test("the own-answer field has Cancel inside it too: Cancel clears the words, closes the box and writes nothing", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await open(view.host);
  await openNote(view.host);
  await typeAnswer(view.host, "Hold until Friday");
  const cancel = answer(view.host).parentElement!.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
  expect(cancel).not.toBeNull();
  await act(async () => cancel!.click());
  expect(hasAnswerBox(view.host)).toBe(false);
  await clock!.advance(10_000);
  expect(store.responses).toEqual([]);
  // Opened again, the box is empty: Cancel dropped the draft too.
  await openNote(view.host);
  expect(answer(view.host).value).toBe("");
});

test("leaving the view mid-countdown sends the answer at once, exactly once", async () => {
  const store = persistence([decision(), information()]);
  const view = await mount(store.source());
  await open(view.host);
  await act(async () => option(view.host, "Hold").click());
  await clock!.advance(1000);
  expect(store.responses).toEqual([]);
  await chooseView(view.host, "History");
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ kind: "answer", choiceId: "hold" });
  await clock!.advance(10_000);
  expect(store.responses).toHaveLength(1);
});

function plain(cardId = "plain-one"): HomeFeedEntry {
  const entry = decision(cardId);
  entry.state.card = { ...entry.state.card, title: "Plain question", payload: { render: "thread" } };
  return entry;
}
const writes = (responses: FeedResponse[]) => responses.map((response) => `${response.revision}:${response.choiceId ?? response.text}`);
const BANNER = "A newer version of this card arrived";

test("a comment waits 5 s like every send: Undo writes nothing and puts the words back; left alone, one message at 5 s; Cancel inside the field sends nothing", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await comment(view.host, "Is Friday too late?");
  // Send and Cancel both sit inside the comment field's border (Sam, 23:35Z), and the count starts at once.
  const field = view.host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Leave a comment for Test agent"]')!;
  expect(field.parentElement!.querySelector("button")).not.toBeNull();
  expect(field.parentElement!.querySelector('button[aria-label="Cancel"]')).not.toBeNull();
  expect(comments(view.host)?.textContent).toContain("Sending in 5s");
  expect(field.value).toBe("");
  await clock!.advance(3000);
  await act(async () => undoButton(comments(view.host)!)!.click());
  expect(field.value).toBe("Is Friday too late?");
  expect(comments(view.host)?.textContent ?? "").not.toContain("Sending in");
  await clock!.advance(10_000);
  expect(store.messages).toEqual([]);
  // Sent again from the field's own Send, left alone: nothing before 5 s, exactly one message at 5 s.
  await act(async () => field.nextElementSibling!.querySelector<HTMLButtonElement>("button")!.click());
  await clock!.advance(4900);
  expect(store.messages).toEqual([]);
  await clock!.advance(100);
  expect(store.messages).toHaveLength(1);
  expect(store.messages[0]).toMatchObject({ kind: "message", cardId: "plain-one", revision: 1, text: "Is Friday too late?" });
  await clock!.advance(10_000);
  expect(store.messages).toHaveLength(1);
  expect(store.responses).toEqual([]);
  // Words in the field, then its Cancel: the box closes and nothing more is sent.
  await type(field, "Actually, never mind.");
  await act(async () => field.parentElement!.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')!.click());
  expect(view.host.querySelector('textarea[aria-label="Leave a comment for Test agent"]')).toBeNull();
  await clock!.advance(10_000);
  expect(store.messages).toHaveLength(1);
});

test("a plain card's conversation interleaves the owner's messages and revision replies, oldest first", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await comment(view.host, "Is Friday too late?");
  await clock!.advance(5000);
  expect(store.messages).toHaveLength(1);
  expect(store.messages[0]).toMatchObject({ kind: "message", cardId: "plain-one", revision: 1, text: "Is Friday too late?" });
  store.messages[0]!.createdAt = "2026-10-28T12:05:00Z";
  store.reply("plain-one", "Friday is fine.", "2026-10-28T12:10:00Z");
  store.reply("plain-one", "Booked for Friday.", "2026-10-28T12:20:00Z");
  await act(async () => store.notify());
  // Reply-only revisions swap in place, even though sending the message engaged the card.
  expect(view.host.textContent).not.toContain(BANNER);
  const thread = comments(view.host)!.textContent!;
  const order = ["Is Friday too late?", "Friday is fine.", "Booked for Friday."].map((text) => thread.indexOf(text));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // The answers sit above the thread.
  expect(answers(view.host)!.compareDocumentPosition(comments(view.host)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(store.responses).toEqual([]);
});

/** Republishes the card as revision+1 with a changed body: not a reply-only revision. */
function edit(store: { durable: HomeFeedSnapshot; archive: HomeFeedEntry[] }, cardId: string, body: string) {
  const index = store.durable.entries.findIndex((entry) => entry.state.card.cardId === cardId);
  const current = store.durable.entries[index]!;
  const revision = current.state.card.revision + 1;
  const next: HomeFeedEntry = { ...structuredClone(current), responses: [],
    state: { card: { ...structuredClone(current.state.card), revision, issuanceId: `issuance-${revision}`, body }, response: null, acknowledgement: null, outcome: null },
    view: { sourceId: current.source.sourceId, cardId, revision, issuanceId: `issuance-${revision}` } };
  store.archive.push(next);
  store.durable.historicalEntries = [...(store.durable.historicalEntries ?? []), current];
  store.durable.entries[index] = next;
}

// Answer state across revisions. A reply-only revision (only payload.replies appended) swaps
// in place and carries the card's answer state; any other revision keeps the strict rule.
test("reply-only revision after an answer: no banner, the answer shows, nothing needs you, one stored answer on revision 1", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await choose(view.host, "Hold");
  store.reply("plain-one", "Noted, holding.", "2026-10-28T12:10:00Z");
  await act(async () => store.notify());
  expect(view.host.textContent).not.toContain(BANNER);
  // The answered card is in Pending (TC-2998); opened there, it is one card showing the answer and the reply.
  await open(view.host, "Plain question");
  expect(view.host.querySelectorAll("li[data-card-key]")).toHaveLength(1);
  expect(status(view.host)).toContain("You chose Hold.");
  expect(comments(view.host)?.textContent).toContain("Noted, holding.");
  expect(needsLine(view.host)).toContain("Nothing needs you.");
  expect(writes(store.responses)).toEqual(["1:hold"]);
  // A fresh session shows the same: the answer stays bound to revision 1 and is displayed on revision 2.
  await view.unmount();
  const fresh = await mount(store.source());
  await chooseView(fresh.host, "All");
  await open(fresh.host, "Plain question");
  expect(status(fresh.host)).toContain("You chose Hold.");
  expect(needsLine(fresh.host)).toContain("Nothing needs you.");
});

test("Change answer after a reply-only revision writes a follow-up that names revision 1", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await choose(view.host, "Hold");
  store.reply("plain-one", "Noted.", "2026-10-28T12:10:00Z");
  await act(async () => store.notify());
  await open(view.host, "Plain question");
  await act(async () => button(view.host, "Change answer").click());
  await choose(view.host, "Proceed");
  expect(store.responses).toHaveLength(2);
  expect(store.responses[1]).toMatchObject({ kind: "followup", revision: 1, issuanceId: "issuance-1", choiceId: "proceed", supersedesResponseId: store.responses[0]!.responseId });
});

test("a reply-only revision during the countdown re-targets the unanswered answer: one write, on revision 2", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await act(async () => option(view.host, "Hold").click());
  await clock!.advance(2000);
  store.reply("plain-one", "Noted.", "2026-10-28T12:10:00Z");
  await act(async () => store.notify());
  expect(view.host.textContent).not.toContain(BANNER);
  expect(bar(view.host)).toBe("Answered: Hold · 3s");
  await clock!.advance(3000);
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ revision: 2, issuanceId: "issuance-2", choiceId: "hold" });
});

test("any other revision during the countdown refuses the commit: nothing is written, the refusal shows", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await act(async () => option(view.host, "Hold").click());
  await clock!.advance(2000);
  edit(store, "plain-one", "The flight times changed.");
  await act(async () => store.notify());
  expect(view.host.textContent).toContain(BANNER);
  await clock!.advance(3000);
  expect(store.responses).toEqual([]);
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Not sent: Hold. This card changed. Answer the newer version.");
  await act(async () => button(view.host, "Show the newer version").click());
  await open(view.host, "Plain question");
  await choose(view.host, "Hold");
  expect(writes(store.responses)).toEqual(["2:hold"]);
  expect(store.responses.some((response) => response.revision === 1)).toBe(false);
});

test("leaving the view mid-countdown after a non-reply-only revision writes nothing either", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await act(async () => option(view.host, "Hold").click());
  edit(store, "plain-one", "The flight times changed.");
  await act(async () => store.notify());
  await chooseView(view.host, "All");
  await clock!.advance(10_000);
  expect(store.responses).toEqual([]);
});

test("an unsent written answer carries over to a reply-only revision and is sent on it", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await openNote(view.host);
  await typeAnswer(view.host, "Hold it until Friday");
  const input = answer(view.host);
  store.reply("plain-one", "Noted.", "2026-10-28T12:10:00Z");
  await act(async () => store.notify());
  expect(view.host.textContent).not.toContain(BANNER);
  expect(answer(view.host) === input).toBe(true);
  expect(input.value).toBe("Hold it until Friday");
  await sendReply(view.host);
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ revision: 2, text: "Hold it until Friday" });
});

test("an unsent written answer stays on the old revision when any other revision arrives", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await openNote(view.host);
  await typeAnswer(view.host, "Hold it until Friday");
  edit(store, "plain-one", "The flight times changed.");
  await act(async () => store.notify());
  expect(answer(view.host).value).toBe("Hold it until Friday");
  expect(canSendOwn(view.host)).toBe(false);
  await clock!.advance(10_000);
  expect(store.responses).toEqual([]);
});

test("a reply-only revision after the answer re-targets nothing: the answer and its follow-ups stay on revision 1", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await choose(view.host, "Hold");
  store.reply("plain-one", "Noted.", "2026-10-28T12:10:00Z");
  store.reply("plain-one", "Booked.", "2026-10-28T12:20:00Z");
  await act(async () => store.notify());
  await open(view.host, "Plain question");
  await act(async () => button(view.host, "Change answer").click());
  await openNote(view.host);
  await typeAnswer(view.host, "Actually, proceed");
  await sendReply(view.host);
  expect(store.responses.map((response) => response.revision)).toEqual([1, 1]);
  expect(store.durable.entries[0]!.state.response).toBeNull();
});

test("revision reply on an untouched card replaces it in place with the reply", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  store.reply("plain-one", "Noted.", "2026-10-28T12:10:00Z");
  await act(async () => store.notify());
  expect(view.host.textContent).not.toContain(BANNER);
  expect(view.host.querySelectorAll("li[data-card-key]")).toHaveLength(1);
  await open(view.host, "Plain question");
  expect(comments(view.host)?.textContent).toContain("Noted.");
  expect(view.host.querySelectorAll("li[data-card-key]")).toHaveLength(1);
});

test("a written answer counting down when any other revision arrives is refused and its draft stays", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await openNote(view.host);
  await typeAnswer(view.host, "Hold it until Friday");
  await act(async () => sendButton(view.host).click());
  edit(store, "plain-one", "The flight times changed.");
  await act(async () => store.notify());
  await clock!.advance(5000);
  expect(store.responses).toEqual([]);
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Not sent: your answer. This card changed. Answer the newer version.");
  expect(answer(view.host).value).toBe("Hold it until Friday");
});

test("a post card's first reply (post → thread) swaps in place and keeps the answer", async () => {
  const entry = plain();
  entry.state.card.payload = { render: "post" };
  const store = persistence([entry]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await choose(view.host, "Hold");
  store.reply("plain-one", "Noted, holding.", "2026-10-28T12:10:00Z");
  await act(async () => store.notify());
  expect(store.durable.entries[0]!.state.card.payload?.render).toBe("thread");
  expect(view.host.textContent).not.toContain(BANNER);
  await open(view.host, "Plain question");
  expect(status(view.host)).toContain("You chose Hold.");
  expect(comments(view.host)?.textContent).toContain("Noted, holding.");
  expect(writes(store.responses)).toEqual(["1:hold"]);
});

test("a short card shows its agent's reply count, none at 0, and opens to the conversation", async () => {
  const busy = plain();
  busy.state.card.payload = { render: "thread", replies: [{ text: "Friday is fine.", at: "2026-10-28T12:10:00Z" }] };
  const quiet = plain("plain-two");
  quiet.state.card.title = "Quiet question";
  const store = persistence([busy, quiet]);
  const view = await mount(store.source());
  expect(item(view.host, "Plain question")!.textContent).toContain("1 reply from Test agent, 1 new");
  expect(item(view.host, "Quiet question")!.textContent).not.toContain("reply from");
  expect(comments(view.host)).toBeNull();
  await open(view.host, "Plain question");
  expect(comments(card(view.host, "Plain question"))?.textContent).toContain("Friday is fine.");
});

test("a comment doesn't answer the card: no response is written and it still needs you", async () => {
  const store = persistence([plain()]);
  const view = await mount(store.source());
  await open(view.host, "Plain question");
  await comment(view.host, "Is Friday too late?");
  await clock!.advance(10_000);
  expect(store.messages).toHaveLength(1);
  expect(store.messages[0]).toMatchObject({ kind: "message", text: "Is Friday too late?" });
  expect(store.responses).toEqual([]);
  expect(needsLine(view.host)).toContain("1 needs you.");
  expect(status(view.host)).toBeNull();
  expect([...answers(view.host)!.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].every((node) => !node.disabled)).toBe(true);
  await view.unmount();
  const fresh = await mount(store.source());
  expect(item(fresh.host, "Plain question")).not.toBeNull();
  expect(needsLine(fresh.host)).toContain("1 needs you.");
});

/** A decision answered with Hold: waiting on its agent, or done once the agent reports it. */
function answered(cardId: string, done: boolean): HomeFeedEntry {
  const entry = decision(cardId);
  const response: FeedResponse = { cardId, revision: 1, issuanceId: "issuance-1", responseId: `answer-${cardId}`, sequence: 1, kind: "answer", choiceId: "hold", createdAt };
  entry.state.response = response;
  if (done) { entry.state.acknowledgement = handling(response, "acknowledged"); entry.state.outcome = handling(response, "succeeded"); }
  return entry;
}
const pendingToggle = (host: ParentNode) => host.querySelector<HTMLButtonElement>('section[aria-label="Pending"] > button');

test("answered cards waiting on their agent or done but not acknowledged fold into one Pending card at the end; only what needs you stays in the flow", async () => {
  for (const selector of ["needs-action", "both"] as const) {
    const store = persistence([answered("waiting-one", false), decision("open-one"), answered("done-one", true)], { defaultSelector: selector });
    const view = await mount(store.source());
    expect(item(view.host, "Question open-one")).not.toBeNull();
    expect(item(view.host, "Question waiting-one")).toBeNull();
    expect(item(view.host, "Question done-one")).toBeNull();
    const toggle = pendingToggle(view.host)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Pending");
    expect(toggle.textContent).toContain("2 · answered, not closed yet");
    // The Pending card is the last thing in the list.
    expect(item(view.host, "Question open-one")!.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => toggle.click());
    const waiting = item(view.host, "Question waiting-one")!, done = item(view.host, "Question done-one")!;
    expect(waiting.textContent).toContain("You chose Hold");
    expect(waiting.textContent).toContain("Waiting");
    expect(hasButton(waiting, "Acknowledge")).toBe(false);
    expect(done.textContent).toContain("Done");
    // A row opens its card in place, inside the Pending card.
    await open(view.host, "Question waiting-one");
    expect(status(view.host)).toContain("You chose Hold.");
    await view.unmount();
  }
  // History lists what is done: no Pending card.
  const store = persistence([answered("waiting-one", false), information()]);
  const view = await mount(store.source());
  await chooseView(view.host, "History");
  expect(pendingToggle(view.host)).toBeNull();
});

test("Acknowledge on a done row takes it out of Pending through the undo bar", async () => {
  const store = persistence([decision("open-one"), answered("done-one", true)], { defaultSelector: "both" });
  const view = await mount(store.source());
  await act(async () => pendingToggle(view.host)!.click());
  await act(async () => button(item(view.host, "Question done-one")!, "Acknowledge").click());
  expect(item(view.host, "Question done-one")).toBeNull();
  expect(pendingToggle(view.host)).toBeNull();
  expect(undoButton(view.host)).not.toBeNull();
  await act(async () => undoButton(view.host)!.click());
  expect(pendingToggle(view.host)?.textContent).toContain("1 · answered, not closed yet");
});

test("an answer its agent acknowledged but has not finished stays in Pending, reading Answered", async () => {
  const acked = answered("acked-one", false);
  acked.state.acknowledgement = handling(acked.state.response!, "acknowledged");
  const store = persistence([decision("open-one"), acked], { defaultSelector: "both" });
  const view = await mount(store.source());
  expect(item(view.host, "Question acked-one")).toBeNull();
  expect(pendingToggle(view.host)?.textContent).toContain("1 · answered, not closed yet");
  await act(async () => pendingToggle(view.host)!.click());
  expect(item(view.host, "Question acked-one")!.textContent).toContain("Answered");
});

test("the top row is Needs you · All · History and a Filter icon; Filter shows its dropdowns first and Snoozed under them", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  const filterButton = view.host.querySelector<HTMLButtonElement>('button[aria-controls="home-feed-filters"]')!;
  const row = filterButton.parentElement!;
  expect([...row.querySelectorAll<HTMLInputElement>('[role="radiogroup"][aria-label="Feed view"] input')].map((input) => input.parentElement!.textContent)).toEqual(["Needs you1", "All", "History"]);
  expect([...row.children].filter((node) => node.tagName === "BUTTON").map((node) => node.textContent)).toEqual(["Filter"]);
  expect(view.host.querySelector('button[aria-controls="home-feed-view"]')).toBeNull();
  await act(async () => filterButton.click());
  const panel = view.host.querySelector<HTMLElement>("#home-feed-filters")!;
  const controls = [...panel.querySelectorAll<HTMLElement>("select, button")].map((node) => node.tagName === "SELECT" ? node.getAttribute("aria-label") : node.textContent);
  expect(controls).toEqual(["Filter by type", "Filter by priority", "Order", "Snoozed"]);
  await act(async () => button(panel, "Snoozed").click());
  expect(button(view.host.querySelector<HTMLElement>("#home-feed-filters") ?? view.host, "Clear filter")).toBeDefined();
});

test("the Agents pill opens every agent; an agent's page lists its cards and a card opens back in the feed", async () => {
  const store = persistence([decision("open-one"), answered("waiting-one", false)]);
  const view = await mount(store.source());
  await act(async () => view.host.querySelector<HTMLButtonElement>('header button[aria-label^="Agents"]')!.click());
  const list = view.host.querySelector<HTMLElement>('section[aria-label="Your agents"]')!;
  expect(list.textContent).toContain("Test agent");
  expect(list.textContent).toContain("Needs you: 1 card");
  await act(async () => [...list.querySelectorAll("button")].find((node) => node.textContent?.includes("Test agent"))!.click());
  const page = view.host.querySelector<HTMLElement>('section[aria-label="Conversation with Test agent"]')!;
  expect(page.textContent).toContain("Question open-one");
  expect(page.textContent).toContain("You chose Hold");
  // A card line goes back to the feed with that card open: the waiting one, inside the Pending card.
  await act(async () => [...page.querySelectorAll("button")].find((node) => node.textContent?.includes("Question waiting-one"))!.click());
  expect(view.host.querySelector('section[aria-label="Conversation with Test agent"]')).toBeNull();
  expect(card(view.host, "Question waiting-one")).toBeDefined();
  // And from a card: its agent's name, then "Open conversation".
  await act(async () => button(card(view.host, "Question waiting-one"), "Test agent").click());
  await act(async () => button(view.host, "Open conversation").click());
  expect(view.host.querySelector('section[aria-label="Conversation with Test agent"]')).not.toBeNull();
});
