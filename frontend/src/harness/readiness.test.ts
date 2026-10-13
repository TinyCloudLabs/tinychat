import { afterEach, describe, expect, test } from "bun:test";

import { waitUntilReady } from "./readiness";
import { FROZEN_NOW, freezeClock } from "./stubs";

const RealDate = globalThis.Date;
afterEach(() => {
  globalThis.Date = RealDate;
});

describe("waitUntilReady", () => {
  test("a never-ready screen gives up at the cap even with the clock frozen (?freeze=1)", async () => {
    freezeClock();
    expect(Date.now()).toBe(FROZEN_NOW);
    const started = performance.now();
    // A Date.now() cap would never expire here; the bound makes a hang a failure.
    const outcome = await Promise.race([
      waitUntilReady(() => false, { capMs: 120, pollMs: 10 }).then(() => "gave up"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(outcome).toBe("gave up");
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(Date.now()).toBe(FROZEN_NOW);
  });

  test("resolves as soon as the screen is ready, before the cap", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 30);
    const started = performance.now();
    await waitUntilReady(() => ready, { capMs: 5_000, pollMs: 10 });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("resolves when cancelled", async () => {
    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 30);
    await waitUntilReady(() => false, { capMs: 5_000, pollMs: 10, isCancelled: () => cancelled });
  });
});
