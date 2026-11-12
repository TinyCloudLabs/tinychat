import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedHandling, FeedResponse, FeedSelector, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { ANSWER_UNDO_SECONDS } from "./AnswerOptions";
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
  jest.useRealTimers();
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
  const node = host.querySelector<HTMLTextAreaElement>('textarea[name="answer"]');
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
/** Lets `seconds` of the undo window pass; all of it by default, so a held answer is sent. Needs jest.useFakeTimers(). */
async function wait(seconds = ANSWER_UNDO_SECONDS) {
  await act(async () => { jest.advanceTimersByTime(seconds * 1_000); });
}
const announced = (host: HTMLElement) => host.querySelector('form [role="status"]')?.textContent;
async function chooseView(host: HTMLElement, value: FeedSelector) {
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="Feed view"]');
  expect(selector).not.toBeNull();
  await act(async () => { selector!.value = value; selector!.dispatchEvent(new Event("change", { bubbles: true })); });
}
function handling(response: FeedResponse, phase: FeedHandling["phase"]): FeedHandling {
  return { cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId, handlingId: `handling-${phase}`, phase, createdAt, detail: { message: phase === "failed" ? "Action failed safely" : "Reversible action completed" } };
}
/** Each step of the answer on show and its state, e.g. "received:done"; null when no answer shows. */
function steps(scope: ParentNode | null | undefined) {
  const list = scope?.querySelector('[aria-label="Answer steps"]');
  return list ? [...list.querySelectorAll<HTMLElement>("li")].map((step) => `${step.dataset.step}:${step.dataset.state}`) : null;
}

test("saving an answer waits for durability, then distinguishes saved, received, and completed", async () => {
  jest.useFakeTimers();
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await typeAnswer(view.host, "Proceed with the isolated action");
  await act(async () => button(view.host, "Send answer").click());
  await wait();
  expect(button(view.host, "Sending…").disabled).toBe(true);
  expect(answer(view.host).value).toBe("Proceed with the isolated action");
  expect(store.responses).toEqual([]);
  expect(steps(view.host)).toBeNull();
  await act(async () => write.resolve());
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1", kind: "answer", text: "Proceed with the isolated action" });
  expect(steps(view.host)).toEqual(["sent:done", "received:upcoming", "outcome:upcoming"]);
  store.durable.entries[0]!.state.acknowledgement = handling(store.responses[0]!, "acknowledged");
  await act(async () => store.notify());
  expect(steps(view.host)).toEqual(["sent:done", "received:done", "outcome:upcoming"]);
  store.durable.entries[0]!.state.outcome = handling(store.responses[0]!, "succeeded");
  await act(async () => store.notify());
  expect(steps(view.host)).toEqual(["sent:done", "received:done", "outcome:done"]);
  expect(view.host.textContent).toContain("Completed");
  expect(view.host.textContent).toContain("Reversible action completed");
  await view.unmount();
  const reopened = await mount(store.source());
  await chooseView(reopened.host, "both");
  expect(reopened.host.textContent).toContain("Proceed with the isolated action");
  expect(steps(reopened.host)).toEqual(["sent:done", "received:done", "outcome:done"]);
});

test("a rejected write keeps the draft actionable and does not imply receipt", async () => {
  jest.useFakeTimers();
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await typeAnswer(view.host, "Keep this unsaved answer");
  await act(async () => button(view.host, "Send answer").click());
  await wait();
  await act(async () => write.reject(new Error("Isolated SQL write denied")));
  expect(answer(view.host).value).toBe("Keep this unsaved answer");
  expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Isolated SQL write denied");
  expect(button(view.host, "Send answer").disabled).toBe(false);
  expect(steps(view.host)).toBeNull();
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
  expect([...view.host.querySelectorAll("button")].some((node) => node.textContent === "Send answer")).toBe(false);
  await chooseView(view.host, "both");
  expect(view.host.textContent).toContain("Informational update");
  expect(view.host.textContent).toContain("Question decision-one");
  await chooseView(view.host, "needs-action");
  expect(view.host.textContent).toContain("Question decision-one");
  expect(store.durable.entries[0]!.view.seenAt).toBeDefined();
  expect(store.responses).toEqual([]);
});

