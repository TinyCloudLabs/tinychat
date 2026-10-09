export interface HaloSource {
  level: number;
  act: number;
  low: number;
  mid: number;
  high: number;
  centroid: number;
  spec: Float32Array;
  wave: Float32Array;
}

const BAND_COUNT = 32;
const WAVE_COUNT = 128;
const MIN_HZ = 70;
const MAX_HZ = 9000;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const gauss = (value: number, sigma: number) =>
  Math.exp(-(value * value) / (2 * sigma * sigma));
const bandLogHz = Float32Array.from({ length: BAND_COUNT }, (_, index) =>
  Math.log2(MIN_HZ * (MAX_HZ / MIN_HZ) ** ((index + 0.5) / BAND_COUNT)),
);

export const QUIET: HaloSource = {
  level: 0,
  act: 0,
  low: 0,
  mid: 0,
  high: 0,
  centroid: 0,
  spec: new Float32Array(BAND_COUNT),
  wave: new Float32Array(WAVE_COUNT),
};

export function whitenSpectrum(
  spectrum: Float32Array,
  mean: Float32Array,
  level: number,
): Float32Array {
  return Float32Array.from(spectrum, (value, index) =>
    clamp01(
      (value / (mean[index] + 0.08)) * 0.45 * (0.35 + 0.9 * clamp01(level)),
    ),
  );
}

/** Maps a level sample to the fixed speech formant envelope without state or noise. */
export function sourceFromLevel(
  level: number,
  peak = level,
  act = level > 0.1 ? 1 : 0,
): HaloSource {
  const normalized = clamp01(level);
  const highWater = clamp01(peak);
  const spec = new Float32Array(BAND_COUNT);
  const wave = new Float32Array(WAVE_COUNT);
  let low = 0,
    mid = 0,
    high = 0,
    weighted = 0,
    total = 0;
  const f1 = Math.log2(500),
    f2 = Math.log2(1500);
  for (let index = 0; index < BAND_COUNT; index++) {
    const frequency = bandLogHz[index];
    const envelope =
      0.42 * gauss(frequency - 7.2, 1.1) +
      0.85 * gauss(frequency - f1, 0.38) +
      0.6 * gauss(frequency - f2, 0.32) +
      0.28 * gauss(frequency - 11.5, 0.45);
    const value = clamp01(envelope * normalized);
    spec[index] = value;
    if (index < 8) low += value / 8;
    else if (index < 20) mid += value / 12;
    else high += value / 12;
    weighted += value * index;
    total += value;
  }
  for (let index = 0; index < WAVE_COUNT; index++) {
    wave[index] =
      Math.sin((index / WAVE_COUNT) * Math.PI * 6) * highWater * 0.35;
  }
  return {
    level: normalized,
    act: clamp01(act),
    low,
    mid,
    high,
    centroid: total > 0 ? weighted / total / (BAND_COUNT - 1) : 0,
    spec,
    wave,
  };
}

/** Turns native level/peak events into a frame-rate, deterministic speech-shaped source. */
export class LevelSourceAdapter {
  private levelTarget = 0;
  private peakTarget = 0;
  private level = 0;
  private peak = 0;
  private activeUntil = 0;
  private lastSampleAt: number | null = null;
  private nextNoiseAt = 0;
  private phase = 0;
  private randomState: number;
  private noise = new Float32Array(BAND_COUNT);
  private noiseTarget = new Float32Array(BAND_COUNT);

  constructor(seed = 0x863) {
    this.randomState = seed >>> 0 || 1;
    this.rollNoise();
  }

  update(level: number, peak = level, now = performance.now()): HaloSource {
    this.levelTarget = clamp01(level);
    this.peakTarget = clamp01(peak);
    if (this.levelTarget > 0.1) this.activeUntil = now + 450;
    return this.sample(now);
  }

  /** Call each animation frame to interpolate the most recent native sample. */
  sample(now = performance.now()): HaloSource {
    const dt =
      this.lastSampleAt === null
        ? 1 / 60
        : Math.max(0, Math.min(0.1, (now - this.lastSampleAt) / 1000));
    this.lastSampleAt = now;
    const levelRate = this.levelTarget > this.level ? 28 : 5.5;
    const peakRate = this.peakTarget > this.peak ? 28 : 5.5;
    this.level +=
      (this.levelTarget - this.level) * (1 - Math.exp(-dt * levelRate));
    this.peak += (this.peakTarget - this.peak) * (1 - Math.exp(-dt * peakRate));
    if (now >= this.nextNoiseAt) {
      this.rollNoise();
      this.nextNoiseAt = now + 125;
    }
    const noiseMix = 1 - Math.exp(-dt * 1.8);
    for (let index = 0; index < BAND_COUNT; index++) {
      this.noise[index] +=
        (this.noiseTarget[index] - this.noise[index]) * noiseMix;
    }
    this.phase += dt * 2.2;
    const base = sourceFromLevel(
      this.level,
      this.peak,
      now < this.activeUntil ? 1 : 0,
    );
    const spec = new Float32Array(BAND_COUNT);
    let low = 0,
      mid = 0,
      high = 0,
      weighted = 0,
      total = 0;
    for (let index = 0; index < BAND_COUNT; index++) {
      const value = clamp01(
        base.spec[index] + this.noise[index] * (0.25 + this.level * 0.75),
      );
      spec[index] = value;
      if (index < 8) low += value / 8;
      else if (index < 20) mid += value / 12;
      else high += value / 12;
      weighted += value * index;
      total += value;
    }
    const wave = Float32Array.from(
      { length: WAVE_COUNT },
      (_, index) =>
        Math.sin((index / WAVE_COUNT) * Math.PI * 6 + this.phase) *
        this.peak *
        0.35,
    );
    return {
      level: this.level,
      act: base.act,
      low,
      mid,
      high,
      centroid: total > 0 ? weighted / total / (BAND_COUNT - 1) : 0,
      spec,
      wave,
    };
  }

  private rollNoise() {
    for (let index = 0; index < BAND_COUNT; index++) {
      this.randomState ^= this.randomState << 13;
      this.randomState ^= this.randomState >>> 17;
      this.randomState ^= this.randomState << 5;
      this.noiseTarget[index] =
        ((this.randomState >>> 0) / 0xffffffff - 0.5) * 0.03;
    }
  }
}
