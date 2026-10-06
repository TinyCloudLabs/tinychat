// The display-only live-capture store behind the Live Edge.
import { afterEach, describe, expect, test } from "bun:test";

import { edgeLevel, liveCapture } from "./liveCapture";

afterEach(() => liveCapture.set(null));

describe("liveCapture", () => {
  test("publishes a capture and its clearing, and only real changes", () => {
    const heard: Array<ReturnType<typeof liveCapture.get>> = [];
    const unsubscribe = liveCapture.subscribe(() => heard.push(liveCapture.get()));
    liveCapture.set({ source: "voice-note", warning: false, startedAt: 1 });
    liveCapture.set({ source: "voice-note", warning: false, startedAt: 1 });
    liveCapture.set({ source: "voice-note", warning: true, startedAt: 1 });
    liveCapture.set(null);
    unsubscribe();
    liveCapture.set({ source: "offline-voice-note", warning: false, startedAt: 2 });
    expect(heard).toEqual([
      { source: "voice-note", warning: false, startedAt: 1 },
      { source: "voice-note", warning: true, startedAt: 1 },
      null,
    ]);
  });

  test("levels fan out to every subscriber until they leave", () => {
    const a: number[] = [];
    const b: number[] = [];
    const offA = liveCapture.subscribeLevel((level) => a.push(level));
    const offB = liveCapture.subscribeLevel((level) => b.push(level));
    liveCapture.setLevel(0.25);
    offA();
    liveCapture.setLevel(0.5);
    offB();
    liveCapture.setLevel(1);
    expect(a).toEqual([0.25]);
    expect(b).toEqual([0.25, 0.5]);
  });

  test("the edge lifts quiet input and lets a peak fall away by 30% a sample", () => {
    expect(edgeLevel(0.25, 0)).toBe(0.5);
    expect(edgeLevel(0, 1)).toBeCloseTo(0.7);
    expect(edgeLevel(2, 0)).toBe(1);
    expect(edgeLevel(-1, 0)).toBe(0);
  });
});
