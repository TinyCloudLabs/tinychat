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
function button(host: HTMLElement, label: string) {
  const node = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(node).toBeDefined();
  return node!;
}
function answer(host: HTMLElement) {
  const node = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Your answer"]');
  expect(node).not.toBeNull();
  return node!;
}
async function typeAnswer(host: HTMLElement, value: string) {
  const node = answer(host);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseView(host: HTMLElement, value: FeedSelector) {
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="Feed view"]');
  expect(selector).not.toBeNull();
  await act(async () => { selector!.value = value; selector!.dispatchEvent(new Event("change", { bubbles: true })); });
}
function handling(response: FeedResponse, phase: FeedHandling["phase"]): FeedHandling {
  return { cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId, handlingId: `handling-${phase}`, phase, createdAt, detail: { message: phase === "failed" ? "Action failed safely" : "Reversible action completed" } };
}

test("saving an answer waits for durability, then distinguishes saved, received, and completed", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await typeAnswer(view.host, "Proceed with the isolated action");
  await act(async () => button(view.host, "Save answer").click());
  expect(answer(view.host).value).toBe("Proceed with the isolated action");
  expect(store.responses).toEqual([]);
  expect(view.host.textContent).not.toContain("Answer saved");
  await act(async () => write.resolve());
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1", kind: "answer", text: "Proceed with the isolated action" });
  expect(view.host.textContent).toContain("Answer saved");
  expect(view.host.textContent).not.toContain("Agent received");
  expect(view.host.textContent).not.toContain("Completed");
  store.durable.entries[0]!.state.acknowledgement = handling(store.responses[0]!, "acknowledged");
  await act(async () => store.notify());
  expect(view.host.textContent).toContain("Agent received");
  expect(view.host.textContent).not.toContain("Completed");
  store.durable.entries[0]!.state.outcome = handling(store.responses[0]!, "succeeded");
  await act(async () => store.notify());
  expect(view.host.textContent).toContain("Completed");
  expect(view.host.textContent).toContain("Reversible action completed");
  await view.unmount();
  const reopened = await mount(store.source());
  await chooseView(reopened.host, "both");
  expect(reopened.host.textContent).toContain("Proceed with the isolated action");
  expect(reopened.host.textContent).toContain("Completed");
});

test("a rejected write keeps the draft actionable and does not imply receipt", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await typeAnswer(view.host, "Keep this unsaved answer");
  await act(async () => button(view.host, "Save answer").click());
  await act(async () => write.reject(new Error("Isolated SQL write denied")));
  expect(answer(view.host).value).toBe("Keep this unsaved answer");
  expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(button(view.host, "Save answer").disabled).toBe(false);
  expect(view.host.textContent).not.toContain("Answer saved");
  expect(view.host.textContent).not.toContain("Agent received");
  expect(store.responses).toEqual([]);
  await view.unmount();
  const reopened = await mount(store.source());
  expect(reopened.host.textContent).toContain("Question decision-one");
  expect(answer(reopened.host).value).toBe("");
});

test("information is nonactionable, Both mixes it with decisions, and seen is not answered", async () => {
  const store = persistence([decision(), information()]);
  const view = await mount(store.source());
  expect(view.host.textContent).toContain("Question decision-one");
  expect(view.host.textContent).not.toContain("Informational update");
  await chooseView(view.host, "information");
  expect(view.host.textContent).toContain("Informational update");
  expect(view.host.textContent).not.toContain("Question decision-one");
  expect(view.host.querySelector("textarea")).toBeNull();
  expect([...view.host.querySelectorAll("button")].some((node) => node.textContent === "Save answer")).toBe(false);
  await chooseView(view.host, "both");
  expect(view.host.textContent).toContain("Informational update");
  expect(view.host.textContent).toContain("Question decision-one");
  await chooseView(view.host, "needs-action");
  expect(view.host.textContent).toContain("Question decision-one");
  expect(store.durable.entries[0]!.view.seenAt).toBeDefined();
  expect(store.responses).toEqual([]);
});

test("new urgent arrivals cannot replace the focused response or its input node", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await typeAnswer(view.host, "Still answering the original question");
  const activeInput = answer(view.host);
  activeInput.focus();
  store.durable.entries.unshift(decision("urgent-new", 1, 100));
  await act(async () => store.notify());
  expect(answer(view.host) === activeInput).toBe(true);
  expect(document.activeElement === activeInput).toBe(true);
  expect(activeInput.value).toBe("Still answering the original question");
  await act(async () => button(view.host, "Save answer").click());
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, text: "Still answering the original question" });
});

