import { useEffect, useLayoutEffect, useRef } from "react";
import { QUIET, type HaloSource, type HaloSourceSubscriber } from "./source";
import {
  BLEED,
  invalidateHalo,
  registerHalo,
  type HaloConfig,
} from "./renderer";

export interface HaloRingProps {
  size: 172 | 214 | 118;
  ticks: 44 | 40;
  paused?: boolean;
  /** Interrupted capture: show neutral ticks and freeze the last source. */
  still?: boolean;
  theme: "night" | "day";
  /** Static snapshots are for deterministic harness frames; production uses subscribe. */
  source?: HaloSource;
  subscribe?: HaloSourceSubscriber;
  className?: string;
}

export function HaloRing({
  size,
  ticks,
  paused = false,
  still = false,
  theme,
  source = QUIET,
  subscribe,
  className,
}: HaloRingProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef(source);
  const config = useRef<HaloConfig | null>(null);
  if (!config.current) {
    config.current = {
      size,
      ticks,
      paused,
      still,
      theme,
      sourceRef,
      weight: 1.45,
      spread: 1,
    };
  }

  useLayoutEffect(() => {
    if (!subscribe) sourceRef.current = source;
    Object.assign(config.current!, {
      size,
      ticks,
      paused,
      still,
      theme,
    });
    if (canvas.current) invalidateHalo(canvas.current);
  }, [size, ticks, paused, still, theme, source, subscribe]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((next) => {
      sourceRef.current = next;
    });
  }, [subscribe]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    return registerHalo(element, config.current!);
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
          left: "50%",
          top: "50%",
          width: size * BLEED,
          height: size * BLEED,
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
        }}
      />
    </span>
  );
}
