import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ModeIcon } from "./softIcons";
import type { ScaleStop } from "./useTranscriptionChoice";
import type { ModeId } from "./transcriptionModes";

const EDGE = 10;

/** A stop's position along the rail, 0 to 1. */
export function stopFraction(index: number, count: number): number {
  return count <= 1 ? 0 : index / (count - 1);
}

/** The stop nearest a position along the rail, 0 to 1. */
export function nearestStop(fraction: number, count: number): number {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(fraction * (count - 1))));
}

const left = (fraction: number) => `calc(${EDGE}px + (100% - ${EDGE * 2}px) * ${fraction})`;

export interface PrivacyScaleProps {
  stops: readonly ScaleStop[];
  mode: ModeId;
  /** Takes a choice; returns why it cannot be taken, or null. */
  onChoose: (id: ModeId) => string | null;
  /** The next available stop in a direction. */
  step: (direction: -1 | 1) => ModeId;
  onUnavailable: (reason: string) => void;
}

export function PrivacyScale({ stops, mode, onChoose, step, onUnavailable }: PrivacyScaleProps) {
  const root = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const count = stops.length;
  const index = Math.max(0, stops.findIndex((s) => s.stop.id === mode));
  const selected = stops[index]!.stop;

  const choose = (id: ModeId) => {
    if (id === mode) return;
    const reason = onChoose(id);
    if (reason !== null) onUnavailable(reason);
  };

  const fractionAt = (event: PointerEvent) => {
    const box = root.current!.getBoundingClientRect();
    const rail = box.width - EDGE * 2;
    return Math.max(0, Math.min(1, (event.clientX - box.left - EDGE) / rail));
  };
  const down = (event: PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(fractionAt(event));
  };
  const move = (event: PointerEvent) => {
    if (drag !== null) setDrag(fractionAt(event));
  };
  const up = (event: PointerEvent) => {
    if (drag === null) return;
    const at = nearestStop(fractionAt(event), count);
    setDrag(null);
    choose(stops[at]!.stop.id);
  };

  const key = (event: KeyboardEvent) => {
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    choose(step(direction));
  };

  return (
    <div
      ref={root}
      className="pr-scale"
      role="slider"
      tabIndex={0}
      aria-label="Transcription privacy"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={index}
      aria-valuetext={selected.shortName}
      data-dragging={drag !== null}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={key}
    >
      <div className="pr-rail" />
      {stops.map((s, i) => (
        <span key={s.stop.id} className="pr-stop" data-stop={s.stop.id} data-available={s.available} style={{ left: left(stopFraction(i, count)) }} />
      ))}
      <span className="pr-knob" style={{ left: left(drag ?? stopFraction(index, count)) }}>
        <ModeIcon id={selected.id} size={14} />
      </span>
    </div>
  );
}
