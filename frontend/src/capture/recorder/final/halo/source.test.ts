import { describe, expect, test } from "bun:test";
import {
  LevelSourceAdapter,
  QUIET,
  sourceFromLevel,
  whitenSpectrum,
} from "./source";

describe("Halo level source", () => {
  test("holds activity for 450 ms and then releases", () => {
    const adapter = new LevelSourceAdapter(7);
    expect(adapter.update(0.11, 0.14, 100).act).toBe(1);
    expect(adapter.update(0.02, 0.03, 500).act).toBe(1);
    expect(adapter.sample(551).act).toBe(0);
  });

  test("smooths incoming level with a faster attack than release", () => {
    const adapter = new LevelSourceAdapter(8);
    const first = adapter.update(0.8, 0.8, 1000);
    const attacked = adapter.sample(1050);
    const releaseStart = adapter.update(0, 0, 1060);
    const released = adapter.sample(1110);

    expect(first.level).toBeGreaterThan(0);
    expect(attacked.level).toBeGreaterThan(first.level);
    expect(attacked.level - first.level).toBeGreaterThan(
      first.level - releaseStart.level,
    );
    expect(released.level).toBeLessThan(releaseStart.level);
    expect(released.level).toBeGreaterThan(0);
  });

  test("produces the same seeded, smoothed spectrum for the same samples", () => {
    const first = new LevelSourceAdapter(42);
    const second = new LevelSourceAdapter(42);
    first.update(0.35, 0.42, 1000);
    second.update(0.35, 0.42, 1000);

    const a = first.sample(1050);
    const b = second.sample(1050);
    expect(Array.from(a.spec)).toEqual(Array.from(b.spec));
    expect(Array.from(a.wave)).toEqual(Array.from(b.wave));
    expect(a.spec).toHaveLength(32);
    expect(a.wave).toHaveLength(128);
    expect(
      [
        ...a.spec,
        ...a.wave,
        a.level,
        a.act,
        a.low,
        a.mid,
        a.high,
        a.centroid,
      ].every((value) => value >= -1 && value <= 1),
    ).toBe(true);
  });

  test("whitening normalizes bands relative to their own running mean", () => {
    const values = new Float32Array([0.4, 0.4]);
    const means = new Float32Array([0.2, 0.8]);
    const whitened = whitenSpectrum(values, means, 0.5);

    expect(whitened[0]).toBeGreaterThan(whitened[1]);
    expect(whitened[0]).toBeCloseTo((0.4 / 0.28) * 0.45 * 0.8, 6);
    expect(whitened[1]).toBeCloseTo((0.4 / 0.88) * 0.45 * 0.8, 6);
  });

  test("exports an entirely silent source", () => {
    expect(QUIET).toMatchObject({
      level: 0,
      act: 0,
      low: 0,
      mid: 0,
      high: 0,
      centroid: 0,
    });
    expect(QUIET.spec).toHaveLength(32);
    expect(QUIET.wave).toHaveLength(128);
    expect([...QUIET.spec, ...QUIET.wave].every((value) => value === 0)).toBe(
      true,
    );
    expect(sourceFromLevel(0)).toMatchObject({ level: 0, act: 0, centroid: 0 });
  });
});
