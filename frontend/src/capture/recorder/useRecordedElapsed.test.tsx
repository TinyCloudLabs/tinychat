import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { RecorderState } from "./recorderReducer";
import { useRecordedElapsed } from "./useRecordedElapsed";

type ClockState = Pick<RecorderState, "phase" | "mic">;
const live: ClockState = { phase: "recording", mic: { state: "recording", reason: null } };
const interrupted: ClockState = { phase: "recording", mic: { state: "interrupted", reason: "call" } };
const paused: ClockState = { phase: "recording", mic: { state: "paused", reason: "user" } };

const saved = {
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  now: Date.now,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};
let now = 0;
let nextTimer = 0;
const intervals = new Map<number, () => void>();
const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
let root: Root | null = null;
let value = 0;

function Probe(props: { elapsedMs: number; recorder: ClockState }) {
  value = useRecordedElapsed(props.elapsedMs, props.recorder);
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});
beforeEach(() => {
  now = 0;
  nextTimer = 0;
  intervals.clear();
  Date.now = () => now;
  Object.assign(globalThis, {
    setInterval: (callback: () => void) => { const id = ++nextTimer; intervals.set(id, callback); return id; },
    clearInterval: (id: number) => { intervals.delete(id); },
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  Date.now = saved.now;
  Object.assign(globalThis, { setInterval: saved.setInterval, clearInterval: saved.clearInterval });
});

async function render(elapsedMs: number, recorder: ClockState) {
  root ??= createRoot(container);
  await act(async () => root!.render(<Probe elapsedMs={elapsedMs} recorder={recorder} />));
}

async function advance(ms: number) {
  now += ms;
  await act(async () => { for (const tick of intervals.values()) tick(); });
}

describe("useRecordedElapsed", () => {
  test("an interruption keeps ticking through a ten-minute call, then user Pause freezes the clock", async () => {
    const atCall = 2 * 3_600_000 + 45 * 60_000;
    await render(atCall, live);
    await render(atCall, interrupted);
    await advance(10 * 60_000);
    expect(value).toBe(atCall + 10 * 60_000);

    await render(atCall + 10 * 60_000, paused);
    await advance(5 * 60_000);
    expect(value).toBe(atCall + 10 * 60_000);
    expect(intervals.size).toBe(0);
  });

  test("a native elapsed checkpoint resyncs the running clock", async () => {
    await render(1000, live);
    await advance(2000);
    expect(value).toBe(3000);
    await render(3500, interrupted);
    expect(value).toBe(3500);
    await advance(500);
    expect(value).toBe(4000);
  });
});
