// Record, through the one recorder: the chat header's mic (icon) and Capture's
// Record action. While a recording is under way, or its receipt is still
// showing, they open the recorder instead; a second recording never starts
// over either. Shown only where a recorder exists (the phone app).
import { MicIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { recorderActive, useRecorder } from "./RecorderProvider";

export function RecordButton(props: { variant: "icon" | "action"; className?: string }) {
  const recorder = useRecorder();
  if (!recorder.available) return null;
  const idle = !recorderActive(recorder);
  const onClick = () => (idle ? recorder.record() : recorder.openSheet());
  // Until the recorder has heard what is already running, Record waits.
  const waiting = idle && !recorder.ready;
  if (props.variant === "icon") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={idle ? "Record a voice note" : "Open recorder"}
        title={idle ? "Record a voice note" : "Open recorder"}
        onClick={onClick}
        disabled={waiting}
        data-testid="header-voice-note"
        className={cn("size-11 shrink-0 rounded-full text-muted-foreground hover:text-foreground fine:size-9 [&_svg]:size-5", props.className)}
      >
        <MicIcon />
      </Button>
    );
  }
  // Capture's actions row: Record between Upload and Meeting.
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={waiting}
      aria-label={idle ? "Record a voice note" : "Open recorder"}
      data-testid={idle ? "voice-note-record" : "capture-open-recorder"}
      className={cn("h-auto min-h-14 flex-[1.4] justify-center gap-2 rounded-xl px-3 text-callout font-semibold [&_svg]:size-5", props.className)}
    >
      <MicIcon aria-hidden="true" /> {idle ? "Record" : "Recorder"}
    </Button>
  );
}
