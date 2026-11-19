// "Keep recording?" (TC-2081): five minutes before a desktop recording's limit; Keep going adds one hour and asks again
// before the new limit; Stop now stops and saves at once; Escape, or no answer, leaves the stop at the limit. Fake clock: no test waits for real minutes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { fakeClock } from "./final/shell/hookTestUtil";
import { KeepRecordingPrompt } from "./KeepRecordingPrompt";
import { StaticRecorderProvider, type RecorderValue } from "./RecorderProvider";
import { clockTime } from "./recorderCopy";

const MIN = 60_000;
const HOUR = 60 * MIN;

let restoreDom: () => void;
let clock: ReturnType<typeof fakeClock>;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  restoreDom = installDom();
  clock = fakeClock();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  clock.restore();
  restoreDom();
});

/** A recording `recordedMs` in (checkpointed now) with a limit, as the desktop recorder sees it. */
function recording(limitMs: number, recordedMs: number, patch: Partial<RecorderValue> = {}): Partial<RecorderValue> {
  return { phase: "recording", mic: { state: "recording", reason: null }, startedAt: 0, audioMs: recordedMs, elapsedMs: recordedMs,
    elapsedAt: clock.now, maxDurationMs: limitMs, autoStop: true, extendLimit: async () => {}, ...patch };
}

async function show(value: Partial<RecorderValue>, node: ReactNode = <KeepRecordingPrompt />) {
  await act(async () => root.render(<StaticRecorderProvider value={value}>{node}</StaticRecorderProvider>));
}

const prompt = () => host.querySelector('[data-testid="keep-recording-prompt"]');
const confirmation = () => host.querySelector('[data-testid="keep-recording-confirmation"]');
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const stopsAt = (limitMs: number, recordedMs: number) => clockTime(clock.now + (limitMs - recordedMs));

describe("Keep recording? prompt", () => {
  test("appears five minutes before the limit with Monica's wording and the local stop time", async () => {
    await show(recording(HOUR, 54 * MIN));
    expect(prompt()).toBeNull();
    await clock.advance(MIN + 1000);
    await show(recording(HOUR, 55 * MIN + 1000));
    const at = stopsAt(HOUR, 55 * MIN + 1000);
    expect(prompt()).not.toBeNull();
    expect(prompt()!.textContent).toContain("Keep recording?");
    expect(prompt()!.textContent).toContain(`This recording stops at ${at} unless you keep going.`);
    expect(button("Keep going")).toBeDefined();
    expect(button("Stop now")).toBeDefined();
    expect(button(`Stop at ${at}`)).toBeUndefined();
  });

  test("the clock ticking brings it up without a new checkpoint", async () => {
    await show(recording(HOUR, 50 * MIN));
    expect(prompt()).toBeNull();
    await clock.advance(6 * MIN);
    expect(prompt()).not.toBeNull();
  });

  test("Keep going adds one hour once, says when it now stops, and asks again five minutes before the new limit", async () => {
    let extended = 0;
    const extendLimit = async () => { extended++; };
    await show(recording(HOUR, 56 * MIN, { extendLimit }));
    expect(prompt()).not.toBeNull();
    await act(async () => button("Keep going")!.click());
    expect(extended).toBe(1);
    // The engine raised the limit: the recorder state now carries two hours.
    await show(recording(2 * HOUR, 56 * MIN, { extendLimit }));
    expect(prompt()).toBeNull();
    expect(confirmation()!.textContent).toBe(`Recording continues until ${stopsAt(2 * HOUR, 56 * MIN)}.`);
    // Fifty-five minutes of recording later it is five minutes from the new limit: asked again.
    await clock.advance(54 * MIN);
    await show(recording(2 * HOUR, 56 * MIN + 54 * MIN, { extendLimit, elapsedAt: clock.now }));
    expect(prompt()).toBeNull();
    await clock.advance(56 * MIN);
    await show(recording(2 * HOUR, 115 * MIN + 1000, { extendLimit, elapsedAt: clock.now }));
    expect(prompt()).not.toBeNull();
    expect(prompt()!.textContent).toContain("Keep recording?");
    expect(extended).toBe(1);
  });

  test("Stop now stops and saves at once through the recorder's stop, and nothing extends", async () => {
    let extended = 0;
    let stopped = 0;
    await show(recording(HOUR, 56 * MIN, { extendLimit: async () => { extended++; }, stop: () => { stopped++; } }));
    await act(async () => button("Stop now")!.click());
    expect(stopped).toBe(1);
    expect(extended).toBe(0);
  });

  test("Escape keeps the planned stop at the limit: it does not stop or extend, and does not come back for that limit", async () => {
    let extended = 0;
    let stopped = 0;
    const patch = (recordedMs: number) => recording(HOUR, recordedMs, { extendLimit: async () => { extended++; }, stop: () => { stopped++; } });
    await show(patch(56 * MIN));
    await act(async () => { prompt()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(prompt()).toBeNull();
    await clock.advance(2 * MIN);
    await show(patch(58 * MIN));
    expect(prompt()).toBeNull();
    expect(extended).toBe(0);
    expect(stopped).toBe(0);
  });

  test("Escape closes it the same way: no answer never extends", async () => {
    let extended = 0;
    await show(recording(HOUR, 56 * MIN, { extendLimit: async () => { extended++; } }));
    await act(async () => { prompt()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(prompt()).toBeNull();
    expect(extended).toBe(0);
  });

  test("an extension the engine refuses leaves the prompt up, so the recording still stops at its limit", async () => {
    await show(recording(HOUR, 56 * MIN, { extendLimit: async () => { throw new Error("recorder_busy"); } }));
    await act(async () => button("Keep going")!.click());
    expect(prompt()).not.toBeNull();
    expect(confirmation()).toBeNull();
  });

  test("never at the phone layout, under the silent cap, while paused, or where the engine cannot change the limit", async () => {
    const near = recording(HOUR, 56 * MIN);
    await show({ ...near, autoStop: false });
    expect(prompt()).toBeNull();
    await show({ ...near, extendLimit: undefined });
    expect(prompt()).toBeNull();
    await show({ ...near, mic: { state: "paused", reason: "user" } });
    expect(prompt()).toBeNull();
    await show({ ...near, phase: "idle" });
    expect(prompt()).toBeNull();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await show(near);
    expect(prompt()).toBeNull();
  });
});
