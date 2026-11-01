import { useContext, useId } from "react";
import { PlatformContext } from "@/lib/platform";
import { useResolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { RecorderValue } from "../RecorderProvider";
import { PauseGlyph, PlayGlyph } from "./minimizedIcons";
import { MinimizedAlert, MinimizedLimitNotice } from "./MinimizedAlert";
import {
  useEntrance,
  useMinimizedAnnouncement,
  useMinimizedElapsed,
  useMinimizedRecorder,
  useMinimizedSilencedSince,
} from "./MinimizedProvider";
import { minimizedLimit, minimizedView } from "./minimizedView";
import "./soft.css";
import "./ribbon.css";

export interface RibbonViewProps {
  recorder: RecorderValue;
  elapsedMs: number;
  /** When the mic went silent, for the no-sound line. */
  silencedSinceMs?: number | null;
  theme: "night" | "day";
  /** The token set: the phone tab bar, or the floating Ribbon on the rail. */
  layout?: "phone" | "rail";
  entering?: boolean;
  /** The polite live region's text. */
  announcement?: string;
}

/** The minimised recorder above the tab bar (and floating on the rail): the time and bars reopen it. */
export function RibbonView({
  recorder,
  elapsedMs,
  silencedSinceMs = null,
  theme,
  layout = "phone",
  entering = false,
  announcement = "",
}: RibbonViewProps) {
  const device = useContext(PlatformContext) === "tauri" ? "mac" : "phone";
  const view = minimizedView(recorder, elapsedMs, silencedSinceMs, device);
  const live = view.ring === "live";
  const limit = minimizedLimit(view, recorder.maxDurationMs);
  const timerId = useId();
  const stopsId = useId();
  const canToggle = view.controls.resume || view.controls.pause;
  return (
    <div
      data-testid="ribbon"
      data-state={view.ring}
      data-live={live}
      data-layout={layout}
      className={cn(
        "mini-skin soft-skin ribbon-skin",
        theme === "night" ? "soft-night" : "soft-day",
        entering && "is-entering",
      )}
    >
      <div className="ribbon">
        <button
          type="button"
          className="ribbon-open"
          onClick={recorder.openSheet}
          aria-label={`${view.status}. Open recorder`}
          aria-describedby={limit ? `${timerId} ${stopsId}` : timerId}
          data-testid="ribbon-open"
        >
          <span
            id={timerId}
            className="soft-timer ribbon-timer"
            data-testid="ribbon-timer"
          >
            {view.timer.text}
          </span>
          {limit && (
            <>
              <span className="ribbon-remaining" data-testid="ribbon-remaining">
                {limit.stopsIn}
              </span>
              <span
                id={stopsId}
                className="mini-tip"
                role="tooltip"
                data-testid="ribbon-stops"
              >
                {limit.stopsAt}
              </span>
            </>
          )}
        </button>
        <button
          type="button"
          className="mini-btn"
          onClick={view.controls.resume ? recorder.resume : recorder.pause}
          disabled={!canToggle}
          aria-label={
            view.controls.resume ? "Resume recording" : "Pause recording"
          }
          data-testid="ribbon-pause"
        >
          <span className="mini-disc">
            {view.controls.resume ? (
              <PlayGlyph size={17} />
            ) : (
              <PauseGlyph size={17} />
            )}
          </span>
        </button>
        <button
          type="button"
          className="mini-btn mini-btn--stop"
          onClick={recorder.stop}
          disabled={!view.controls.stop}
          aria-label="Stop and save"
          data-testid="ribbon-stop"
        >
          <span className="mini-disc">
            <i className="mini-stop-glyph" aria-hidden="true" />
          </span>
        </button>
        {limit && (
          <span className="mini-limit" aria-hidden="true" data-testid="ribbon-limit">
            <span
              className="mini-limit-fill"
              style={{ width: `${(limit.fraction * 100).toFixed(1)}%` }}
            />
          </span>
        )}
      </div>
      <span
        role="status"
        className="sr-only"
        data-testid="minimized-announcement"
      >
        {announcement}
      </span>
    </div>
  );
}

export function Ribbon({ layout }: { layout?: RibbonViewProps["layout"] }) {
  const recorder = useMinimizedRecorder();
  const elapsedMs = useMinimizedElapsed();
  const silencedSinceMs = useMinimizedSilencedSince();
  const entering = useEntrance();
  const announcement = useMinimizedAnnouncement(entering);
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  return (
    <RibbonView
      recorder={recorder}
      elapsedMs={elapsedMs}
      silencedSinceMs={silencedSinceMs}
      theme={theme}
      layout={layout}
      entering={entering}
      announcement={announcement}
    />
  );
}

/**
 * From 768 to 1023 px the Ribbon sits in a reserved row at the foot of the main area.
 * Without the Ribbon (after Stop) the row holds only the error and why the recorder stopped itself, if either.
 */
export function FloatingRibbon({ ribbon = true }: { ribbon?: boolean }) {
  return (
    <div className="ribbon-float" data-ribbon={ribbon}>
      <div className="ribbon-float-inner">
        <MinimizedAlert layout="rail" />
        {!ribbon && <MinimizedLimitNotice layout="rail" />}
        {ribbon && <Ribbon layout="rail" />}
      </div>
    </div>
  );
}