test("new urgent arrivals cannot replace the focused response or its input node", async () => {
  jest.useFakeTimers();
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
  await act(async () => button(view.host, "Send answer").click());
  await wait();
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, text: "Still answering the original question" });
});

test("an in-flight answer retains its exact issuance and loads its outcome after the latest snapshot replaces it", async () => {
  jest.useFakeTimers();
  const write = Promise.withResolvers<void>();
  const store = persistence([decision()], { beforeSave: () => write.promise });
  const view = await mount(store.source());
  await typeAnswer(view.host, "Answer for revision one only");
  const originalInput = answer(view.host);
  await act(async () => button(view.host, "Send answer").click());
  await wait();
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
  expect(steps(view.host.querySelector('[aria-label="Focused card"]'))).toEqual(["sent:done", "received:done", "outcome:done"]);
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Answer for revision one only");
  await act(async () => button(view.host, "Next card").click());
  expect(answer(view.host).value).toBe("");
  expect(steps(view.host.querySelector('[aria-label="Focused card"]'))).toBeNull();
  await view.unmount();
  const reopened = await mount(store.source());
  expect(answer(reopened.host).value).toBe("");
  expect(steps(reopened.host)).toBeNull();
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
  expect(steps(view.host)).toBeNull();
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
  expect(steps(view.host)).toEqual(["sent:done", "received:done", "outcome:failed"]);
  expect(view.host.textContent).toContain("Failed");
  expect(view.host.textContent).not.toContain("Completed");
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

test("each step that has arrived shows its own time, a waiting one says so, and an outcome with no separate receipt still counts as received", async () => {
  const entry = decision();
  entry.state.response = { cardId: "decision-one", revision: 1, issuanceId: "issuance-1", responseId: "saved-response", sequence: 1, kind: "answer", choiceId: "proceed", createdAt: "2026-10-28T12:01:00Z" };
  const store = persistence([entry], { defaultSelector: "both" });
  const view = await mount(store.source());
  const times = () => [...view.host.querySelectorAll('[aria-label="Answer steps"] li')].map((step) => step.querySelector("time")?.getAttribute("datetime") ?? null);
  expect(steps(view.host)).toEqual(["sent:done", "received:upcoming", "outcome:upcoming"]);
  expect(times()).toEqual(["2026-10-28T12:01:00Z", null, null]);
  expect(view.host.querySelector('[data-step="received"]')?.textContent).toBe("Agent received, not yet");
  store.durable.entries[0]!.state.outcome = { ...handling(entry.state.response, "succeeded"), createdAt: "2026-10-28T12:03:00Z" };
  await act(async () => store.notify());
  expect(steps(view.host)).toEqual(["sent:done", "received:done", "outcome:done"]);
  expect(times()).toEqual(["2026-10-28T12:01:00Z", null, "2026-10-28T12:03:00Z"]);
  store.durable.entries[0]!.state.acknowledgement = { ...handling(entry.state.response, "acknowledged"), createdAt: "2026-10-28T12:02:00Z" };
  await act(async () => store.notify());
  expect(times()).toEqual(["2026-10-28T12:01:00Z", "2026-10-28T12:02:00Z", "2026-10-28T12:03:00Z"]);
});

test("one tap chooses: the option is pressed, the others dim, and nothing is saved until the undo window runs out", async () => {
  jest.useFakeTimers();
  const store = persistence([decision()]);
  const view = await mount(store.source());
  expect(view.host.querySelector('input[type="radio"]')).toBeNull();
  expect(view.host.textContent).toContain(`Your answer is sent ${ANSWER_UNDO_SECONDS} seconds after you tap an option or press Send. You can undo it until then, not after.`);
  await act(async () => button(view.host, "Proceed").click());
  expect(button(view.host, "Proceed").getAttribute("aria-pressed")).toBe("true");
  expect(button(view.host, "Hold").disabled).toBe(true);
  expect(answer(view.host).disabled).toBe(true);
  expect(view.host.textContent).toContain(`Sending to Test agent in ${ANSWER_UNDO_SECONDS}s`);
  expect(announced(view.host)).toBe(`Sending in ${ANSWER_UNDO_SECONDS} seconds. Undo is available until then.`);
  await wait(ANSWER_UNDO_SECONDS - 1);
  expect(view.host.textContent).toContain("Sending to Test agent in 1s");
  expect(store.responses).toEqual([]);
  await wait(1);
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ cardId: "decision-one", revision: 1, issuanceId: "issuance-1", kind: "answer", choiceId: "proceed" });
  expect(store.responses[0]!.text).toBeUndefined();
  expect(steps(view.host)).toEqual(["sent:done", "received:upcoming", "outcome:upcoming"]);
});

