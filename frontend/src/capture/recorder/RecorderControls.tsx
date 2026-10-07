import { MicIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { RecorderValue } from "./RecorderProvider";
import { DiscardConfirm } from "./DiscardConfirm";

export function RecorderControls({ recorder, discardAsking }: { recorder: RecorderValue; discardAsking?: boolean }) {
  const live = recorder.phase === "recording";
  const paused = recorder.mic.state === "paused";
  const needsResume = paused || recorder.mic.state === "interrupted" || recorder.mic.state === "needs_user";
  if (recorder.phase === "idle") {
    return <Button type="button" onClick={recorder.record} className="h-14 w-full gap-3 rounded-xl text-body font-semibold" data-testid="recorder-record-again"><MicIcon aria-hidden />Record</Button>;
  }
  return (
    <div className="flex min-h-16 items-center justify-between gap-3" data-testid="recorder-controls">
      <div className="flex min-w-20 flex-1 justify-start">{live && <DiscardConfirm onDiscard={recorder.discard} held={discardAsking} />}</div>
      <Button type="button" variant="live" onClick={recorder.stop} disabled={!live} aria-label="Stop and save" data-testid="voice-note-stop" className="size-16 shrink-0 rounded-full p-0 disabled:bg-surface-2 disabled:text-foreground disabled:opacity-100">
        <SquareIcon className="!size-6 fill-current" aria-hidden />
      </Button>
      <div className="flex min-w-20 flex-1 justify-end">
        {live && <Button type="button" variant="outline" onClick={needsResume ? recorder.resume : recorder.pause} aria-label={needsResume ? "Resume recording" : "Pause recording"} data-testid={needsResume ? "voice-note-resume" : "voice-note-pause"} className="size-12 rounded-full p-0">
          {needsResume ? <PlayIcon className="!size-5 fill-current" aria-hidden /> : <PauseIcon className="!size-5" aria-hidden />}
        </Button>}
      </div>
    </div>
  );
}
