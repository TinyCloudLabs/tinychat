// The minimised recorder in the expanded sidebar's footer: the status and the
// time, with Open.
import { AlertCircleIcon, CheckIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { islandState } from "./Island";
import { islandShown, useRecorder, type RecorderValue } from "./RecorderProvider";
import { ISLAND_KEPT, ISLAND_SAVED, micWarning } from "./recorderCopy";
import { RecorderTimer } from "./RecorderTimer";

export function SidebarLiveCardView(props: { recorder: RecorderValue; className?: string }) {
  const { recorder } = props;
  const state = islandState(recorder);
  const warning = recorder.phase === "recording" && micWarning(recorder.mic) !== null;
  const paused = recorder.phase === "recording" && (recorder.mic.state === "paused" || recorder.mic.state === "interrupted" || recorder.mic.state === "needs_user");
  return (
    <div
      data-testid="sidebar-live"
      data-state={state}
      className={cn("flex items-center gap-2 rounded-lg bg-surface-2 py-1.5 pl-3 pr-1.5", props.className)}
    >
      <p role="status" className="flex min-w-0 flex-1 items-center gap-2 text-callout">
        {state === "live" && (
          <>
            <span className={cn("size-2.5 shrink-0 rounded-full", paused ? "bg-muted-foreground" : warning ? "bg-warning" : "bg-live motion-safe:animate-live-pulse")} aria-hidden="true" />
            <RecorderTimer startedAt={recorder.startedAt} audioMs={recorder.audioMs} running={!paused && recorder.phase === "recording"} className="font-semibold" />
            <span className="sr-only">{paused ? "Paused" : warning ? "Recording, mic problem" : "Recording"}</span>
          </>
        )}
        {state === "saving" && (
          <>
            <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="tnum min-w-0 [overflow-wrap:anywhere]">Saving{typeof recorder.savePercent === "number" ? ` · ${recorder.savePercent}%` : "…"}</span>
          </>
        )}
        {state === "landed" && (
          <>
            <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{ISLAND_SAVED}</span>
          </>
        )}
        {state === "failed" && (
          <>
            <AlertCircleIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{ISLAND_KEPT}</span>
          </>
        )}
      </p>
      <Button type="button" variant="ghost" size="sm" onClick={recorder.openSheet} aria-label="Open recorder" data-testid="sidebar-live-open">
        Open
      </Button>
    </div>
  );
}

export function SidebarLiveCard(props: { className?: string }) {
  const recorder = useRecorder();
  if (!islandShown(recorder)) return null;
  return <SidebarLiveCardView recorder={recorder} className={props.className} />;
}
