// The minimised bar (TC-2077): timer, Pause and Stop only, plus the recording limit's thin line, "Stops in"
// readout and the exact stop time on hover; no waveform and no status line.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StaticRecorderProvider, useRecorder, type RecorderValue } from "../RecorderProvider";
import { clockTime } from "../recorderCopy";
import { FINAL_COPY } from "./finalCopy";
import { RibbonView } from "./Ribbon";
import { SidebarDockView } from "./SidebarDock";
import { minimizedLimit, minimizedView } from "./minimizedView";

const MIN = 60_000;

function recorderWith(patch: Partial<RecorderValue>): RecorderValue {
  let seen: RecorderValue | null = null;
  const Grab = () => {
    seen = useRecorder();
    return null;
  };
  renderToStaticMarkup(
    <StaticRecorderProvider value={patch}>
      <Grab />
    </StaticRecorderProvider>,
  );
  return seen!;
}

const LIMIT = 10 * MIN;
const running = (elapsedMs: number, elapsedAt = Date.now()): Partial<RecorderValue> => ({
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: 0,
  audioMs: elapsedMs,
  elapsedMs,
  elapsedAt,
  maxDurationMs: LIMIT,
});
const paused = (elapsedMs: number): Partial<RecorderValue> => ({
  ...running(elapsedMs),
  mic: { state: "paused", reason: "user" },
});

const limitOf = (patch: Partial<RecorderValue>, elapsedMs = patch.elapsedMs ?? 0) => {
  const recorder = recorderWith(patch);
  return minimizedLimit(minimizedView(recorder, elapsedMs), recorder.maxDurationMs);
};

describe("minimizedLimit", () => {
  test("remaining time and the used fraction follow the elapsed time", () => {
    const early = limitOf(running(2 * MIN))!;
    expect(early.stopsIn).toBe("Stops in 8:00");
    expect(early.fraction).toBeCloseTo(0.2, 6);
    const late = limitOf(running(7.5 * MIN))!;
    expect(late.stopsIn).toBe("Stops in 2:30");
    expect(late.fraction).toBeCloseTo(0.75, 6);
  });

  test("Pause freezes it and Resume carries on from the same place", () => {
    const before = limitOf(paused(3 * MIN))!;
    expect(before.stopsIn).toBe("Stops in 7:00");
    expect(before.fraction).toBeCloseTo(0.3, 6);
    // The same elapsed time a while later (the pause went on): the remaining time did not move.
    const later = limitOf(paused(3 * MIN), 3 * MIN)!;
    expect(later.stopsIn).toBe(before.stopsIn);
    expect(later.fraction).toBe(before.fraction);
    expect(limitOf(running(3 * MIN + 5_000))).toMatchObject({ stopsIn: "Stops in 6:55" });
  });

  test("it names the exact local clock time the recording stops", () => {
    const at = new Date(2026, 9, 26, 14, 5).getTime();
    const limit = limitOf(running(2 * MIN, at - 8 * MIN), 2 * MIN);
    expect(limit?.stopsAt).toBe(FINAL_COPY.recordingStopsAt(clockTime(at)));
    expect(limit?.stopsAt).toMatch(/^Recording stops at \d/);
  });

  test("the line is clamped to the bar", () => {
    expect(limitOf(running(LIMIT), LIMIT + 5 * MIN)?.fraction).toBe(1);
  });

  test("with no limit there is nothing to show", () => {
    const view = minimizedView(recorderWith(running(MIN)), MIN);
    for (const max of [0, -1, Infinity, NaN, undefined, null]) {
      expect(minimizedLimit(view, max)).toBeNull();
    }
    const { countdown: _gone, ...timer } = view.timer;
    expect(minimizedLimit({ timer }, LIMIT)).toBeNull();
  });
});

describe("the minimised bar", () => {
  const dock = (patch: Partial<RecorderValue>) =>
    renderToStaticMarkup(
      <SidebarDockView recorder={recorderWith(patch)} elapsedMs={patch.elapsedMs ?? 0} theme="night" />,
    );

  test("dock: timer, Pause and Stop, with no waveform and no Listening line", () => {
    const html = dock(running(2 * MIN));
    expect(html).toContain('data-testid="dock-timer">2:00<');
    expect(html).toContain('aria-label="Pause recording"');
    expect(html).toContain('aria-label="Stop and save"');
    expect(html).not.toContain("data-bar");
    expect(html).not.toContain("data-spectrum-bars");
    expect(html).not.toMatch(/Listening/);
    expect(html).not.toContain("dock-status");
  });

  test("the dock carries the readout, the thin line and the hover text the control is described by", () => {
    for (const html of [dock(running(2 * MIN))]) {
      expect(html).toContain(">Stops in 8:00<");
      expect(html).toMatch(/role="tooltip"[^>]*>Recording stops at /);
      expect(html).toMatch(/aria-hidden="true"[^>]*data-testid="(ribbon|dock)-limit"/);
      expect(html).toContain("width:20.0%");
      const id = /aria-describedby="[^"]*?(_R_\w+_)"/.exec(html)![1]!;
      expect(html).toContain(`id="${id}" class="mini-tip"`);
    }
  });
});
