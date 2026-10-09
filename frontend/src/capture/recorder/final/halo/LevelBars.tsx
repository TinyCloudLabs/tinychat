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

function useBars(root: RefObject<HTMLDivElement | null>, subscribe: LevelBarsProps["subscribe"], bars: number, paused: boolean, levels?: readonly number[]) {
  useEffect(() => {
    const spans = root.current ? Array.from(root.current.children) as HTMLElement[] : [];
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paint = (values: readonly number[]) => spans.forEach((bar, index) => {
      const value = Math.max(0.08, Math.min(1, values[index] ?? values[values.length - 1] ?? 0.08));
      bar.style.transform = `scaleY(${value.toFixed(3)})`;
    });
    if (paused) { paint([]); return; }
    if (levels) { paint(levels); return; }
    if (reduced) { paint([]); return; }
    if (!subscribe) return;
    const samples = new Array(bars).fill(0.08);
    return subscribe((level) => { samples.shift(); samples.push(level); paint(samples); });
  }, [root, subscribe, bars, paused, levels]);
}

export function LevelBars({ subscribe, bars = 3, paused = false, levels, theme = "night", className }: LevelBarsProps) {
  const root = useRef<HTMLDivElement>(null);
  useBars(root, subscribe, bars, paused, levels);
  return <div ref={root} className={`halo-bars ${className ?? ""}`} data-level-bars="" data-paused={paused} aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: 3, width: bars * 4 + (bars - 1) * 3, height: 28 }}>
    {Array.from({ length: bars }, (_, index) => <span key={index} data-bar={index} style={{ transform: "scaleY(0.08)", height: "100%", width: 4, flex: "none", borderRadius: 99, background: paused ? "#8f8993" : theme === "night" ? "#ff6b62" : "#e5483f", transformOrigin: "center" }} />)}
  </div>;
}

export interface MirroredSpectrumBarsProps {
  source?: Pick<HaloSource, "spec" | "act">;
  subscribe?: (listener: (source: Pick<HaloSource, "spec" | "act">) => void) => () => void;
  bars?: 30 | 22;
  paused?: boolean;
  theme?: "night" | "day";
  className?: string;
}

export function MirroredSpectrumBars({ source, subscribe, bars = 30, paused = false, theme = "night", className }: MirroredSpectrumBarsProps) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const spans = root.current ? Array.from(root.current.children) as HTMLElement[] : [];
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paint = (next?: Pick<HaloSource, "spec" | "act">) => spans.forEach((bar, index) => {
      const distance = Math.abs(index - (bars - 1) / 2) / Math.max(1, (bars - 1) / 2);
      const band = Math.round(distance * 31);
      const value = Math.max(0.08, Math.min(1, (next?.spec[band] ?? 0) * (next?.act ?? 0)));
      bar.style.transform = `scaleY(${(paused || reduced ? Math.max(0.08, value) : value).toFixed(3)})`;
    });
    paint(source);
    if (paused || reduced || !subscribe) return;
    return subscribe(paint);
  }, [bars, paused, source, subscribe]);
  return <div ref={root} className={`halo-spectrum ${className ?? ""}`} data-spectrum-bars="" data-paused={paused} aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: 2, height: 44 }}>
    {Array.from({ length: bars }, (_, index) => <span key={index} data-bar={index} style={{ transform: "scaleY(0.08)", height: "100%", minWidth: 1, flex: 1, borderRadius: 99, background: paused ? "#8f8993" : theme === "night" ? "#ff6b62" : "#e5483f", transformOrigin: "center" }} />)}
  </div>;
}
