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
