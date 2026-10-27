// A recording under the silent safety cap (Stop recordings automatically off: the phone layout's default) shows no
// countdown anywhere: no "Stops in", no "Stops at" line, no hover text, no limit bar. TC-2081.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { PlatformContext } from "@/lib/platform";

import { StaticRecorderProvider, useRecorder, type RecorderValue } from "../RecorderProvider";
import { initialRecorderState } from "../recorderReducer";
import { RibbonView } from "./Ribbon";
import { SidebarDockView } from "./SidebarDock";
import { minimizedLimit, minimizedView } from "./minimizedView";
import { selectRecorderView } from "./recorderView";
import { PhoneRecorder } from "./PhoneRecorder";

const MIN = 60_000;
const HOUR = 60 * MIN;
const CAP = 8 * HOUR;

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

const running = (patch: Partial<RecorderValue>): Partial<RecorderValue> => ({
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: 0,
  audioMs: 2 * MIN,
  elapsedMs: 2 * MIN,
  elapsedAt: Date.now(),
  ...patch,
});

describe("a recording under the silent safety cap", () => {
  const capped = running({ maxDurationMs: CAP, autoStop: false });
  const automatic = running({ maxDurationMs: HOUR, autoStop: true });

  test("the view has no countdown, in any phase of the clock; the automatic one does", () => {
    const base = { ...initialRecorderState, phase: "recording" as const, mic: { state: "recording" as const, reason: null }, maxDurationMs: CAP };
    const input = { nowMs: Date.now(), elapsedMs: 2 * MIN, inputName: null, silencedSinceMs: null, device: "mac" as const };
    expect(selectRecorderView({ ...base, autoStop: false }, input).timer.countdown).toBeUndefined();
    expect(selectRecorderView({ ...base, autoStop: false }, { ...input, elapsedMs: CAP - MIN }).timer.countdown).toBeUndefined();
    expect(selectRecorderView({ ...base, autoStop: true }, input).timer.countdown).toBeDefined();
  });

  test("minimizedLimit is null: no readout, no hover time, no limit bar", () => {
    const recorder = recorderWith(capped);
    expect(minimizedLimit(minimizedView(recorder, 2 * MIN), recorder.maxDurationMs)).toBeNull();
    const nearCap = recorderWith({ ...capped, elapsedMs: CAP - MIN, audioMs: CAP - MIN });
    expect(minimizedLimit(minimizedView(nearCap, CAP - MIN), nearCap.maxDurationMs)).toBeNull();
    const withLimit = recorderWith(automatic);
    expect(minimizedLimit(minimizedView(withLimit, 2 * MIN), withLimit.maxDurationMs)).not.toBeNull();
  });

  test("Ribbon and dock render no Stops in, no Recording stops at, and no limit line", () => {
    const ribbon = renderToStaticMarkup(<RibbonView recorder={recorderWith(capped)} elapsedMs={2 * MIN} theme="night" />);
    const dock = renderToStaticMarkup(<SidebarDockView recorder={recorderWith(capped)} elapsedMs={2 * MIN} theme="night" />);
    for (const html of [ribbon, dock]) {
      expect(html).not.toMatch(/Stops in|Stops at|stops at/);
      expect(html).toContain("2:00");
    }
  });
});

describe("the phone recorder sheet", () => {
  const sheet = (patch: Partial<RecorderValue>) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <PlatformContext.Provider value="ios">
          <StaticRecorderProvider value={{ ...running({}), recordingId: "rec-1", sheetOpen: true, ...patch }}>
            <PhoneRecorder />
          </StaticRecorderProvider>
        </PlatformContext.Provider>
      </MemoryRouter>,
    );

  test("with automatic stopping off the sheet shows the timer and no stop time; with it on, the stop time sits under the timer", () => {
    expect(sheet({ maxDurationMs: CAP, autoStop: false })).not.toMatch(/Stops at|pr-countdown/);
    expect(sheet({ maxDurationMs: HOUR, autoStop: true })).toMatch(/class="pr-countdown">Stops at [^<]+</);
  });
});
