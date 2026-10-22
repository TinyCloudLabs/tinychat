import { describe, expect, test } from "bun:test";
import { FixedWindowBudget, WakeQueue } from "../exo/wake-intake.js";

/** A run that stays pending until released, so the test controls when the owner's slot frees. */
function gated() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { run: () => done, release };
}

describe("WakeQueue", () => {
  test("serves owners round-robin: owner b's wake runs before owner a's second and third wakes", async () => {
    const queue = new WakeQueue({ concurrency: 1 });
    const order: string[] = [];
    const record = (label: string) => async () => {
      order.push(label);
    };
    queue.offer("a", "a1", record("a1"));
    queue.offer("a", "a2", record("a2"));
    queue.offer("a", "a3", record("a3"));
    queue.offer("b", "b1", record("b1"));
    await queue.idle();
    expect(order).toEqual(["a1", "b1", "a2", "a3"]);
  });

  test("dedupes on (owner, request id): repeated offers of one pair occupy one slot", async () => {
    const queue = new WakeQueue({ concurrency: 1 });
    const blocker = gated();
    queue.offer("a", "blocker", () => blocker.run());
    for (let i = 0; i < 100; i += 1) queue.offer("b", "same", () => blocker.run());
    expect(queue.stats()).toEqual({ pending: 1, running: 1 });
    blocker.release();
    await queue.idle();
  });

  test("the same pair is not admitted twice while it is running", async () => {
    const queue = new WakeQueue({ concurrency: 2 });
    const blocker = gated();
    let runs = 0;
    const run = async () => {
      runs += 1;
      await blocker.run();
    };
    queue.offer("a", "r", run);
    queue.offer("a", "r", run);
    expect(queue.stats()).toEqual({ pending: 0, running: 1 });
    blocker.release();
    await queue.idle();
    expect(runs).toBe(1);
  });

  test("global cap holds under a 10x flood across many owners", () => {
    const queue = new WakeQueue({ globalCap: 8, ownerCap: 16, concurrency: 1 });
    const blocker = gated();
    queue.offer("hold", "hold", () => blocker.run());
    for (let owner = 0; owner < 10; owner += 1) {
      for (let id = 0; id < 80; id += 1) queue.offer(`owner-${owner}`, `r-${id}`, () => blocker.run());
    }
    expect(queue.stats().pending).toBeLessThanOrEqual(8);
    blocker.release();
  });

  test("per-owner cap holds under a 10x flood from one owner", () => {
    const queue = new WakeQueue({ globalCap: 256, ownerCap: 4, concurrency: 1 });
    const blocker = gated();
    queue.offer("hold", "hold", () => blocker.run());
    for (let id = 0; id < 40; id += 1) queue.offer("flood", `r-${id}`, () => blocker.run());
    expect(queue.stats().pending).toBe(4);
    blocker.release();
  });

  test("over a cap, the newest wake is kept and an older pending wake is dropped", async () => {
    const queue = new WakeQueue({ globalCap: 256, ownerCap: 2, concurrency: 1, random: () => 0 });
    const blocker = gated();
    const ran: string[] = [];
    queue.offer("hold", "hold", () => blocker.run());
    for (const id of ["r1", "r2", "r3", "r4"]) {
      queue.offer("owner", id, async () => {
        ran.push(id);
      });
    }
    blocker.release();
    await queue.idle();
    expect(ran).toEqual(["r3", "r4"]);
  });

  test("an owner with no pending work leaves the rotation and no longer blocks others", async () => {
    const queue = new WakeQueue({ concurrency: 1 });
    const order: string[] = [];
    queue.offer("a", "a1", async () => {
      order.push("a1");
    });
    queue.offer("b", "b1", async () => {
      order.push("b1");
    });
    await queue.idle();
    expect(order).toEqual(["a1", "b1"]);
    expect(queue.stats()).toEqual({ pending: 0, running: 0 });
  });
});

describe("FixedWindowBudget", () => {
  test("a limit of zero refuses the first spend", () => {
    expect(new FixedWindowBudget(0, 60_000).spend("owner", 0)).toBe(false);
  });

  test("allows exactly `limit` spends per window, then refuses", () => {
    const budget = new FixedWindowBudget(2, 1_000);
    expect(budget.spend("owner", 0)).toBe(true);
    expect(budget.spend("owner", 0)).toBe(true);
    expect(budget.spend("owner", 999)).toBe(false);
  });

  test("the window rolls over at its length and keys are independent", () => {
    const budget = new FixedWindowBudget(1, 1_000);
    expect(budget.spend("a", 0)).toBe(true);
    expect(budget.spend("a", 999)).toBe(false);
    expect(budget.spend("b", 999)).toBe(true);
    expect(budget.spend("a", 1_000)).toBe(true);
  });
});
