// "How this got here" on a note (TC-761, plan §2.7): the route the capture
// took into the user's space, built only from what its row records. The
// source column says where it came from; `transcript_provider` (or a voice
// note's `transcription_engine`) adds the stop that made its text. Nothing
// the row does not record is drawn: no provider, no middle node.
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { RouteLine, type RouteNode } from "@/capture/recorder/RouteLine";
import { GMEET_MEETING_SOURCE } from "@/lib/connectors/gmeetNormalize";
import { UPLOAD_MEETING_SOURCE } from "@/lib/audioUpload";
import { LOCAL_MEETING_SOURCE } from "@/lib/localTranscriber";
import { TRANSCRIBER_MEETING_SOURCE } from "@/lib/transcriberSave";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";

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

function phoneLabel(platform: string | null): string {
  if (platform === "ios") return "iPhone";
  if (platform === "android") return "Android phone";
  return "Phone";
}

/** Who made the text, as the row records it. */
function processor(source: string, metadata: Record<string, unknown> | null): "private-cloud" | "assemblyai" | "whisper" | null {
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
      ? phoneLabel(str((capture as { platform?: unknown } | null | undefined)?.platform))
      : source === UPLOAD_MEETING_SOURCE
        ? "Upload"
        : source === LOCAL_MEETING_SOURCE
          ? "This Mac"
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
      nodes: [{ label: sourceLabel, kind: "source" }, { label: "Private cloud", kind: "processing" }, SPACE],
      sentence: `${saved} ${audioStored ? "A copy was" : "It was"} transcribed by TinyCloud Private Transcription${speech}.`,
      privateCloud: true,
    };
  }
  if (by === "assemblyai") {
    const account = str(metadata?.assemblyai_account);
    const whose = account === "tinycloud" ? " with TinyCloud's account" : account === "own" ? " with your key" : "";
    return {
      nodes: [{ label: sourceLabel, kind: "source" }, { label: "AssemblyAI", kind: "processing" }, SPACE],
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

export function HowThisGotHere(props: { source: string; metadata: Record<string, unknown> | null }) {
  const route = captureRoute(props.source, props.metadata);
  return (
    <section aria-labelledby="how-this-got-here" data-testid="how-this-got-here">
      <h2 id="how-this-got-here" className="text-headline">
        How this got here
      </h2>
      <RouteLine nodes={route.nodes} landed className="mt-3" />
      <p className="mt-3 max-w-[68ch] text-callout text-muted-foreground">{route.sentence}</p>
      {route.privateCloud && <HowItWorksLink section="transcription">How private cloud works</HowItWorksLink>}
    </section>
  );
}
