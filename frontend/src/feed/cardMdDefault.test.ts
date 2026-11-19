import { expect, test } from "bun:test";
import { feedCardSchema, type FeedCard } from "@tinycloud/sdk-services/feed";
import { CARD_MD_DEFAULT, CARD_MD_EXAMPLES } from "./cardMdDefault";
import { cardUnshown } from "./unshownCard";
import { briefOf } from "./brief";

/** The JSON blocks exactly as an agent reads them in the default text. */
const blocks = [...CARD_MD_DEFAULT.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);

test("the default text carries one known-good card per kind: decision, update, link update and page", () => {
  expect(blocks).toEqual(CARD_MD_EXAMPLES.map(({ card }) => card as unknown as Record<string, unknown>));
  expect(blocks.map((card) => [card.kind, (card.payload as { render: string }).render])).toEqual([
    ["decision", "post"], ["update", "post"], ["update", "link"], ["page", "post"],
  ]);
});

for (const card of blocks) {
  test(`${card.cardId}: passes the publish check with nothing dropped, and the Feed draws every field`, () => {
    const parsed = feedCardSchema.parse(card);
    // feed publish keeps only what the schema knows: a dropped key would make the example lie.
    expect(parsed as unknown).toEqual(card);
    expect(cardUnshown(parsed as FeedCard)).toEqual([]);
    const payload = card.payload as { priority: number; summary?: string; agent?: unknown };
    expect(card.urgency).toBe(5 - payload.priority);
    expect(payload.summary && payload.agent).toBeTruthy();
  });
}

test("the decision has a brief with the five sections, and the page has the image and questions the Feed needs", () => {
  const decision = blocks.find((card) => card.kind === "decision")!;
  const brief = briefOf(decision.payload as Record<string, unknown>);
  for (const section of ["Background", "Why now", "If you don't answer", "The options", "Recommendation"]) expect(brief?.markdown).toContain(`## ${section}\n`);
  const page = (blocks.find((card) => card.kind === "page")!.payload as { page: { image: unknown; questions: unknown } }).page;
  expect(typeof page.image).toBe("string");
  expect(Array.isArray(page.questions)).toBe(true);
});

test("the default text follows the public text rules", () => {
  expect(CARD_MD_DEFAULT).not.toMatch(/\byet\b/i);
  expect(CARD_MD_DEFAULT).not.toMatch(/encrypt|secure|security|ready|readiness/i);
  expect(CARD_MD_DEFAULT).not.toMatch(/\b(Sam|Naomi|Holden|Monica|Alex|Bobbie|Clarissa|Hunter|Amos|Fable|Astra)\b/);
});
