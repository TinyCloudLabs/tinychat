import type { RecorderValue } from "../RecorderProvider";
import { useResolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { honestRecorderError } from "./honestRecorderError";
import { useMinimizedRecorder } from "./MinimizedProvider";
import { showsMinimizedError } from "./minimizedView";
import "./soft.css";
import "./ribbon.css";

/**
 * What a rejected Pause, Resume or Stop leaves for someone with the sheet closed: the error, a way to
 * the full recorder, and (when a Stop's outcome is unknown, so the phase stays "stopping") Stop again.
 */
export function MinimizedAlert({
  layout = "phone",
}: {
  layout?: "phone" | "rail" | "desktop";
}) {
  const recorder = useMinimizedRecorder();
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  if (!showsMinimizedError(recorder)) return null;
  return (
    <div
      data-testid="minimized-alert"
      data-layout={layout}
      className={cn(
        "mini-skin soft-skin",
        theme === "night" ? "soft-night" : "soft-day",
      )}
    >
      <div className="mini-alert">
        <p role="alert" className="mini-alert-text">
          {honestRecorderError(recorder)}
        </p>
        {recorder.phase === "stopping" && (
          <button
            type="button"
            onClick={recorder.stop}
            data-testid="minimized-alert-retry"
          >
            Try again
          </button>
        )}
        <button
          type="button"
          onClick={recorder.openSheet}
          aria-label="Open recorder"
          data-testid="minimized-alert-open"
        >
          Open
        </button>
      </div>
    </div>
  );
}

/** Why the recorder stopped itself, while the note it saved is still on show (the rail's minimised recorder has no room for it). */
export function MinimizedLimitNotice({ layout = "rail" }: { layout?: "phone" | "rail" | "desktop" }) {
  const recorder = useMinimizedRecorder();
  const theme = useResolvedTheme() === "dark" ? "night" : "day";
  if (!limitNoticeShown(recorder)) return null;
  return (
    <div
      data-testid="minimized-limit"
      data-layout={layout}
      className={cn("mini-skin soft-skin", theme === "night" ? "soft-night" : "soft-day")}
    >
      <div className="mini-alert">
        <p role="status" className="mini-alert-text">
          {recorder.limitNotice}
        </p>
        <button type="button" onClick={recorder.openSheet} aria-label="Open recorder" data-testid="minimized-limit-open">
          Open
        </button>
      </div>
    </div>
  );
}

/** The limit notice belongs to a recording that is saving or saved, never to a live one. */
export function limitNoticeShown(recorder: Pick<RecorderValue, "phase" | "limitNotice">): boolean {
  return recorder.limitNotice !== null && recorder.phase !== "starting" && recorder.phase !== "recording";
}
