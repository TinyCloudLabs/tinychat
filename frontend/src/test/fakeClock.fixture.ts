import { jest, spyOn } from "bun:test";
import { act } from "react";

// A test helper (bun:test only), named .fixture.ts so the app's tsc build leaves it out.

export interface FakeClock {
  /** Moves the fake clock by `ms`, inside act(). */
  advance(ms: number): Promise<void>;
  restore(): void;
}

/**
 * Routes happy-dom's window timers through Bun's fake clock (call after installDom).
 * Returns `advance(ms)`, which moves the clock inside act(), and `restore()`.
 */
export function installFakeClock(): FakeClock {
  jest.useFakeTimers();
  const spies = [
    spyOn(window, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (typeof callback !== "function") throw new Error("Unexpected string timer");
      return Number(globalThis.setTimeout(() => callback(...args), delay));
    }),
    spyOn(window, "setInterval").mockImplementation((callback, delay, ...args) => {
      if (typeof callback !== "function") throw new Error("Unexpected string timer");
      return Number(globalThis.setInterval(() => callback(...args), delay));
    }),
    spyOn(window, "clearTimeout").mockImplementation((id) => globalThis.clearTimeout(id)),
    spyOn(window, "clearInterval").mockImplementation((id) => globalThis.clearInterval(id)),
  ];
  return {
    async advance(ms: number) { await act(async () => { jest.advanceTimersByTime(ms); }); },
    restore() { for (const spy of spies) spy.mockRestore(); jest.useRealTimers(); },
  };
}
