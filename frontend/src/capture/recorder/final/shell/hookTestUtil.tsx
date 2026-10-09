// Mounts React in a bare container for hook tests: no DOM, no global left behind (restore() puts them back).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export function installReactTestEnv() {
  const g = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
  const saved = { window: g.window, act: g.IS_REACT_ACT_ENVIRONMENT };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {}, innerWidth: 390, addEventListener() {}, removeEventListener() {} };
  return () => {
    g.window = saved.window;
    g.IS_REACT_ACT_ENVIRONMENT = saved.act;
  };
}

const container = () =>
  ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;

export function mount() {
  const root: Root = createRoot(container());
  return {
    render: (element: ReactNode) => act(async () => root.render(element)),
    unmount: () => act(async () => root.unmount()),
  };
}

/** Fires every interval callback (the 500 ms clock of useRecordedElapsed) after moving time on. */
export function fakeClock() {
  const real = { now: Date.now, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  let now = 1_000_000;
  let nextTimer = 0;
  const intervals = new Map<number, () => void>();
  Date.now = () => now;
  Object.assign(globalThis, {
    setInterval: (callback: () => void) => {
      const id = ++nextTimer;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: (id: number) => {
      intervals.delete(id);
    },
  });
  return {
    get now() {
      return now;
    },
    advance: async (ms: number) => {
      now += ms;
      await act(async () => {
        for (const tick of intervals.values()) tick();
      });
    },
    restore: () => {
      Date.now = real.now;
      Object.assign(globalThis, { setInterval: real.setInterval, clearInterval: real.clearInterval });
    },
  };
}
