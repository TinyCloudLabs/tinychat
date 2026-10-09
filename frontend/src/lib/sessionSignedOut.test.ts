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
