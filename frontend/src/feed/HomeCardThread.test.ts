import { expect, test } from "bun:test";
import { commentTree, type ThreadItem } from "./HomeCardThread";

const comment = (id: string, at: string, mine: boolean, replyTo?: string): ThreadItem => ({ key: id, id, at, speaker: mine ? "You" : "Agent", text: id, mine, ...(replyTo ? { replyTo } : {}) });
const shape = (items: ThreadItem[]) => commentTree(items).map(({ item, replies }) => [item.id, replies.map((reply) => reply.id)]);

test("an agent comment replying to an owner comment sits one level under it; the rest are top-level, oldest first", () => {
  expect(shape([
    comment("you-1", "2026-11-01T10:00:00Z", true),
    comment("agent-1", "2026-11-01T10:05:00Z", false, "you-1"),
    comment("agent-2", "2026-11-01T10:06:00Z", false),
    comment("you-2", "2026-11-01T10:07:00Z", true),
    comment("agent-3", "2026-11-01T10:08:00Z", false, "you-1"),
  ])).toEqual([["you-1", ["agent-1", "agent-3"]], ["agent-2", []], ["you-2", []]]);
});

test("nothing nests deeper than one level: a reply to a reply, to an agent comment, or to an unknown id is top-level", () => {
  expect(shape([
    comment("you-1", "2026-11-01T10:00:00Z", true),
    comment("agent-1", "2026-11-01T10:05:00Z", false, "you-1"),
    comment("agent-2", "2026-11-01T10:06:00Z", false, "agent-1"),
    comment("agent-3", "2026-11-01T10:07:00Z", false, "missing"),
  ])).toEqual([["you-1", ["agent-1"]], ["agent-2", []], ["agent-3", []]]);
  // An owner comment never becomes a reply, even if it names another comment.
  expect(shape([comment("you-1", "2026-11-01T10:00:00Z", true), comment("you-2", "2026-11-01T10:01:00Z", true, "you-1")])).toEqual([["you-1", []], ["you-2", []]]);
});
