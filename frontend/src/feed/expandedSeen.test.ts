import { expect, test } from "bun:test";
import { SEEN_THRESHOLDS, visibleEnoughToSee } from "./expandedSeen";

const view = (intersectionRatio: number, cardHeight = 400, rootHeight = 800) => ({ intersectionRatio, cardHeight, rootHeight });

test("a card counts once half of it is visible, and not before", () => {
  expect(visibleEnoughToSee(view(0))).toBe(false);
  expect(visibleEnoughToSee(view(0.49))).toBe(false);
  expect(visibleEnoughToSee(view(0.5))).toBe(true);
  expect(visibleEnoughToSee(view(1))).toBe(true);
});

test("a card too tall for half of it to fit counts once the screen is nearly full of it", () => {
  expect(visibleEnoughToSee(view(0.1, 4000, 800))).toBe(false);
  expect(visibleEnoughToSee(view(0.18, 4000, 800))).toBe(true);
});

test("the observer reports at every hundredth, so a tall card's share is seen when it is reached", () => {
  expect(SEEN_THRESHOLDS).toHaveLength(101);
  expect(SEEN_THRESHOLDS[0]).toBe(0);
  expect(SEEN_THRESHOLDS.at(-1)).toBe(1);
});
