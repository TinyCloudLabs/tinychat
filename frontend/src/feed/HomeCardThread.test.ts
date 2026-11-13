import { expect, test } from "bun:test";
import { awaitingConfirmation, chatItems, plainConversation, type ConversationLine } from "./CardConversation";
import type { HomeFeedEntry } from "./feedStoreTypes";

const mine = (key: string, at: string, extra: Partial<ConversationLine> = {}): ConversationLine => ({ key, mine: true, text: key, at, who: "Agent", ...extra });
const theirs = (key: string, at: string, replyTo?: string): ConversationLine => ({ key, mine: false, text: key, at, who: "Agent", ...(replyTo ? { replyTo } : {}) });

test("the chat draws each of your comments alone and the agent's lines in runs, one run per comment answered", () => {
  const shape = chatItems([
    mine("me:1", "2026-11-01T10:00:00Z"),
    theirs("agent:0", "2026-11-01T10:05:00Z", "me:1"),
    theirs("agent:1", "2026-11-01T10:06:00Z", "me:1"),
    theirs("agent:2", "2026-11-01T10:07:00Z"),
    mine("me:2", "2026-11-01T10:08:00Z"),
  ]).map((item) => item.kind === "mine" ? item.line.key : item.lines.map((line) => line.key));
  expect(shape).toEqual(["me:1", ["agent:0", "agent:1"], ["agent:2"], "me:2"]);
});

test("a comment waits for confirmation unless received, replied to, held, or sent again since", () => {
  const lines = [
    mine("me:a", "2026-11-01T10:00:00Z", { text: "same" }),
    mine("me:b", "2026-11-01T10:01:00Z", { received: true }),
    mine("me:c", "2026-11-01T10:02:00Z"),
    theirs("agent:0", "2026-11-01T10:03:00Z", "me:c"),
    mine("held:d", "2026-11-01T10:04:00Z", { held: true }),
    mine("me:e", "2026-11-01T10:05:00Z", { text: "same" }),
  ];
  expect(awaitingConfirmation(lines).map((line) => line.key)).toEqual(["me:e"]);
});

test("a plain card's conversation: messages and replies with replyTo; owner actions (feed.*) never show", () => {
  const entry = {
    source: { label: "Helper" },
    state: { card: { revision: 1, createdAt: "2026-11-01T09:00:00Z", payload: { replies: [{ text: "On it", at: "2026-11-01T10:01:00Z", replyTo: "r1" }] } } },
    responses: [
      { responseId: "r1", kind: "message", text: "Please hurry", createdAt: "2026-11-01T10:00:00Z" },
      { responseId: "r2", kind: "message", text: "Dropped", payloadType: "feed.drop", createdAt: "2026-11-01T10:02:00Z" },
      { responseId: "r3", kind: "answer", choiceId: "a", createdAt: "2026-11-01T10:03:00Z" },
    ],
    responseHandling: { r1: { acknowledgement: { at: "2026-11-01T10:00:05Z" } } },
  } as unknown as HomeFeedEntry;
  expect(plainConversation(entry).map(({ key, mine, text, received, replyTo }) => ({ key, mine, text, received, replyTo }))).toEqual([
    { key: "me:r1", mine: true, text: "Please hurry", received: true, replyTo: undefined },
    { key: "agent:0", mine: false, text: "On it", received: undefined, replyTo: "me:r1" },
  ]);
});
