// The stop time's controls (TC-2182): +15 min, +30 min and No limit change the running recording's limit only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import type { LimitExtension } from "@/lib/voiceNotes/nativeVoiceNotes";
import { AutoStopControls } from "./final/AutoStopControls";
import { HeaderRecordButton } from "./HeaderRecordButton";
import { initialRecorderState, recorderReducer } from "./recorderReducer";
import { StaticRecorderProvider, type RecorderValue } from "./RecorderProvider";

const MIN = 60_000;
const HOUR = 60 * MIN;
const SAFETY_CAP = 8 * HOUR;

let restoreDom: () => void;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  restoreDom = installDom();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreDom();
});

const show = (value: Partial<RecorderValue>, node: React.ReactNode) =>
  act(async () => root.render(<StaticRecorderProvider value={value}>{node}</StaticRecorderProvider>));
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe("AutoStopControls", () => {
  test("each button asks for its own extension: 15 minutes, 30 minutes, none", async () => {
    const asked: Array<LimitExtension | undefined> = [];
    await show({ extendLimit: async (extension) => { asked.push(extension); } }, <AutoStopControls />);
    for (const label of ["+15 min", "+30 min", "No limit"]) await act(async () => button(label)!.click());
    expect(asked).toEqual([15 * MIN, 30 * MIN, "none"]);
  });

  test("absent where the engine cannot change a running limit", async () => {
    await show({ extendLimit: undefined }, <AutoStopControls />);
    expect(host.querySelector('[data-testid="limit-controls"]')).toBeNull();
  });

  test("a refused change says so and leaves the buttons usable", async () => {
    await show({ extendLimit: async () => { throw new Error("recorder_busy"); } }, <AutoStopControls />);
    await act(async () => button("+15 min")!.click());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("still stops at the time shown");
    expect(button("+15 min")!.disabled).toBe(false);
  });
});

describe("limit state", () => {
  const live = recorderReducer(
    recorderReducer(initialRecorderState, { type: "START_REQUESTED" }),
    { type: "STARTED", id: "rec-1", startedAt: 0, maxDurationMs: HOUR, elapsedAt: 0 },
  );

  test("an extension past an hour is kept: there is no 60-minute cap", () => {
    const next = recorderReducer(live, { type: "LIMIT_EXTENDED", maxDurationMs: HOUR + 15 * MIN });
    expect(next).toMatchObject({ maxDurationMs: HOUR + 15 * MIN, autoStop: true });
    expect(recorderReducer(next, { type: "LIMIT_EXTENDED", maxDurationMs: HOUR + 45 * MIN }).maxDurationMs).toBe(HOUR + 45 * MIN);
  });

  test("no limit turns the stop time off for this recording and keeps the engine's cap", () => {
    expect(recorderReducer(live, { type: "LIMIT_EXTENDED", maxDurationMs: SAFETY_CAP, noLimit: true }))
      .toMatchObject({ maxDurationMs: SAFETY_CAP, autoStop: false });
  });

  test("a late extension never lowers the limit", () => {
    expect(recorderReducer(live, { type: "LIMIT_EXTENDED", maxDurationMs: 30 * MIN })).toBe(live);
  });
});

describe("header microphone", () => {
  test("is not drawn while recording; it is drawn when idle", async () => {
    await show({ available: true, ready: true, phase: "recording", outcome: null }, <HeaderRecordButton />);
    expect(host.querySelector('[data-testid="header-voice-note"]')).toBeNull();
    await show({ available: true, ready: true, phase: "idle", outcome: null }, <HeaderRecordButton />);
    expect(host.querySelector('[data-testid="header-voice-note"]')).not.toBeNull();
  });
});
