// "How this got here" on a note (TC-761, plan §2.7): the route the capture
// took into the user's space, built only from what its row records. The
// source column says where it came from; `transcript_provider` (or a voice
// note's `transcription_engine`) adds the stop that made its text. Nothing
// the row does not record is drawn: no provider, no middle node.
import { RefreshCwIcon } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { EXO_MERGED_SOURCE } from "@tinyboilerplate/core";

import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { Skeleton } from "@/components/ui/skeleton";
import { routeSourceName, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import { RouteLine, type RouteNode } from "@/capture/recorder/RouteLine";
import { GMEET_MEETING_SOURCE } from "@/lib/connectors/gmeetNormalize";
import type { MeetingMetadataRead } from "@/lib/connectors/meetingExplorer";
import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import { LOCAL_MEETING_SOURCE } from "@/lib/localTranscriber";
import { TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { displayMembers, type CombinedMemberLine } from "./combine/combinedView";
import { librarySourceLabel } from "./libraryKinds";

export interface CaptureRoute {
  nodes: RouteNode[];
  /** One precise sentence: what was saved, and who made the text. */
  sentence: string;
  /** Private cloud made the text (the route links to how it works). */
  privateCloud: boolean;
}

const PRIVATE_CLOUD = "tinycloud-private-transcription";

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Where a voice note started; one with no recorded platform predates the desktop and web recorders, so it came from a phone. */
function voiceNoteSource(platform: string | null): string {
  return routeSourceName(platform === "tauri" || platform === "web" || platform === "android" ? platform : "ios");
}

/**
 * Who made the text, as the row records it. A voice note's engine and provider are
 * written when a transcription is attempted; only its transcription outcome says
 * that text came of it.
 */
function processor(source: string, metadata: Record<string, unknown> | null): "private-cloud" | "assemblyai" | "whisper" | null {
  if (source === VOICE_NOTE_SOURCE && metadata?.transcription_outcome !== "transcribed") return null;
  const provider = str(metadata?.transcript_provider);
  if (provider === PRIVATE_CLOUD) return "private-cloud";
  if (provider === "assemblyai") return "assemblyai";
  if (provider === "whispercpp") return "whisper";
  // Voice notes transcribed before the provider was recorded on them.
  if (source === VOICE_NOTE_SOURCE && str(metadata?.transcription_engine) === "private-cloud") return "private-cloud";
  return null;
}

const SPACE: RouteNode = { label: "Your space", kind: "destination" };

/** The route for one row, from its source and (once read) its metadata. */
export function captureRoute(source: string, metadata: Record<string, unknown> | null): CaptureRoute {
  if (source === VOICE_NOTE_SOURCE && metadata?.capture === "pasted") return {
    nodes: [{ label: "Pasted transcript", kind: "source" }, SPACE],
    sentence: "Pasted transcript saved to your TinyCloud space.", privateCloud: false,
  };
  if (source === EXO_MERGED_SOURCE) {
    // Display only: a combined row with unreadable metadata still gets this, without the member names.
    const from = displayMembers(metadata).map((m) => librarySourceLabel(m.source));
    const named = from.length > 0 ? `Combined from ${from.join(" + ")}` : "Combined from two of your captures";
    return {
      nodes: [{ label: from.length > 0 ? from.join(" + ") : "Two captures", kind: "source" }, { label: "Combined", kind: "processing" }, SPACE],
      sentence: `${named}, saved to your TinyCloud space. The original captures weren’t changed.`,
      privateCloud: false,
    };
  }
  if (source === "fireflies" || source === GMEET_MEETING_SOURCE) {
    const name = source === "fireflies" ? "Fireflies" : "Google Meet";
    return { nodes: [{ label: name, kind: "source" }, SPACE], sentence: `Synced from ${name} into your TinyCloud space.`, privateCloud: false };
  }
  if (source === TRANSCRIBER_MEETING_SOURCE) {
    return {
      nodes: [{ label: "Meeting", kind: "source" }, { label: "TinyCloud notetaker", kind: "processing" }, SPACE],
      sentence: "TinyCloud's notetaker joined the meeting and saved its transcript to your TinyCloud space.",
      privateCloud: false,
    };
  }

  const capture = metadata?.capture;
  const sourceLabel =
    source === VOICE_NOTE_SOURCE
      ? voiceNoteSource(str((capture as { platform?: unknown } | null | undefined)?.platform))
      : source === UPLOAD_MEETING_SOURCE
        ? "Upload"
        : source === LOCAL_MEETING_SOURCE
          ? routeSourceName("tauri")
          : null;
  if (sourceLabel === null) {
    return { nodes: [{ label: source, kind: "source" }, SPACE], sentence: "Saved to your TinyCloud space.", privateCloud: false };
  }

  const audioStored = (metadata?.audio as { stored?: unknown } | undefined)?.stored === true;
  const saved = audioStored ? "Audio saved to your TinyCloud space." : "Saved to your TinyCloud space.";
  const by = processor(source, metadata);
  if (by === null) return { nodes: [{ label: sourceLabel, kind: "source" }, SPACE], sentence: saved, privateCloud: false };

  if (by === "private-cloud") {
    const speech = str(metadata?.inference_provider) === "tinfoil" ? "; speech-to-text by Tinfoil" : "";
    return {
      nodes: [{ label: sourceLabel, kind: "source" }, { label: TRANSCRIBER_NAME["private-cloud"], kind: "processing" }, SPACE],
      sentence: `${saved} ${audioStored ? "A copy was" : "It was"} transcribed by TinyCloud Private Transcription${speech}.`,
      privateCloud: true,
    };
  }
  if (by === "assemblyai") {
    const account = str(metadata?.assemblyai_account);
    const whose = account === "tinycloud" ? " with TinyCloud's account" : account === "own" ? " with your key" : "";
    return {
      nodes: [{ label: sourceLabel, kind: "source" }, { label: TRANSCRIBER_NAME.assemblyai, kind: "processing" }, SPACE],
      sentence: `${saved} ${audioStored ? "A copy was" : "It was"} transcribed by AssemblyAI${whose}.`,
      privateCloud: false,
    };
  }
  return {
    nodes: [{ label: sourceLabel, kind: "source" }, { label: "Whisper on this Mac", kind: "processing" }, SPACE],
    sentence: "Transcribed by Whisper on this Mac. The transcript was saved to your TinyCloud space; the audio stayed on this Mac.",
    privateCloud: false,
  };
}

/**
 * The route, once the row's metadata has been read: a skeleton while it is
 * read, and no route at all when the read failed (a route drawn from the
 * source alone would claim a path with no stop in it), with Try again.
 */
export function HowThisGotHere(props: { source: string; read: MeetingMetadataRead | undefined; onRetry: () => void; /** A combined meeting's originals, with a link where they still exist. */ members?: readonly CombinedMemberLine[] }) {
  const { read } = props;
  // A source opened from here goes Back to here, not to the Library list.
  const here = useLocation().pathname;
  const route = read !== undefined && read.status !== "failed" ? captureRoute(props.source, read.status === "ok" ? read.metadata : null) : null;
  return (
    <section aria-labelledby="how-this-got-here" data-testid="how-this-got-here" data-state={read === undefined ? "loading" : read.status}>
      <h2 id="how-this-got-here" className="text-headline">
        How this got here
      </h2>
      {read === undefined ? (
        <div role="status" className="mt-3">
          <span className="sr-only">Loading where this came from…</span>
          <Skeleton lines={2} className="max-w-md" />
        </div>
      ) : route === null ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-callout text-muted-foreground">Couldn’t load where this came from.</p>
          <Button type="button" variant="outline" onClick={props.onRetry} data-testid="how-this-got-here-retry">
            <RefreshCwIcon aria-hidden /> Try again
          </Button>
        </div>
      ) : (
        <>
          <RouteLine nodes={route.nodes} landed className="mt-3" />
          <p className="mt-3 max-w-[68ch] text-callout text-muted-foreground">{route.sentence}</p>
          {route.privateCloud && <HowItWorksLink section="transcription">How private cloud works</HowItWorksLink>}
          {props.members && props.members.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1" aria-label="Combined from" data-testid="combined-members">
              {props.members.map((m) => (
                <li key={`${m.source}:${m.sourceId}`} className="text-callout" data-testid="combined-member">
                  <span className="text-muted-foreground">{m.sourceLabel} · </span>
                  {m.href !== null ? <Link to={m.href} state={{ backTo: here }} className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]">{m.title}</Link>
                    : <span className="text-muted-foreground">no longer in your Library</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
