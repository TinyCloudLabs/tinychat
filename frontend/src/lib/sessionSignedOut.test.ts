import { expect, test } from "bun:test";
import { clearSessionAfterHandoff, registerSessionSignedOutHook } from "./sessionSignedOut";

test("a 401 clears credentials only after the registered native handoff", async () => {
  const order: string[] = [];
  const session = { clear: () => { order.push("clear"); } };
  const dispose = registerSessionSignedOutHook(session, async () => { order.push("handoff"); return true; });
  await clearSessionAfterHandoff(session);
  expect(order).toEqual(["handoff", "clear"]);
  dispose();
});

test("a failed native handoff leaves the bearer session intact", async () => {
  let cleared = false;
  const session = { clear: () => { cleared = true; } };
  const dispose = registerSessionSignedOutHook(session, async () => false);
  await expect(clearSessionAfterHandoff(session)).rejects.toThrow("Session was kept");
  expect(cleared).toBe(false);
  dispose();
});

test("simultaneous 401 responses share one durable handoff", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let handoffs = 0;
  let clears = 0;
  const session = { clear: () => { clears++; } };
  const dispose = registerSessionSignedOutHook(session, async () => { handoffs++; await gate; return true; });
  const first = clearSessionAfterHandoff(session);
  const second = clearSessionAfterHandoff(session);
  expect(handoffs).toBe(1);
  expect(clears).toBe(0);
  release();
  await Promise.all([first, second]);
  expect(clears).toBe(2);
  dispose();
});
