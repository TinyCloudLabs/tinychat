// The centre of the recorder: where this note's audio goes (plan §2.7). A
// "Transcription" heading, Off · On this phone · Private cloud when private cloud is offered
// to this build and account, the route as a RouteLine, one short line, and a
// link to How it works for the rest. Choosing Private cloud the first time
// asks once ("Use private cloud"); the full disclosure is on How it works.
// On this phone never needs a sign-in or a network check: native capture defaults to it
// already, and the only extra state to show is the model's download progress. Signed out, native
// (CaptureEngine) forces on-device regardless of what's requested, so this control must too: only
// "On this phone" is ever offered or shown selected — never "Off".
import { useEffect, useId, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { InfoTip } from "@/components/ui/info-tip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { VoiceNotes, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { onDeviceSttStore, onDeviceModelLine } from "@/lib/voiceNotes/onDeviceSttStore";
import { isOnDeviceReady, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { readDefaultTranscriber, setRecordingTranscriber } from "@/lib/voiceNotes/transcriberPreference";
import type { RecorderValue } from "./RecorderProvider";
import type { SetTranscriberResult } from "./voiceNoteRecorderController";
import { RouteLine, voiceNoteRoute } from "./RouteLine";
import type { VoiceNoteTranscriptionProps } from "./transcriptionProps";

type Route = "off" | "on-device" | "private-cloud";
type RecordingRoute = Pick<RecorderValue, "transcriber" | "setTranscriber">;

/** The default recorder changes this note's journaled native options, not its JS default. */
export function setRecordingRoute(recorder: RecordingRoute, id: Route) {
  return recorder.setTranscriber(id, { scope: "recording", ...(id === "on-device" ? { waitForModel: true } : {}) });
}

export function consentToRecordingPrivateCloud(recorder: RecordingRoute, onConsent: () => void) {
  onConsent();
  return setRecordingRoute(recorder, "private-cloud");
}

const ROUTE_NAME: Record<Route, string> = { off: "Off", "on-device": "On this phone", "private-cloud": "Private cloud" };
export const SIGNED_OUT_ROUTE = "Sign in to choose another mode";

export function routeUnavailable(next: Route): string {
  return `${ROUTE_NAME[next]} isn't available right now`;
}

/** Runs a route change and tells the user when the provider refuses or fails; the selection stays
 * wherever the provider says it is, so there is nothing to undo. */
export async function requestRecordingRoute(
  next: Route,
  request: () => Promise<SetTranscriberResult>,
  outcome: { needsConsent: () => void; settled: () => void; notify: (message: string) => void },
): Promise<void> {
  let result: SetTranscriberResult;
  try {
    result = await request();
  } catch (caught) {
    console.error("[Recorder] Could not change the transcription route", caught);
    outcome.notify(`Could not change the transcription to ${ROUTE_NAME[next]}: ${caught instanceof Error ? caught.message : String(caught)}`);
    return;
  }
  switch (result) {
    case "ok":
      outcome.settled();
      return;
    case "needs_consent":
      outcome.needsConsent();
      return;
    case "locked_signed_out":
      console.error(`[Recorder] The provider is locked to on-device while signed out; ${next} was refused`);
      outcome.notify(SIGNED_OUT_ROUTE);
      return;
    case "unavailable":
      console.error(`[Recorder] The provider cannot use ${next} right now`);
      outcome.notify(routeUnavailable(next));
      return;
  }
}

function asRoute(transcriber: TranscriberId): Route {
  return transcriber === "private-cloud" ? "private-cloud" : transcriber === "on-device" ? "on-device" : "off";
}

function routeOptions(signedIn: boolean, offered: boolean): { value: Route; label: string }[] {
  if (!signedIn) return [{ value: "on-device", label: "On this phone" }];
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

/** Round-2 finding 2: while a recording is already live (picked up after minimizing/reopening, or
 * a remount for any other reason), its own `options.transcriber` is the ground truth for what
 * route to show — not the stored default, which this same recording may have been overridden away
 * from via `setRecordingTranscriber`. Only when no recording exists yet does the stored default
 * apply, via `onDeviceDefault`. Exported for testing: there is no DOM in this workspace, so this
 * hook (no host elements) is mounted directly rather than the full component. */
export function useLiveRouteOverride(signedIn: boolean): { activeOverride: Route | null; onDeviceDefault: boolean | null; offDefault: boolean | null } {
  const [activeOverride, setActiveOverride] = useState<Route | null>(null);
  const [onDeviceDefault, setOnDeviceDefault] = useState<boolean | null>(null);
  const [offDefault, setOffDefault] = useState<boolean | null>(null);
  useEffect(() => {
    if (!signedIn) return; // forced on-device; nothing to read
    let active = true;
    const fallbackToDefault = () => readDefaultTranscriber().then((transcriber) => { if (active) {
      setOnDeviceDefault(transcriber === "on-device");
      setOffDefault(transcriber === "off");
    } }, () => {});
    void VoiceNotes.status().then(
      (status) => {
        if (!active) return;
        if (status.intent !== "stopped" && status.options) { setActiveOverride(asRoute(status.options.transcriber)); return; }
        void fallbackToDefault();
      },
      fallbackToDefault,
    );
    return () => { active = false; };
  }, [signedIn]);
  return { activeOverride, onDeviceDefault, offDefault };
}

export function TranscriptionRouteControl(props: {
  /** Absent in a build without private cloud transcription. */
  transcription: VoiceNoteTranscriptionProps | undefined;
  /** Native forces on-device while signed out, no matter what's selected (CaptureEngine). */
  signedIn: boolean;
  /** Present in the recorder; the Library's standalone control has no live recording. */
  recorder?: RecordingRoute;
  /** Start on the one-time question, as if Private cloud had just been chosen (the harness). */
  defaultAsking?: boolean;
  className?: string;
}) {
  const { transcription, signedIn, recorder } = props;
  const headingId = useId();
  const offered = signedIn && transcription?.availability === "available";
  const consented = transcription?.consented ?? false;
  const [asking, setAsking] = useState(props.defaultAsking ?? false);
  const [notice, setNotice] = useState<string | null>(null);
  const [offPicked, setOffPicked] = useState(false);
  // Native's own default is on-device (CaptureEngine's defaultOptions()) unless an account has
  // set something else; seed from that instead of defaulting to Off until the native read
  // resolves, then correct from the real stored default once it lands. Already-consented private
  // cloud is a stronger, synchronously-known signal of intent than that still-loading default.
  // The recorder below reads the controller's native choice instead of these local hints.
  const [onDevicePicked, setOnDevicePicked] = useState(!consented);
  const { activeOverride: liveOverride, onDeviceDefault, offDefault } = useLiveRouteOverride(signedIn && !recorder);
  const [activeOverride, setActiveOverride] = useState<Route | null>(null);
  useEffect(() => { if (liveOverride) setActiveOverride(liveOverride); }, [liveOverride]);
  useEffect(() => { if (onDeviceDefault !== null) setOnDevicePicked(onDeviceDefault); }, [onDeviceDefault]);
  useEffect(() => { if (offDefault !== null) setOffPicked(offDefault); }, [offDefault]);
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const askingNow = offered && !consented && asking;
  // With a live recorder the selection is always the provider's; `asking` only shows the consent question.
  const route: Route = !signedIn ? "on-device"
    : recorder ? asRoute(recorder.transcriber.id)
    : askingNow ? "private-cloud"
    : activeOverride ?? (offPicked && !askingNow ? "off"
    : onDevicePicked && !askingNow ? "on-device"
    : offered && (consented || askingNow) ? "private-cloud" : "off");

  const choose = (next: Route) => {
    if (next === route || !signedIn) return;
    hapticSelection();
    setNotice(null);
    if (recorder) {
      if (next === "private-cloud" && !consented) { setAsking(true); return; }
      setAsking(false);
      void requestRecordingRoute(next, () => setRecordingRoute(recorder, next), { needsConsent: () => setAsking(true), settled: () => {}, notify: setNotice });
      return;
    }
    if (next === "off") {
      setAsking(false);
      setOnDevicePicked(false);
      setActiveOverride("off");
      setOffPicked(true);
      void setRecordingTranscriber("off");
    } else if (next === "on-device") {
      setAsking(false);
      setOnDevicePicked(true);
      setActiveOverride("on-device");
      setOffPicked(false);
      void setRecordingTranscriber("on-device");
    } else {
      setOnDevicePicked(false);
      setOffPicked(false);
      setActiveOverride(null); // defers to the consent flow below, as before
      if (!transcription) return;
      setAsking(true);
    }
  };

  const modelLine = onDeviceModelLine(sttStatus);
  const primaryModel = sttStatus.models.find((m) => m.id === "parakeet-tdt-0.6b-v3-int8" || m.id === "parakeet-tdt-110m-en-int8");

  let line: string;
  if (askingNow) line = "";
  else if (route === "on-device") line = isOnDeviceReady(sttStatus) ? "Transcribed on this phone." : `Transcribed on this phone, once the model finishes downloading. ${modelLine.text}`;
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
      <SegmentedControl<Route> aria-label="Transcription" value={route} onValueChange={choose} options={routeOptions(signedIn, offered)} />
      <RouteLine nodes={voiceNoteRoute(route)} />
      {askingNow ? (
        <div className="flex flex-col gap-3" data-testid="voice-note-transcription-consent">
          <p className="text-callout text-muted-foreground">
            After you stop, TinyCloud Private Transcription turns notes up to {minutes(transcription!.maxSeconds)} minutes
            into text.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Button type="button" onClick={() => {
              if (!recorder) { transcription!.onConsent(); return; }
              setNotice(null);
              void requestRecordingRoute("private-cloud", () => consentToRecordingPrivateCloud(recorder, transcription!.onConsent), {
                needsConsent: () => {},
                settled: () => setAsking(false),
                notify: setNotice,
              });
            }} data-testid="voice-note-transcription-enable">
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
      {notice && (
        <p role="alert" className="text-callout text-destructive" data-testid="transcription-route-notice">
          {notice}
        </p>
      )}
    </section>
  );
}
