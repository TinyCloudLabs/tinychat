import { describe, expect, test } from "bun:test";
import { appFirstLoadSettled, createFirstLoadTracker, markAppFirstLoadSettled, resetAppFirstLoad } from "./replicationFirstLoad";

describe("first-load tracker", () => {
  test("warm cached list: listLoading is never true, the revalidate runs then ends: settles without the deadline", () => {
    const observe = createFirstLoadTracker();
    expect(observe(false, false)).toBe(false); // idle first render: nothing started yet
    expect(observe(false, true)).toBe(false); // revalidate running
    expect(observe(false, false)).toBe(true);
  });

  test("cold list: loading then done settles", () => {
    const observe = createFirstLoadTracker();
    expect(observe(true, false)).toBe(false);
    expect(observe(false, false)).toBe(true);
  });

  test("stays unsettled while either signal is still running", () => {
    const observe = createFirstLoadTracker();
    observe(true, false);
    expect(observe(false, true)).toBe(false);
    expect(observe(true, true)).toBe(false);
    expect(observe(false, false)).toBe(true);
  });
});

describe("app first-load signal", () => {
  test("waiters resolve on mark; resolved at once afterwards; reset re-arms", async () => {
    resetAppFirstLoad();
    let resolved = false;
    const waiting = appFirstLoadSettled().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    markAppFirstLoadSettled();
    await waiting;
    expect(resolved).toBe(true);
    await appFirstLoadSettled();
    resetAppFirstLoad();
    let again = false;
    void appFirstLoadSettled().then(() => { again = true; });
    await Promise.resolve();
    expect(again).toBe(false);
    markAppFirstLoadSettled();
  });
});
