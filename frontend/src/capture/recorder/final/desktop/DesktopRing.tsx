import { useEffect, useMemo, useRef } from "react";
import { HaloRing, LevelSourceAdapter, QUIET } from "../halo";
import { levelFromAmplitude } from "@/lib/voiceNotes/web/webLevels";
import type { LevelEvent } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { RecorderView } from "../recorderView";
import { RingGlyph } from "../softIcons";

export interface DesktopRingProps {
  ring: RecorderView["ring"];
  flat: boolean;
  theme: "night" | "day";
  size: 214 | 172;
  subscribeLevel: (listener: (level: number) => void) => () => void;
  subscribeLevels?: (listener: (levels: LevelEvent) => void) => () => void;
  systemAudioCaptured?: boolean;
  /** The ring is the pause/resume button: its label and press handler. */
  action: { label: string; onPress: () => void; disabled: boolean } | null;
  glyph: "pause" | "play" | null;
}

/** RecorderRing at the desktop sizes; the phone's is fixed at 172. */
export function DesktopRing({
  ring,
  flat,
  theme,
  size,
  subscribeLevel,
  subscribeLevels,
  systemAudioCaptured = false,
  action,
  glyph,
}: DesktopRingProps) {
  const adapter = useMemo(() => new LevelSourceAdapter(), []);
  const themTrace = useRef<SVGCircleElement>(null);
  const subscribe = useMemo(() => adapter.subscribe.bind(adapter), [adapter]);
  useEffect(
    () => subscribeLevel((level) => void adapter.update(level)),
    [adapter, subscribeLevel],
  );
  useEffect(() => {
    if (!systemAudioCaptured || !subscribeLevels) return;
    return subscribeLevels((levels) => {
      const level = levelFromAmplitude(levels.sources?.system?.level ?? 0);
      themTrace.current?.setAttribute("stroke-dasharray", `${Math.max(1, level * 100)} 100`);
    });
  }, [subscribeLevels, systemAudioCaptured]);
  const body = (
    <>
      <HaloRing
        size={size}
        ticks={44}
        theme={theme}
        paused={ring === "paused"}
        still={
          ring === "still" || ring === "still-resumable" || ring === "idle"
        }
        source={QUIET}
        subscribe={ring === "live" && !flat ? subscribe : undefined}
      />
      {ring === "live" && systemAudioCaptured && (
        <svg className="dr-them-trace" viewBox="0 0 100 100" role="img" aria-label="Them audio level">
          <circle className="dr-them-track" cx="50" cy="50" r="48" pathLength="100" />
          <circle ref={themTrace} className="dr-them-level" cx="50" cy="50" r="48" pathLength="100" strokeDasharray="1 100" />
        </svg>
      )}
      {glyph && <RingGlyph kind={glyph} />}
    </>
  );
  if (!action) {
    return (
      <div className="pr-ring" data-ring={ring}>
        {body}
      </div>
    );
  }
  return (
    <button
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
