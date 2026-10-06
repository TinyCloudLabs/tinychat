// The centre of the recorder: where this note's audio goes (plan §2.7). A
// "Transcription" heading, Off · Private cloud when private cloud is offered
// to this build and account, the route as a RouteLine, one short line, and a
// link to How it works for the rest. Choosing Private cloud the first time
// asks once ("Use private cloud"); the full disclosure is on How it works.
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { InfoTip } from "@/components/ui/info-tip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { RouteLine, voiceNoteRoute } from "./RouteLine";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";

type Route = "off" | "private-cloud";

const ROUTE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "private-cloud", label: "Private cloud" },
] as const;

function minutes(seconds: number): number {
  return Math.round(seconds / 60);
}

export function TranscriptionRouteControl(props: {
  /** Absent in a build without private cloud transcription. */
  transcription: VoiceNoteTranscriptionProps | undefined;
  /** Start on the one-time question, as if Private cloud had just been chosen (the harness). */
  defaultAsking?: boolean;
  className?: string;
}) {
  const { transcription } = props;
  const headingId = useId();
  const offered = transcription?.availability === "available";
  const consented = transcription?.consented ?? false;
  const [asking, setAsking] = useState(props.defaultAsking ?? false);
  const askingNow = offered && !consented && asking;
  const route: Route = offered && (consented || askingNow) ? "private-cloud" : "off";

  const choose = (next: Route) => {
    if (!transcription || next === route) return;
    hapticSelection();
    if (next === "off") {
      setAsking(false);
      if (consented) transcription.onTurnOff();
    } else {
      setAsking(true);
    }
  };

  let line: string;
  if (askingNow) line = "";
  else if (offered && consented) line = `Private cloud transcribes notes up to ${minutes(transcription!.maxSeconds)} minutes.`;
  else if (transcription?.availability === "checking" && consented) line = "Checking private cloud…";
  else if (transcription?.availability === "failed" && consented) line = "Private cloud is unavailable right now.";
  else line = "Audio only.";

  return (
    <section aria-labelledby={headingId} data-testid="transcription-route" data-route={route} className={cn("flex flex-col gap-3", props.className)}>
      <div className="flex items-center gap-0.5">
        <h3 id={headingId} className="text-headline">
          Transcription
        </h3>
        {offered && <InfoTip label="About transcription">Your choice applies to this note and new ones.</InfoTip>}
      </div>
      {offered && (
        <SegmentedControl<Route> aria-label="Transcription" value={route} onValueChange={choose} options={ROUTE_OPTIONS} />
      )}
      <RouteLine nodes={voiceNoteRoute(route === "private-cloud")} />
      {askingNow ? (
        <div className="flex flex-col gap-3" data-testid="voice-note-transcription-consent">
          <p className="text-callout text-muted-foreground">
            After you stop, TinyCloud Private Transcription turns notes up to {minutes(transcription!.maxSeconds)} minutes
            into text.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Button type="button" onClick={transcription!.onConsent} data-testid="voice-note-transcription-enable">
              Use private cloud
            </Button>
            <HowItWorksLink section="transcription" />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p className="min-w-0 text-callout text-muted-foreground" data-testid="transcription-route-line">
            {line}
          </p>
          {transcription?.availability === "failed" && consented && (
            <Button type="button" variant="outline" size="sm" onClick={transcription.onRecheck} data-testid="voice-note-transcription-recheck">
              Check again
            </Button>
          )}
          <HowItWorksLink section="transcription" className="ml-auto" />
        </div>
      )}
    </section>
  );
}
