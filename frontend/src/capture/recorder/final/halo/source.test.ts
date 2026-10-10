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
    expect(adapter.update(0.11, 0.14, 100).act).toBeGreaterThan(0);
    expect(adapter.update(0.02, 0.03, 500).act).toBeGreaterThan(0);
    const beforeRelease = adapter.sample(549).act;
    const afterHold = adapter.sample(551).act;
    expect(afterHold).toBeLessThan(beforeRelease);
    let released = afterHold;
    for (let time = 567; time <= 2_000; time += 16) {
      released = adapter.sample(time).act;
    }
    expect(released).toBeLessThan(0.03);
  });

  test("smooths incoming level with a faster attack than release", () => {
    const adapter = new LevelSourceAdapter(8);
    const firstLevel = adapter.update(0.8, 0.8, 1000).level;
    const attackedLevel = adapter.sample(1050).level;
    const releaseStart = adapter.update(0, 0, 1060).level;
    const released = adapter.sample(1110).level;

    expect(firstLevel).toBeGreaterThan(0);
    expect(attackedLevel).toBeGreaterThan(firstLevel);
    expect(attackedLevel - firstLevel).toBeGreaterThan(
      firstLevel - releaseStart,
    );
    expect(released).toBeLessThan(releaseStart);
    expect(released).toBeGreaterThan(0);
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
    expect(first.sample(1066)).toBe(a);
    expect(first.sample(1066).spec).toBe(a.spec);
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
    const output = new Float32Array(2);
    const whitened = whitenSpectrum(values, means, 0.5, output);

    expect(whitened[0]).toBeGreaterThan(whitened[1]);
    expect(whitened[0]).toBeCloseTo((0.4 / 0.28) * 0.45 * 0.8, 6);
    expect(whitened[1]).toBeCloseTo((0.4 / 0.88) * 0.45 * 0.8, 6);
    expect(whitened).toBe(output);
  });

  test("holds spectrum jitter still when reduced motion is requested", () => {
    const adapter = new LevelSourceAdapter(73);
    adapter.update(0.35, 0.42, 1000);
    adapter.sample(1100, true);
    const beforeSource = adapter.sample(1200, true);
    const before = Array.from(beforeSource.spec);
    const beforeLevel = beforeSource.level;
    const beforeWave = Array.from(beforeSource.wave);
    const after = adapter.sample(1300, true);

    const priorNoise = before.map(
      (value, index) =>
        (value - sourceFromLevel(beforeLevel).spec[index]) /
        (0.25 + beforeLevel * 0.75),
    );
    after.spec.forEach((value, index) => {
      const noise =
        (value - sourceFromLevel(after.level).spec[index]) /
        (0.25 + after.level * 0.75);
      expect(noise).toBeCloseTo(priorNoise[index], 2);
    });
    const scale = Math.max(...beforeWave.map(Math.abs));
    const nextScale = Math.max(...after.wave.map(Math.abs));
    after.wave.forEach((value, index) =>
      expect(value / nextScale).toBeCloseTo(beforeWave[index] / scale, 5),
    );
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
