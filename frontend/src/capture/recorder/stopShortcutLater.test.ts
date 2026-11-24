import { describe, expect, spyOn, test } from "bun:test";
import { watchStopRequestsLater } from "./recordShortcut";
import * as stopShortcut from "./stopShortcut";
import type { StopRequests } from "./stopShortcut";

// The call prompt tile's Stop loads with its own chunk on the Mac (TC-2882). A chunk that does not load must leave the
// recorder as it is: nothing throws, nothing stops, and it is logged once.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The native side: one request held until it is claimed, announced to whoever listens. */
function nativeRequests() {
  let handler: (() => void) | null = null;
  let pending = false;
  const requests: StopRequests = {
    async subscribe(next) {
      handler = next;
      return () => { if (handler === next) handler = null; };
    },
    async take() {
      const claimed = pending;
      pending = false;
      return claimed;
    },
  };
  return { requests, listening: () => handler !== null, press: async () => { pending = true; handler?.(); await settle(); } };
}

describe("the tile's Stop, loaded on first use", () => {
  test("a chunk that does not load stops nothing, throws nothing and is logged once", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const calls: string[] = [];
      const unwatch = watchStopRequestsLater(() => ({ state: { phase: "recording" }, stop: () => calls.push("stop") }),
        () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/stopShortcut-x.js")));
      await settle();
      expect(calls).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(() => unwatch()).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  test("once loaded, a claim stops a live recording as it is then, and stopping listening ends it", async () => {
    const native = nativeRequests();
    const calls: string[] = [];
    let phase = "idle";
    const unwatch = watchStopRequestsLater(() => ({ state: { phase }, stop: () => calls.push("stop") }),
      async () => ({ ...stopShortcut, tauriStopRequests: native.requests }));
    await settle();
    expect(native.listening()).toBe(true);
    await native.press();
    expect(calls).toEqual([]);
    phase = "recording";
    await native.press();
    expect(calls).toEqual(["stop"]);
    unwatch();
    expect(native.listening()).toBe(false);
  });

  test("stopping listening before the chunk loads leaves nothing listening", async () => {
    const native = nativeRequests();
    const unwatch = watchStopRequestsLater(() => ({ state: { phase: "recording" }, stop: () => undefined }),
      async () => ({ ...stopShortcut, tauriStopRequests: native.requests }));
    unwatch();
    await settle();
    expect(native.listening()).toBe(false);
  });
});
