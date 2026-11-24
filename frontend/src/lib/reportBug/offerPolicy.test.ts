import { expect, test } from "bun:test";
import { createOfferPolicy, OFFER } from "./offerPolicy";

const LAUNCH = 1_000_000;
const ready = { locked: false, sheetOpen: false };
const later = LAUNCH + OFFER.launchQuietMs;

test("one offer per screenshot id", () => {
  const policy = createOfferPolicy(LAUNCH);
  expect(policy.offer("a", later, ready)).toBe(true);
  policy.sent();
  expect(policy.offer("a", later + 1, ready)).toBe(false);
  expect(policy.offer("b", later + 2, ready)).toBe(true);
});

test("no offer in the first seconds after launch, under the app lock, or while the sheet is open", () => {
  const policy = createOfferPolicy(LAUNCH);
  expect(policy.offer("a", LAUNCH + 100, ready)).toBe(false);
  expect(policy.offer("b", later, { locked: true, sheetOpen: false })).toBe(false);
  expect(policy.offer("c", later, { locked: false, sheetOpen: true })).toBe(false);
  expect(policy.offer("d", later, ready)).toBe(true);
});

test("a dismissal pauses offers for ten minutes; a send resets the count", () => {
  const policy = createOfferPolicy(LAUNCH);
  expect(policy.offer("a", later, ready)).toBe(true);
  policy.dismissed(later);
  expect(policy.offer("b", later + OFFER.cooldownMs - 1, ready)).toBe(false);
  expect(policy.offer("c", later + OFFER.cooldownMs, ready)).toBe(true);
});

test("three dismissals in a row stop offers until the app restarts", () => {
  const policy = createOfferPolicy(LAUNCH);
  let now = later;
  for (const id of ["a", "b", "c"]) {
    expect(policy.offer(id, now, ready)).toBe(true);
    policy.dismissed(now);
    now += OFFER.cooldownMs;
  }
  expect(policy.offer("d", now + 24 * 3_600_000, ready)).toBe(false);
  expect(createOfferPolicy(LAUNCH).offer("d", later, ready)).toBe(true);
});

test("a send in between breaks the dismissal streak", () => {
  const policy = createOfferPolicy(LAUNCH);
  let now = later;
  for (const [id, outcome] of [["a", "dismiss"], ["b", "dismiss"], ["c", "send"], ["d", "dismiss"]] as const) {
    expect(policy.offer(id, now, ready)).toBe(true);
    if (outcome === "send") policy.sent();
    else policy.dismissed(now);
    now += OFFER.cooldownMs;
  }
  expect(policy.offer("e", now, ready)).toBe(true);
});
