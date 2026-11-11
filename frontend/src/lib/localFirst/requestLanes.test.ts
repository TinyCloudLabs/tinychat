import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { FOREGROUND_COUNT_MAX_MS, FOREGROUND_QUIET_MS, foregroundDatabase, inBackground, inForeground, laneSnapshot, resetLanesForTests, whenForegroundIdle } from "./requestLanes";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
/** Let queued promise callbacks run; timers stay frozen. */
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

let visibility: "visible" | "hidden" = "visible";
const listeners = new Set<() => void>();
beforeEach(() => {
  jest.useFakeTimers();
  resetLanesForTests();
  visibility = "visible";
  listeners.clear();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get visibilityState() { return visibility; },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    },
  });
});
afterEach(() => {
  resetLanesForTests();
  jest.useRealTimers();
  Reflect.deleteProperty(globalThis, "document");
});

test("a foreground request starts at once even with background copying queued and running", async () => {
  const copying = gate();
  const started: string[] = [];
  void inBackground(async () => { started.push("copy-1"); await copying.promise; });
  void inBackground(async () => { started.push("copy-2"); });
  await flush();
  expect(started).toEqual(["copy-1"]);

  await inForeground(async () => { started.push("screen"); });
  // The screen's request did not wait for copy-1 to finish, nor for copy-2's turn.
  expect(started).toEqual(["copy-1", "screen"]);
  copying.open();
});

test("background work waits until the foreground is done and quiet, then runs one at a time", async () => {
  const screen = gate();
  const copy = gate();
  const started: string[] = [];
  const foreground = inForeground(() => screen.promise);
  void inBackground(async () => { started.push("copy-1"); await copy.promise; });
  void inBackground(async () => { started.push("copy-2"); });
  await flush();
  expect(started).toEqual([]);
  expect(laneSnapshot()).toEqual({ foreground: 1, background: 0, queued: 2 });

  screen.open();
  await foreground;
  jest.advanceTimersByTime(FOREGROUND_QUIET_MS - 1);
  await flush();
  expect(started).toEqual([]); // still inside the quiet gap
  jest.advanceTimersByTime(1);
  await flush();
  expect(started).toEqual(["copy-1"]); // one at a time
  copy.open();
  await flush();
  expect(started).toEqual(["copy-1", "copy-2"]);
});

test("a hidden tab starts no background work until it is visible again", async () => {
  visibility = "hidden";
  const started: string[] = [];
  void inBackground(async () => { started.push("copy"); });
  jest.advanceTimersByTime(FOREGROUND_QUIET_MS * 10);
  await flush();
  expect(started).toEqual([]);
  visibility = "visible";
  for (const listener of listeners) listener();
  await flush();
  expect(started).toEqual(["copy"]);
});

test("whenForegroundIdle resolves only after foreground calls on a wrapped database finish", async () => {
  const reply = gate();
  const db = foregroundDatabase({ query: async () => { await reply.promise; return { ok: true }; }, name: "threads" });
  expect(db.name).toBe("threads");
  const query = db.query();
  let idle = false;
  void whenForegroundIdle().then(() => { idle = true; });
  jest.advanceTimersByTime(FOREGROUND_QUIET_MS * 10);
  await flush();
  expect(idle).toBe(false);
  reply.open();
  await query;
  jest.advanceTimersByTime(FOREGROUND_QUIET_MS);
  await flush();
  expect(idle).toBe(true);
});

test("a foreground call that never answers stops holding background work after the cap", async () => {
  const started: string[] = [];
  void inForeground(() => new Promise<void>(() => {})); // the node never answers
  void inBackground(async () => { started.push("copy"); });
  jest.advanceTimersByTime(FOREGROUND_COUNT_MAX_MS - 1);
  await flush();
  expect(started).toEqual([]);
  jest.advanceTimersByTime(1 + FOREGROUND_QUIET_MS);
  await flush();
  expect(started).toEqual(["copy"]);
});
