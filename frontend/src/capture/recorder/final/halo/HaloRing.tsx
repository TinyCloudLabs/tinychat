import { useEffect, useRef } from "react";
import { QUIET, type HaloSource } from "./source";
import { registerHalo } from "./renderer";

export interface HaloRingProps {
  size: 172 | 214 | 118;
  ticks: 44 | 40;
  paused?: boolean;
  still?: boolean;
  theme: "night" | "day";
  source?: HaloSource;
  className?: string;
}

export function HaloRing({
  size,
  ticks,
  paused = false,
  still = false,
  theme,
  source = QUIET,
  className,
}: HaloRingProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frozenSource = useRef(source);
  if (!paused && !still) frozenSource.current = source;
  const displaySource = paused || still ? frozenSource.current : source;
  const config = useRef({
    size,
    ticks,
    paused,
    still,
    theme,
    source,
    weight: 1.45,
    spread: 1,
  });
  Object.assign(config.current, {
    size,
    ticks,
    paused,
    still,
    theme,
    source: displaySource,
  });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    return registerHalo(element, config.current);
  }, []);
  return (
    <span
      className={`halo-ring ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        display: "inline-grid",
        placeItems: "center",
        position: "relative",
        flex: "none",
        overflow: "visible",
      }}
      data-halo-size={size}
      aria-hidden="true"
    >
      <canvas
        ref={canvas}
        className="halo-ring__canvas"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    </span>
  );
}