test("an in-flight answer retains its exact issuance and loads its outcome after the latest snapshot replaces it", async () => {
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
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
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Completed");
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Answer for revision one only");
  await act(async () => button(view.host, "Next card").click());
  expect(answer(view.host).value).toBe("");
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).not.toContain("Answer saved");
  await view.unmount();
  const reopened = await mount(store.source());
  expect(answer(reopened.host).value).toBe("");
  expect(reopened.host.textContent).not.toContain("Answer saved");
});

test("snoozing removes attention without writing an answer and expiry restores it", async () => {
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await act(async () => button(view.host, "Snooze for 1 hour").click());
  expect(store.responses).toEqual([]);
  expect(store.durable.entries[0]!.view.snoozedUntil).toBeDefined();
  expect(view.host.querySelector("textarea")).toBeNull();
  store.durable.entries[0]!.view.snoozedUntil = "2000-01-01T00:00:00Z";
  await act(async () => store.notify());
  expect(view.host.textContent).toContain("Question decision-one");
  expect(answer(view.host).value).toBe("");
  expect(view.host.textContent).not.toContain("Answer saved");
});

test("the explicit saved default reaches another session without every view change becoming the default", async () => {
  const store = persistence([decision(), information()]);
  const view = await mount(store.source());
  await chooseView(view.host, "information");
  expect(store.durable.settings.defaultSelector).toBe("needs-action");
  await act(async () => button(view.host, "Use as default").click());
  await view.unmount();
  const secondSession = await mount(store.source());
  expect(secondSession.host.querySelector<HTMLSelectElement>('select[aria-label="Feed view"]')?.value).toBe("information");
  expect(secondSession.host.textContent).toContain("Informational update");
  expect(secondSession.host.querySelector("textarea")).toBeNull();
});

test("a failed outcome stays distinct from an unsaved answer and keeps source/report links", async () => {
  const entry = decision();
  entry.state.response = { cardId: "decision-one", revision: 1, issuanceId: "issuance-1", responseId: "saved-response", sequence: 1, kind: "answer", choiceId: "hold", createdAt };
  entry.state.acknowledgement = handling(entry.state.response, "acknowledged");
  entry.state.outcome = handling(entry.state.response, "failed");
  const store = persistence([entry], { defaultSelector: "both" });
  const view = await mount(store.source());
  expect(view.host.textContent).toContain("Answer saved");
  expect(view.host.textContent).toContain("Agent received");
  expect(view.host.textContent).toContain("Failed");
  expect(view.host.textContent).toContain("Action failed safely");
  expect(view.host.querySelector("a[href='https://example.org/source']")).not.toBeNull();
  expect(view.host.querySelector("a[href='https://example.org/report']")).not.toBeNull();
  await chooseView(view.host, "needs-action");
  expect(view.host.querySelector("textarea")).toBeNull();
  expect(store.responses).toEqual([]);
});

test("a true latest-issuance replacement preserves the draft until explicit navigation", async () => {
  const original = decision();
  original.state.card.title = "Original question";
  const store = persistence([original]);
  const view = await mount(store.source());
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
  expect(view.host.querySelector('[aria-label="Focused card"] h2')?.textContent).toBe("Original question");
  await act(async () => button(view.host, "Next card").click());
  expect(view.host.querySelector('[aria-label="Focused card"] h2')?.textContent).toBe("Replacement question");
  expect(answer(view.host).value).toBe("");
});

test("Next card advances through all three cards before wrapping", async () => {
  const store = persistence([decision("a", 1, 3), decision("b", 1, 2), decision("c", 1, 1)]);
  const view = await mount(store.source());
  const title = () => view.host.querySelector('[aria-label="Focused card"] h2')?.textContent;
  expect(title()).toBe("Question a");
  await act(async () => button(view.host, "Next card").click());
  expect(title()).toBe("Question b");
  await act(async () => button(view.host, "Next card").click());
  expect(title()).toBe("Question c");
  await act(async () => button(view.host, "Next card").click());
  expect(title()).toBe("Question a");
});
