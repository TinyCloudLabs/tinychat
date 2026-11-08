import { expect, test } from "bun:test";
import { audienceCopy, displayOptions, isReplyOnlyRevision, optionText } from "./cardKit";
import type { HomeFeedEntry } from "./feedStoreTypes";

const options = [{ id: "yes", label: "Yes: node caches too (Recommended)" }, { id: "no", label: "No: client cache only" }];

test("a trailing (Recommended) marker comes off the label and marks that option suggested", () => {
  expect(displayOptions(options)).toEqual({ options: [{ id: "yes", label: "Yes: node caches too" }, { id: "no", label: "No: client cache only" }], suggested: "yes" });
  expect(optionText("Ship it  ( recommended )")).toBe("Ship it  ( recommended )");
  expect(optionText("Ship it (RECOMMENDED) ")).toBe("Ship it");
});

test("the card's own recommendation wins over a marker in a label", () => {
  expect(displayOptions(options, "no").suggested).toBe("no");
});

test("a marker mid-label is text, not a recommendation", () => {
  expect(displayOptions([{ id: "a", label: "(Recommended) by the old plan, now dropped" }]).suggested).toBeUndefined();
});

test("the thread helper names who actually receives a message, and never counts held recipients", () => {
  expect(audienceCopy({ approved: ["Mail agent"], fallback: "x" })).toEqual({ ask: "Ask Mail agent something", helper: "Only Mail agent sees this." });
  expect(audienceCopy({ approved: ["A", "B"], fallback: "x" }).helper).toBe("Only A and B see this.");
  expect(audienceCopy({ approved: ["A", "B", "C"], fallback: "x" })).toEqual({ ask: "Ask the agents on this card something", helper: "Only the 3 agents on this card see this." });
  expect(audienceCopy({ approved: ["A"], held: ["H"], fallback: "x" }).helper).toBe("Only A sees this. H isn't connected yet, so it doesn't get it.");
  expect(audienceCopy({ approved: [], held: ["H", "J"], fallback: "Owner" })).toEqual({ ask: "Ask Owner something", helper: "Only you see this for now. H and J aren't connected yet, so they don't get it." });
});

