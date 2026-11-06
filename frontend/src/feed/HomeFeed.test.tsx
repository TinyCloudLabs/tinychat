import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedHandling, FeedResponse, FeedSelector, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
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
function persistence(entries: HomeFeedEntry[], options: { beforeSave?: () => Promise<void>; defaultSelector?: FeedSelector } = {}) {
  const durable: HomeFeedSnapshot = { entries: structuredClone(entries), settings: { defaultSelector: options.defaultSelector ?? "needs-action" } };
  const archive = [...durable.entries];
  const listeners = new Set<() => void>();
  const responses: FeedResponse[] = [];
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
  return { durable, archive, responses, source, notify: () => { for (const listener of listeners) listener(); } };
}

let restore: (() => void) | undefined;
const roots = new Set<Root>();
const originalFetch = globalThis.fetch;
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  globalThis.fetch = originalFetch;
  restore?.(); restore = undefined;
});
async function mount(source: HomeFeedSource) {
  restore ??= installDom();
  // Legacy sample transport is inert, never used as evidence of real feed data.
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const props: HomeFeedEntriesProps = { realEntries: [], source };
  await act(async () => root.render(<FeedViewEntries {...props} />));
  return { host, async unmount() { await act(async () => root.unmount()); roots.delete(root); host.remove(); } };
}
function button(host: ParentNode, label: string) {
  const node = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(node).toBeDefined();
  return node!;
}
function hasButton(host: ParentNode, label: string) {
  return [...host.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === label);
}
function answer(host: HTMLElement) {
  const node = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your answer"]');
  expect(node).not.toBeNull();
  return node!;
}
function option(host: ParentNode, label: string) {
  const node = [...host.querySelectorAll('[role="group"][aria-label="Answers"] button')].find((candidate) => candidate.textContent?.includes(label));
  expect(node).toBeDefined();
  return node as HTMLButtonElement;
}
function card(host: HTMLElement, title: string) {
  const node = host.querySelector<HTMLElement>(`article[aria-label="${title}"]`);
  expect(node).not.toBeNull();
  return node!;
}
function status(host: ParentNode) {
  return host.querySelector('[role="status"][aria-label="Your answer"]')?.textContent ?? null;
}
async function openNote(host: HTMLElement) {
  await act(async () => button(host, "Add a note").click());
}
async function typeAnswer(host: HTMLElement, value: string) {
  const node = answer(host);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function segment(host: HTMLElement, label: "Needs you" | "All" | "Done") {
  const node = [...host.querySelectorAll('[role="group"][aria-label="Show"] button')].find((candidate) => candidate.textContent?.startsWith(label));
  expect(node).toBeDefined();
  return node as HTMLButtonElement;
}
async function chooseView(host: HTMLElement, label: "Needs you" | "All" | "Done") {
  await act(async () => segment(host, label).click());
}
function handling(response: FeedResponse, phase: FeedHandling["phase"]): FeedHandling {
  return { cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId, handlingId: `handling-${phase}`, phase, createdAt, detail: { message: phase === "failed" ? "Action failed safely" : "Reversible action completed" } };
}

test("saving an answer waits for durability, then distinguishes saved, received, and completed", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await openNote(view.host);
  await typeAnswer(view.host, "Proceed with the isolated action");
  await act(async () => button(view.host, "Save answer").click());
  expect(answer(view.host).value).toBe("Proceed with the isolated action");
  expect(store.responses).toEqual([]);
  expect(status(view.host)).toBeNull();
  await act(async () => write.resolve());
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1", kind: "answer", text: "Proceed with the isolated action" });
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
  expect(status(reopened.host)).toContain("Proceed with the isolated action");
  expect(status(reopened.host)).toContain("finished it");
});

test("one tap saves the option once, and Change answer saves a follow-up that replaces it", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await act(async () => option(view.host, "Hold").click());
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1", kind: "answer", choiceId: "hold" });
  expect(store.responses[0]!.supersedesResponseId).toBeUndefined();
  // The answered card stays in Needs you, showing the label (never the id) and Change answer.
  expect(status(view.host)).toContain("You chose Hold.");
  expect(view.host.querySelector('[role="group"][aria-label="Answers"]')).toBeNull();
  await act(async () => button(view.host, "Change answer").click());
  await act(async () => option(view.host, "Proceed").click());
  expect(store.responses).toHaveLength(2);
  expect(store.responses[1]).toMatchObject({ kind: "followup", choiceId: "proceed", supersedesResponseId: store.responses[0]!.responseId });
  expect(status(view.host)).toContain("You chose Proceed.");
});

test("Keep my answer leaves the saved answer untouched", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await act(async () => option(view.host, "Hold").click());
  await act(async () => button(view.host, "Change answer").click());
  await act(async () => button(view.host, "Keep my answer").click());
  expect(store.responses).toHaveLength(1);
  expect(status(view.host)).toContain("You chose Hold.");
});

