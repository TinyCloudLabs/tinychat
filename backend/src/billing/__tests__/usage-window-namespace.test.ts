// Issue #31 regression — tier-namespaced local usage window key.
//
// The local in-memory counter (usage.ts) is a single slot per address keyed by a
// window-start integer. A paid anchored week and a free UTC day normally resolve
// to DIFFERENT integers, so a downgrade reads the old paid slot as 0 (RESET). But
// at a UTC-midnight billing anchor on the FIRST UTC-day of the week, the two
// integers COLLIDE and the pre-fix counter read the old paid usage against the new
// free limit → a silent 402. Pairing the slot's periodStart with its window kind
// makes the two windows distinct, so a tier transition always rolls over.
//
// This file constructs that exact collision and proves the free-tier read sees 0.
// Mutation-proof: revert the windowKind namespacing in usage.ts and the
// "reads 0" assertion goes RED (the counter carries the paid 12000).
import { afterEach, describe, expect, test } from "bun:test";
import { TIERS } from "../tiers.js";
import {
  _resetUsage,
  getUsage,
  isOverBudget,
  recordUsage,
  startOfAnchoredWeek,
  startOfUtcDay,
} from "../usage.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PAID_USAGE = 12000; // > the 500 free limit, so a carry would 402

afterEach(() => {
  _resetUsage();
});

// Build the collision: a UTC-midnight anchor whose anchored week begins on the
// same UTC-day that contains `now`. Then startOfAnchoredWeek === startOfUtcDay.
function buildCollision(now: number): { anchor: number; utcDay: number; week: number } {
  const utcDay = startOfUtcDay(now);
  const anchor = utcDay - 4 * WEEK_MS; // 4 whole weeks earlier, still UTC-midnight
  const week = startOfAnchoredWeek(anchor, now);
  return { anchor, utcDay, week };
}

describe("#31 — local usage window key is tier-namespaced", () => {
  test("the collision precondition holds (anchored-week start === utc-day start)", () => {
    const now = Date.UTC(2026, 4, 14, 6, 0, 0); // mid-morning, safely inside the day
    const { utcDay, week } = buildCollision(now);
    expect(week).toBe(utcDay); // the integers collide — the dangerous case
  });

  test("paid→free at the collision RESETS: free read sees 0, not the carried paid usage", () => {
    const now = Date.UTC(2026, 4, 14, 6, 0, 0);
    const { anchor, week, utcDay } = buildCollision(now);
    expect(week).toBe(utcDay); // guard: we are exercising the collision

    const address = "0xcollision";
    // While paid (weekly, midnight anchor) the user burns a full paid window.
    recordUsage(address, TIERS.pro, PAID_USAGE, anchor, now);
    expect(getUsage(address, TIERS.pro, anchor, now).used).toBe(PAID_USAGE);

    // Immediately downgraded to free (day window, no anchor) at the SAME instant.
    const freeUsage = getUsage(address, TIERS.free, null, now);
    expect(freeUsage.used).toBe(0); // RESET — the heart of #31
    expect(freeUsage.limit).toBe(getUsage(address, TIERS.free, null, now).limit);
    expect(isOverBudget(address, TIERS.free, null, now)).toBe(false); // serves, no silent 402
  });

  test("recording free usage after the transition does not resurrect the paid slot", () => {
    const now = Date.UTC(2026, 4, 14, 6, 0, 0);
    const { anchor, week, utcDay } = buildCollision(now);
    expect(week).toBe(utcDay);

    const address = "0xcollision2";
    recordUsage(address, TIERS.pro, PAID_USAGE, anchor, now);
    // A single free credit starts a fresh free window at the same integer.
    recordUsage(address, TIERS.free, 1, null, now);
    expect(getUsage(address, TIERS.free, null, now).used).toBe(1); // fresh window, not 12001
  });

  test("control: the non-collision case still RESETS (no regression)", () => {
    const now = Date.UTC(2026, 4, 14, 6, 0, 0);
    const utcDay = startOfUtcDay(now);
    // Day-3 anchor: anchored week start differs from the utc-day start.
    const anchor = utcDay - 4 * WEEK_MS - 3 * 24 * 60 * 60 * 1000;
    expect(startOfAnchoredWeek(anchor, now)).not.toBe(utcDay);

    const address = "0xcontrol";
    recordUsage(address, TIERS.pro, PAID_USAGE, anchor, now);
    expect(getUsage(address, TIERS.free, null, now).used).toBe(0); // already reset pre-fix
  });

  test("the paid weekly window itself still accumulates within its own kind", () => {
    const now = Date.UTC(2026, 4, 14, 6, 0, 0);
    const { anchor } = buildCollision(now);
    const address = "0xpaid";
    recordUsage(address, TIERS.pro, 100, anchor, now);
    recordUsage(address, TIERS.pro, 50, anchor, now);
    expect(getUsage(address, TIERS.pro, anchor, now).used).toBe(150); // same kind → accumulate
  });
});
