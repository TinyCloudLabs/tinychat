import { describe, expect, test } from "bun:test";
import {
  ACTIVE_HANG_MS, ACTIVE_LEVEL, createActivityTracker, LEVEL_INTERVAL_MS, levelFromAmplitude, measureLevels, startLevelMeter,
  type LevelMeterEnv, type LevelSample,
} from "./webLevels";

describe("level mapping", () => {
  test("silence is 0, -12 dBFS is 1, and the curve is the engine's gamma 1.5", () => {
    expect(levelFromAmplitude(0)).toBe(0);
    expect(levelFromAmplitude(10 ** (-60 / 20))).toBeCloseTo(0, 5);
    expect(levelFromAmplitude(10 ** (-12 / 20))).toBeCloseTo(1, 5);
    expect(levelFromAmplitude(1)).toBe(1);
    const dB = -36;
    expect(levelFromAmplitude(10 ** (dB / 20))).toBeCloseTo(((dB + 60) / 48) ** 1.5, 5);
  });

  test("rms drives level and the absolute peak drives peak", () => {
    const samples = new Float32Array(1024);
    samples[10] = 0.5;
    const { level, peak } = measureLevels(samples);
    expect(peak).toBeCloseTo(levelFromAmplitude(0.5), 5);
    expect(level).toBeLessThan(peak);
    expect(measureLevels(new Float32Array(0))).toEqual({ level: 0, peak: 0 });
    const negative = new Float32Array(8).fill(-0.5);
    expect(measureLevels(negative).peak).toBeCloseTo(levelFromAmplitude(0.5), 5);
  });
});

describe("voice activity", () => {
  test("a level above the threshold turns it on and it hangs for 450 ms after the level drops", () => {
    expect(ACTIVE_LEVEL).toBe(0.1);
    expect(ACTIVE_HANG_MS).toBe(450);
    const tracker = createActivityTracker();
    expect(tracker.update(0.05, 33)).toBe(false);
    expect(tracker.update(0.11, 33)).toBe(true);
    for (let elapsed = 33; elapsed < ACTIVE_HANG_MS; elapsed += 33) expect(tracker.update(0, 33)).toBe(true);
    expect(tracker.update(0, 33)).toBe(false);
  });

  test("a level exactly at the threshold is not activity", () => {
    expect(createActivityTracker().update(ACTIVE_LEVEL, 33)).toBe(false);
  });
});

describe("startLevelMeter", () => {
  test("samples the analyser on a ~30 Hz timer and stops cleanly", () => {
    let nowMs = 0;
    let handler: (() => void) | null = null;
    let interval = 0;
    const env: LevelMeterEnv = {
      now: () => nowMs,
      setInterval: (fn, ms) => { handler = fn; interval = ms; return 7; },
      clearInterval: (handle) => { expect(handle).toBe(7); handler = null; },
    };
    const loud = new Float32Array(1024).fill(0.25);
    let samples = loud;
    const analyser = { fftSize: 1024, getFloatTimeDomainData: (out: Float32Array) => out.set(samples) };
    const received: LevelSample[] = [];
    const meter = startLevelMeter(analyser, (sample) => received.push(sample), env);
    expect(interval).toBe(LEVEL_INTERVAL_MS);
    expect(1000 / interval).toBeGreaterThan(29);
    nowMs += 33; handler!();
    expect(received[0]).toMatchObject({ active: true });
    expect(received[0]!.level).toBeCloseTo(levelFromAmplitude(0.25), 5);
    samples = new Float32Array(1024);
    nowMs += 33; handler!();
    expect(received[1]).toMatchObject({ level: 0, peak: 0, active: true });
    meter.stop();
    expect(handler).toBeNull();
  });
});
