import { describe, expect, test } from "bun:test";
import { LevelSourceAdapter, sourceFromLevel } from "./source";

describe("LevelSourceAdapter", () => {
  test("holds voice activity for 450 ms after the last voiced sample", () => {
    const adapter = new LevelSourceAdapter();
    expect(adapter.update(0.4, 0.5, 100).act).toBe(1);
    expect(adapter.update(0.02, 0.03, 500).act).toBe(1);
    expect(adapter.update(0.02, 0.03, 551).act).toBe(0);
  });

  test("is deterministic and returns normalized bands and waveform", () => {
    const a = sourceFromLevel(0.6, 0.9), b = sourceFromLevel(0.6, 0.9);
    expect(Array.from(a.spec)).toEqual(Array.from(b.spec));
    expect(Array.from(a.wave)).toEqual(Array.from(b.wave));
    expect(a.spec).toHaveLength(32); expect(a.wave).toHaveLength(128);
    expect([...a.spec, ...a.wave, a.level, a.act, a.low, a.mid, a.high, a.centroid].every((v) => v >= -1 && v <= 1)).toBe(true);
  });

  test("seeded band noise and frame interpolation are reproducible", () => {
    const first = new LevelSourceAdapter(42);
    const second = new LevelSourceAdapter(42);
    first.update(0.7, 0.8, 1000); second.update(0.7, 0.8, 1000);
    const a = first.sample(1050), b = second.sample(1050);
    expect(Array.from(a.spec)).toEqual(Array.from(b.spec));
    expect(a.level).toBeGreaterThan(0);
    expect(a.level).toBeLessThan(0.7);
    expect(first.sample(1100).level).toBeGreaterThan(a.level);
  });
});