test("a rejected write keeps the draft actionable and does not imply receipt", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await openNote(view.host);
  await typeAnswer(view.host, "Keep this unsaved answer");
  await act(async () => button(view.host, "Save answer").click());
  await act(async () => write.reject(new Error("Isolated SQL write denied")));
  expect(answer(view.host).value).toBe("Keep this unsaved answer");
  const alert = view.host.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("Your answer wasn't saved. Try again.");
  expect(button(view.host, "Save answer").disabled).toBe(false);
  expect(status(view.host)).toBeNull();
  expect(store.responses).toEqual([]);
  await view.unmount();
  const reopened = await mount(store.source());
  expect(card(reopened.host, "Question decision-one")).toBeDefined();
  await openNote(reopened.host);
  expect(answer(reopened.host).value).toBe("");
});

test("a retried tap after a failed write reuses its response identity", async () => {
  let fail = true;
  const store = persistence([decision()], { beforeSave: async () => { if (fail) throw new Error("Isolated SQL write denied"); } });
  const ids: string[] = [];
  const base = store.source();
  const view = await mount({ ...base, async saveResponse(entry, response, payload) { ids.push(response.responseId); return base.saveResponse(entry, response, payload); } });
  await act(async () => option(view.host, "Hold").click());
  expect(store.responses).toEqual([]);
  fail = false;
  await act(async () => option(view.host, "Hold").click());
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]!);
  expect(store.responses).toHaveLength(1);
});

test("information is nonactionable, All mixes it with decisions, and seen is not answered", async () => {
  const store = persistence([decision(), information()]);
  const view = await mount(store.source());
  expect(segment(view.host, "Needs you").getAttribute("aria-pressed")).toBe("true");
  expect(view.host.textContent).toContain("Question decision-one");
  expect(view.host.textContent).not.toContain("Informational update");
  await chooseView(view.host, "All");
  expect(segment(view.host, "All").getAttribute("aria-pressed")).toBe("true");
  expect(segment(view.host, "Needs you").getAttribute("aria-pressed")).toBe("false");
  expect(view.host.textContent).toContain("Informational update");
  expect(view.host.textContent).toContain("Question decision-one");
  const info = card(view.host, "Informational update");
  expect(info.querySelector("textarea")).toBeNull();
  expect(info.querySelector('[role="group"][aria-label="Answers"]')).toBeNull();
  await chooseView(view.host, "Needs you");
  expect(view.host.textContent).not.toContain("Informational update");
  await act(async () => card(view.host, "Question decision-one").querySelector<HTMLButtonElement>("h3 button")!.click());
  expect(store.durable.entries[0]!.view.seenAt).toBeDefined();
  expect(store.responses).toEqual([]);
});

test("a collapsed card expands in place and keeps its draft", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  const article = card(view.host, "Question decision-one");
  const title = article.querySelector<HTMLButtonElement>("h3 button")!;
  expect(title.getAttribute("aria-expanded")).toBe("false");
  expect(article.querySelector("a[href='https://example.org/source']")).toBeNull();
  await openNote(view.host);
  await typeAnswer(view.host, "Draft before expanding");
  const input = answer(view.host);
  await act(async () => title.click());
  expect(title.getAttribute("aria-expanded")).toBe("true");
  expect(card(view.host, "Question decision-one") === article).toBe(true);
  expect(article.querySelector("a[href='https://example.org/source']")).not.toBeNull();
  expect(answer(view.host) === input).toBe(true);
  expect(input.value).toBe("Draft before expanding");
  await act(async () => title.click());
  expect(title.getAttribute("aria-expanded")).toBe("false");
  expect(store.responses).toEqual([]);
});

test("new urgent arrivals cannot replace the focused response or its input node", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await openNote(view.host);
  await typeAnswer(view.host, "Still answering the original question");
  const activeInput = answer(view.host);
  activeInput.focus();
  store.durable.entries.unshift(decision("urgent-new", 1, 100));
  await act(async () => store.notify());
  expect(card(view.host, "Question urgent-new")).toBeDefined();
  expect(answer(view.host) === activeInput).toBe(true);
  expect(document.activeElement === activeInput).toBe(true);
  expect(activeInput.value).toBe("Still answering the original question");
  await act(async () => button(card(view.host, "Question decision-one"), "Save answer").click());
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, text: "Still answering the original question" });
});

test("an in-flight answer retains its exact issuance and loads its outcome after the latest snapshot replaces it", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await openNote(view.host);
  await typeAnswer(view.host, "Answer for revision one only");
  const originalInput = answer(view.host);
  await act(async () => button(view.host, "Save answer").click());
  store.durable.entries = [decision("decision-one", 2)];
  await act(async () => store.notify());
  expect(answer(view.host) === originalInput).toBe(true);
  expect(originalInput.value).toBe("Answer for revision one only");
  await act(async () => write.resolve());
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1" });
  expect(store.durable.entries[0]!.state.response).toBeNull();
  store.archive[0]!.state.acknowledgement = handling(store.responses[0]!, "acknowledged");
  store.archive[0]!.state.outcome = handling(store.responses[0]!, "succeeded");
  await act(async () => store.notify());
  expect(status(view.host)).toContain("finished it");
  expect(status(view.host)).toContain("Answer for revision one only");
  await act(async () => button(view.host, "Show the newer version").click());
  expect(status(view.host)).toBeNull();
  await openNote(view.host);
  expect(answer(view.host).value).toBe("");
  await view.unmount();
  const reopened = await mount(store.source());
  expect(status(reopened.host)).toBeNull();
});