test("Undo within the window returns the card to how it was and saves nothing", async () => {
  jest.useFakeTimers();
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await act(async () => button(view.host, "Hold").click());
  await wait(ANSWER_UNDO_SECONDS - 1);
  await act(async () => button(view.host, "Undo").click());
  expect(button(view.host, "Hold").getAttribute("aria-pressed")).toBe("false");
  expect(button(view.host, "Proceed").disabled).toBe(false);
  expect(answer(view.host).disabled).toBe(false);
  expect(view.host.textContent).not.toContain("Sending in");
  expect([...view.host.querySelectorAll("button")].some((node) => node.textContent === "Undo")).toBe(false);
  expect(announced(view.host)).toBe("Undone. Nothing was sent.");
  await wait(ANSWER_UNDO_SECONDS * 3);
  expect(store.responses).toEqual([]);
  expect(steps(view.host)).toBeNull();
});

test("a typed answer has its own Send with the same undo window, and Undo keeps the draft", async () => {
  jest.useFakeTimers();
  const store = persistence([decision()]);
  const view = await mount(store.source());
  expect(button(view.host, "Send answer").disabled).toBe(true);
  await typeAnswer(view.host, "Hold until the report is in");
  await act(async () => button(view.host, "Send answer").click());
  expect(button(view.host, `Sending to Test agent in ${ANSWER_UNDO_SECONDS}s`).disabled).toBe(true);
  expect(button(view.host, "Proceed").disabled).toBe(true);
  await act(async () => button(view.host, "Undo").click());
  expect(answer(view.host).value).toBe("Hold until the report is in");
  expect(button(view.host, "Send answer").disabled).toBe(false);
  await wait();
  expect(store.responses).toEqual([]);
  await act(async () => button(view.host, "Send answer").click());
  await wait();
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ kind: "answer", text: "Hold until the report is in" });
  expect(store.responses[0]!.choiceId).toBeUndefined();
});

test("a tapped option takes the typed answer with it", async () => {
  jest.useFakeTimers();
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await typeAnswer(view.host, "Only for this week");
  await act(async () => button(view.host, "Proceed").click());
  await wait();
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ choiceId: "proceed", text: "Only for this week" });
});

test("a failed send shows the error beside Try again, which resends the same response", async () => {
  jest.useFakeTimers();
  let refuse = true;
  const store = persistence([decision()], { beforeSave: async () => { if (refuse) throw new Error("Isolated SQL write denied"); } });
  const source = store.source();
  const attempts: string[] = [];
  const save = source.saveResponse;
  source.saveResponse = async (entry, response, payload) => { attempts.push(response.responseId); return save(entry, response, payload); };
  const view = await mount(source);
  await act(async () => button(view.host, "Proceed").click());
  await wait();
  const alert = view.host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Isolated SQL write denied");
  expect(button(view.host, "Proceed").getAttribute("aria-pressed")).toBe("true");
  expect(button(view.host, "Hold").disabled).toBe(false);
  expect(store.responses).toEqual([]);
  refuse = false;
  await act(async () => [...alert!.querySelectorAll("button")].find((node) => node.textContent === "Try again")!.click());
  expect(store.responses).toHaveLength(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]!);
  expect(store.responses[0]).toMatchObject({ responseId: attempts[0], choiceId: "proceed" });
  expect(view.host.querySelector('[role="alert"]')).toBeNull();
});

