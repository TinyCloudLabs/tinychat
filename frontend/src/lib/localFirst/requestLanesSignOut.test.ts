import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { FOREGROUND_QUIET_MS, inBackground, inForeground, laneSnapshot, resetLanesForTests } from "./requestLanes";

// TC-4462: background work that reads `tcw.sql` after sign-out throws before it returns a promise.
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const signedOut = () => ({ get sql(): never { throw new Error("Not signed in. Call signIn() first."); } });

beforeEach(() => {
  jest.useFakeTimers();
  resetLanesForTests();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "visible", addEventListener: () => undefined },
  });
});
afterEach(() => {
  resetLanesForTests();
  jest.useRealTimers();
  Reflect.deleteProperty(globalThis, "document");
});

test("queued background work that throws on sign-out reaches its caller, throws out of no timer, and frees the lane", async () => {
  const tcw = signedOut();
  // A foreground request is in flight, so the background work is queued when the session ends.
  let finishForeground!: () => void;
  const foreground = inForeground(() => new Promise<void>((resolve) => { finishForeground = resolve; }));
  let reached: unknown;
  const queued = inBackground(() => (tcw.sql as unknown as { db(name: string): Promise<void> }).db("feed")).catch((error: unknown) => { reached = error; });
  let second = false;
  const next = inBackground(async () => { second = true; });
  finishForeground();
  await foreground;
  // The lane starts the queued work from a timer: a throw there would be an uncaught error in this call.
  expect(() => jest.advanceTimersByTime(FOREGROUND_QUIET_MS + 1)).not.toThrow();
  await flush();
  await queued;
  await next;
  expect(String((reached as Error).message)).toBe("Not signed in. Call signIn() first.");
  expect(second).toBe(true);
  expect(laneSnapshot()).toEqual({ foreground: 0, background: 0, queued: 0 });
});

test("a work item that throws before returning does not hold the lane for good", async () => {
  const bad = inBackground((() => { throw new Error("sync failure"); }) as () => Promise<void>);
  await expect(bad).rejects.toThrow("sync failure");
  let ran = false;
  const good = inBackground(async () => { ran = true; });
  jest.advanceTimersByTime(FOREGROUND_QUIET_MS + 1);
  await flush();
  await good;
  expect(ran).toBe(true);
  expect(laneSnapshot().background).toBe(0);
});
