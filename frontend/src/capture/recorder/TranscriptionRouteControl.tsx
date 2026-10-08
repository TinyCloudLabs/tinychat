// The centre of the recorder: where this note's audio goes (plan §2.7). A
// "Transcription" heading, Off · On this phone · Private cloud when private cloud is offered
// to this build and account, the route as a RouteLine, one short line, and a
// link to How it works for the rest. Choosing Private cloud the first time
// asks once ("Use private cloud"); the full disclosure is on How it works.
// On this phone never needs a sign-in or a network check: native capture defaults to it
// already, and the only extra state to show is the model's download progress.
import { useId, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { InfoTip } from "@/components/ui/info-tip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { onDeviceSttStore, onDeviceModelLine } from "@/lib/voiceNotes/onDeviceSttStore";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { setRecordingTranscriber } from "@/lib/voiceNotes/transcriberPreference";
import { RouteLine, voiceNoteRoute } from "./RouteLine";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";

type Route = "off" | "on-device" | "private-cloud";

function routeOptions(offered: boolean): { value: Route; label: string }[] {
  return offered
    ? [
        { value: "off", label: "Off" },
        { value: "on-device", label: "On this phone" },
        { value: "private-cloud", label: "Private cloud" },
      ]
    : [
        { value: "off", label: "Off" },
        { value: "on-device", label: "On this phone" },
      ];
}

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
  const [onDevicePicked, setOnDevicePicked] = useState(false);
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const askingNow = offered && !consented && asking;
  const route: Route = onDevicePicked && !askingNow ? "on-device" : offered && (consented || askingNow) ? "private-cloud" : "off";

  const choose = (next: Route) => {
    if (next === route) return;
    hapticSelection();
    if (next === "off") {
      setAsking(false);
      setOnDevicePicked(false);
      void setRecordingTranscriber("off");
      if (consented) transcription?.onTurnOff();
    } else if (next === "on-device") {
      setAsking(false);
      setOnDevicePicked(true);
      void setRecordingTranscriber("on-device");
    } else {
      setOnDevicePicked(false);
      if (!transcription) return;
      setAsking(true);
    }
  };

  const modelLine = onDeviceModelLine(sttStatus);
  const primaryModel = sttStatus.models.find((m) => m.id === "parakeet-tdt-0.6b-v3-int8" || m.id === "parakeet-tdt-110m-en-int8");

  let line: string;
  if (askingNow) line = "";
  else if (route === "on-device") line = modelLine.text === "Ready" ? "Transcribed on this phone." : `Transcribed on this phone, once the model finishes downloading. ${modelLine.text}`;
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
        <InfoTip label="About transcription">Your choice applies to this note and new ones.</InfoTip>
      </div>
      <SegmentedControl<Route> aria-label="Transcription" value={route} onValueChange={choose} options={routeOptions(offered)} />
      <RouteLine nodes={voiceNoteRoute(route)} />
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
          {route === "on-device" && primaryModel && primaryModel.state !== "ready" && primaryModel.state !== "downloading" && primaryModel.state !== "queued" && (
            <Button type="button" variant="outline" size="sm" data-testid="voice-note-on-device-download"
              onClick={() => void OnDeviceStt.downloadNow({ allowCellular: false })}>
              Download
            </Button>
          )}
          {route === "on-device" && (primaryModel?.state === "downloading" || primaryModel?.state === "queued") && (
            <Button type="button" variant="outline" size="sm" data-testid="voice-note-on-device-cancel-download"
              onClick={() => void OnDeviceStt.cancelDownload()}>
              Cancel
            </Button>
          )}
          <HowItWorksLink section="transcription" className="ml-auto" />
        </div>
      )}
    </section>
  );
}