test("snoozing removes attention without writing an answer and expiry restores it", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await act(async () => button(view.host, "Ask me later").click());
  const presets = view.host.querySelector('[role="group"][aria-label="Ask me later"]')!;
  await act(async () => presets.querySelector("button")!.click());
  expect(store.responses).toEqual([]);
  expect(store.durable.entries[0]!.view.snoozedUntil).toBeDefined();
  expect(view.host.querySelector("article")).toBeNull();
  expect(view.host.textContent).toContain("Nothing needs you right now.");
  store.durable.entries[0]!.view.snoozedUntil = "2000-01-01T00:00:00Z";
  await act(async () => store.notify());
  expect(view.host.textContent).toContain("Question decision-one");
  expect(status(view.host)).toBeNull();
  expect(option(view.host, "Hold")).toBeDefined();
});

test("the last view is remembered for the next session; Done is not", async () => {
  const store = persistence([decision(), information()]);
  const view = await mount(store.source());
  await chooseView(view.host, "All");
  expect(store.durable.settings.defaultSelector).toBe("both");
  await chooseView(view.host, "Done");
  expect(store.durable.settings.defaultSelector).toBe("both");
  await view.unmount();
  const secondSession = await mount(store.source());
  expect(segment(secondSession.host, "All").getAttribute("aria-pressed")).toBe("true");
  expect(secondSession.host.textContent).toContain("Informational update");
});

test("a failed outcome stays distinct from an unsaved answer and keeps source/report links", async () => {
  const entry = decision();
  entry.state.response = { cardId: "decision-one", revision: 1, issuanceId: "issuance-1", responseId: "saved-response", sequence: 1, kind: "answer", choiceId: "hold", createdAt };
  entry.state.acknowledgement = handling(entry.state.response, "acknowledged");
  entry.state.outcome = handling(entry.state.response, "failed");
  const store = persistence([entry], { defaultSelector: "both" });
  const view = await mount(store.source());
  expect(status(view.host)).toContain("You chose Hold.");
  expect(status(view.host)).toContain("Test agent got it.");
  expect(status(view.host)).toContain("couldn't finish it");
  expect(status(view.host)).toContain("Action failed safely");
  expect(view.host.querySelector("a[href='https://example.org/report']")).not.toBeNull();
  await act(async () => card(view.host, "Question decision-one").querySelector<HTMLButtonElement>("h3 button")!.click());
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
  expect(view.host.querySelector("article h3")?.textContent).toBe("Original question");
  expect(view.host.querySelectorAll("article")).toHaveLength(1);
  await act(async () => button(view.host, "Show the newer version").click());
  expect(view.host.querySelector("article h3")?.textContent).toBe("Replacement question");
  expect(view.host.querySelector('textarea[aria-label="Your answer"]')).toBeNull();
  expect(hasButton(view.host, "Add a note")).toBe(true);
  expect(store.responses).toEqual([]);
});

test("a (Recommended) label shows without the marker and with the Suggested tag, and a tap saves the unchanged choice", async () => {
  const entry = decision();
  entry.state.card.choices = [{ id: "proceed", label: "Proceed (Recommended)" }, { id: "hold", label: "Hold" }];
  const store = persistence([entry]);
  const view = await mount(store.source());
  const proceed = option(view.host, "Proceed");
  expect(proceed.textContent).toBe("Proceed Suggested");
  expect(option(view.host, "Hold").textContent).toBe("Hold");
  await act(async () => proceed.click());
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ kind: "answer", choiceId: "proceed" });
  expect(store.durable.entries[0]!.state.card.choices?.[0]?.label).toBe("Proceed (Recommended)");
  expect(status(view.host)).toContain("You chose Proceed.");
});

test("a replaced issuance refuses new answers: no write ever carries the old identity", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await openNote(view.host);
  await typeAnswer(view.host, "Drafted against revision one");
  store.durable.entries = [decision("decision-one", 2)];
  await act(async () => store.notify());
  // The old issuance stays on screen with its draft, but every way to answer it is refused.
  expect(answer(view.host).value).toBe("Drafted against revision one");
  expect(option(view.host, "Hold").disabled).toBe(true);
  expect(button(view.host, "Save answer").disabled).toBe(true);
  await act(async () => option(view.host, "Hold").click());
  await act(async () => { answer(view.host).form!.requestSubmit(); });
  expect(store.responses).toEqual([]);
  await act(async () => button(view.host, "Show the newer version").click());
  await act(async () => option(view.host, "Hold").click());
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 2, issuanceId: "issuance-2", choiceId: "hold" });
  expect(store.responses.some((response) => response.revision === 1)).toBe(false);
});
