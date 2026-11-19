import { describe, expect, test } from "bun:test";
import { appFirstLoadSettled, markAppFirstLoadSettled, resetAppFirstLoad } from "./replicationFirstLoad";

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
