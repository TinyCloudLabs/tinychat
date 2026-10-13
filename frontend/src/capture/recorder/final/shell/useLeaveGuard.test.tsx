import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installReactTestEnv, mount } from "./hookTestUtil";
import { leaveGuard, useLeaveGuard, type LeaveGuardTarget } from "./useLeaveGuard";

function fakeWindow() {
  const listeners = new Set<(event: BeforeUnloadEvent) => void>();
  const target: LeaveGuardTarget = {
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  };
  return { target, listeners };
}

describe("leaveGuard", () => {
  test("asks the browser to confirm", () => {
    let prevented = false;
    const event = { preventDefault: () => (prevented = true), returnValue: "unset" } as unknown as BeforeUnloadEvent;
    leaveGuard(event);
    expect(prevented).toBe(true);
    expect(event.returnValue).toBe("");
  });
});

describe("useLeaveGuard", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = installReactTestEnv();
  });
  afterEach(() => restoreEnv());

  test("listens only while active, and removes the listener when not", async () => {
    const w = fakeWindow();
    function Probe({ active }: { active: boolean }) {
      useLeaveGuard(active, w.target);
      return null;
    }
    const view = mount();
    await view.render(<Probe active={false} />);
    expect(w.listeners.size).toBe(0);
    await view.render(<Probe active />);
    expect([...w.listeners]).toEqual([leaveGuard]);
    await view.render(<Probe active={false} />);
    expect(w.listeners.size).toBe(0);
    await view.render(<Probe active />);
    await view.unmount();
    expect(w.listeners.size).toBe(0);
  });
});
