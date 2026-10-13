import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installReactTestEnv, mount } from "./hookTestUtil";
import { holdWakeLock, useWakeLock, type WakeLockEnv } from "./useWakeLock";

function fakeEnv(options: { supported?: boolean; visible?: boolean; rejectWith?: Error } = {}) {
  const { supported = true, rejectWith } = options;
  const warnings: string[] = [];
  const listeners = new Set<() => void>();
  const state = { visible: options.visible ?? true, requests: 0, releases: 0 };
  const sentinels: Array<{ fireRelease(): void }> = [];
  const env: WakeLockEnv = {
    navigator: supported
      ? {
          wakeLock: {
            request: async (type) => {
              expect(type).toBe("screen");
              state.requests += 1;
              if (rejectWith) throw rejectWith;
              let onRelease: (() => void) | undefined;
              sentinels.push({ fireRelease: () => onRelease?.() });
              return {
                release: async () => {
                  state.releases += 1;
                },
                addEventListener: (_type, listener) => {
                  onRelease = listener;
                },
              };
            },
          },
        }
      : {},
    document: {
      get visibilityState() {
        return state.visible ? "visible" : "hidden";
      },
      addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
    } as unknown as WakeLockEnv["document"],
    warn: (message) => void warnings.push(message),
  };
  return {
    env,
    state,
    warnings,
    sentinels,
    listeners,
    setVisible(visible: boolean) {
      state.visible = visible;
      for (const listener of [...listeners]) listener();
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("holdWakeLock", () => {
  test("takes the screen lock while held and releases it when let go", async () => {
    const f = fakeEnv();
    const release = holdWakeLock(f.env);
    await settle();
    expect(f.state.requests).toBe(1);
    release();
    await settle();
    expect(f.state.releases).toBe(1);
    expect(f.listeners.size).toBe(0);
  });

  test("a hidden tab loses the lock; coming back takes it again, once", async () => {
    const f = fakeEnv();
    const release = holdWakeLock(f.env);
    await settle();
    f.setVisible(false);
    f.sentinels[0]!.fireRelease();
    f.setVisible(true);
    f.setVisible(true);
    await settle();
    expect(f.state.requests).toBe(2);
    release();
    await settle();
    expect(f.state.releases).toBe(1);
  });

  test("starting in a hidden tab waits for it to show", async () => {
    const f = fakeEnv({ visible: false });
    const release = holdWakeLock(f.env);
    await settle();
    expect(f.state.requests).toBe(0);
    expect(f.warnings).toEqual([]);
    f.setVisible(true);
    await settle();
    expect(f.state.requests).toBe(1);
    release();
  });

  test("letting go while the request is out releases the lock when it arrives", async () => {
    const f = fakeEnv();
    const release = holdWakeLock(f.env);
    release();
    await settle();
    expect(f.state.requests).toBe(1);
    expect(f.state.releases).toBe(1);
  });

  test("an unsupported browser warns once and does not throw", async () => {
    const f = fakeEnv({ supported: false });
    const release = holdWakeLock(f.env);
    f.setVisible(true);
    f.setVisible(true);
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("no screen wake lock");
    release();
  });

  test("a rejected request warns and does not throw", async () => {
    const f = fakeEnv({ rejectWith: new Error("NotAllowedError") });
    const release = holdWakeLock(f.env);
    await settle();
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("Could not hold the screen wake lock");
    release();
  });
});

describe("useWakeLock", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = installReactTestEnv();
  });
  afterEach(() => restoreEnv());

  test("held while wanted, released on pause or stop, taken again on resume", async () => {
    const f = fakeEnv();
    function Probe({ wanted }: { wanted: boolean }) {
      useWakeLock(wanted, f.env);
      return null;
    }
    const view = mount();
    await view.render(<Probe wanted={false} />);
    await settle();
    expect(f.state.requests).toBe(0);
    await view.render(<Probe wanted />);
    await settle();
    expect(f.state.requests).toBe(1);
    await view.render(<Probe wanted={false} />);
    await settle();
    expect(f.state.releases).toBe(1);
    await view.render(<Probe wanted />);
    await settle();
    expect(f.state.requests).toBe(2);
    await view.unmount();
    await settle();
    expect(f.state.releases).toBe(2);
  });
});
