import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { RecorderState } from "./recorderReducer";
import { useRecordedElapsed } from "./useRecordedElapsed";

type ClockState = Pick<RecorderState, "phase" | "mic" | "elapsedAt">;
const live: ClockState = { phase: "recording", mic: { state: "recording", reason: null }, elapsedAt: 0 };
const interrupted: ClockState = { phase: "recording", mic: { state: "interrupted", reason: "call" }, elapsedAt: 0 };
const paused: ClockState = { phase: "recording", mic: { state: "paused", reason: "user" }, elapsedAt: 0 };

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
const container = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "", addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;
const roots = new Map<string, Root>();
const values = new Map<string, number>();

function Probe(props: { id: string; elapsedMs: number; recorder: ClockState }) {
  values.set(props.id, useRecordedElapsed(props.elapsedMs, props.recorder));
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
  values.clear();
  Date.now = () => now;
  Object.assign(globalThis, {
    setInterval: (callback: () => void) => { const id = ++nextTimer; intervals.set(id, callback); return id; },
    clearInterval: (id: number) => { intervals.delete(id); },
  });
});
afterEach(async () => {
  await act(async () => { for (const root of roots.values()) root.unmount(); });
  roots.clear();
  Date.now = saved.now;
  Object.assign(globalThis, { setInterval: saved.setInterval, clearInterval: saved.clearInterval });
});

async function render(elapsedMs: number, recorder: ClockState, id = "first") {
  let root = roots.get(id);
  if (!root) { root = createRoot(container()); roots.set(id, root); }
  await act(async () => root.render(<Probe id={id} elapsedMs={elapsedMs} recorder={recorder} />));
}

async function advance(ms: number) {
  now += ms;
  await act(async () => { for (const tick of intervals.values()) tick(); });
}

describe("useRecordedElapsed", () => {
  test("mounting 40 seconds after the checkpoint includes those 40 seconds", async () => {
    now = 40_000;
    await render(79_706, live);
    expect(values.get("first")).toBe(119_706);
  });

  test("views mounted at different times agree on one live elapsed clock", async () => {
    await render(79_706, live);
    await advance(40_000);
    await render(79_706, live, "second");
    expect(values.get("first")).toBe(119_706);
    expect(values.get("second")).toBe(119_706);
    await advance(500);
    expect(values.get("first")).toBe(values.get("second"));
  });

  test("an interruption keeps ticking through a ten-minute call, then user Pause freezes the clock", async () => {
    const atCall = 2 * 3_600_000 + 45 * 60_000;
    await render(atCall, live);
    await render(atCall, interrupted);
    await advance(10 * 60_000);
    expect(values.get("first")).toBe(atCall + 10 * 60_000);

    await render(atCall + 10 * 60_000, { ...paused, elapsedAt: now });
    await advance(5 * 60_000);
    expect(values.get("first")).toBe(atCall + 10 * 60_000);
    expect(intervals.size).toBe(0);
  });

  test("a stopped recording keeps the frozen value", async () => {
    await render(79_706, live);
    await advance(40_000);
    await render(119_706, { ...live, phase: "saving", elapsedAt: now });
    await advance(10_000);
    expect(values.get("first")).toBe(119_706);
    expect(intervals.size).toBe(0);
  });

  test("a native elapsed checkpoint resyncs the running clock", async () => {
    await render(1000, live);
    await advance(2000);
    expect(values.get("first")).toBe(3000);
    await render(3500, { ...interrupted, elapsedAt: now });
    expect(values.get("first")).toBe(3500);
    await advance(500);
    expect(values.get("first")).toBe(4000);
  });
});
