import { useEffect, useMemo, useState } from "react";
import { HaloRing, LevelSourceAdapter, QUIET } from "./halo";
import { RingGlyph } from "./softIcons";
import type { RecorderView } from "./recorderView";

export interface RecorderRingProps {
  ring: RecorderView["ring"];
  flat: boolean;
  theme: "night" | "day";
  subscribeLevel: (listener: (level: number) => void) => () => void;
  /** The ring is the pause/resume button: its label and press handler. */
  action: { label: string; onPress: () => void; disabled: boolean } | null;
  glyph: "pause" | "play" | null;
  /** Mic permission is denied: show the resting body without activity ticks. */
  quiet?: boolean;
}

/** The ring is sized by CSS from its stage (.pr-ring in phone.css); this is only its size before the first measurement. */
const FIRST_SIZE = 172;

export function RecorderRing({
  ring,
  flat,
  theme,
  subscribeLevel,
  action,
  glyph,
  quiet = false,
}: RecorderRingProps) {
  const [ringEl, setRingEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState(FIRST_SIZE);
  useEffect(() => {
    if (!ringEl) return;
    const measure = () => {
      const width = Math.round(ringEl.offsetWidth);
      if (width > 0) setSize(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ringEl);
    return () => observer.disconnect();
  }, [ringEl]);
  const adapter = useMemo(() => new LevelSourceAdapter(), []);
  const subscribe = useMemo(() => adapter.subscribe.bind(adapter), [adapter]);
  useEffect(
    () => subscribeLevel((level) => void adapter.update(level)),
    [adapter, subscribeLevel],
  );
  const live = ring === "live";
  const body = (
    <>
      <HaloRing
        size={size}
        ticks={quiet ? 0 : 44}
        theme={theme}
        paused={ring === "paused"}
        still={
          ring === "still" || ring === "still-resumable" || ring === "idle"
        }
        source={QUIET}
        subscribe={live && !flat ? subscribe : undefined}
      />
      {glyph && <RingGlyph kind={glyph} />}
    </>
  );
  if (!action) {
    return (
      <div ref={setRingEl} className="pr-ring" data-ring={ring}>
        {body}
      </div>
    );
  }
  return (
    <button
      ref={setRingEl}
      type="button"
      className="pr-ring"
      data-ring={ring}
      aria-label={action.label}
      disabled={action.disabled}
      onClick={action.onPress}
    >
      {body}
    </button>
  );
}