test("leaving the card during the undo window sends the answer at once, to the card it was given on", async () => {
  jest.useFakeTimers();
  const store = persistence([decision("a", 1, 2), decision("b", 1, 1)]);
  const view = await mount(store.source());
  await act(async () => button(view.host, "Hold").click());
  await wait(1);
  expect(store.responses).toEqual([]);
  await act(async () => button(view.host, "Next card").click());
  expect(view.host.querySelector('[aria-label="Focused card"] h2')?.textContent).toBe("Question b");
  expect(store.responses).toHaveLength(1);
  expect(store.responses[0]).toMatchObject({ cardId: "a", kind: "answer", choiceId: "hold" });
  await wait(ANSWER_UNDO_SECONDS * 3);
  expect(store.responses).toHaveLength(1);
});

const fold = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Focused card"] [aria-label="Answer sent"]');
/** Whether the focused card is folded away, leaving only the line that says what was chosen. */
const folded = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Focused card"] article')!.parentElement!.hidden;

test("once sent, the card folds to what was chosen with its steps, and Show card opens it again", async () => {
  jest.useFakeTimers();
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await act(async () => button(view.host, "Proceed").click());
  expect(fold(view.host)).toBeNull();
  expect(folded(view.host)).toBe(false);
  await wait();
  const line = fold(view.host)!;
  expect(line.textContent).toContain("You chose Proceed");
  expect(line.textContent).toContain("Question decision-one");
  expect(steps(line)).toEqual(["sent:done", "received:upcoming", "outcome:upcoming"]);
  expect(folded(view.host)).toBe(true);
  expect(document.activeElement === line).toBe(true);
  store.durable.entries[0]!.state.acknowledgement = handling(store.responses[0]!, "acknowledged");
  await act(async () => store.notify());
  expect(steps(fold(view.host))).toEqual(["sent:done", "received:done", "outcome:upcoming"]);
  store.durable.entries[0]!.state.outcome = handling(store.responses[0]!, "succeeded");
  await act(async () => store.notify());
  expect(steps(fold(view.host))).toEqual(["sent:done", "received:done", "outcome:done"]);
  expect(fold(view.host)!.textContent).toContain("Reversible action completed");
  expect(fold(view.host) === line).toBe(true);
  await act(async () => button(view.host, "Show card").click());
  expect(folded(view.host)).toBe(false);
  expect(button(view.host, "Hide card").getAttribute("aria-expanded")).toBe("true");
  expect(steps(fold(view.host))).toBeNull();
  expect(steps(view.host.querySelector('[aria-label="Answer status"]'))).toEqual(["sent:done", "received:done", "outcome:done"]);
  await act(async () => button(view.host, "Hide card").click());
  expect(folded(view.host)).toBe(true);
  expect(button(view.host, "Show card").getAttribute("aria-expanded")).toBe("false");
});

test("a typed answer folds to its own words, and a follow-up from the opened card folds again", async () => {
  jest.useFakeTimers();
  const store = persistence([decision()]);
  const view = await mount(store.source());
  await typeAnswer(view.host, "Hold until the report is in");
  await act(async () => button(view.host, "Send answer").click());
  await wait();
  expect(fold(view.host)!.textContent).toContain("You answered “Hold until the report is in”");
  expect(folded(view.host)).toBe(true);
  await act(async () => button(view.host, "Show card").click());
  await act(async () => button(view.host, "Add follow-up").click());
  expect(view.host.textContent).toContain("A follow-up does not cancel an action already received by the agent.");
  await act(async () => button(view.host, "Hold").click());
  await wait();
  expect(store.responses).toHaveLength(2);
  expect(store.responses[1]).toMatchObject({ kind: "followup", choiceId: "hold", supersedesResponseId: store.responses[0]!.responseId });
  expect(fold(view.host)!.textContent).toContain("You chose Hold");
  expect(folded(view.host)).toBe(true);
});

test("the fold belongs to the answered card: the next card opens whole", async () => {
  jest.useFakeTimers();
  const store = persistence([decision("a", 1, 2), decision("b", 1, 1)]);
  const view = await mount(store.source());
  await act(async () => button(view.host, "Proceed").click());
  await wait();
  expect(fold(view.host)!.textContent).toContain("Question a");
  await act(async () => button(view.host, "Next card").click());
  expect(view.host.querySelector('[aria-label="Focused card"] h2')?.textContent).toBe("Question b");
  expect(fold(view.host)).toBeNull();
  expect(folded(view.host)).toBe(false);
  expect(button(view.host, "Proceed").getAttribute("aria-pressed")).toBe("false");
});
