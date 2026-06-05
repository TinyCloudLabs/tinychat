import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TIERS } from "../billing/tiers.js";
import {
  _resetMissingAnchorWarning,
  _resetUsage,
  getUsage,
  isOverBudget,
  recordUsage,
  startOfAnchoredWeek,
  startOfNextAnchoredWeek,
  startOfNextUtcDay,
  startOfUtcDay,
} from "../billing/usage.js";

const ADDR = "0xabc";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

afterEach(() => {
  _resetUsage();
  _resetMissingAnchorWarning();
  delete process.env.CREDIT_BUDGET_FREE;
  delete process.env.CREDIT_BUDGET_PLUS_WEEKLY;
  delete process.env.CREDIT_BUDGET_PRO_WEEKLY;
});

// 2026-03-15T10:00:00Z
const MID_MARCH = Date.UTC(2026, 2, 15, 10, 0, 0);

describe("window boundaries (UTC)", () => {
  test("day boundaries", () => {
    expect(startOfUtcDay(MID_MARCH)).toBe(Date.UTC(2026, 2, 15));
    expect(startOfNextUtcDay(MID_MARCH)).toBe(Date.UTC(2026, 2, 16));
  });
});

describe("anchored-week boundaries", () => {
  // Wed mid-day: an "in the middle of the week" anchor.
  const ANCHOR = Date.UTC(2026, 1, 11, 14, 30, 0);

  test("now == anchor → start == anchor; reset == anchor + 7d", () => {
    expect(startOfAnchoredWeek(ANCHOR, ANCHOR)).toBe(ANCHOR);
    expect(startOfNextAnchoredWeek(ANCHOR, ANCHOR)).toBe(ANCHOR + WEEK_MS);
  });

  test("now == anchor + 7d exactly → start == anchor + 7d (next window, not previous)", () => {
    expect(startOfAnchoredWeek(ANCHOR, ANCHOR + WEEK_MS)).toBe(ANCHOR + WEEK_MS);
    expect(startOfNextAnchoredWeek(ANCHOR, ANCHOR + WEEK_MS)).toBe(ANCHOR + 2 * WEEK_MS);
  });

  test("anchor mid-week: now between anchor and anchor+7d", () => {
    const now = ANCHOR + 3 * DAY_MS;
    expect(startOfAnchoredWeek(ANCHOR, now)).toBe(ANCHOR);
    expect(startOfNextAnchoredWeek(ANCHOR, now)).toBe(ANCHOR + WEEK_MS);
  });

  test("multi-week elapsed: anchor+20d → start == anchor+14d", () => {
    const now = ANCHOR + 20 * DAY_MS;
    expect(startOfAnchoredWeek(ANCHOR, now)).toBe(ANCHOR + 2 * WEEK_MS);
    expect(startOfNextAnchoredWeek(ANCHOR, now)).toBe(ANCHOR + 3 * WEEK_MS);
  });

  test("future anchor (now < anchor): boundary <= now, reset > now, monotonic 7d apart", () => {
    const now = ANCHOR - 3 * DAY_MS;
    const start = startOfAnchoredWeek(ANCHOR, now);
    const reset = startOfNextAnchoredWeek(ANCHOR, now);
    expect(start).toBeLessThanOrEqual(now);
    expect(reset).toBeGreaterThan(now);
    expect(reset - start).toBe(WEEK_MS);
  });

  test("DST-straddle: anchor in winter, now after US+EU spring-forward — windows still exactly 7*86_400_000ms", () => {
    // 2026 spring-forward: US Mar 8, EU Mar 29. Walk now from before US DST to
    // after EU DST and assert every window stays exactly WEEK_MS wide.
    const anchor = Date.UTC(2026, 1, 18, 9, 15, 0); // Feb 18 — before any DST
    const nows = [
      Date.UTC(2026, 2, 7, 9, 15, 0), //   before US DST
      Date.UTC(2026, 2, 9, 9, 15, 0), //   after  US DST, before EU DST
      Date.UTC(2026, 2, 28, 9, 15, 0), //  one day before EU DST
      Date.UTC(2026, 2, 30, 9, 15, 0), //  after  EU DST
      Date.UTC(2026, 3, 15, 9, 15, 0), //  three weeks later
    ];
    for (const now of nows) {
      const start = startOfAnchoredWeek(anchor, now);
      const reset = startOfNextAnchoredWeek(anchor, now);
      expect(reset - start).toBe(WEEK_MS);
      expect((start - anchor) % WEEK_MS).toBe(0);
      expect(start).toBeLessThanOrEqual(now);
      expect(reset).toBeGreaterThan(now);
    }
  });
});

