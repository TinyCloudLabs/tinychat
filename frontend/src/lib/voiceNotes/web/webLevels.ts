// Live input level for the recorder halo: an AnalyserNode on the capture stream, read
// at ~30 Hz. Level mapping and voice-activity hang come from the recorder design engine.

export const LEVEL_INTERVAL_MS = 33;
export const ACTIVE_LEVEL = 0.1;
export const ACTIVE_HANG_MS = 450;

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 0..1: -60 dBFS maps to 0, -12 dBFS to 1, with the engine's 1.5 gamma. */
export function levelFromAmplitude(amplitude: number): number {
  const dB = 20 * Math.log10(amplitude + 1e-9);
  return clamp01((dB + 60) / 48) ** 1.5;
}

export function measureLevels(samples: Float32Array): { level: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return { level: levelFromAmplitude(rms), peak: levelFromAmplitude(peak) };
}

/** Voice activity: on while the level is above ACTIVE_LEVEL, and for ACTIVE_HANG_MS after it last was. */
export function createActivityTracker() {
  let active = false;
  let hangMs = 0;
  return {
    update(level: number, dtMs: number): boolean {
      if (level > ACTIVE_LEVEL) {
        active = true;
        hangMs = ACTIVE_HANG_MS;
      } else if ((hangMs -= dtMs) <= 0) active = false;
      return active;
    },
    get active() { return active; },
  };
}

export interface LevelSample { level: number; peak: number; active: boolean }

export interface LevelMeter {
  stop(): void;
}

export interface LevelMeterEnv {
  now(): number;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const browserLevelMeterEnv: LevelMeterEnv = {
  now: () => performance.now(),
  setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export function startLevelMeter(
  analyser: Pick<AnalyserNode, "fftSize" | "getFloatTimeDomainData">,
  onSample: (sample: LevelSample) => void,
  env: LevelMeterEnv = browserLevelMeterEnv,
): LevelMeter {
  const buffer = new Float32Array(analyser.fftSize);
  const activity = createActivityTracker();
  let last = env.now();
  const handle = env.setInterval(() => {
    const at = env.now();
    const dtMs = Math.min(250, at - last);
    last = at;
    analyser.getFloatTimeDomainData(buffer);
    const { level, peak } = measureLevels(buffer);
    onSample({ level, peak, active: activity.update(level, dtMs) });
  }, LEVEL_INTERVAL_MS);
  return { stop: () => env.clearInterval(handle) };
}
