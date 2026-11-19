import { afterEach, beforeEach, expect, test } from "bun:test";
import { HELD_ANSWER_TTL_MS } from "./answerOutbox";
import type { HomeFeedEntry } from "./feedStoreTypes";
import { clearPostDraft, clearPostDrafts, labPageOf, pageAnswerPayload, pageSummary, postDraft, postDraftKey, postStatus, rememberPageAnswer, savePostDraft, type LabPage } from "./postAnswers";

const page: LabPage = {
  image: "/look.png", imageAlt: "The look",
  questions: [
    { id: "colour", header: "Colour", question: "Which colour?", options: [{ label: "Blue" }, { label: "Green" }] },
    { id: "names", question: "Which names?", multi: true, options: [{ label: "Ada" }, { label: "Bo" }] },
  ],
};
const identity = { cardId: "post-one", revision: 1, issuanceId: "issuance-one" };
function entry(change: (entry: HomeFeedEntry) => void = () => {}): HomeFeedEntry {
  const value: HomeFeedEntry = {
    source: { sourceId: "agent-one", agentDid: "did:key:post-test", label: "Test agent", output: { spaceId: "space-one", database: "out" }, responses: { spaceId: "space-one", database: "in" } },
    state: { card: { ...identity, kind: "page", needsResponse: true, title: "A post", body: "Body", urgency: 1, createdAt: "2026-11-12T11:00:00.000Z", payload: { page } }, response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "agent-one", ...identity },
  };
  change(value);
  return value;
}
const sentAs = (responseId: string) => (value: HomeFeedEntry) => { value.state.response = { ...identity, responseId, sequence: 1, kind: "answer", createdAt: "2026-11-12T11:10:00.000Z" }; };

const store = new Map<string, string>();
const storage = {
  get length() { return store.size; },
  key: (index: number) => [...store.keys()][index] ?? null,
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => store.clear(),
} as Storage;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeEach(() => { store.clear(); Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { localStorage: storage } }); });
afterEach(() => { if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as Record<string, unknown>).window; });

test("a post's answers go as a summary in words and a private feed.page payload of the answered questions", () => {
  const answers = { colour: { choices: ["Blue"], note: " darker " }, names: { choices: [], note: "" } };
  expect(labPageOf(entry())).toEqual(page);
  expect(pageSummary(page, answers)).toBe("Colour: Blue. darker");
  expect(pageAnswerPayload(page, answers)).toEqual({ type: "feed.page", version: 1, data: { answers: { colour: { choices: ["Blue"], note: "darker" } } } });
});

test("the status comes from the saved payload after a reload, and from the draft before anything is sent", () => {
  savePostDraft(entry(), { colour: { choices: ["Green"], note: "" } });
  expect(postStatus(entry(), page, "Needs you")).toBe("1 of 2 answered");
  const partial = entry((value) => { sentAs("answer-partial")(value); value.responsePayloads = { "answer-partial": pageAnswerPayload(page, { names: { choices: ["Ada", "Bo"], note: "" } }) }; });
  expect(postStatus(partial, page, "Waiting")).toBe("1 of 2 answered");
  const full = entry((value) => { sentAs("answer-full")(value); value.responsePayloads = { "answer-full": pageAnswerPayload(page, { colour: { choices: ["Blue"], note: "" }, names: { choices: ["Bo"], note: "" } }) }; });
  expect(postStatus(full, page, "Waiting")).toBe("Done");
  // Sent from this tab and not loaded back yet: the written payload stands in.
  rememberPageAnswer("answer-here", pageAnswerPayload(page, { colour: { choices: ["Blue"], note: "" }, names: { choices: [], note: "Neither" } }));
  expect(postStatus(entry(sentAs("answer-here")), page, "Waiting")).toBe("Done");
  // An answer without a page payload says what the feed says.
  clearPostDraft(entry());
  expect(postStatus(entry(sentAs("answer-plain")), page, "Waiting")).toBe("Waiting");
});

test("a draft is kept per owner and card, drops what the page no longer asks, and expires with the outbox", () => {
  savePostDraft(entry(), { colour: { choices: ["Red"], note: "" }, names: { choices: ["Ada", "Cy"], note: "" }, gone: { choices: [], note: "old" } });
  expect(postDraftKey(entry())).toBe(`tinychat.home.post-draft.v1:space-one:${JSON.stringify(["agent-one", "post-one"])}`);
  expect(postDraft(entry(), page)).toEqual({ names: { choices: ["Ada"], note: "" } });
  store.set(postDraftKey(entry()), JSON.stringify({ at: new Date(Date.now() - HELD_ANSWER_TTL_MS - 1000).toISOString(), answers: { colour: { choices: ["Blue"], note: "" } } }));
  expect(postDraft(entry(), page)).toBeUndefined();
  expect(store.size).toBe(0);
  savePostDraft(entry(), { colour: { choices: ["Blue"], note: "" } });
  clearPostDrafts("space-one");
  expect(store.size).toBe(0);
});