function revision(revisionNumber: number, replies?: string[], change: Partial<{ body: string; choices: { id: string; label: string }[]; cardId: string; sourceId: string; agentDid: string }> = {}): HomeFeedEntry {
  return {
    source: { sourceId: change.sourceId ?? "agent", agentDid: change.agentDid ?? "did:key:agent", label: "Agent",
      output: { spaceId: "space", database: "out" }, responses: { spaceId: "space", database: "resp" } },
    state: { card: { cardId: change.cardId ?? "card", revision: revisionNumber, issuanceId: `i${revisionNumber}`, kind: "ask", needsResponse: true, title: "T", body: change.body ?? "B", urgency: 1,
      createdAt: `2026-11-0${revisionNumber}T00:00:00Z`, choices: change.choices ?? [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      payload: { render: "thread", source: { label: "S" }, ...(replies ? { replies: replies.map((text) => ({ text })) } : {}) } },
      response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "agent", cardId: "card", revision: revisionNumber, issuanceId: `i${revisionNumber}` },
  };
}

test("a revision that only appends replies is reply-only", () => {
  expect(isReplyOnlyRevision(revision(1), revision(2, ["one"]))).toBe(true);
  expect(isReplyOnlyRevision(revision(1, ["one"]), revision(2, ["one", "two", "three"]))).toBe(true);
  expect(isReplyOnlyRevision(revision(1, ["one"]), revision(4, ["one", "two"]))).toBe(true);
});

test("anything else is not reply-only", () => {
  expect(isReplyOnlyRevision(revision(1, ["one", "two"]), revision(2, ["one!", "two", "three"]))).toBe(false); // edited earlier reply
  expect(isReplyOnlyRevision(revision(1, ["one", "two"]), revision(2, ["two", "three"]))).toBe(false); // removed reply
  expect(isReplyOnlyRevision(revision(1, ["one", "two"]), revision(2, ["two", "one", "three"]))).toBe(false); // reordered
  expect(isReplyOnlyRevision(revision(1, ["one"]), revision(2))).toBe(false); // replies missing from the next one
  expect(isReplyOnlyRevision(revision(1, ["one"]), revision(2, ["one"]))).toBe(false); // nothing appended
  expect(isReplyOnlyRevision(revision(1), revision(2, ["one"], { body: "Changed" }))).toBe(false); // body change
  expect(isReplyOnlyRevision(revision(1), revision(2, ["one"], { choices: [{ id: "a", label: "A2" }, { id: "b", label: "B" }] }))).toBe(false); // choice label
  expect(isReplyOnlyRevision(revision(1), revision(2, ["one"], { choices: [{ id: "b", label: "B" }, { id: "a", label: "A" }] }))).toBe(false); // choice order
  expect(isReplyOnlyRevision(revision(1), revision(2, ["one"], { sourceId: "other" }))).toBe(false); // different source
  expect(isReplyOnlyRevision(revision(1), revision(2, ["one"], { agentDid: "did:key:other" }))).toBe(false); // different agent
  expect(isReplyOnlyRevision(revision(1), revision(2, ["one"], { cardId: "other" }))).toBe(false); // different card
  expect(isReplyOnlyRevision(revision(2), revision(2, ["one"]))).toBe(false); // same revision
  expect(isReplyOnlyRevision(revision(3), revision(2, ["one"]))).toBe(false); // older revision
  const extraKey = revision(2, ["one"]); extraKey.state.card.payload = { ...extraKey.state.card.payload, render: "post" };
  expect(isReplyOnlyRevision(revision(1), extraKey)).toBe(false); // another payload key changed
});

test("a post card's first reply may turn it into a thread, and nothing else may change with it", () => {
  const post = (replies?: string[], body?: string) => { const entry = revision(1, replies, body ? { body } : {}); entry.state.card.payload = { ...entry.state.card.payload, render: "post" }; return entry; };
  const as = (entry: HomeFeedEntry, render: string, revisionNumber = 2) => { const next = structuredClone(entry); next.state.card.revision = revisionNumber; next.state.card.payload = { ...next.state.card.payload, render }; return next; };
  expect(isReplyOnlyRevision(post(), revision(2, ["one"]))).toBe(true); // absent → 1
  expect(isReplyOnlyRevision(post([]), revision(2, ["one"]))).toBe(true); // [] → 1
  expect(isReplyOnlyRevision(revision(1), as(revision(1, ["one"]), "post"))).toBe(false); // thread → post
  expect(isReplyOnlyRevision(post(), revision(2))).toBe(false); // post → thread, no reply
  expect(isReplyOnlyRevision(post(), revision(2, ["one"], { body: "Changed" }))).toBe(false); // plus a body change
  expect(isReplyOnlyRevision(post(["one"]), revision(2, ["one", "two"]))).toBe(false); // previous already had replies
  expect(isReplyOnlyRevision(post(), as(revision(1, ["one"]), "link"))).toBe(false); // post → link
  expect(isReplyOnlyRevision(revision(1), as(revision(1, ["one"]), "link"))).toBe(false); // thread → link
});

test("an absent render or payload counts as a post for the first-reply exception only", () => {
  const bare = (payload: "no-render" | "no-payload") => {
    const entry = revision(1);
    if (payload === "no-payload") delete entry.state.card.payload;
    else { const { render: _render, ...rest } = entry.state.card.payload!; entry.state.card.payload = rest; }
    return entry;
  };
  const withRender = (entry: HomeFeedEntry, render: string | undefined, replies?: string[], revisionNumber = 2) => {
    const next = structuredClone(entry);
    next.state.card.revision = revisionNumber;
    const { render: _render, replies: _replies, ...rest } = next.state.card.payload ?? {};
    next.state.card.payload = { ...rest, ...(render ? { render } : {}), ...(replies ? { replies: replies.map((text) => ({ text })) } : {}) };
    return next;
  };
  // absent render key → thread with a first reply
  expect(isReplyOnlyRevision(bare("no-render"), withRender(bare("no-render"), "thread", ["one"]))).toBe(true);
  // absent payload → thread with a first reply (the next payload is otherwise empty too)
  const noPayload = bare("no-payload");
  const threaded = structuredClone(noPayload); threaded.state.card.revision = 2; threaded.state.card.payload = { render: "thread", replies: [{ text: "one" }] };
  expect(isReplyOnlyRevision(noPayload, threaded)).toBe(true);
  // absent → link
  expect(isReplyOnlyRevision(bare("no-render"), withRender(bare("no-render"), "link", ["one"]))).toBe(false);
  // absent ↔ post with replies unchanged: a stray render difference is a new request
  expect(isReplyOnlyRevision(bare("no-render"), withRender(bare("no-render"), "post"))).toBe(false);
  expect(isReplyOnlyRevision(withRender(bare("no-render"), "post", undefined, 1), withRender(bare("no-render"), undefined))).toBe(false);
  expect(isReplyOnlyRevision(bare("no-render"), withRender(bare("no-render"), "post", ["one"]))).toBe(false);
});
