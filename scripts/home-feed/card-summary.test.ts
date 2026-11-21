import { expect, test } from "bun:test";
import { boardKey, validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { boardCard } from "./inventory";
import { boardRecord, NOW } from "./mirror-node.fixture";

/**
 * A board card's `post` is the one line Home leads with: the mirror carries it as the card's `payload.summary`, which the Feed
 * already reads for a card's short view. A card without a post carries no summary (Home shows its body, as before).
 */
const NOW_MS = Date.parse(NOW);
const rowOf = (record: BoardRecord) => ({ key: boardKey(record.kind, record.id), record });
const cardOf = (record: BoardRecord) => boardCard(rowOf(record), [record], NOW_MS);
const withPost = (kind: "ask" | "task" | "incident" | "work" | "progress", post: string): BoardRecord => JSON.parse(JSON.stringify(boardRecord(kind, `${kind}-summary`, { post })));

test("a card with a post carries it as payload.summary, for every kind the mirror posts", () => {
  for (const kind of ["ask", "task", "incident", "work", "progress"] as const) {
    const card = cardOf(withPost(kind, "Reconnect fixed; one check left."));
    expect(card.payload?.summary, kind).toBe("Reconnect fixed; one check left.");
    expect(card.body, kind).not.toBe("Reconnect fixed; one check left.");
  }
});

test("a post is carried trimmed, as the board stores it", () => {
  const card = cardOf(withPost("task", "  Reconnect fixed; one check left.  \n"));
  expect(card.payload?.summary).toBe("Reconnect fixed; one check left.");
});

test("a card without a post carries no summary at all", () => {
  const card = cardOf(JSON.parse(JSON.stringify(boardRecord("task", "task-no-summary", {}))));
  expect(card.payload).toBeDefined();
  expect("summary" in (card.payload ?? {})).toBe(false);
});

test("a post of exactly 280 characters is carried whole; one over is refused before it can reach a card", () => {
  const edge = "a".repeat(280);
  expect(cardOf(withPost("task", edge)).payload?.summary).toBe(edge);
  const record = JSON.parse(JSON.stringify(boardRecord("task", "task-too-long", {}))) as Record<string, unknown>;
  expect(validateRecord("task", { ...record, post: "a".repeat(281) }).ok).toBe(false);
  expect(validateRecord("task", { ...record, post: "   " }).ok).toBe(false);
});
