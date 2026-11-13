import { expect, test } from "bun:test";
import type { FeedHandling } from "@tinycloud/sdk-services/feed";
import type { SitrepProjection } from "@tinyboilerplate/core/feed/sitrep";
import { cardStatus } from "./cardStatus";
import type { HomeFeedEntry } from "./feedStoreTypes";

const now = Date.parse("2026-11-12T12:00:00.000Z");
const identity = { cardId: "card-one", revision: 1, issuanceId: "issuance-one" };
function entry(change: (entry: HomeFeedEntry) => void = () => {}): HomeFeedEntry {
  const value: HomeFeedEntry = {
    source: { sourceId: "agent-one", agentDid: "did:key:status-test", label: "Test agent", output: { spaceId: "s", database: "out" }, responses: { spaceId: "s", database: "in" } },
    state: { card: { ...identity, kind: "question", needsResponse: true, title: "Question", body: "Body", urgency: 1, createdAt: "2026-11-12T11:00:00.000Z" }, response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "agent-one", ...identity },
  };
  change(value);
  return value;
}
const answered = (value: HomeFeedEntry) => { value.state.response = { ...identity, responseId: "answer-one", sequence: 1, kind: "answer", createdAt: "2026-11-12T11:10:00.000Z" }; };
const outcome = (phase: FeedHandling["phase"]) => (value: HomeFeedEntry) => { answered(value); value.state.outcome = { ...identity, responseId: "answer-one", handlingId: "h", phase, createdAt: "2026-11-12T11:20:00.000Z" }; };
const typed = (attention: SitrepProjection["attention"]) => ({ attention }) as SitrepProjection;

test("a plain card reads Needs you, Waiting on its agent, then Done or Failed; Snoozed and Information stay", () => {
  expect(cardStatus(entry(), undefined, now, "Test agent")).toBe("Needs you");
  expect(cardStatus(entry(answered), undefined, now, "Test agent")).toBe("Waiting on Test agent");
  expect(cardStatus(entry(outcome("succeeded")), undefined, now, "Test agent")).toBe("Done");
  expect(cardStatus(entry(outcome("failed")), undefined, now, "Test agent")).toBe("Failed");
  expect(cardStatus(entry((value) => { value.view.snoozedUntil = "2026-11-12T13:00:00.000Z"; }), undefined, now, "Test agent")).toBe("Snoozed");
  expect(cardStatus(entry((value) => { value.state.card.needsResponse = false; }), undefined, now, "Test agent")).toBe("Information");
});

test("a typed card keeps every state the page showed, each in one plain word", () => {
  const words = (["needs-action", "handled", "expired", "closed", "snoozed", "not-needed", "information"] as const).map((attention) => cardStatus(entry(), typed(attention), now, "Studio agent"));
  expect(words).toEqual(["Needs you", "Waiting on Studio agent", "Expired", "Closed", "Snoozed", "Not needed", "Information"]);
  expect(cardStatus(entry(outcome("succeeded")), typed("handled"), now, "Studio agent")).toBe("Done");
});

test("an outcome for an earlier answer does not mark a newer follow-up done", () => {
  const value = entry(outcome("succeeded"));
  value.state.response = { ...identity, responseId: "follow-up", sequence: 2, kind: "followup", createdAt: "2026-11-12T11:30:00.000Z" };
  expect(cardStatus(value, undefined, now, "Test agent")).toBe("Waiting on Test agent");
});

const acknowledged = (responseId = "answer-one") => (value: HomeFeedEntry) => {
  answered(value);
  value.state.acknowledgement = { ...identity, responseId, handlingId: "ack", phase: "acknowledged", createdAt: "2026-11-12T11:15:00.000Z" };
};

test("once the agent acknowledges the latest answer, a typed or plain card reads Answered until its outcome", () => {
  expect(cardStatus(entry(acknowledged()), typed("handled"), now, "Rocinante")).toBe("Answered");
  expect(cardStatus(entry(acknowledged()), undefined, now, "Test agent")).toBe("Answered");
  const done = entry(acknowledged());
  done.state.outcome = { ...identity, responseId: "answer-one", handlingId: "h", phase: "succeeded", createdAt: "2026-11-12T11:20:00.000Z" };
  expect(cardStatus(done, typed("handled"), now, "Rocinante")).toBe("Done");
});

test("an acknowledgement of an earlier answer leaves a newer follow-up Waiting", () => {
  const value = entry(acknowledged());
  value.state.response = { ...identity, responseId: "follow-up", sequence: 2, kind: "followup", createdAt: "2026-11-12T11:30:00.000Z" };
  expect(cardStatus(value, typed("handled"), now, "Rocinante")).toBe("Waiting on Rocinante");
});

test("a typed card closed after Sam answered it reads Answered; closed unanswered stays Closed", () => {
  const closedAnswered = { attention: "closed", answer: { askId: "a", action: "answer", text: "OK", at: "2026-11-12T11:10:00.000Z" } } as unknown as SitrepProjection;
  expect(cardStatus(entry(), closedAnswered, now, "Rocinante")).toBe("Answered");
  expect(cardStatus(entry(), typed("closed"), now, "Rocinante")).toBe("Closed");
});
