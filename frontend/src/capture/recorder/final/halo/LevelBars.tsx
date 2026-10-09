import { useEffect, useRef, type RefObject } from "react";
import type { HaloSource } from "./source";

export interface LevelBarsProps {
  subscribe?: (listener: (level: number) => void) => () => void;
  bars?: number;
  paused?: boolean;
  theme?: "night" | "day";
  levels?: readonly number[];
  className?: string;
}

export function viaBarHeights(level: number): number[] {
  const value = Math.max(0, Math.min(1, level));
  return [
    0.25 + 0.75 * Math.min(1, value * 1.4),
    0.25 + 0.75 * value,
    0.25 + 0.75 * Math.min(1, value * 0.8),
  ];
}

function useBars(
  root: RefObject<HTMLDivElement | null>,
  subscribe: LevelBarsProps["subscribe"],
  bars: number,
  paused: boolean,
  levels: readonly number[] | undefined,
) {
  const heights = useRef<number[]>([]);
  if (heights.current.length !== bars) {
    heights.current = Array.from(
      { length: bars },
      (_, index) => levels?.[index] ?? 0.25,
    );
  }

  useEffect(() => {
    const spans = root.current
      ? (Array.from(root.current.children) as HTMLElement[])
      : [];
    const paint = (isPaused: boolean) =>
      spans.forEach((bar, index) => {
        bar.style.transform = `scaleY(${heights.current[index].toFixed(3)})`;
        bar.style.background = isPaused
          ? "#8f8993"
          : bar.dataset.theme === "day"
            ? "#e5483f"
            : "#ff6b62";
      });

    if (levels) {
      for (let index = 0; index < bars; index++) {
        heights.current[index] = Math.max(
          0,
          Math.min(1, levels[index] ?? levels[levels.length - 1] ?? 0.25),
        );
      }
    }
    paint(paused);
    if (!subscribe || paused || levels) return;

    return subscribe((level) => {
      const mapped = viaBarHeights(level);
      for (let index = 0; index < bars; index++) {
        heights.current[index] = mapped[index % mapped.length];
      }
      paint(false);
    });
  }, [root, subscribe, bars, paused, levels]);
}

export function LevelBars({
  subscribe,
  bars = 3,
  paused = false,
  levels,
  theme = "night",
  className,
}: LevelBarsProps) {
  const root = useRef<HTMLDivElement>(null);
  useBars(root, subscribe, bars, paused, levels);
  const height = 12;
  const width = 2.5;
  return (
    <div
      ref={root}
      className={`halo-bars ${className ?? ""}`}
      data-level-bars=""
      data-paused={paused}
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 2,
        width: bars * width + (bars - 1) * 2,
        height,
      }}
    >
      {Array.from({ length: bars }, (_, index) => (
        <span
          key={index}
          data-bar={index}
          data-theme={theme}
          style={{
            transform: `scaleY(${(levels?.[index] ?? 0.25).toFixed(3)})`,
            height: "100%",
            width,
            flex: "none",
            borderRadius: 2,
            background: paused
              ? "#8f8993"
              : theme === "night"
                ? "#ff6b62"
                : "#e5483f",
            opacity: 0.75,
            transformOrigin: "center",
          }}
        />
      ))}
    </div>
  );
}

export interface MirroredSpectrumBarsProps {
  source?: Pick<HaloSource, "spec" | "act">;
  subscribe?: (
    listener: (source: Pick<HaloSource, "spec" | "act">) => void,
  ) => () => void;
  bars?: 30 | 22;
  paused?: boolean;
  theme?: "night" | "day";
  className?: string;
}

export function mirroredBandIndex(index: number, bars: number): number {
  const distance = Math.abs((index / (bars - 1)) * 2 - 1);
  return Math.min(31, Math.floor(distance * 27));
}

export function ribbonBarScale(value: number, act: number): number {
  return 0.12 + 0.88 * Math.min(1, value * act * 1.25);
}

export function dockBarScale(value: number, act: number): number {
  return 0.2 + 0.8 * value * act;
}

function spectrumBarScale(value: number, act: number, bars: number): number {
  return bars === 22 ? dockBarScale(value, act) : ribbonBarScale(value, act);
}

function setSpectrumHeights(
  heights: number[],
  source: Pick<HaloSource, "spec" | "act">,
  bars: number,
) {
  for (let index = 0; index < bars; index++) {
    const band = mirroredBandIndex(index, bars);
    heights[index] = spectrumBarScale(source.spec[band], source.act, bars);
  }
}

export function MirroredSpectrumBars({
  source,
  subscribe,
  bars = 30,
  paused = false,
  theme = "night",
  className,
}: MirroredSpectrumBarsProps) {
  const root = useRef<HTMLDivElement>(null);
  const heights = useRef<number[]>([]);
  const lastPainted = useRef<number[]>([]);
  if (heights.current.length !== bars) {
    heights.current = Array.from({ length: bars }, () => 0.12);
    lastPainted.current = Array.from({ length: bars }, () => -1);
  }

  useEffect(() => {
    const spans = root.current
      ? (Array.from(root.current.children) as HTMLElement[])
      : [];
    const paint = () => {
      spans.forEach((bar, index) => {
        const scale = Math.round(heights.current[index] * 1000);
        if (lastPainted.current[index] === scale) return;
        lastPainted.current[index] = scale;
        bar.style.transform = `scaleY(${(scale / 1000).toFixed(3)})`;
      });
    };
    if (source && !paused) setSpectrumHeights(heights.current, source, bars);
    paint();
    if (!subscribe || paused) return;
    return subscribe((next) => {
      setSpectrumHeights(heights.current, next, bars);
      paint();
    });
  }, [bars, paused, source, subscribe]);

  const width = bars === 22 ? 2.5 : 3;
  const height = bars === 22 ? 18 : 30;
  return (
    <div
      ref={root}
      className={`halo-spectrum ${className ?? ""}`}
      data-spectrum-bars=""
      data-paused={paused}
      aria-hidden="true"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 2,
        width: "100%",
        height,
      }}
    >
      {Array.from({ length: bars }, (_, index) => {
        const initialScale = source
          ? spectrumBarScale(
              source.spec[mirroredBandIndex(index, bars)],
              source.act,
              bars,
            )
          : 0.12;
        return (
          <span
            key={index}
            data-bar={index}
            style={{
              transform: `scaleY(${initialScale.toFixed(3)})`,
              height: "100%",
              width,
              flex: "none",
              borderRadius: 2,
              background: paused
                ? "#8f8993"
                : theme === "night"
                  ? "#ff6b62"
                  : "#e5483f",
              transformOrigin: "center",
            }}
          />
        );
      })}
    </div>
  );
}