describe("usage accounting — free tier (daily UTC window)", () => {
  test("records and reads within a window", () => {
    recordUsage(ADDR, TIERS.free, 120, null, MID_MARCH);
    recordUsage(ADDR, TIERS.free, 30, null, MID_MARCH);
    const usage = getUsage(ADDR, TIERS.free, null, MID_MARCH);
    expect(usage.used).toBe(150);
    expect(usage.limit).toBe(500);
    expect(usage.resetsAt).toBe(new Date(Date.UTC(2026, 2, 16)).toISOString());
  });

  test("free tier rolls over on the next UTC day", () => {
    recordUsage(ADDR, TIERS.free, 400, null, MID_MARCH);
    expect(getUsage(ADDR, TIERS.free, null, MID_MARCH).used).toBe(400);
    const nextDay = Date.UTC(2026, 2, 16, 1, 0, 0);
    expect(getUsage(ADDR, TIERS.free, null, nextDay).used).toBe(0);
  });

  test("isOverBudget reflects the budget", () => {
    expect(isOverBudget(ADDR, TIERS.free, null, MID_MARCH)).toBe(false);
    recordUsage(ADDR, TIERS.free, 500, null, MID_MARCH);
    expect(isOverBudget(ADDR, TIERS.free, null, MID_MARCH)).toBe(true);
  });

  test("budget limit follows env override at call time", () => {
    process.env.CREDIT_BUDGET_FREE = "1000";
    expect(getUsage(ADDR, TIERS.free, null, MID_MARCH).limit).toBe(1000);
    recordUsage(ADDR, TIERS.free, 500, null, MID_MARCH);
    expect(isOverBudget(ADDR, TIERS.free, null, MID_MARCH)).toBe(false);
    recordUsage(ADDR, TIERS.free, 500, null, MID_MARCH);
    expect(isOverBudget(ADDR, TIERS.free, null, MID_MARCH)).toBe(true);
  });

  test("free tier ignores any anchor passed in (daily window unchanged)", () => {
    // Passing a random anchor must not perturb the free path — it's strictly a
    // paid-tier concern and the daily UTC window is the regression guard.
    const bogusAnchor = Date.UTC(2025, 5, 4, 12);
    recordUsage(ADDR, TIERS.free, 75, bogusAnchor, MID_MARCH);
    const snap = getUsage(ADDR, TIERS.free, bogusAnchor, MID_MARCH);
    expect(snap.used).toBe(75);
    expect(snap.resetsAt).toBe(new Date(Date.UTC(2026, 2, 16)).toISOString());
  });
});

describe("usage accounting — paid tier (anchored 7d window)", () => {
  // Mid-week anchor so the window boundary is unambiguously offset from any
  // UTC-day boundary — protects against accidental day-rounding regressions.
  const ANCHOR = Date.UTC(2026, 1, 11, 14, 30, 0);

  test("does NOT roll over across days within the same anchored week", () => {
    const now = ANCHOR + 2 * DAY_MS;
    recordUsage(ADDR, TIERS.plus, 10_000, ANCHOR, now);
    const sameWeek = ANCHOR + 5 * DAY_MS;
    expect(getUsage(ADDR, TIERS.plus, ANCHOR, sameWeek).used).toBe(10_000);
  });

  test("rolls over on the next anchored-week boundary (used → 0, resetsAt advances exactly 7d)", () => {
    const earlyWeek = ANCHOR + 2 * DAY_MS;
    recordUsage(ADDR, TIERS.plus, 10_000, ANCHOR, earlyWeek);
    const firstSnap = getUsage(ADDR, TIERS.plus, ANCHOR, earlyWeek);
    expect(firstSnap.used).toBe(10_000);

    // Step across the anchored boundary by any amount inside the next window.
    const nextWeek = ANCHOR + WEEK_MS + DAY_MS;
    const snap = getUsage(ADDR, TIERS.plus, ANCHOR, nextWeek);
    expect(snap.used).toBe(0);
    expect(new Date(snap.resetsAt).getTime() - new Date(firstSnap.resetsAt).getTime()).toBe(
      WEEK_MS,
    );
  });

  test("isOverBudget honours CREDIT_BUDGET_PLUS_WEEKLY env override", () => {
    process.env.CREDIT_BUDGET_PLUS_WEEKLY = "200";
    const now = ANCHOR + DAY_MS;
    expect(isOverBudget(ADDR, TIERS.plus, ANCHOR, now)).toBe(false);
    recordUsage(ADDR, TIERS.plus, 200, ANCHOR, now);
    expect(isOverBudget(ADDR, TIERS.plus, ANCHOR, now)).toBe(true);
  });

  test("isOverBudget honours CREDIT_BUDGET_PRO_WEEKLY env override", () => {
    process.env.CREDIT_BUDGET_PRO_WEEKLY = "300";
    const now = ANCHOR + DAY_MS;
    expect(isOverBudget(ADDR, TIERS.pro, ANCHOR, now)).toBe(false);
    recordUsage(ADDR, TIERS.pro, 300, ANCHOR, now);
    expect(isOverBudget(ADDR, TIERS.pro, ANCHOR, now)).toBe(true);
  });
});

describe("missing anchor on paid tier (defensive fallback)", () => {
  let warns: unknown[][];
  let origWarn: typeof console.warn;

  beforeEach(() => {
    warns = [];
    origWarn = console.warn;
    console.warn = ((...args: unknown[]) => {
      warns.push(args);
    }) as typeof console.warn;
  });

  afterEach(() => {
    console.warn = origWarn;
  });

  test("warns exactly once per process across all public fns", () => {
    getUsage(ADDR, TIERS.plus, null, MID_MARCH);
    isOverBudget(ADDR, TIERS.plus, null, MID_MARCH);
    recordUsage(ADDR, TIERS.plus, 5, null, MID_MARCH);
    getUsage(ADDR, TIERS.pro, null, MID_MARCH);
    expect(warns.length).toBe(1);
    expect(String(warns[0][0])).toContain("billing anchor");
  });

  test("window starts at now (never wrongly locks the user out)", () => {
    const snap = getUsage(ADDR, TIERS.plus, null, MID_MARCH);
    expect(snap.used).toBe(0);
    expect(snap.resetsAt).toBe(new Date(MID_MARCH + WEEK_MS).toISOString());
    expect(isOverBudget(ADDR, TIERS.plus, null, MID_MARCH)).toBe(false);
  });

  test("free tier with null anchor does NOT warn", () => {
    getUsage(ADDR, TIERS.free, null, MID_MARCH);
    isOverBudget(ADDR, TIERS.free, null, MID_MARCH);
    recordUsage(ADDR, TIERS.free, 1, null, MID_MARCH);
    expect(warns.length).toBe(0);
  });
});
