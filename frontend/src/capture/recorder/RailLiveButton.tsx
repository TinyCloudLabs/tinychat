// The minimised recorder in the navigation rail (phone on its side, tablet):
// a dot and the time, above Settings. It opens the recorder.
import { CheckIcon, Loader2Icon, AlertCircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { islandShown, useRecorder, type RecorderValue } from "./RecorderProvider";
import { islandState } from "./Island";
import { micWarning } from "./recorderCopy";
import { RecorderTimer } from "./RecorderTimer";

export function RailLiveButtonView(props: { recorder: RecorderValue; className?: string }) {
  const { recorder } = props;
  const state = islandState(recorder);
  const warning = recorder.phase === "recording" && micWarning(recorder.mic) !== null;
  const paused = recorder.phase === "recording" && (recorder.mic.state === "paused" || recorder.mic.state === "interrupted" || recorder.mic.state === "needs_user");
  const label =
    state === "live" ? `${paused ? "Paused" : "Recording"}. Open recorder` : state === "saving" ? "Saving. Open recorder" : state === "landed" ? "Saved. Open recorder" : "Not saved yet. Open recorder";
  return (
    <button
      type="button"
      onClick={recorder.openSheet}
      aria-label={label}
      data-testid="rail-live"
      data-state={state}
      className={cn(
        "tap-transparent flex min-h-14 w-14 flex-col items-center justify-center gap-1 rounded-lg bg-surface-2 transition-opacity active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.className,
      )}
    >
      {state === "live" && (
        <span className={cn("size-2.5 rounded-full", paused ? "bg-muted-foreground" : warning ? "bg-warning" : "bg-live motion-safe:animate-live-pulse")} aria-hidden="true" />
      )}
      {state === "saving" && <Loader2Icon className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />}
      {state === "landed" && <CheckIcon className="size-4 text-primary" aria-hidden="true" />}
      {state === "failed" && <AlertCircleIcon className="size-4 text-warning" aria-hidden="true" />}
      {state === "live" && <RecorderTimer audioMs={recorder.audioMs} running={!paused && recorder.phase === "recording"} className="text-label" />}
    </button>
  );
}

export function RailLiveButton(props: { className?: string }) {
  const recorder = useRecorder();
  if (!islandShown(recorder)) return null;
  return <RailLiveButtonView recorder={recorder} className={props.className} />;
}
